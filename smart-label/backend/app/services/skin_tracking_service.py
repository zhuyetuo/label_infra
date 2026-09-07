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
from collections import defaultdict
from datetime import date

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.skin import SkinRecord
from app.models.skin_daily import SkinDailyStat

_ANSWER_FIELDS = ("has_hair_loss", "color", "odor", "lesion", "hair_spot", "hair_diameter", "coat")


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


def _photo_counts() -> dict[tuple[str, str], int]:
    """{(日期, 狗名): 张数}。目录是 {material_root}/{skin_photo_dir}/{日期[-ok]}/{狗}/*.jpg"""
    root = os.path.join(settings.material_root, settings.skin_photo_dir)
    out: dict[tuple[str, str], int] = {}
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
                out[(day, dog)] = out.get((day, dog), 0) + n
    return out


async def daily_tracking(
    db: AsyncSession, date_from: date, date_to: date, imu_dog_map: dict[str, str] | None = None
) -> dict:
    """返回 {rows, warnings}，一行 = (日期, 狗)。"""
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

    photos = await asyncio.to_thread(_photo_counts)
    imu_dog_map = imu_dog_map or {}

    # 先把 (日期, IMU) 的两份 C 值合到一起
    merged: dict[tuple[str, str], dict] = defaultdict(lambda: {"ai": None, "human": None, "stats": {}})
    for s in stats:
        key = (s.stat_date.isoformat(), s.imu)
        merged[key][s.source] = {"c_value": s.c_value, "c_tier": s.c_tier}
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
            return {"total": r.get("total"), "s_tier": r.get("s_tier"), "c_tier": r.get("c_tier")}
        except SkinTrackingError:
            return None

    rows: list[dict] = []
    jobs: list[tuple[dict, str, object]] = []
    for key in sorted(merged):
        day, imu = key
        m = merged[key]
        dog = imu_dog_map.get(imu) or imu
        rec = rec_by_key.get((day, dog))
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
            "photo_count": photos.get((day, dog), 0),
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
