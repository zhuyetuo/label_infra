"""
把以前用 Label Studio 标的那批数据导进这个平台。

背景：2026-06 到 08 这几个月的标注是在 Label Studio 上做的，一共 58 个 LS 项目、
2088 个任务、2609 条时间段标注。那批数据是现在模型的训练集来源，不能丢，而且
要能在这个平台上翻出来核对——尤其是接下来 AI 辅助标注跑起来之后，得拿人工标的
这批当基准去比"AI 和人一致的有多少、不一致的在哪"。

## 映射关系

LS 的一个 task 对应一个媒体文件，文件名带 cam 号：

    multicam_20260718_021310_cam1_imu1_resampled16hz.mp4

这个平台的一个 sample 捆的是多路视频 + 一个 IMU CSV，编号里没有 cam：

    multicam_20260718_021310_imu1

所以 cam 号在映射时丢掉，(会话时间戳, imu号) 才是主键。同一个会话被 cam1 和
cam2 各标一遍的情况不存在——LS 那边一个 task 就是一个 cam×imu 配对文件，
配对分布看下来 cam_i 基本只跟 imu_i 走。

还有一类 task 是切片：

    multicam_20260719_181724_cam1_imu1_resampled16hz_clip01_182019-182022.mp4

它是从整段里剪出来的一小段（18:20:19–18:20:22），媒体文件本身只有那三秒。
平台没有"切片样本"这种东西，但 tasks 表本来就支持样本内的子时间段
（segment_start_ms / segment_end_ms），所以切片 task 导成整段样本上的一个
子时间段任务，正好对得上。

## 时间基准

LS 存的是绝对时间（`2026-07-18 02:14:05.692`），平台存的是相对样本开头的毫秒。
换算要有个 t0。

**不能拿文件名里的时间戳当 t0**，三个坑：
  1. 时间戳有 6 位（`021310`）和 9 位（`080944934`，带毫秒）两种写法；
  2. 切片文件名里的 `clip01_182019-182022` 是切片自己的起止，不是会话起点；
  3. 文件名精度只到秒，而标注精度到毫秒。

所以 t0 一律读样本 IMU CSV 的第一行时间戳。那一行就是这段录制的真实开头，
三种情况全都对，而且跟平台里其它地方（推理、导出）用的是同一个基准。

## 幂等

同一份导出反复跑不会翻倍：任务按 (项目, 样本, 子时间段起止) 认，已经有了就
跳过，不重建也不追加标注。改过标注的任务更是绝对不碰——重跑一次导入不该把
人后来的修订盖掉。

## 用法

导出文件就在仓库里（backend/fixtures/labelstudio_old/，一共 368KB），跟这个脚本配套，
git pull 下来就能跑，不用再手工往容器里传文件。容器里的路径是 /app/fixtures/...
（Dockerfile 是 COPY . . + WORKDIR /app）。

注意 compose 里的服务名是 api，不是 backend：

    cd ~/label_infra/smart-label/deploy

    # 先空跑看统计，什么都不写
    docker compose exec api python -m app.scripts.import_labelstudio_old \
      --src /app/fixtures/labelstudio_old --dry-run

    # 确认没问题再真导
    docker compose exec api python -m app.scripts.import_labelstudio_old \
      --src /app/fixtures/labelstudio_old --user 1

--src 认两种：解压好的目录（结构是 `<数据集名>/<project-N-at-....json>`），
或者一堆 .zip 所在的目录（会自己解压到临时目录，跑完删掉）。
--only <数据集名> 只导一个，先拿最小的 2026_8_28_imu1_bb 试水比较稳。
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import glob
import json
import os
import re
import sys
import tempfile
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timedelta

from sqlalchemy import select

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.annotation import (
    AnnotationLabelItem,
    AnnotationRecord,
    LabelItemSource,
    RecordSourceType,
)
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task, TaskStatus, TaskType

# 老文件名：multicam_<日期>_<时间>_cam<N>_imu<M>[_resampled16hz][_clip01_HHMMSS-HHMMSS]
_MEDIA_RE = re.compile(
    r"(?P<session>multicam_\d{8}_\d{6,9})"
    r"_cam(?P<cam>\d+)_imu(?P<imu>\d+)"
    r"(?:_resampled\d+hz)?"
    r"(?:_(?P<clip>clip\d+)_(?P<cs>\d{6})-(?P<ce>\d{6}))?"
)

# LS 的 task.data 里媒体字段名换过好几茬：两路时代是 video1/video2 + csv，
# 四路时代是 video1..video4 + csv1/csv2，还有更早的单路 video。
# 只要能拿到一个能解析出会话号的就够了，挨个试。
_MEDIA_KEYS = ("csv1", "csv", "csv2", "video1", "video", "video2", "video3", "video4")

# 标注末尾压着样本结尾、或者视频比 CSV 长个一两秒是常事，留点余量再判越界
_EDGE_TOL_MS = 5000

_TS_FMTS = ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S.%f")


def parse_ts(v: str) -> float | None:
    """CSV 第一列 / LS 的 start-end，统一转成 epoch 秒。

    两种写法都要认，跟 utils/ffprobe.measure_csv_hz 里的判断保持一致：降过采样的
    那批是可读日期串，采集端直接写的 raw 是 epoch 毫秒的浮点数。纯数字按绝对量级
    判单位——epoch 秒是 1.8e9 量级、毫秒 1.8e12、微秒 1.8e15，差着一千倍不会认错。
    """
    v = (v or "").strip()
    if not v:
        return None
    for f in _TS_FMTS:
        try:
            return datetime.strptime(v, f).timestamp()
        except ValueError:
            continue
    try:
        n = float(v)
    except ValueError:
        return None
    a = abs(n)
    if a >= 1e14:
        return n / 1e6
    if a >= 1e11:
        return n / 1e3
    return n


def csv_t0(rel_path: str) -> float | None:
    """样本 IMU CSV 的第一行时间戳，当作这个样本的时间原点。"""
    full = os.path.join(settings.nas_root, rel_path)
    try:
        with open(full, encoding="utf-8-sig", newline="") as f:
            reader = csv.reader(f)
            next(reader, None)  # 表头
            for row in reader:
                if row and row[0]:
                    t = parse_ts(row[0])
                    if t is not None:
                        return t
    except OSError:
        return None
    return None


def media_of(task: dict) -> str:
    for k in _MEDIA_KEYS:
        v = (task.get("data") or {}).get(k)
        if v:
            return os.path.basename(str(v))
    return ""


def extract_sources(src: str) -> tuple[str, tempfile.TemporaryDirectory | None]:
    """--src 可以是解压好的目录，也可以是一堆 .zip 所在的目录。"""
    zips = sorted(glob.glob(os.path.join(src, "*.zip")))
    if not zips:
        return src, None
    tmp = tempfile.TemporaryDirectory(prefix="ls_import_")
    for z in zips:
        with zipfile.ZipFile(z) as zf:
            zf.extractall(tmp.name)
    return tmp.name, tmp


def load_groups(root: str) -> dict[str, list[str]]:
    """{数据集名: [导出的 json 路径, ...]}，一个数据集 = 平台上一个项目。"""
    groups: dict[str, list[str]] = defaultdict(list)
    for path in sorted(glob.glob(os.path.join(root, "*", "*.json"))):
        groups[os.path.basename(os.path.dirname(path))].append(path)
    return dict(groups)


def clip_window(m: re.Match, day: str) -> tuple[float, float] | None:
    """切片文件名里的 `clip01_182019-182022` → 这一小段的绝对起止（epoch 秒）。

    只有时分秒，日期从会话时间戳里取。跨零点的录制（23:59 开始、00:02 结束）
    会让结束时间看着比开始早，那种情况给结束加一天。
    """
    try:
        s = datetime.strptime(f"{day} {m.group('cs')}", "%Y%m%d %H%M%S")
        e = datetime.strptime(f"{day} {m.group('ce')}", "%Y%m%d %H%M%S")
    except ValueError:
        return None
    if e < s:
        e += timedelta(days=1)
    return s.timestamp(), e.timestamp()


async def get_or_create_project(db, name: str, user_id: int, dry: bool) -> Project | None:
    p = (await db.execute(select(Project).where(Project.name == name))).scalar_one_or_none()
    if p or dry:
        return p
    p = Project(
        name=name,
        description="从 Label Studio 导入的历史标注（只改动过的会产生新一轮，原始轮次保留）",
        created_by=user_id,
    )
    db.add(p)
    await db.flush()
    return p


async def get_or_create_labels(db, project_id: int, codes: list[str], user_id: int, dry: bool) -> dict[str, int]:
    rows = (
        await db.execute(select(LabelDefinition).where(LabelDefinition.project_id == project_id))
    ).scalars().all()
    out = {r.code: r.id for r in rows}
    for i, code in enumerate(codes):
        if code in out:
            continue
        if dry:
            out[code] = -1
            continue
        d = LabelDefinition(
            project_id=project_id, code=code, display_name=code, sort_order=i, created_by=user_id
        )
        db.add(d)
        await db.flush()
        out[code] = d.id
    return out


async def reset_projects(db, names: list[str]) -> None:
    """把之前导进来的 _old 项目连同任务/标注整个删掉，为重导让路。

    什么时候用：第一版导入把 1078 个老任务当成"已存在"跳过了，1156 条标注没进去，
    库里那份是残的。这些项目是导入脚本自己建的、还没人在上面改过东西，删掉重来
    比写一个"补差异"的迁移脚本简单得多，也不容易出错。

    只删名字精确匹配的这几个 _old 项目。人手建的项目、别的项目一律不碰。
    """
    from sqlalchemy import delete
    for name in names:
        p = (await db.execute(select(Project).where(Project.name == name))).scalar_one_or_none()
        if p is None:
            continue
        task_ids = list((await db.execute(select(Task.id).where(Task.project_id == p.id))).scalars())
        rec_ids = []
        if task_ids:
            rec_ids = list((await db.execute(
                select(AnnotationRecord.id).where(AnnotationRecord.task_id.in_(task_ids)))).scalars())
        # 从叶子往根删，外键才不会拦
        if rec_ids:
            await db.execute(delete(AnnotationLabelItem).where(
                AnnotationLabelItem.annotation_record_id.in_(rec_ids)))
            await db.execute(delete(AnnotationRecord).where(AnnotationRecord.id.in_(rec_ids)))
        if task_ids:
            await db.execute(delete(Task).where(Task.id.in_(task_ids)))
        await db.execute(delete(LabelDefinition).where(LabelDefinition.project_id == p.id))
        await db.delete(p)
        print(f"  已删除项目 {name}（任务 {len(task_ids)} 个，标注记录 {len(rec_ids)} 条）")
    await db.commit()


async def run(src: str, user_id: int, dry: bool, only: str | None, reset: bool = False) -> int:
    root, tmp = extract_sources(src)
    groups = load_groups(root)
    if not groups:
        print(f"{src} 下没找到 <数据集>/<project-*.json>，也没有 .zip")
        return 1

    stats = Counter()
    missing_samples: Counter = Counter()
    unparsed: Counter = Counter()

    async with SessionLocal() as db:
        if reset:
            names = [f"{d}_old" for d in sorted(groups) if not only or only == d]
            if dry:
                print(f"(dry-run) 会先删掉这些项目再重导: {', '.join(names)}")
            else:
                print("先清掉之前导入的项目（只删这几个 _old，别的不碰）：")
                await reset_projects(db, names)
                print()

        for dataset, files in sorted(groups.items()):
            if only and only != dataset:
                continue
            pname = f"{dataset}_old"

            # 先把这个数据集用到的标签扫一遍，一次建齐——标签定义是项目级的，
            # 边导边建会让 label_definitions 的 sort_order 跟着 task 顺序乱跳
            tasks_raw: list[dict] = []
            label_codes: list[str] = []
            for path in files:
                with open(path, encoding="utf-8") as f:
                    for t in json.load(f):
                        tasks_raw.append(t)
                        for a in t.get("annotations") or []:
                            for r in a.get("result") or []:
                                for code in (r.get("value") or {}).get("timeserieslabels") or []:
                                    if code not in label_codes:
                                        label_codes.append(code)

            print(f"\n── {pname} ── 老项目 {len(files)} 个，任务 {len(tasks_raw)} 个，标签 {len(label_codes)} 种")

            project = await get_or_create_project(db, pname, user_id, dry)
            if project is None:
                print(f"   (dry-run) 会新建项目 {pname}，标签: {' '.join(label_codes)}")
                label_ids = {c: -1 for c in label_codes}
                pid = -1
            else:
                label_ids = await get_or_create_labels(db, project.id, label_codes, user_id, dry)
                pid = project.id

            t0_cache: dict[str, float | None] = {}
            # 本次运行里已经建过的任务：键 → (annotation_record_id, 已有的标注集合)
            # dry-run 时没有 record_id，只放集合
            in_run: dict = {}
            for t in tasks_raw:
                base = media_of(t)
                m = _MEDIA_RE.search(base)
                if not m:
                    # 更早的 rec_wit_* 单设备录制，平台里没有对应样本，导不了
                    unparsed[base.split("_")[0] or "(空)"] += 1
                    stats["跳过_文件名无法解析"] += 1
                    continue

                code = f"{m.group('session')}_imu{m.group('imu')}"
                sample = (
                    await db.execute(select(Sample).where(Sample.sample_code == code))
                ).scalar_one_or_none()
                if sample is None:
                    missing_samples[code] += 1
                    stats["跳过_平台上没有这个样本"] += 1
                    continue

                if code not in t0_cache:
                    t0_cache[code] = csv_t0(sample.imu_csv_path)
                t0 = t0_cache[code]
                if t0 is None:
                    stats["跳过_读不到样本CSV的起始时间"] += 1
                    continue

                seg_start = seg_end = None
                if m.group("clip"):
                    w = clip_window(m, m.group("session").split("_")[1])
                    if w is None:
                        stats["跳过_切片时间解析失败"] += 1
                        continue
                    seg_start = int(round((w[0] - t0) * 1000))
                    seg_end = int(round((w[1] - t0) * 1000))
                    if seg_end <= seg_start:
                        stats["跳过_切片时间段无效"] += 1
                        continue

                # 一个 (项目, 样本, 子时间段) 对应平台上的一个任务。多个老任务
                # 落到同一个键上是常事——LS 那边一个 task 是一个 cam×imu 文件，
                # cam1_imu3 和 cam3_imu3 指向同一个样本；同一个时间窗还会有
                # clip01 和 clip05 两份切片，各自标了不同的东西。
                #
                # 这里必须**合并**，不能后来者跳过。第一版就是跳过，结果 2088 个
                # 老任务里 1078 个被判成"已存在"，其中 1076 个的标注跟先到的那个
                # 不一样——1156 条独有的标注片段一声不吭地没了。而 dry-run 还看不
                # 出来：那时项目还不存在，pid 是 -1，这段检查整个被绕过去了，
                # 报出来的是漂亮的 2040。
                #
                # 区分两种"已经有了"：
                #   本次运行里刚建的  → 合并进去（in_run 里有）
                #   上次导入留下的    → 原样不动，重跑不该盖掉人后来的修订
                key = (pid, sample.id, seg_start)
                merge_into = in_run.get(key)
                if merge_into is None and pid > 0:
                    q = select(Task).where(
                        Task.project_id == pid, Task.sample_id == sample.id,
                        Task.segment_start_ms.is_(None) if seg_start is None
                        else Task.segment_start_ms == seg_start,
                    )
                    if (await db.execute(q)).scalars().first() is not None:
                        stats["已存在_跳过（上次导入的，不动）"] += 1
                        continue

                items: list[tuple[str, int, int]] = []
                for a in t.get("annotations") or []:
                    for r in a.get("result") or []:
                        v = r.get("value") or {}
                        s, e = parse_ts(v.get("start") or ""), parse_ts(v.get("end") or "")
                        codes = v.get("timeserieslabels") or []
                        if s is None or e is None or not codes:
                            stats["跳过_标注缺时间或标签"] += 1
                            continue
                        a_ms, b_ms = int(round((s - t0) * 1000)), int(round((e - t0) * 1000))
                        if b_ms <= a_ms:
                            stats["跳过_标注时间段无效"] += 1
                            continue
                        # 落在样本之外的一律不要。实测这批导出里 2570 条有一条切片的
                        # 绝对时间比会话起点早了 23 小时——多半是当年切片时文件名的
                        # 时分秒跨了零点、日期取错。这种换算出来是负的毫秒，写进
                        # start_time_ms 那一列不会报错，只会变成一条永远对不上画面的
                        # 脏标注，回头查起来比当场丢掉难得多。
                        # 上界用样本时长；时长没探测出来的样本放行，只挡负数。
                        limit_ms = (sample.video_duration_sec or 0) * 1000
                        if a_ms < 0 or (limit_ms and a_ms > limit_ms + _EDGE_TOL_MS):
                            stats["跳过_标注落在样本时间轴之外"] += 1
                            continue
                        for c in codes:
                            items.append((c, a_ms, b_ms))

                if not items:
                    stats["跳过_没有有效标注"] += 1
                    continue

                # dry-run 也要模拟合并，否则报出来的数字比真跑的乐观
                if merge_into is not None:
                    stats["合并进已有任务"] += 1
                    seen = merge_into if dry else merge_into[1]
                    fresh = [x for x in items if x not in seen]
                    stats["合并_新增标注片段"] += len(fresh)
                    stats["合并_丢弃重复片段"] += len(items) - len(fresh)
                    seen.update(fresh)
                    if not dry and fresh:
                        for c, a_ms, b_ms in fresh:
                            db.add(AnnotationLabelItem(
                                annotation_record_id=merge_into[0], label_id=label_ids[c],
                                start_time_ms=a_ms, end_time_ms=b_ms,
                                source_type=LabelItemSource.human_added,
                                created_by=user_id,
                            ))
                    continue

                stats["导入_任务"] += 1
                stats["导入_标注片段"] += len(items)
                if dry:
                    in_run[key] = set(items)
                    continue

                task = Task(
                    project_id=pid, sample_id=sample.id,
                    task_type=TaskType.from_scratch,      # 老数据是人从零标的，不是 AI 预标改的
                    status=TaskStatus.APPROVED,           # 当成品收进来，但仍然可以改（改了会产生新一轮）
                    segment_start_ms=seg_start, segment_end_ms=seg_end,
                    round_no=1, created_by=user_id,
                )
                db.add(task)
                await db.flush()
                rec = AnnotationRecord(
                    task_id=task.id, round_no=1,
                    source_type=RecordSourceType.human_only,
                    submitted_at=datetime.now(),
                )
                db.add(rec)
                await db.flush()
                for c, a_ms, b_ms in items:
                    db.add(AnnotationLabelItem(
                        annotation_record_id=rec.id, label_id=label_ids[c],
                        start_time_ms=a_ms, end_time_ms=b_ms,
                        source_type=LabelItemSource.human_added,
                        created_by=user_id,
                    ))
                in_run[key] = (rec.id, set(items))
            if not dry:
                await db.commit()

    print("\n=========== 汇总 ===========")
    for k, v in sorted(stats.items()):
        print(f"  {k:28s} {v:6d}")
    if missing_samples:
        print(f"\n⚠ 平台上找不到的样本 {len(missing_samples)} 个（这些标注没导进去）：")
        for c, n in missing_samples.most_common(10):
            print(f"    {c}  ({n} 个任务)")
        if len(missing_samples) > 10:
            print(f"    ……还有 {len(missing_samples) - 10} 个")
        print("  多半是 NAS 上原始文件已经不在了，或者还没扫描导入。"
              "先跑一次样本扫描再来，导入是幂等的，重跑只补没导进去的那些。")
    if unparsed:
        print(f"\n⚠ 文件名认不出来、导不进来的 {sum(unparsed.values())} 个任务：")
        for pre, n in unparsed.most_common():
            why = {
                "multi": "单摄像头时代（imu_camera_sync_multi.py），只有一路 video + 一个 csv",
                "rec": "更早的纯 IMU 录制（rec_wit_*），根本没有视频",
            }.get(pre, "不认识的命名")
            print(f"    {pre}_*  {n:3d} 个 —— {why}")
        print("  平台的 sample 至少要 cam1+cam2 两路视频，这些凑不出来，只能留在 LS 的导出文件里。"
              "占比很小（约 1.5% 的标注片段），但别当成 0：真要用得单独想办法。")
    if dry:
        print("\n(dry-run，什么都没写。去掉 --dry-run 才真的导入)")
    if tmp:
        tmp.cleanup()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="把 Label Studio 导出的历史标注导入平台")
    ap.add_argument("--src", required=True, help="解压后的目录（<数据集>/<project-*.json>），或一堆 .zip 所在的目录")
    ap.add_argument("--user", type=int, default=1, help="以哪个用户的身份创建项目/任务/标注，默认 1")
    ap.add_argument("--only", help="只导这一个数据集（目录名）")
    ap.add_argument("--dry-run", action="store_true", help="只统计不写库")
    ap.add_argument("--reset", action="store_true",
                    help="先把同名的 _old 项目连同任务/标注整个删掉再重导。"
                         "用于修第一版导入留下的残缺数据——那次把 1078 个老任务"
                         "当成'已存在'跳过了，1156 条标注没进库。"
                         "只删这几个 _old 项目，人手建的项目不碰。"
                         "已经在这些项目上改过标注的话别用，会连人的修改一起删掉。")
    a = ap.parse_args()
    return asyncio.run(run(a.src, a.user, a.dry_run, a.only, a.reset))


if __name__ == "__main__":
    sys.exit(main())
