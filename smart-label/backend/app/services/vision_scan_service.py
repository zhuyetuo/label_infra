"""
扫样本的视频：画面里有没有狗，存下来给列表用。

要解决的是一件很具体的事：标注员打开一份样本，标到一半才发现这半小时狗根本
不在画面里（跑开了、被抱走了、摄像头对着空笼子）。这时候 IMU 波形是平的，
但"平"也可能是狗趴着不动——分不出来，只能人点开视频看。

扫完存下来，列表上直接写「这段没狗」，点都不用点。

── 一条贯穿全文件的规矩 ────────────────────────────────────────────────

**「没扫成」绝不能表现成「确认没狗」。**

这两个的后果是相反的：前者要人去查为什么没扫成，后者让人放心跳过这一段。
混了的话，一次服务没起就会让一整天的素材被静默跳过，而且没有任何报错。

所以：扫失败写 state=failed 且 no_dog_ratio 留空；扫了但一帧都没采到写
verdict=unknown 且 no_dog_ratio 也留空。任何"看起来像 0% 有狗"的数字都不许
在没真扫成的时候出现。
"""

import asyncio
import json
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.sample import Sample
from app.models.sample_vision_scan import STATE_FAILED, STATE_OK, SampleVisionScan
from app.services import vision_sam_client as vc

_logger = logging.getLogger("smart-label.vision-scan")

#: 一份样本最多几路。cam2/cam3 可以为空（狗场一间一狗一摄像头，早期还有单路的）
CAMS = ("cam1", "cam2", "cam3")


def video_paths(sample: Sample) -> list[tuple[str, str]]:
    """这份样本有哪几路视频 → [(cam, rel_path), ...]，空的跳过。"""
    out = []
    for cam, path in (("cam1", sample.video_cam1_path),
                      ("cam2", sample.video_cam2_path),
                      ("cam3", sample.video_cam3_path)):
        if (path or "").strip():
            out.append((cam, path.strip()))
    return out


def compact_timeline(frames: list[dict]) -> str:
    """逐采样点的 [[秒, 几只], ...]。不存框——见 model 里的说明。"""
    return json.dumps([[f.get("t"), f.get("n_dogs", 0)] for f in frames], separators=(",", ":"))


def load_timeline(raw: str | None) -> list[list[float]]:
    if not raw:
        return []
    try:
        val = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return val if isinstance(val, list) else []


def scan_to_row(sample_id: int, cam: str, result: dict, weights: str | None) -> dict:
    """vision_service 的返回 → 这张表的一行。"""
    frames = result.get("frames") or []
    ratio = result.get("no_dog_ratio")
    return {
        "sample_id": sample_id,
        "cam": cam,
        "state": STATE_OK,
        "error": None,
        "verdict": result.get("verdict"),
        # 服务那边一帧都没采到时就返回 None，这里原样透传，**不要补 0 或 1**
        "no_dog_ratio": float(ratio) if ratio is not None else None,
        "max_dogs": result.get("max_dogs"),
        "sampled": result.get("sampled"),
        "frames_with_dog": result.get("frames_with_dog"),
        "duration_sec": result.get("duration_sec"),
        "timeline": compact_timeline(frames),
        "every_sec": result.get("every_sec"),
        "conf": result.get("conf"),
        "weights": weights,
    }


def failed_row(sample_id: int, cam: str, reason: str) -> dict:
    """扫不成的一行。所有结论性字段一律留空——留空的意思是"不知道"，
    而填个数会被读成"知道，答案是这个"。"""
    return {
        "sample_id": sample_id, "cam": cam, "state": STATE_FAILED, "error": reason[:500],
        "verdict": None, "no_dog_ratio": None, "max_dogs": None, "sampled": None,
        "frames_with_dog": None, "duration_sec": None, "timeline": None,
        "every_sec": None, "conf": None, "weights": None,
    }


