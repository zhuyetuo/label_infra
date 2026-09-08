"""
皮肤评估页：PM 规则（问答分/C值/S总分）、IMU 日统计、ML 模型 A/B 全部转发给
imu_train/label_service 的 /api/v1/skin/*（规则只有一份在那边），这边只管两件事的
存储：问卷记录（skin_records）和周报表（skin_weekly_rows）。管理员/超管可用。
"""

import datetime as _dt
import json
import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.sample import Sample
from app.models.skin import SkinRecord, SkinWeeklyRow
from app.models.task import Task
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.services.skin_link_service import SkinLinkError, collect_link_stats, read_stored_link_stats
from app.services.skin_tracking_service import SkinTrackingError, daily_tracking

router = APIRouter(prefix="/skin", tags=["skin"], dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])

_logger = logging.getLogger("smart-label.skin")


async def _algo(method: str, path: str, payload: dict | None = None, timeout: float | None = None):
    url = f"{settings.algo_service_url.rstrip('/')}/api/v1/skin/{path}"
    try:
        async with httpx.AsyncClient(timeout=timeout or settings.algo_infer_timeout_sec) as client:
            resp = await client.get(url) if method == "GET" else await client.post(url, json=payload or {})
    except httpx.RequestError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"无法连接 AI 服务 ({url}): {e}") from e
    if resp.status_code != 200:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"AI 服务返回 {resp.status_code}: {resp.text[:300]}")
    return resp.json()


# ── 标注平台联动：AI 版 / 人工版抓挠日统计 ───────────────────────────────

@router.get("/link/stats")
async def link_stats(
    date_from: _dt.date,
    date_to: _dt.date,
    project_id: int | None = None,
    ai_min_conf: float = 0.0,
    include_drafts: bool = False,
    refresh: bool = False,
    db: AsyncSession = Depends(get_db),
):
    """
    把这段日期里标注平台上的「抓挠」片段按 (日期, IMU) 聚合成日统计 + C 值，AI 版
    （稳定版预标注原始 JSON）和人工版（已提交/已通过任务的当前片段）各一份，前端
    并排对比、选一个灌进 C 值计算。基线按传入日期范围内的其它天算，想要更准的
    基线就把范围拉长。include_drafts=true 时人工版把还没提交/审核的草稿也算进去
    （自己一个人标、不走审核流程时用）。
    """
    if date_to < date_from:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "结束日期不能早于开始日期")
    if (date_to - date_from).days > 92:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "一次最多拉 3 个月")
    if not refresh:
        # 默认读库里存好的：不扫 NAS、不调 AI 服务，打开就有
        stored = await read_stored_link_stats(db, date_from, date_to)
        if stored["rows"]:
            return ok(stored)
    try:
        return ok(
            await collect_link_stats(
                db, date_from, date_to, project_id, ai_min_conf=ai_min_conf, include_drafts=include_drafts
            )
        )
    except SkinLinkError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e
    except Exception as e:  # noqa: BLE001
        # 出了预料之外的错也要让人在界面上看到原因，而不是"暂无数据"一片空白
        _logger.exception("项目联动统计失败 %s~%s project=%s", date_from, date_to, project_id)
        return ok({"rows": [], "warnings": [f"统计失败：{type(e).__name__}: {e}"]})


@router.get("/daily-tracking")
async def get_daily_tracking(
    date_from: _dt.date, date_to: _dt.date, c_prefer: str = "human", db: AsyncSession = Depends(get_db)
):
    """
    每日跟踪表：一行 = (日期, 狗)。C 值取「项目联动」存下来的（人工版优先，没有用 AI 版），
    据此判断要不要做问答；S 总分算两份——问答留空的（下限）和有问答记录时的真实值。
    还带上当天这只狗有几张皮肤照片。
    """
    if date_to < date_from:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "结束日期不能早于开始日期")
    try:
        opts = await _algo("GET", "options")
        imu_map = (opts or {}).get("imu_dog_default_map") or {}
    except HTTPException:
        imu_map = {}
    try:
        return ok(await daily_tracking(db, date_from, date_to, imu_map, c_prefer=c_prefer))
    except SkinTrackingError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e


