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
    db: AsyncSession, name: str, date_from: date | None = None, date_to: date | None = None,
    project_ids: list[int] | None = None,
    include_submitted: bool = False, scope: str = "approved",
) -> dict:
    if not _NAME_RE.match(name):
        raise TrainingExportError("数据集名只能用字母/数字/下划线/横线，1–64 位")
    if scope not in ("approved", "reviewed"):
        raise TrainingExportError("scope 只能是 approved 或 reviewed")
    only_reviewed = scope == "reviewed"
    q = select(Task, Sample).join(Sample, Sample.id == Task.sample_id).order_by(Task.id)
    # 日期和项目各自可选。都不给就是"全部"——那是合理需求（把手上所有标注导成
    # 一份），只是导出来会很大，n_tasks 会如实报出来。
    if date_from is not None:
        q = q.where(Sample.session_date >= date_from)
    if date_to is not None:
        q = q.where(Sample.session_date <= date_to)
    if not only_reviewed:
        # 整份取：任务本身得审过
        statuses = [TaskStatus.APPROVED] + ([TaskStatus.SUBMITTED] if include_submitted else [])
        q = q.where(Task.status.in_(statuses))
    if project_ids:
        q = q.where(Task.project_id.in_(project_ids))
    rows = (await db.execute(q)).all()
    if not rows:
        raise TrainingExportError(
            "这个范围里没有任务" if only_reviewed else "这个范围里没有审核通过的任务"
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
    # 同类别重叠并掉了几段、不同类别压在一起有几处，导出后能对上账
    n_merged_overlaps = 0
    n_conflicts = 0
    n_conflict_ms = 0
    conflicts: list[dict] = []

    ls_tasks: list[dict] = []
    # 实际进了这份数据集的采集日，用来回显"范围"。
    # 名字别叫 spans——这个函数里下面的合并循环有个
    # `for label_id, spans in by_label.items()`，会把同名变量重新绑成一堆
    # (起, 止) 毫秒元组。第一版就叫 spans，结果日期和元组混在一个列表里，
    # min() 直接 TypeError: '<' not supported between 'date' and 'tuple'。
    session_days: list[date] = []
    label_counter: Counter[str] = Counter()
    label_sec: Counter[str] = Counter()
    warnings: list[str] = []
    # 这份数据集里各种采样率各占多少个任务。混了频率是要当场看见的事，
    # 不是等模型训出来效果不对再回头查。
    hz_counter: Counter[int] = Counter()
    n_hz_unknown = 0
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

        # 同一类别里压在一起的段先并掉。会出现是因为「疑似抓挠」补上来的段常常跟
        # 已有的 AI 段覆盖同一次抓挠，只是起止差几百毫秒——不并的话重叠那部分的
        # 数据行会被导两遍，等于给这一段偷偷加了权。标签是"这段时间是什么"，
        # 两段都说是抓挠，并成一段是等价的，不丢信息。
        by_label: dict[int, list[tuple[int, int]]] = {}
        for label_id, s_ms, e_ms in items:
            by_label.setdefault(label_id, []).append((s_ms, e_ms))
        merged_items: list[tuple[int, int, int]] = []
        for label_id, spans in by_label.items():
            merged = _merge(spans)
            n_merged_overlaps += len(spans) - len(merged)
            merged_items.extend((label_id, a_ms, b_ms) for a_ms, b_ms in merged)

        # 不同类别压在一起是矛盾标注（同一段时间既是活动又是抓挠）。两条都导出的话，
        # 同一批数据行会以两个类别各进一次，模型学到的是纯噪声——比不要这段更糟。
        # 不能替人决定谁对，所以按跟「待定」一样的办法：把重叠那一小段从两边都挖掉，
        # 各自剩下的部分照常用。宁可少一点数据，也不喂矛盾的。
        ordered = sorted(merged_items, key=lambda x: x[1])
        conflict_spans: list[tuple[int, int]] = []
        for i in range(len(ordered) - 1):
            l1, a1, b1 = ordered[i]
            for l2, a2, b2 in ordered[i + 1 :]:
                if a2 >= b1:
                    break
                if l1 == l2:
                    continue
                lo, hi = a2, min(b1, b2)
                conflict_spans.append((lo, hi))
                n_conflicts += 1
                # 结构化记一份：前端要按这个直接把工作台开到出问题的时刻，
                # 不能让人拿着一句话回去自己找
                if len(conflicts) < 200:
                    conflicts.append({
                        "task_id": task.id,
                        "sample_code": sample.sample_code,
                        "label_a": label_names.get(l1, str(l1)),
                        "label_b": label_names.get(l2, str(l2)),
                        "start_ms": lo,
                        "end_ms": hi,
                        "seconds": round((hi - lo) / 1000, 2),
                    })
        if conflict_spans:
            merged_conflicts = _merge(conflict_spans)
            n_conflict_ms += sum(b - a for a, b in merged_conflicts)
            holes = _merge(holes + merged_conflicts)

        for label_id, s_ms, e_ms in ordered:
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
                        # 相对 CSV 起点的毫秒：核对时「去修」要拿它把工作台开到
                        # 这一刻。训练那边只读上面三个 key，多带两个不影响
                        "start_ms": a_ms,
                        "end_ms": b_ms,
                    },
                })
                label_counter[name_] += 1
                # 段数不等于份量：一段睡觉 30 分钟和一段抓挠 2 秒都算"1 段"。
                # 判断类别均不均衡要看时长，看段数会得出完全相反的结论。
                label_sec[name_] += (b_ms - a_ms) / 1000
                total_sec += (b_ms - a_ms) / 1000
        n_segments += len(result)
        # 带上这份 CSV 自己的采样率，别让下游按一个全局假设去重采样。
        # 这批数据是混的：8-11 之前采集端就已经降到 16Hz 存了，8-11 起才是 50Hz
        # 原始流。全按 50Hz 处理的话，本来就是 16Hz 的那批会被再降一次到 ~5Hz——
        # 而抓挠的判据是陀螺仪 4–8Hz 的能量占比，5Hz 采样的奈奎斯特频率才 2.5Hz，
        # 那个频带整个没了。训出来的模型不会报错，只是认不出抓挠。
        # 扫描导入时已经逐个文件量过并存在 samples.imu_sample_rate_hz 上，这里
        # 只是把它带出去。量不出来的留 None，下游自己决定退回什么默认值。
        if sample.imu_sample_rate_hz:
            hz_counter[int(sample.imu_sample_rate_hz)] += 1
        else:
            n_hz_unknown += 1
        if sample.session_date is not None:
            session_days.append(sample.session_date)
        ls_tasks.append({
            "id": task.id,
            "data": {
                "csv": sample.imu_csv_path,
                "sample_code": sample.sample_code,
                "sample_rate_hz": sample.imu_sample_rate_hz,
            },
            "annotations": [{"id": task.id, "result": result}],
        })
    if not ls_tasks:
        raise TrainingExportError("没有可导出的任务；" + "；".join(warnings[:3]))

    # 混了采样率就喊一声，放在 warnings 最前面。不拦着导出——混着导是合理需求，
    # 只要下游按每个任务的 sample_rate_hz 处理就行；但绝不能让它悄无声息。
    if len(hz_counter) > 1:
        parts = "、".join(f"{k}Hz {v} 个任务" for k, v in sorted(hz_counter.items()))
        warnings.insert(0, (
            f"⚠ 这份数据集混了 {len(hz_counter)} 种采样率（{parts}）。"
            "每个任务的 data.sample_rate_hz 里有各自的频率，训练时按它来重采样；"
            "统一按某一个频率处理会把另一批算错，而且不会报错。"
        ))
    if n_hz_unknown:
        warnings.insert(0, (
            f"⚠ 有 {n_hz_unknown} 个任务量不出采样率（sample_rate_hz 为 null）。"
            "多半是 CSV 时间戳列有问题；下游会退回默认频率，那批数据可能算错。"
        ))

    rel_dir = os.path.join(TRAIN_DIR, name)
    full_dir = os.path.join(settings.nas_root, rel_dir)
    meta = {
        "name": name,
        # 回显的是**实际包含进来的**最早/最晚采集日，不是筛选条件。
        # 不给日期范围时筛选条件本来就是空的；就算给了，圈到的样本也未必铺满整个
        # 区间——列表上那一列写着"范围"，人看的是"这份数据集里装的是哪几天"。
        "date_from": (min(session_days).isoformat() if session_days else None),
        "date_to": (max(session_days).isoformat() if session_days else None),
        # 筛选条件另存一份，重导时照着填
        "filter": {
            "date_from": date_from.isoformat() if date_from else None,
            "date_to": date_to.isoformat() if date_to else None,
            "project_ids": project_ids or [],
        },
        "include_submitted": include_submitted,
        "scope": scope,
        # 按片段取时跳过了多少条"没人看过的 AI 片段"，导出后能对上账
        "n_untouched_skipped": n_skipped_untouched,
        # 同类别压在一起并掉了几段（「疑似抓挠」补上来的常跟已有 AI 段覆盖同一次动作）
        "n_merged_overlaps": n_merged_overlaps,
        # 不同类别压在一起的处数：这是矛盾标注，得回工作台改
        "n_label_conflicts": n_conflicts,
        # 因为类别冲突挖掉了多少秒
        "label_conflict_excluded_sec": round(n_conflict_ms / 1000, 1),
        "conflicts": conflicts,
        "n_tasks": len(ls_tasks), "n_segments": n_segments, "total_hours": round(total_sec / 3600, 2),
        # 有多少段被判「待定」而挖掉了，以及采集时掉数据挖掉了多久，导出后能对上账
        "n_uncertain_excluded": n_holes,
        "missing_excluded_min": round(n_missing_ms / 60000, 1),
        # 采样率分布：{16: 641, 50: 284} 这种。下游按每份文件自己的频率处理即可，
        # 不用也不该去猜一个全局值。
        "sample_rate_hz": {str(k): v for k, v in sorted(hz_counter.items())},
        "n_sample_rate_unknown": n_hz_unknown,
        "labels": dict(label_counter),
        # 每个类别的总时长（秒）。段数看不出份量，均衡与否得按时长算。
        "label_seconds": {k: round(v, 1) for k, v in label_sec.items()},
        "warnings": warnings[:50],
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
                    # 老数据集没有这两个字段，前端要能忍
                    "start_ms": v.get("start_ms"),
                    "end_ms": v.get("end_ms"),
                })
    return {"total": total, "truncated": total > len(rows), "rows": rows}


