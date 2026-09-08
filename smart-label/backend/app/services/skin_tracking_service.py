"""
每日跟踪：把「一天一只狗」这条线上的东西拼成一行——

    IMU 抓挠统计（AI 版 / 人工版）→ C 值 → 是否触发问答 → 问答（可选）→ S 总分

一行 = (日期, 狗)。数据全部来自已经算好/存好的东西，不重新扫 NAS：
  - C 值：skin_daily_stats（「项目联动」算完存下来的，ai / human 两份）
  - 问答：skin_records（PM 手工填的那份，按 狗名 + 日期 匹配）
  - 照片：素材库 NAS 上 {日期}/{狗}/ 下有几张，只数个数不读图
  - S 总分：调 label_service 的 /skin/s-total，同一套 PM 规则

S 算两份，因为 PM 想看「不填问答能到什么程度」和「填了之后变成什么」：
  - s_no_q：问答留空（缺的题按 0 分算，等于只有 C 值那 40% 在起作用），
            是这一天的**下限**；
  - s_with_q：有问答记录时用真实答案算。没有记录就没有这一份。

触发问答的规则代码里原本没有，按「C 值到了 C1 / C2 就该去问」实现，
阈值见 settings.skin_question_trigger_tiers，不认同改配置即可。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from collections import defaultdict
from datetime import date

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource
from app.models.dog import Dog
from app.models.label import LabelDefinition
from app.models.sample import Sample
from app.models.skin import SkinRecord
from app.models.skin_daily import SkinDailyStat
from app.models.task import Task

_ANSWER_FIELDS = ("has_hair_loss", "color", "odor", "lesion", "hair_spot", "hair_diameter", "coat")
_IMU_RE = re.compile(r"_imu(\d+)$", re.IGNORECASE)


def _loads(raw: str | None):
    """库里存的是 JSON 字符串，坏了也不能让整张表打不开。"""
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def _imu_of(sample_code: str) -> str | None:
    m = _IMU_RE.search(sample_code or "")
    return f"IMU{m.group(1)}" if m else None


class SkinTrackingError(Exception):
    pass


async def _algo_post(path: str, payload: dict) -> dict:
    url = f"{settings.algo_service_url.rstrip('/')}/api/v1/skin/{path}"
    try:
        async with httpx.AsyncClient(timeout=settings.algo_infer_timeout_sec) as client:
            resp = await client.post(url, json=payload)
    except httpx.RequestError as e:
        raise SkinTrackingError(f"无法连接 AI 服务 ({url}): {e}") from e
    if resp.status_code != 200:
        raise SkinTrackingError(f"AI 服务返回 {resp.status_code}: {resp.text[:300]}")
    return resp.json()


def _norm_dog(name: str, extra: set[str] | None = None) -> set[str]:
    """
    一只狗的几种叫法。PM 那边是「金毛-巴利」这种「品种-名字」，NAS 上的目录名
    常常只写名字（「巴利」），也可能写拼音（「Bali」「bibi」）。这里把可能的写法
    都列出来，匹配时任一相等或互相包含就算同一只。

    extra 是狗档案里登记的别名——配置文件里那份是兜底的默认值，改一次要重启，
    真正该维护这层对应关系的地方是狗档案页面。
    """
    n = (name or "").strip()
    parts = {n, n.lower()}
    for alias in list(settings.skin_dog_aliases.get(n, [])) + sorted(extra or ()):
        alias = (alias or "").strip()
        if alias:
            parts.add(alias)
            parts.add(alias.lower())
    for sep in ("-", "_", " "):
        if sep in n:
            for piece in n.split(sep):
                piece = piece.strip()
                if piece:
                    parts.add(piece)
                    parts.add(piece.lower())
    return {p for p in parts if p}


def _photo_index() -> list[tuple[str, str, int]]:
    """[(日期, 目录里的狗名, 张数)]。目录是 {material_root}/{skin_photo_dir}/{日期[-ok]}/{狗}/*.jpg"""
    root = os.path.join(settings.material_root, settings.skin_photo_dir)
    out: list[tuple[str, str, int]] = []
    if not os.path.isdir(root):
        return out
    exts = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
    for folder in os.listdir(root):
        fpath = os.path.join(root, folder)
        if not os.path.isdir(fpath):
            continue
        day = folder[:10]  # 目录名可能带 -ok 后缀
        for dog in os.listdir(fpath):
            dpath = os.path.join(fpath, dog)
            if not os.path.isdir(dpath):
                continue
            n = sum(1 for fn in os.listdir(dpath) if os.path.splitext(fn)[1].lower() in exts)
            if n:
                out.append((day, dog, n))
    return out


def _match_photos(
    index: list[tuple[str, str, int]], day: str, dog: str, extra: set[str] | None = None
) -> tuple[int, str | None]:
    """返回 (张数, NAS 上实际的狗目录名)。目录名跟 PM 狗名对不上是常态，做宽松匹配。"""
    aliases = _norm_dog(dog, extra)
    total, matched = 0, None
    for d, folder_dog, n in index:
        if d != day:
            continue
        fd = folder_dog.strip()
        fdl = fd.lower()
        hit = fd in aliases or fdl in aliases or any(a in fdl or fdl in a.lower() for a in aliases if len(a) >= 2)
        if hit:
            total += n
            matched = matched or fd
    return total, matched


async def daily_tracking(
    db: AsyncSession, date_from: date, date_to: date, imu_dog_map: dict[str, str] | None = None,
    c_prefer: str = "human",
) -> dict:
    """返回 {rows, warnings}，一行 = (日期, 狗)。

    c_prefer 决定这张表用哪一版 C 值（S 总分跟着它算）：
      human —— 人工版优先，没有才用 AI 版。看"人最后定了什么"用这个
      ai    —— 一律用 AI 版。线上就是纯 AI，没有人工审核这一环；采集期只审了
               一部分天的话，两版混在一列里趋势是断的（今天人工 30、明天 AI 70，
               看着像暴涨，其实只是口径换了）。要看长期趋势就该锁死 AI 版
    """
    warnings: list[str] = []
    trigger_tiers = set(settings.skin_question_trigger_tiers)

    stats = (
        await db.execute(
            select(SkinDailyStat)
            .where(SkinDailyStat.stat_date >= date_from, SkinDailyStat.stat_date <= date_to)
            .order_by(SkinDailyStat.stat_date, SkinDailyStat.imu)
        )
    ).scalars().all()
    if not stats:
        return {"rows": [], "warnings": ["这段日期还没有算过 C 值，先去「项目联动」点一次「重新拉取」"]}

    records = (
        await db.execute(
            select(SkinRecord).where(SkinRecord.fill_date >= date_from, SkinRecord.fill_date <= date_to)
        )
    ).scalars().all()
    # 同一天同一只狗可能好几个人填过，取最后保存的那份
    rec_by_key: dict[tuple[str, str], SkinRecord] = {}
    for r in sorted(records, key=lambda x: (x.updated_at or x.created_at)):
        rec_by_key[(r.fill_date.isoformat(), r.dog_name)] = r

    photo_index = await asyncio.to_thread(_photo_index)
    # 狗档案是这几套叫法（PM 的「比熊-BB」、NAS 目录的「bibi」、机位号 IMU1）
    # 唯一能对上的地方：机位号优先，没登记就退回按编号数字当机位（IMU1 ↔ 编号1）
    dog_rows = (await db.execute(select(Dog))).scalars().all()
    alias_by_imu: dict[str, set[str]] = defaultdict(set)
    for d in dog_rows:
        imu_key = (d.imu or "").strip().upper() or (f"IMU{d.dog_code}" if (d.dog_code or "").isdigit() else "")
        if not imu_key:
            continue
        for v in [d.name, d.breed, *(d.aliases or "").replace("，", ",").split(",")]:
            v = (v or "").strip()
            if v:
                alias_by_imu[imu_key].add(v)

    # 这一天这只狗底下有哪几个任务：跟踪表里点「查看标注」要跳过去复看，
    # 顺带带上每个任务里「抓挠」片段有几段，好挑哪一段去看
    task_rows = (
        await db.execute(
            select(Task.id, Task.status, Sample.sample_code, Sample.session_date, Sample.video_duration_sec)
            .join(Sample, Sample.id == Task.sample_id)
            .where(Sample.session_date >= date_from, Sample.session_date <= date_to)
            .order_by(Sample.sample_code)
        )
    ).all()
    scratch_label_ids = set(
        (
            await db.execute(
                select(LabelDefinition.id).where(
                    (LabelDefinition.display_name == "抓挠") | (LabelDefinition.code == "抓挠")
                )
            )
        ).scalars().all()
    )
    # 每个任务的人工复看结果：AI 标的抓挠里，确认了几段、判成待定几段（分两种
    # 原因）、还有几段本来是 AI 标的抓挠、被人改成别的类别（比如其实是甩身体）。
    # 光看「9 段」不知道人看过没有、看完是什么结论，这几个数就是给这个的。
    seg_counts: dict[int, int] = {}
    review_counts: dict[int, dict] = defaultdict(
        lambda: {"confirmed": 0, "uncertain_no_view": 0, "uncertain_ambiguous": 0, "relabeled": 0}
    )
    if task_rows and scratch_label_ids:
        task_ids_all = [t[0] for t in task_rows]
        rows_c = await db.execute(
            select(
                AnnotationRecord.task_id,
                AnnotationLabelItem.label_id,
                AnnotationLabelItem.source_type,
                AnnotationLabelItem.is_modified,
                AnnotationLabelItem.ai_confirmed,
                AnnotationLabelItem.uncertain,
                AnnotationLabelItem.uncertain_reason,
            )
            .join(AnnotationLabelItem, AnnotationLabelItem.annotation_record_id == AnnotationRecord.id)
            .join(Task, Task.id == AnnotationRecord.task_id)
            .where(
                AnnotationRecord.task_id.in_(task_ids_all),
                AnnotationRecord.round_no == Task.round_no,
            )
        )
        for tid, label_id, source, modified, confirmed, uncertain, reason in rows_c.all():
            is_scratch = label_id in scratch_label_ids
            is_ai = source == LabelItemSource.ai_generated
            if is_scratch:
                seg_counts[tid] = seg_counts.get(tid, 0) + 1
                if uncertain:
                    key = "uncertain_no_view" if reason == "no_view" else "uncertain_ambiguous"
                    review_counts[tid][key] += 1
                elif confirmed:
                    review_counts[tid]["confirmed"] += 1
            elif is_ai and modified:
                # AI 给的、被人改过、现在不是抓挠了——「甩身体误判成抓挠」这类。
                # 严格说也可能是别的类别之间互改，但复看时人只动抓挠这一类，够用
                review_counts[tid]["relabeled"] += 1

    tasks_by_key: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for tid, status, code, sdate, dur in task_rows:
        imu = _imu_of(code)
        if imu is None or sdate is None:
            continue
        tasks_by_key[(sdate.isoformat(), imu)].append(
            {
                "task_id": tid,
                "sample_code": code,
                "status": status.value if hasattr(status, "value") else str(status),
                "scratch_segments": seg_counts.get(tid, 0),
                **review_counts[tid],
                # 前端要拿它把「09:00:14 ~ ?」补成「09:00:14 ~ 10:00:00」
                "video_duration_sec": dur,
            }
        )
    imu_dog_map = imu_dog_map or {}

    # 先把 (日期, IMU) 的两份 C 值合到一起
    merged: dict[tuple[str, str], dict] = defaultdict(lambda: {"ai": None, "human": None, "stats": {}})
    for s in stats:
        key = (s.stat_date.isoformat(), s.imu)
        merged[key][s.source] = {
            "c_value": s.c_value,
            "c_tier": s.c_tier,
            # 算 C 用的那几个输入 + 各项得分，跟踪表 tooltip 要拿来讲"怎么来的"
            "c_inputs": _loads(s.c_inputs),
            "c_detail": _loads(s.c_detail),
        }
        if s.stats and not merged[key]["stats"]:
            try:
                merged[key]["stats"] = json.loads(s.stats)
            except ValueError:
                pass

    async def _s_total(c_value, c_tier, answers: dict | None) -> dict | None:
        payload = {"c_value": c_value, "c_tier_hint": c_tier}
        payload.update({k: (answers or {}).get(k) for k in _ANSWER_FIELDS})
        try:
            r = await _algo_post("s-total", payload)
            # 整份返回：除了总分/档位，还有 C/皮肤组/毛发组各自贡献了多少，
            # 前端把它摊开成一行行的算式
            return r
        except SkinTrackingError:
            return None

    rows: list[dict] = []
    jobs: list[tuple[dict, str, object]] = []
    for key in sorted(merged):
        day, imu = key
        m = merged[key]
        dog = imu_dog_map.get(imu) or imu
        rec = rec_by_key.get((day, dog))
        photo_n, photo_dog = _match_photos(photo_index, day, dog, alias_by_imu.get(imu))
        if c_prefer == "ai":
            primary = m["ai"]
            p_source = "ai" if m["ai"] else None
        else:
            # 人工版优先（人核对过的更可信），没有就用 AI 版
            primary = m["human"] or m["ai"]
            p_source = "human" if m["human"] else ("ai" if m["ai"] else None)
        c_value = (primary or {}).get("c_value")
        c_tier = (primary or {}).get("c_tier")
        row = {
            "date": day,
            "imu": imu,
            "dog_name": dog,
            "stats": m["stats"],
            # 基线（这只狗别的日子的中位数）单独拎出来，图上要画成参考线
            "baseline_count": (m["stats"] or {}).get("baseline_count"),
            "baseline_duration_min": (m["stats"] or {}).get("baseline_duration_min"),
            "n_baseline_days": (m["stats"] or {}).get("n_baseline_days"),
            "c_ai": m["ai"],
            "c_human": m["human"],
            "c_source": p_source,
            "c_value": c_value,
            "c_tier": c_tier,
            "delta_c": (
                round(m["human"]["c_value"] - m["ai"]["c_value"], 1)
                if m["human"] and m["ai"] and m["human"]["c_value"] is not None and m["ai"]["c_value"] is not None
                else None
            ),
            # C 到了 C1/C2 就该去问一轮，C0 不用
            "question_triggered": c_tier in trigger_tiers if c_tier else False,
            "has_answers": rec is not None,
            "record_id": rec.id if rec else None,
            "q_score": rec.q_score if rec else None,
            "filler": rec.filler if rec else None,
            "tasks_detail": tasks_by_key.get(key, []),
            "photo_count": photo_n,
            # NAS 上实际的目录名，前端弹窗按它去筛图（可能跟 PM 的狗名不一样）
            "photo_dog": photo_dog,
            "s_no_q": None,
            "s_with_q": None,
        }
        rows.append(row)
        if c_value is not None:
            jobs.append((row, "s_no_q", None))
            if rec is not None:
                jobs.append((row, "s_with_q", {k: getattr(rec, k) for k in _ANSWER_FIELDS}))

    sem = asyncio.Semaphore(8)

    async def _run(row: dict, field: str, answers: dict | None) -> None:
        async with sem:
            row[field] = await _s_total(row["c_value"], row["c_tier"], answers)

    if jobs:
        await asyncio.gather(*(_run(r, f, a) for r, f, a in jobs))
        if all(r["s_no_q"] is None for r in rows if r["c_value"] is not None):
            warnings.append("S 总分没算出来，检查 AI 服务是否正常")

    return {"rows": rows, "warnings": warnings, "trigger_tiers": sorted(trigger_tiers)}