async def _upsert(db: AsyncSession, row: dict) -> None:
    """一份样本的一路只留最新一次。重扫就覆盖，不堆历史——堆着的话列表要
    每次挑最新的一条，而"最新"在并发重扫时并不好定义。"""
    existing = (
        await db.execute(
            select(SampleVisionScan).where(
                SampleVisionScan.sample_id == row["sample_id"],
                SampleVisionScan.cam == row["cam"],
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        db.add(SampleVisionScan(**row))
        return
    for k, v in row.items():
        setattr(existing, k, v)


async def scan_sample(db: AsyncSession, sample: Sample, every_sec: float = 5.0,
                      conf: float = 0.35) -> dict:
    """扫一份样本的全部视频路。每一路单独成败，一路挂了不影响别的路。"""
    weights = None
    try:
        st = await vc.dog_status()
        weights = st.get("loaded_weights") or st.get("weights")
    except Exception:  # noqa: BLE001 拿不到型号不影响扫描本身
        pass

    done, failed = 0, 0
    for cam, path in video_paths(sample):
        try:
            r = await vc.scan_dog(path, every_sec=every_sec, conf=conf)
            await _upsert(db, scan_to_row(sample.id, cam, r, weights))
            done += 1
        except Exception as e:  # noqa: BLE001 一路挂了不该带倒别的路
            _logger.warning("扫 %s %s 失败：%s", sample.sample_code, cam, e)
            await _upsert(db, failed_row(sample.id, cam, f"{type(e).__name__}: {e}"))
            failed += 1
    await db.commit()
    return {"sample_id": sample.id, "sample_code": sample.sample_code,
            "scanned": done, "failed": failed}


async def scan_many(db: AsyncSession, sample_ids: list[int], every_sec: float = 5.0,
                    conf: float = 0.35) -> dict:
    """批量扫。**串行**，不是并发：

    扫描吃的是同一张 GPU，而那张卡上还挂着 SAM。几十个并发请求打过去，显存
    峰值叠加会把两个模型一起 OOM——而 SAM OOM 了标注员那边按钮就灰了，
    等于为了扫得快一点，把正在干活的人挡在外面。
    """
    samples = (await db.execute(select(Sample).where(Sample.id.in_(sample_ids)))).scalars().all()
    out = []
    for s in samples:
        out.append(await scan_sample(db, s, every_sec=every_sec, conf=conf))
        # 让出事件循环：串行跑几十份样本要几分钟，中间不让出的话同一个 worker
        # 上别的请求全被卡住
        await asyncio.sleep(0)
    return {"samples": len(out), "items": out}


# ── 读回去给列表用 ──────────────────────────────────────────────────────

def row_to_dict(row: SampleVisionScan) -> dict:
    return {
        "cam": row.cam,
        "state": row.state,
        "error": row.error,
        "verdict": row.verdict,
        "no_dog_ratio": float(row.no_dog_ratio) if row.no_dog_ratio is not None else None,
        "max_dogs": row.max_dogs,
        "sampled": row.sampled,
        "duration_sec": float(row.duration_sec) if row.duration_sec is not None else None,
        "weights": row.weights,
        "scanned_at": row.scanned_at.isoformat() if row.scanned_at else None,
    }


def sample_verdict(rows: list[dict]) -> str:
    """一份样本的多路 → 一个能放进列表的结论。

    **只要有任何一路看见了狗，这份样本就是 has_dog。** 影棚三路拍的是同一个
    空间的不同角度，cam1 空着不代表狗不在场——按"全都没狗"才算没狗，漏判的
    方向是安全的（人多看一段），反过来会让人跳过真有素材的样本。

    一路都没扫成 → unknown。**不是** no_dog。
    """
    if not rows:
        return "unscanned"
    ok = [r for r in rows if r.get("state") == STATE_OK and r.get("verdict")]
    if not ok:
        return "unknown"
    verdicts = {r["verdict"] for r in ok}
    if "has_dog" in verdicts:
        return "has_dog"
    if "mostly_empty" in verdicts:
        return "mostly_empty"
    if verdicts == {"unknown"}:
        return "unknown"
    # 剩下只可能是 no_dog（可能混着 unknown）。有 unknown 混在里面时不能说
    # "确认没狗"——那一路根本没看成
    return "no_dog" if verdicts == {"no_dog"} else "unknown"