def label_stats(names: list[str]) -> dict:
    """按类别统计这些数据集的段数和时长，用来看类别均不均衡。

    直接读各自的 merged_tmp.json 现算，不读 meta.json 里的汇总：
    label_seconds 是后加的字段，之前导出的数据集里没有；而"哪些类别不够、要不要
    补采"这种判断，最不该因为"这份数据集导得早"就少一块。现算就都有。

    多选是重点。单份数据集看均衡没什么意义——真正要回答的是"我手上所有训练数据
    加起来，抓挠占多少"，而数据是一批批攒的，答案只能跨数据集看。
    """
    per: dict[str, Counter] = {}
    per_sec: dict[str, Counter] = {}
    missing: list[str] = []
    for name in names:
        if not _NAME_RE.match(name):
            continue
        path = os.path.join(settings.nas_root, TRAIN_DIR, name, "merged_tmp.json")
        if not os.path.isfile(path):
            missing.append(name)
            continue
        with open(path, encoding="utf-8") as f:
            tasks = json.load(f)
        c, s = Counter(), Counter()
        for t_ in tasks:
            for ann in t_.get("annotations") or []:
                for seg in ann.get("result") or []:
                    v = seg.get("value") or {}
                    labels = v.get("timeserieslabels") or []
                    if not labels:
                        continue
                    try:
                        a_ = datetime.strptime(v.get("start") or "", "%Y-%m-%d %H:%M:%S.%f")
                        b_ = datetime.strptime(v.get("end") or "", "%Y-%m-%d %H:%M:%S.%f")
                        sec = (b_ - a_).total_seconds()
                    except ValueError:
                        sec = 0.0
                    c[labels[0]] += 1
                    s[labels[0]] += sec
        per[name] = c
        per_sec[name] = s

    total_c, total_s = Counter(), Counter()
    for name in per:
        total_c.update(per[name])
        total_s.update(per_sec[name])
    grand = sum(total_s.values()) or 1.0
    rows = [
        {
            "label": k,
            "n_segments": total_c[k],
            "seconds": round(total_s[k], 1),
            "hours": round(total_s[k] / 3600, 3),
            "pct": round(total_s[k] / grand * 100, 2),
            # 每份数据集各贡献了多少秒，一眼看出"这个类别只有某一批有"
            "by_dataset": {n: round(per_sec[n][k], 1) for n in per if per_sec[n][k] > 0},
        }
        for k in sorted(total_s, key=lambda x: -total_s[x])
    ]
    return {
        "datasets": list(per),
        "missing": missing,
        "total_hours": round(grand / 3600, 2),
        "total_segments": sum(total_c.values()),
        "rows": rows,
    }


