"""
训练集导出：把审核通过的任务的当前片段整理成 imu_train 的 train_custom.sh 认的
Label Studio 导出格式（单 csv：data.csv + annotations[].result[].value{start,end,
timeserieslabels}），写到 NAS 的 data_train/<name>/merged_tmp.json，旁边一份 meta.json
记录范围和数量。imu_train/label_service 的 /train 接 export_json 后自己整理进仓库目录。

两种取法（scope）：
  approved   —— 只取审核通过（可选加上已提交）的任务，整份都算数。最稳，但一份
                标注得从头到尾审完才用得上。
  reviewed   —— 不看任务状态，只取**人碰过的那些片段**（确认过 / 改过 / 人工加的、
                包括从「疑似抓挠」确认上来的）。人工复看是很费时间的事，实际总是
                「这个任务只审了抓挠」「那个任务审了一半」，等整份审完再用，攒不出
                数据集。按片段取就能一点一点往里加。
                安全性来自导出格式本身：labelstudio_to_custom 只提取被标注区间里的
                行，没标注的时间根本不会进数据集——所以"没人看过的 AI 片段不导出"
                不会变成"把它当负样本"，那段时间是直接不参与训练。

数据来源只有一种：任务当前轮的片段。审核通过的任务里 AI 片段被确认/纠正过、人工
新增的、从候选里确认的，都已经是同一张表里的正式片段；被排除的候选和被删掉的误报
所占的时间，本来就被活动/睡觉这些状态片段覆盖着，天然是负样本，不用单独处理。

例外有两种，处理办法一样——挖洞：

1. 标了「待定」的片段（画面里没拍到狗、动作看不清，既不能确认也不舍得删）。
   只是"不导出待定条"是不够的：那段时间通常还压着一条"活动/睡觉"，不挖的话
   等于把一段可能是抓挠的数据当成负样本喂给模型，比不要这段数据更糟。
1b. 标了「待定」的**候选**（疑似抓挠里人看完拿不准的那些）。它本来就不在草稿里，
   但同样不能让那段时间以"活动/睡觉"的身份混成负样本，一并挖掉。
2. 采集时掉的数据（蓝牙断连，六轴全写 0 占帧对齐的位置，或者写 MISSING）。
   现场用 BLE 收数据才会这样，线上设备是先存本地硬盘再回传，不会缺帧——所以
   这是采集期的临时噪声，绝不能进训练集。AI 结果 JSON 里记着这些时间段
   （missing 字段），这里读出来一并挖掉。注意是挖时间段、不是丢 CSV 行：行还
   得留着，不然工作台上看视频会跳帧、波形跟时间轴对不上。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
from collections import Counter
from datetime import date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.ai_candidate import AiCandidate, CandidateStatus
from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource
from app.models.label import LabelDefinition
from app.models.sample import Sample
from app.models.task import Task, TaskStatus
from app.services.ai_prelabel_service import PrelabelError, _csv_start_of, ai_label_relpath, parse_ts
from app.services.skin_link_service import _read_ai_json

TRAIN_DIR = "data_train"
_NAME_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")


class TrainingExportError(Exception):
    pass


def _merge(spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """把重叠/相接的区间并成不相交的一组，方便下面做差集。"""
    out: list[list[int]] = []
    for s_ms, e_ms in sorted(spans):
        if e_ms <= s_ms:
            continue
        if out and s_ms <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e_ms)
        else:
            out.append([s_ms, e_ms])
    return [(a, b) for a, b in out]


# 挖掉之后剩的碎片短于这个长度就不要了：窗口是 2 秒一个，比这更短的碎片
# 切不出完整窗口，留着只是噪声
_MIN_PIECE_MS = 1000


def _subtract(start_ms: int, end_ms: int, holes: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """[start, end) 减去 holes（已合并、已排序），返回剩下的碎片。"""
    pieces = [(start_ms, end_ms)]
    for h_s, h_e in holes:
        if h_e <= start_ms or h_s >= end_ms:
            continue
        nxt: list[tuple[int, int]] = []
        for a, b in pieces:
            if h_e <= a or h_s >= b:
                nxt.append((a, b))
                continue
            if h_s > a:
                nxt.append((a, h_s))
            if h_e < b:
                nxt.append((h_e, b))
        pieces = nxt
    return [(a, b) for a, b in pieces if b - a >= _MIN_PIECE_MS]


def _fmt(t: datetime) -> str:
    return t.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


async def export_dataset(
    db: AsyncSession, name: str, date_from: date, date_to: date, project_id: int | None = None,
    include_submitted: bool = False, scope: str = "approved",
) -> dict:
    if not _NAME_RE.match(name):
        raise TrainingExportError("数据集名只能用字母/数字/下划线/横线，1–64 位")
    if scope not in ("approved", "reviewed"):
        raise TrainingExportError("scope 只能是 approved 或 reviewed")
    only_reviewed = scope == "reviewed"
    q = (
        select(Task, Sample)
        .join(Sample, Sample.id == Task.sample_id)
        .where(Sample.session_date >= date_from, Sample.session_date <= date_to)
        .order_by(Task.id)
    )
    if not only_reviewed:
        # 整份取：任务本身得审过
        statuses = [TaskStatus.APPROVED] + ([TaskStatus.SUBMITTED] if include_submitted else [])
        q = q.where(Task.status.in_(statuses))
    if project_id is not None:
        q = q.where(Task.project_id == project_id)
    rows = (await db.execute(q)).all()
    if not rows:
        raise TrainingExportError(
            "这段日期里没有任务" if only_reviewed else "这段日期里没有审核通过的任务"
        )

    label_names = dict(
        (await db.execute(select(LabelDefinition.id, LabelDefinition.display_name))).all()
    )
    task_ids = [t.id for t, _ in rows]
    items_by_task: dict[int, list[tuple[int, int, int]]] = {}
    holes_by_task: dict[int, list[tuple[int, int]]] = {}
    item_rows = await db.execute(
        select(
            AnnotationRecord.task_id,
            AnnotationLabelItem.label_id,
            AnnotationLabelItem.start_time_ms,
            AnnotationLabelItem.end_time_ms,
            AnnotationLabelItem.uncertain,
            AnnotationLabelItem.ai_confirmed,
            AnnotationLabelItem.is_modified,
            AnnotationLabelItem.source_type,
        )
        .join(AnnotationLabelItem, AnnotationLabelItem.annotation_record_id == AnnotationRecord.id)
        .join(Task, Task.id == AnnotationRecord.task_id)
        .where(AnnotationRecord.task_id.in_(task_ids), AnnotationRecord.round_no == Task.round_no)
    )
    n_skipped_untouched = 0
    for task_id, label_id, s_ms, e_ms, uncertain, confirmed, modified, source in item_rows.all():
        if uncertain:
            # 「待定」永远挖洞，跟怎么取无关：那段时间既不能当正例也不能当负例
            holes_by_task.setdefault(task_id, []).append((int(s_ms), int(e_ms)))
            continue
        if only_reviewed:
            # 人碰过才算数：确认过、改过、或者本来就是人加的（含从候选确认上来的）。
            # 没人看过的纯 AI 片段跳过——它只是模型自己的输出，拿去训练就是自我强化
            touched = bool(confirmed) or bool(modified) or source == LabelItemSource.human_added
            if not touched:
                n_skipped_untouched += 1
                continue
        items_by_task.setdefault(task_id, []).append((label_id, int(s_ms), int(e_ms)))

    # 候选里被标成「待定」的：不在草稿里，但那段时间同样不能当负样本用
    cand_holes: dict[int, list[tuple[int, int]]] = {}
    cand_rows = await db.execute(
        select(AiCandidate.task_id, AiCandidate.start_time_ms, AiCandidate.end_time_ms)
        .join(Task, Task.id == AiCandidate.task_id)
        .where(
            AiCandidate.task_id.in_(task_ids),
            AiCandidate.round_no == Task.round_no,
            AiCandidate.status == CandidateStatus.uncertain,
        )
    )
    for tid, s_ms, e_ms in cand_rows.all():
        cand_holes.setdefault(tid, []).append((int(s_ms), int(e_ms)))

    def _missing_holes(sample: Sample, csv_start: datetime) -> list[tuple[int, int]]:
        """AI 结果里记的掉数据时间段，换算成相对 CSV 起点的毫秒。"""
        data = _read_ai_json(ai_label_relpath(sample.imu_csv_path)) if sample.imu_csv_path else None
        out: list[tuple[int, int]] = []
        for m in (data or {}).get("missing") or []:
            a, b = parse_ts(m.get("start_ts")), parse_ts(m.get("end_ts"))
            if a and b and b > a:
                out.append((
                    int(round((a - csv_start).total_seconds() * 1000)),
                    int(round((b - csv_start).total_seconds() * 1000)),
                ))
        return out

    n_holes = sum(len(v) for v in holes_by_task.values()) + sum(len(v) for v in cand_holes.values())
    n_missing_ms = 0

    ls_tasks: list[dict] = []
    label_counter: Counter[str] = Counter()
    warnings: list[str] = []
    n_segments = 0
    total_sec = 0.0
    for task, sample in rows:
        items = items_by_task.get(task.id) or []
        if not items:
            warnings.append(f"任务 #{task.id} 没有片段，跳过")
            continue
        try:
            csv_start = await _csv_start_of(sample)
        except PrelabelError as e:
            warnings.append(f"任务 #{task.id}：{e}")
            continue
        result = []
        # 「待定」和「采集时掉数据」都要挖掉，合成一组洞一起处理
        missing = await asyncio.to_thread(_missing_holes, sample, csv_start)
        n_missing_ms += sum(b - a for a, b in missing)
        holes = _merge((holes_by_task.get(task.id) or []) + (cand_holes.get(task.id) or []) + missing)
        for label_id, s_ms, e_ms in sorted(items, key=lambda x: x[1]):
            if e_ms <= s_ms:
                continue
            name_ = label_names.get(label_id, str(label_id))
            # 跟「待定」重叠的部分挖掉，剩下的碎片各导一条
            for a_ms, b_ms in _subtract(s_ms, e_ms, holes):
                result.append({
                    "from_name": "label", "to_name": "ts", "type": "timeserieslabels",
                    "value": {
                        "start": _fmt(csv_start + timedelta(milliseconds=a_ms)),
                        "end": _fmt(csv_start + timedelta(milliseconds=b_ms)),
                        "timeserieslabels": [name_],
                    },
                })
                label_counter[name_] += 1
                total_sec += (b_ms - a_ms) / 1000
        n_segments += len(result)
        ls_tasks.append({
            "id": task.id,
            "data": {"csv": sample.imu_csv_path, "sample_code": sample.sample_code},
            "annotations": [{"id": task.id, "result": result}],
        })
    if not ls_tasks:
        raise TrainingExportError("没有可导出的任务；" + "；".join(warnings[:3]))

    rel_dir = os.path.join(TRAIN_DIR, name)
    full_dir = os.path.join(settings.nas_root, rel_dir)
    meta = {
        "name": name, "date_from": date_from.isoformat(), "date_to": date_to.isoformat(),
        "project_id": project_id, "include_submitted": include_submitted,
        "scope": scope,
        # 按片段取时跳过了多少条"没人看过的 AI 片段"，导出后能对上账
        "n_untouched_skipped": n_skipped_untouched,
        "n_tasks": len(ls_tasks), "n_segments": n_segments, "total_hours": round(total_sec / 3600, 2),
        # 有多少段被判「待定」而挖掉了，以及采集时掉数据挖掉了多久，导出后能对上账
        "n_uncertain_excluded": n_holes,
        "missing_excluded_min": round(n_missing_ms / 60000, 1),
        "labels": dict(label_counter), "warnings": warnings[:50],
        "exported_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "export_json": os.path.join(rel_dir, "merged_tmp.json"),
    }

    def _write() -> None:
        os.makedirs(full_dir, exist_ok=True)
        with open(os.path.join(full_dir, "merged_tmp.json"), "w", encoding="utf-8") as f:
            json.dump(ls_tasks, f, ensure_ascii=False)
        with open(os.path.join(full_dir, "meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

    await asyncio.to_thread(_write)
    return meta


def read_segments(name: str, limit: int = 5000) -> dict:
    """
    把导出文件里的片段摊平成一张表，用来核对"这份数据集到底装了什么"。

    读的就是最终喂给训练的那份 merged_tmp.json，不是重新从数据库算——要核对的
    正是"落到文件里的是什么"，重算一遍等于换了个东西看。
    """
    if not _NAME_RE.match(name):
        raise TrainingExportError("数据集名不合法")
    path = os.path.join(settings.nas_root, TRAIN_DIR, name, "merged_tmp.json")
    if not os.path.isfile(path):
        raise TrainingExportError("这个数据集没有导出文件")
    with open(path, encoding="utf-8") as f:
        tasks = json.load(f)

    rows: list[dict] = []
    total = 0
    for t in tasks:
        code = (t.get("data") or {}).get("sample_code") or ""
        for ann in t.get("annotations") or []:
            for seg in ann.get("result") or []:
                total += 1
                if len(rows) >= limit:
                    continue
                v = seg.get("value") or {}
                labels = v.get("timeserieslabels") or []
                start, end = v.get("start") or "", v.get("end") or ""
                sec = None
                try:
                    a_ = datetime.strptime(start, "%Y-%m-%d %H:%M:%S.%f")
                    b_ = datetime.strptime(end, "%Y-%m-%d %H:%M:%S.%f")
                    sec = round((b_ - a_).total_seconds(), 2)
                except ValueError:
                    pass
                rows.append({
                    "task_id": t.get("id"),
                    "sample_code": code,
                    "label": labels[0] if labels else "",
                    "start": start,
                    "end": end,
                    "seconds": sec,
                })
    return {"total": total, "truncated": total > len(rows), "rows": rows}


def delete_dataset(name: str) -> None:
    """删掉 NAS 上这个数据集目录。名字先过一遍白名单，别让 ../ 之类的跑出去。"""
    if not _NAME_RE.match(name):
        raise TrainingExportError("数据集名不合法")
    root = os.path.realpath(os.path.join(settings.nas_root, TRAIN_DIR))
    full = os.path.realpath(os.path.join(root, name))
    if full != root and not full.startswith(root + os.sep):
        raise TrainingExportError("非法路径")
    if not os.path.isdir(full):
        raise TrainingExportError("这个数据集不存在")
    shutil.rmtree(full)


def list_datasets() -> list[dict]:
    root = os.path.join(settings.nas_root, TRAIN_DIR)
    if not os.path.isdir(root):
        return []
    out = []
    for d in sorted(os.listdir(root), reverse=True):
        p = os.path.join(root, d, "meta.json")
        if not os.path.isfile(p):
            continue
        try:
            with open(p, encoding="utf-8") as f:
                out.append(json.load(f))
        except (OSError, ValueError):
            continue
    return out
