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
import time
from collections import defaultdict
from datetime import date

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import permissions as perms
from app.core.config import settings
from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource
from app.models.ai_candidate import AiCandidate, CandidateStatus
from app.models.dog import Dog
from app.models.label import LabelDefinition
from app.services import label_tree
from app.models.sample import Sample
from app.models.skin import SkinRecord
from app.models.skin_daily import SkinDailyStat
from app.models.skin_photo_rating import SkinPhotoRating
from app.models.task import Task
from app.models.user import User
from app.services import site_layout
from app.services.dog_name_service import DogIndex, dog_meta, dog_profiles, imu_keys_of_dog

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


def _consensus(ratings: list[dict]) -> str | None:
    """几个人的照片评级合成一个：「看不清」不算；都一样就是它，不一样取最重的（宁可多关注）"""
    gs = sorted({r["grade"] for r in ratings if r["grade"] in ("S0", "S1", "S2")})
    return gs[-1] if gs else None


_photo_cache: tuple[float, list] | None = None


def _photo_index() -> list[tuple[str, str, int, str]]:
    """带 60 秒缓存：每点一次「刷新」都把 NAS 上整棵照片树走一遍太重"""
    global _photo_cache
    if _photo_cache is not None and time.monotonic() - _photo_cache[0] < 60:
        return _photo_cache[1]
    out = _scan_photos()
    _photo_cache = (time.monotonic(), out)
    return out


def _scan_photos() -> list[tuple[str, str, int, str]]:
    """[(日期, 目录里的狗名, 张数, 日期目录)]。跟「皮肤照片」标签页同一份扫描（tooth_service.list_photos），
    主目录（视频问诊）和狗场那几棵树（博朗旺 / 雷喏斯达…）都算——原来只扫主目录，狗场的照片在跟踪表上对不上。
    日期目录要带上：照片评级是按 (日期目录, 狗目录) 记的"""
    from app.services import tooth_service

    try:
        folders = tooth_service.list_photos("skin")
    except Exception:  # noqa: BLE001 —— NAS 没挂上就当没照片，别把整张表带崩
        return []
    out: list[tuple[str, str, int, str]] = []
    for f in folders:
        day = f.get("date") or (f.get("folder") or "")[:10]
        for d in f.get("dogs") or []:
            n = len(d.get("photos") or [])
            if n:
                out.append((day, d["name"], n, f["folder"]))
    return out


_by_day_cache: tuple[int, dict] | None = None


def _by_day(index: list[tuple[str, str, int, str]]) -> dict[str, list[tuple[str, str, int, str]]]:
    """照片目录按日期分组；同一份 index（60 秒缓存）只分一次"""
    global _by_day_cache
    if _by_day_cache is None or _by_day_cache[0] != id(index):
        g: dict[str, list] = {}
        for row in index:
            g.setdefault(row[0], []).append(row)
        _by_day_cache = (id(index), g)
    return _by_day_cache[1]