@router.get("/data-range")
async def data_range(db: AsyncSession = Depends(get_db)):
    """
    标注平台上现在**有任务**的数据覆盖到哪天到哪天。

    每日跟踪表的日期范围默认跟着它走。这两边很容易对不上：跟踪表的行来自
    skin_daily_stats（「项目联动」算完存下来的历史结果），项目删了那些行还在，
    于是会看到一堆早就没有项目的日子。默认框在"现在真的有任务的范围"里，
    看到的就是当下这批数据。
    """
    row = (
        await db.execute(
            select(func.min(Sample.session_date), func.max(Sample.session_date)).join(
                Task, Task.sample_id == Sample.id
            )
        )
    ).one()
    return ok({
        "date_from": row[0].isoformat() if row[0] else None,
        "date_to": row[1].isoformat() if row[1] else None,
    })


# ── 透传：规则/统计/ML ─────────────────────────────────────────────────

@router.get("/options")
async def options():
    return ok(await _algo("GET", "options"))


@router.post("/questionnaire-score")
async def questionnaire_score(body: dict):
    return ok(await _algo("POST", "questionnaire-score", body))


@router.post("/c-score")
async def c_score(body: dict):
    return ok(await _algo("POST", "c-score", body))


@router.post("/s-total")
async def s_total(body: dict):
    return ok(await _algo("POST", "s-total", body))


@router.post("/stats/scan")
async def stats_scan(body: dict):
    return ok(await _algo("POST", "stats/scan", body, timeout=120))


@router.post("/stats/to-c-inputs")
async def stats_to_c_inputs(body: dict):
    return ok(await _algo("POST", "stats/to-c-inputs", body))


@router.post("/ml/scan")
async def ml_scan(body: dict):
    return ok(await _algo("POST", "ml/scan", body, timeout=120))


@router.post("/ml/preview")
async def ml_preview(body: dict):
    return ok(await _algo("POST", "ml/preview", body, timeout=300))


@router.post("/ml/predict-c")
async def ml_predict_c(body: dict):
    return ok(await _algo("POST", "ml/predict-c", body, timeout=300))


@router.post("/ml/predict-s")
async def ml_predict_s(body: dict):
    return ok(await _algo("POST", "ml/predict-s", body, timeout=300))


# ── 问卷记录 ──────────────────────────────────────────────────────────

class SkinRecordIn(BaseModel):
    dog_name: str
    fill_date: _dt.date
    filler: str
    imu: str | None = None
    dog_id: int | None = None
    has_hair_loss: str | None = None
    color: str | None = None
    odor: str | None = None
    lesion: str | None = None
    hair_spot: str | None = None
    hair_diameter: str | None = None
    coat: str | None = None
    q_score: float | None = None
    c_value: float | None = None
    c_tier: str | None = None
    s_total: float | None = None
    s_tier: str | None = None
    c_inputs: dict | None = None
    c_source: str | None = None
    c_value_ai: float | None = None
    c_tier_ai: str | None = None
    c_value_human: float | None = None
    c_tier_human: str | None = None
    confirm_overwrite: bool = False


def _record_out(r: SkinRecord) -> dict:
    return {
        "id": r.id, "dog_name": r.dog_name, "dog_id": r.dog_id, "fill_date": r.fill_date.isoformat(), "filler": r.filler,
        "imu": r.imu, "has_hair_loss": r.has_hair_loss, "color": r.color, "odor": r.odor, "lesion": r.lesion,
        "hair_spot": r.hair_spot, "hair_diameter": r.hair_diameter, "coat": r.coat,
        "q_score": r.q_score, "c_value": r.c_value, "c_tier": r.c_tier, "s_total": r.s_total, "s_tier": r.s_tier,
        "c_inputs": json.loads(r.c_inputs) if r.c_inputs else None,
        "c_source": r.c_source, "c_value_ai": r.c_value_ai, "c_tier_ai": r.c_tier_ai,
        "c_value_human": r.c_value_human, "c_tier_human": r.c_tier_human,
        "created_by": r.created_by, "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }


@router.get("/records")
async def list_records(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(SkinRecord).order_by(SkinRecord.fill_date.desc(), SkinRecord.id.desc()))).scalars().all()
    return ok([_record_out(r) for r in rows])