def check_dataset(name: str, max_examples: int = 200) -> dict:
    """
    体检这份导出：有没有重复的段、有没有时间上压在一起的段。

    为什么要查：
      - 完全相同的段进两次 = 同一份数据在训练里被数了两遍，等于偷偷加权
      - 同一任务里两段时间重叠：同类别的说明该合成一段；不同类别的是矛盾标注
        （同一段时间既是活动又是抓挠），模型学到的是噪声
      - 同一个样本出现在两个任务里（比如同一份数据建了两次任务），两边都审过的话
        同一段时间会以两条记录进训练集——这是最难自己发现的一种重复

    只看导出文件本身，不回数据库——要查的就是"喂给训练的这份有没有毛病"。
    """
    data = read_segments(name, limit=10**9)
    rows = data["rows"]

    def _t(v: str) -> datetime | None:
        try:
            return datetime.strptime(v, "%Y-%m-%d %H:%M:%S.%f")
        except ValueError:
            return None

    exact: dict[tuple, int] = {}
    bad_range: list[dict] = []
    by_task: dict[int, list[dict]] = {}
    by_sample: dict[str, set[int]] = {}
    for r in rows:
        key = (r["task_id"], r["label"], r["start"], r["end"])
        exact[key] = exact.get(key, 0) + 1
        if r["seconds"] is None or r["seconds"] <= 0:
            bad_range.append(r)
        by_task.setdefault(r["task_id"], []).append(r)
        if r["sample_code"]:
            by_sample.setdefault(r["sample_code"], set()).add(r["task_id"])

    dup_rows = [
        {"task_id": k[0], "label": k[1], "start": k[2], "end": k[3], "count": n}
        for k, n in exact.items()
        if n > 1
    ]

    overlaps: list[dict] = []
    n_overlap_total = 0
    for task_id, segs in by_task.items():
        parsed = []
        for r in segs:
            a_, b_ = _t(r["start"]), _t(r["end"])
            if a_ and b_ and b_ > a_:
                parsed.append((a_, b_, r))
        parsed.sort(key=lambda x: x[0])
        for i in range(len(parsed) - 1):
            a1, b1, r1 = parsed[i]
            # 只跟后面那些"开始时间早于我结束时间"的比，排完序之后一撞上就可以停
            for j in range(i + 1, len(parsed)):
                a2, b2, r2 = parsed[j]
                if a2 >= b1:
                    break
                sec = (min(b1, b2) - a2).total_seconds()
                if sec <= 0:
                    continue
                # 完全一样的两条上面按「完全重复」报过了，这里不再当成重叠重复报一遍
                if (
                    r1["label"] == r2["label"]
                    and r1["start"] == r2["start"]
                    and r1["end"] == r2["end"]
                ):
                    continue
                n_overlap_total += 1
                if len(overlaps) < max_examples:
                    overlaps.append({
                        "task_id": task_id,
                        "sample_code": r1["sample_code"],
                        "label_a": r1["label"], "start_a": r1["start"], "end_a": r1["end"],
                        "label_b": r2["label"], "start_b": r2["start"], "end_b": r2["end"],
                        "overlap_sec": round(sec, 2),
                        "same_label": r1["label"] == r2["label"],
                    })

    shared = [
        {"sample_code": code, "task_ids": sorted(tids)}
        for code, tids in by_sample.items()
        if len(tids) > 1
    ]

    return {
        "n_segments": len(rows),
        "n_exact_dups": sum(n - 1 for n in exact.values() if n > 1),
        "exact_dups": dup_rows[:max_examples],
        "n_overlaps": n_overlap_total,
        "overlaps": overlaps,
        "n_bad_range": len(bad_range),
        "bad_range": bad_range[:max_examples],
        "shared_samples": shared[:max_examples],
        "n_shared_samples": len(shared),
    }


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