def _match_photos(
    index: list[tuple[str, str, int, str]], day: str, dog: str, extra: set[str] | None = None
) -> tuple[int, str | None, list[tuple[str, str]]]:
    """返回 (张数, NAS 上实际的狗目录名, 对上的 [(日期目录, 狗目录)])。目录名跟 PM 狗名对不上是常态，做宽松匹配。"""
    aliases = _norm_dog(dog, extra)
    total, matched = 0, None
    pairs: list[tuple[str, str]] = []
    # 只看这一天的：原来每一行都把全部照片目录（几个月、几千条）扫一遍，几百行就是上百万次比较，
    # 而且是在事件循环里同步做的——这期间整个后端谁的请求都处理不了
    for d, folder_dog, n, folder in _by_day(index).get(day, ()):
        fd = folder_dog.strip()
        fdl = fd.lower()
        # 狗场目录是「002拉布拉多小七」这种：编号 + 品种 + 名字，按包含关系认
        hit = fd in aliases or fdl in aliases or any(a in fdl or fdl in a.lower() for a in aliases if len(a) >= 2)
        if hit:
            total += n
            matched = matched or fd
            pairs.append((folder, folder_dog))
    return total, matched, pairs


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
    # 照片评级：按 (日期目录, 狗目录) 分好
    ratings_by_pair: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r, dn, un, role, pm in (await db.execute(
        select(SkinPhotoRating, User.display_name, User.username, User.role, User.permissions)
        .join(User, User.id == SkinPhotoRating.user_id)
        .where(SkinPhotoRating.album == "skin")
    )).all():
        ratings_by_pair[(r.folder, r.dog_folder)].append({
            "user_id": r.user_id, "user_name": dn or un, "user_role": getattr(role, "value", str(role)),
            "grade": r.grade, "note": r.note, "is_vet": perms.is_vet(pm),
        })
    # 狗档案是这几套叫法（PM 的「比熊-BB」、NAS 目录的「bibi」、设备号 IMU1）
    # 唯一能对上的地方。一只狗配两个 IMU 轮换充电，两个都要挂上同一套别名，
    # 否则换了设备的那几天照片就对不上了
    #
    # 同一批项圈会在几个狗场轮着用：同一个 IMU 号在不同狗场是不同的狗。所以狗名和别名
    # 都按 (场地, IMU) 记，场地从当天样本的路径里认（下面 site_by_key）。原来只按 IMU
    # 记，新狗场一建档，老狗场的历史行全显示成新狗的名字，照片也对到新狗的别名上
    dog_rows = (await db.execute(select(Dog))).scalars().all()
    dog_idx = DogIndex([(d.dog_code, d.name, d.imu, d.site) for d in dog_rows])
    alias_by_key: dict[tuple[str | None, str], set[str]] = defaultdict(set)
    for d in dog_rows:
        imu_keys = imu_keys_of_dog(d.imu, d.dog_code)
        if not imu_keys:
            continue
        names = {v.strip() for v in [d.name, d.breed, *(d.aliases or "").replace("，", ",").split(",")] if (v or "").strip()}
        site = site_layout.site_key_of_name(d.site)
        for imu_key in imu_keys:
            alias_by_key[(site, imu_key)] |= names

    # 这一天这只狗底下有哪几个任务：跟踪表里点「查看标注」要跳过去复看，
    # 顺带带上每个任务里「抓挠」片段有几段，好挑哪一段去看
    task_rows = (
        await db.execute(
            select(Task.id, Task.status, Sample.sample_code, Sample.session_date, Sample.video_duration_sec,
                   Sample.video_cam1_path, Sample.imu_csv_path, Task.scratch_checked_by, Task.scratch_checked_at)
            .join(Sample, Sample.id == Task.sample_id)
            .where(Sample.session_date >= date_from, Sample.session_date <= date_to)
            .order_by(Sample.sample_code)
        )
    ).all()
    # 「抓挠」加上它的全部子标签（抓挠-头颈耳……）：标了细的也算抓挠
    scratch_label_ids = await label_tree.expand_ids(db, set(
        (
            await db.execute(
                select(LabelDefinition.id).where(
                    (LabelDefinition.display_name == "抓挠") | (LabelDefinition.code == "抓挠")
                )
            )
        ).scalars().all()
    ))
    # 每个任务的人工复看结果：AI 标的抓挠里，确认了几段、判成待定几段（三种原因
    # 分开数）、还有几段本来是 AI 标的抓挠、被人改成别的类别（比如其实是甩身体）。
    # 光看「9 段」不知道人看过没有、看完是什么结论，这几个数就是给这个的。
    #
    # 待定必须分原因，因为三种的后续动作完全不同：没画面的除非补拍否则永远定不了，
    # 不用再看；看不清的换个人/换个视角也许能定；要细切的是已经确定是抓挠、只是
    # 起止要调，纯粹是排期问题。混成一个「待定 3」的话，人还得逐条点进去才知道
    # 哪些值得回头再看。
    seg_counts: dict[int, int] = {}
    review_counts: dict[int, dict] = defaultdict(
        lambda: {
            "confirmed": 0,
            "uncertain_no_view": 0,
            "uncertain_ambiguous": 0,
            "uncertain_needs_split": 0,
            "relabeled": 0,
            # AI 标的抓挠里还没人碰过的（没确认、没判待定）。0 且有抓挠 = 这一段的抓挠都看过了
            "scratch_unreviewed": 0,
        }
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
                AnnotationLabelItem.seg_status,
                AnnotationLabelItem.review_note,
            )
            .join(AnnotationLabelItem, AnnotationLabelItem.annotation_record_id == AnnotationRecord.id)
            .join(Task, Task.id == AnnotationRecord.task_id)
            .where(
                AnnotationRecord.task_id.in_(task_ids_all),
                AnnotationRecord.round_no == Task.round_no,
            )
        )
        for tid, label_id, source, modified, confirmed, uncertain, reason, seg_status, review_note in rows_c.all():
            # 跟项目页的片段审核同步：审核通过的、人改过的，都算人看过（原来只认「AI 确认」，
            # 项目页显示抓挠全部通过，这边还写着「未复看」）
            confirmed = bool(confirmed or modified or (seg_status == "approved" and review_note is None))
            is_scratch = label_id in scratch_label_ids
            is_ai = source == LabelItemSource.ai_generated
            if is_scratch:
                seg_counts[tid] = seg_counts.get(tid, 0) + 1
                if uncertain:
                    # 老数据里没有 needs_split，reason 认不出来的一律算「看不清」
                    key = {
                        "no_view": "uncertain_no_view",
                        "needs_split": "uncertain_needs_split",
                    }.get(reason or "", "uncertain_ambiguous")
                    review_counts[tid][key] += 1
                elif confirmed:
                    review_counts[tid]["confirmed"] += 1
                elif is_ai:
                    review_counts[tid]["scratch_unreviewed"] += 1
            elif is_ai and modified:
                # AI 给的、被人改过、现在不是抓挠了——「甩身体误判成抓挠」这类。
                # 严格说也可能是别的类别之间互改，但复看时人只动抓挠这一类，够用
                review_counts[tid]["relabeled"] += 1

    # 「疑似抓挠」候选的处理进度：还剩几条没看、确认成抓挠几条、改成别的类别
    # 几条（那是人纠正过的误报）、排除几条。复看漏检主要看这几个数
    cand_counts: dict[int, dict] = defaultdict(
        lambda: {
            "cand_pending": 0,
            "cand_confirmed": 0,
            "cand_relabeled": 0,
            "cand_rejected": 0,
            "cand_uncertain": 0,
            # 跟片段那边一样按原因拆开，理由见上面
            "cand_uncertain_no_view": 0,
            "cand_uncertain_ambiguous": 0,
            "cand_uncertain_needs_split": 0,
        }
    )
    if task_rows:
        rows_cand = await db.execute(
            select(
                AiCandidate.task_id,
                AiCandidate.status,
                AiCandidate.decided_label_id,
                AiCandidate.uncertain_reason,
            )
            .join(Task, Task.id == AiCandidate.task_id)
            .where(AiCandidate.task_id.in_([t[0] for t in task_rows]), AiCandidate.round_no == Task.round_no)
        )
        for tid, st, decided_label, cand_reason in rows_cand.all():
            if st == CandidateStatus.pending:
                cand_counts[tid]["cand_pending"] += 1
            elif st == CandidateStatus.rejected:
                cand_counts[tid]["cand_rejected"] += 1
            elif st == CandidateStatus.uncertain:
                cand_counts[tid]["cand_uncertain"] += 1
                cand_counts[tid][
                    {
                        "no_view": "cand_uncertain_no_view",
                        "needs_split": "cand_uncertain_needs_split",
                    }.get(cand_reason or "", "cand_uncertain_ambiguous")
                ] += 1
            elif decided_label is not None and decided_label not in scratch_label_ids:
                cand_counts[tid]["cand_relabeled"] += 1
            else:
                cand_counts[tid]["cand_confirmed"] += 1

    tasks_by_key: dict[tuple[str, str], list[dict]] = defaultdict(list)
    # (日期, IMU) 是哪个狗场的：同一天同一个 IMU 号只会在一个狗场（项圈是同一批，搬过去了）
    site_by_key: dict[tuple[str, str], str] = {}
    checker_ids = {r[7] for r in task_rows if r[7]}
    checker_names = {uid: dn or un for uid, dn, un in (await db.execute(
        select(User.id, User.display_name, User.username).where(User.id.in_(checker_ids))
    )).all()} if checker_ids else {}
    for tid, status, code, sdate, dur, cam1, csv, chk_by, chk_at in task_rows:
        imu = _imu_of(code)
        if imu is None or sdate is None:
            continue
        site = site_layout.site_of(code, cam1, csv)
        if site:
            site_by_key.setdefault((sdate.isoformat(), imu), site)
        tasks_by_key[(sdate.isoformat(), imu)].append(
            {
                "task_id": tid,
                "sample_code": code,
                "status": status.value if hasattr(status, "value") else str(status),
                "scratch_segments": seg_counts.get(tid, 0),
                **review_counts[tid],
                **cand_counts[tid],
                # 前端要拿它把「09:00:14 ~ ?」补成「09:00:14 ~ 10:00:00」
                "video_duration_sec": dur,
                # 谁、什么时候点的「抓挠确认无误 / 整份通过」（存在任务上，所有管理员都看得到）
                "scratch_checked_by": checker_names.get(chk_by) if chk_by else None,
                "scratch_checked_at": chk_at.isoformat() if chk_at else None,
            }
        )
    imu_dog_map = imu_dog_map or {}

    # 先把 (日期, IMU) 的两份 C 值合到一起
    merged: dict[tuple[str, str], dict] = defaultdict(lambda: {"ai": None, "human": None, "stats": {}, "devices": None})
    for s in stats:
        key = (s.stat_date.isoformat(), s.imu)
        merged[key][s.source] = {
            "c_value": s.c_value,
            "c_tier": s.c_tier,
            # 算 C 用的那几个输入 + 各项得分，跟踪表 tooltip 要拿来讲"怎么来的"
            "c_inputs": _loads(s.c_inputs),
            "c_detail": _loads(s.c_detail),
            # ML 版预测（模型 A 的 C 档、模型 B 的 S 档），跟这份 C 值同一个来源的事件算的
            "ml": _loads(s.ml),
        }
        if s.devices and not merged[key]["devices"]:
            merged[key]["devices"] = _loads(s.devices)
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

    profiles = await dog_profiles(db)
    rows: list[dict] = []
    jobs: list[tuple[dict, str, object]] = []
    for key in sorted(merged):
        day, imu = key
        m = merged[key]
        # 一只狗两个项圈合成的一行：imu 是「IMU1+IMU2」，场地 / 狗名 / 别名 / 任务都按里面每个设备找
        parts = imu.split("+")
        site = next((site_by_key[(day, p)] for p in parts if (day, p) in site_by_key), None)
        dog = dog_idx.name(parts[0], site) or imu_dog_map.get(parts[0]) or imu
        rec = rec_by_key.get((day, dog))
        aliases = set().union(*[alias_by_key.get((site, p), set()) for p in parts]) or None if site else None
        if aliases is None:     # 认不出场地：这个 IMU 在各狗场的别名都算上（老行为）
            aliases = set().union(*[v for (s, k), v in alias_by_key.items() if k in parts]) or None
        photo_n, photo_dog, photo_pairs = _match_photos(photo_index, day, dog, aliases)
        # 兽医 / 实习生看这天照片给的评级（皮肤照片标签页），跟 C / S 放一行对照
        p_ratings = [r for pair in photo_pairs for r in ratings_by_pair.get(pair, [])]
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
            # 场地 / 几号单间 / 品种：光一个狗名分不清是哪只，也要能按它们筛
            **dog_meta(profiles, site, parts[0], dog),
            # 每个设备戴了多久、哪几段（两个项圈合成一行时才有）
            "devices": m["devices"],
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
            "ml": (primary or {}).get("ml"),
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
            "tasks_detail": [t for p in parts for t in tasks_by_key.get((day, p), [])],
            "photo_count": photo_n,
            # NAS 上实际的目录名，前端弹窗按它去筛图（可能跟 PM 的狗名不一样）
            "photo_dog": photo_dog,
            "photo_folder": photo_pairs[0][0] if photo_pairs else None,
            "photo_ratings": p_ratings,
            "photo_grade": _consensus(p_ratings),
            # 只看兽医的评级（准确率对照、重训模型 B 都以它为准）
            "photo_grade_vet": _consensus([x for x in p_ratings if x["is_vet"]]),
            "s_no_q": None,
            "s_with_q": None,
        }
        rows.append(row)
        if c_value is not None:
            jobs.append((row, "s_no_q", None))
            if rec is not None:
                jobs.append((row, "s_with_q", {k: getattr(rec, k) for k in _ANSWER_FIELDS}))

    sem = asyncio.Semaphore(4)

    async def _run(row: dict, field: str, answers: dict | None) -> None:
        async with sem:
            row[field] = await _s_total(row["c_value"], row["c_tier"], answers)

    if jobs:
        # 整批一个请求（AI 服务的 s-batch）；以前每行一两次 HTTP，几百行就是几百个请求挤在
        # 单进程的 AI 服务上，点一次「刷新」别的页面跟着超时。AI 服务是老版本没这个接口时退回逐行
        try:
            payloads = []
            for r, _f, a in jobs:
                p = {"c_value": r["c_value"], "c_tier_hint": r["c_tier"]}
                p.update({k: (a or {}).get(k) for k in _ANSWER_FIELDS})
                payloads.append(p)
            for i in range(0, len(jobs), 500):
                res = await _algo_post("s-batch", {"rows": payloads[i:i + 500]})
                for (r, f, _a), x in zip(jobs[i:i + 500], res):
                    r[f] = x
        except SkinTrackingError as e:
            if " 404" in str(e) or " 405" in str(e):
                await asyncio.gather(*(_run(r, f, a) for r, f, a in jobs))
        if all(r["s_no_q"] is None for r in rows if r["c_value"] is not None):
            warnings.append("S 总分没算出来，检查 AI 服务是否正常")

    return {"rows": rows, "warnings": warnings, "trigger_tiers": sorted(trigger_tiers)}