@router.post("/records")
async def save_record(body: SkinRecordIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """(狗, 日期, 填写人) 已存在时：没勾确认覆盖 → 409 提示；勾了 → 整行覆盖"""
    existing = (await db.execute(select(SkinRecord).where(
        SkinRecord.dog_name == body.dog_name, SkinRecord.fill_date == body.fill_date, SkinRecord.filler == body.filler
    ))).scalar_one_or_none()
    if existing is not None and not body.confirm_overwrite:
        raise HTTPException(status.HTTP_409_CONFLICT, f"已存在完全相同的记录（{body.dog_name}/{body.fill_date}/{body.filler}），勾选「确认覆盖」后再保存")
    row = existing or SkinRecord(created_by=user.id)
    for k, v in body.model_dump(exclude={"confirm_overwrite", "c_inputs"}).items():
        setattr(row, k, v)
    row.c_inputs = json.dumps(body.c_inputs, ensure_ascii=False) if body.c_inputs else None
    if existing is None:
        db.add(row)
    await db.commit()
    await db.refresh(row)
    return ok(_record_out(row), msg="已覆盖旧记录" if existing else "已保存新记录")


@router.delete("/records/{record_id}")
async def delete_record(record_id: int, db: AsyncSession = Depends(get_db)):
    row = await db.get(SkinRecord, record_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "记录不存在")
    await db.delete(row)
    await db.commit()
    return ok(None, msg="已删除")


# ── 周报表 ────────────────────────────────────────────────────────────

class WeeklyRowIn(BaseModel):
    imu: str
    report_date: str
    dog_name: str | None = None
    data: dict


class WeeklyAutofillIn(BaseModel):
    imu: str
    dog_name: str | None = None
    stats_rows: list[dict]
    date_labels: list[str]


def _weekly_out(r: SkinWeeklyRow) -> dict:
    return {"id": r.id, "imu": r.imu, "dog_name": r.dog_name, "report_date": r.report_date, "data": json.loads(r.data),
            "updated_at": r.updated_at.isoformat() if r.updated_at else None}


async def _columns() -> list[str]:
    return (await _algo("GET", "options"))["weekly_report_columns"]


def _to_list(cols: list[str], data: dict) -> list:
    return [data.get(c, "") if data.get(c) is not None else "" for c in cols]


def _to_dict(cols: list[str], row: list) -> dict:
    return {c: ("" if v is None else v) for c, v in zip(cols, list(row) + [""] * (len(cols) - len(row)))}


@router.get("/weekly")
async def list_weekly(imu: str | None = None, db: AsyncSession = Depends(get_db)):
    q = select(SkinWeeklyRow)
    if imu:
        q = q.where(SkinWeeklyRow.imu == imu)
    rows = (await db.execute(q.order_by(SkinWeeklyRow.imu, SkinWeeklyRow.report_date))).scalars().all()
    return ok([_weekly_out(r) for r in rows])


@router.post("/weekly/defaults")
async def weekly_defaults(body: WeeklyRowIn):
    """把某天的行按审核链条垫上默认值（不存盘，给表单加载用）"""
    cols = await _columns()
    res = await _algo("POST", "weekly/defaults", {"rows": [_to_list(cols, body.data)]})
    return ok(_to_dict(cols, res["rows"][0]))


@router.post("/weekly")
async def upsert_weekly(body: WeeklyRowIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """保存某 IMU 某天的一行：先让 AI 服务按 PM 规则重算对比/误差列，再按 (imu, date) 覆盖存"""
    cols = await _columns()
    data = dict(body.data)
    data[cols[0]] = body.report_date
    res = await _algo("POST", "weekly/recompute", {"rows": [_to_list(cols, data)]})
    data = _to_dict(cols, res["rows"][0])
    row = (await db.execute(select(SkinWeeklyRow).where(SkinWeeklyRow.imu == body.imu, SkinWeeklyRow.report_date == body.report_date))).scalar_one_or_none()
    created = row is None
    if created:
        row = SkinWeeklyRow(imu=body.imu, report_date=body.report_date, created_by=user.id, data="{}")
        db.add(row)
    row.dog_name = body.dog_name or row.dog_name
    row.data = json.dumps(data, ensure_ascii=False)
    await db.commit()
    await db.refresh(row)
    return ok(_weekly_out(row), msg=f"已{'新增' if created else '更新'} {body.imu} {body.report_date}")


@router.delete("/weekly/{row_id}")
async def delete_weekly(row_id: int, db: AsyncSession = Depends(get_db)):
    row = await db.get(SkinWeeklyRow, row_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "记录不存在")
    await db.delete(row)
    await db.commit()
    return ok(None, msg="已删除")


@router.post("/weekly/autofill")
async def weekly_autofill(body: WeeklyAutofillIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """批量自动填「模型-」列：对选中的日期，从日统计行算 C 值（AI 服务 /skin/c-score），
    写 今日佩戴时长/模型-抓挠次数/总时长/C级评级 四列，其它列保留。"""
    cols = await _columns()
    filled, skipped = 0, []
    for date_label in sorted(body.date_labels):
        m = next((r for r in body.stats_rows if r.get("date_label") == date_label and r.get("imu") == body.imu), None)
        if not m:
            skipped.append(date_label)
            continue
        ci = await _algo("POST", "stats/to-c-inputs", m)
        c = await _algo("POST", "c-score", {k: ci[k] for k in ("baseline_count", "baseline_duration_min", "today_count", "today_duration_min",
                                                                "cluster_count", "persistence_days", "zn", "zd", "long_scratch", "has_baseline")})
        row = (await db.execute(select(SkinWeeklyRow).where(SkinWeeklyRow.imu == body.imu, SkinWeeklyRow.report_date == m["date"]))).scalar_one_or_none()
        data = json.loads(row.data) if row else {col: "" for col in cols}
        data[cols[0]] = m["date"]
        data["今日佩戴时长"] = f"{m.get('valid_wear_hours')}小时"
        data["模型-抓挠次数"] = m.get("event_count")
        data["模型-抓挠总时长(分钟)"] = m.get("total_duration_min")
        data["模型-C级评级"] = c["tier"]
        res = await _algo("POST", "weekly/recompute", {"rows": [_to_list(cols, data)]})
        data = _to_dict(cols, res["rows"][0])
        if row is None:
            row = SkinWeeklyRow(imu=body.imu, report_date=m["date"], created_by=user.id, data="{}")
            db.add(row)
        row.dog_name = body.dog_name or row.dog_name
        row.data = json.dumps(data, ensure_ascii=False)
        filled += 1
    await db.commit()
    msg = f"已自动填好 {filled} 天的「模型-」列（{body.imu}，{body.dog_name or '未选狗狗'}）" + (f"；没找到数据、跳过：{'、'.join(skipped)}" if skipped else "")
    return ok({"filled": filled, "skipped": skipped}, msg=msg)


@router.post("/weekly/recompute-all")
async def weekly_recompute_all(imu: str | None = None, db: AsyncSession = Depends(get_db)):
    cols = await _columns()
    q = select(SkinWeeklyRow)
    if imu:
        q = q.where(SkinWeeklyRow.imu == imu)
    rows = (await db.execute(q)).scalars().all()
    if rows:
        res = await _algo("POST", "weekly/recompute", {"rows": [_to_list(cols, json.loads(r.data)) for r in rows]})
        for r, new in zip(rows, res["rows"]):
            r.data = json.dumps(_to_dict(cols, new), ensure_ascii=False)
        await db.commit()
    return ok({"count": len(rows)}, msg=f"已重新计算 {len(rows)} 行的对比/误差列")
