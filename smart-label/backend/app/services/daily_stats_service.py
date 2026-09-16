"""日常统计：每只狗每天各类行为多久、多少次。

跟皮肤评估是**两个问题**，所以是两个页面：
  皮肤评估   抓挠 → C值 → 问答 → S总分，回答"皮肤有没有风险"
  日常统计   活动/睡觉/未佩戴/甩身体/抓挠，回答"这只狗今天过得怎么样"

数据来自 `sample_inference_runs`——平台自己跑的推理结果索引。
**不是** algo_service 那张 pet_dog_daily_summary：那是线上项圈那条线的产物，
数据源（TDengine 25Hz）、模型、后处理都不一样，而且它现在的模型只有 3 类，
根本没有未佩戴和甩身体。两个数字放一起说会很难解释，所以这里只管平台这一份，
并且把模型版本明确标出来。

## 为什么必须按 (模型, 版本) 分组

一天里的样本可能是不同版本跑的（换了模型、或者同时跑了 edge 和线上做对比）。
混着加起来会得到一个悄悄把两个版本平均掉的数字——**而它看起来完全正常**。
所以聚合的键里带上 model_tag 和 mode，前端按版本切换，不做跨版本合并。
"""

from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dog import Dog
from app.models.inference_run import SampleInferenceRun
from app.models.sample import Sample
from app.services.dog_name_service import imu_keys_of_dog
from app.services.skin_tracking_service import _imu_of

_logger = logging.getLogger("smart-label.daily_stats")

# 展示顺序。**写死顺序而不是按字典序**：按字典序的话每换一个模型
# 列的顺序就变，两天的表放一起看不出哪列是哪列
LABEL_ORDER = ["活动", "睡觉", "抓挠", "未佩戴", "甩身体"]


def _loads(v) -> dict:
    if not v:
        return {}
    try:
        d = json.loads(v)
        return d if isinstance(d, dict) else {}
    except ValueError:
        return {}


async def versions(db: AsyncSession) -> list[dict]:
    """有哪些 (模型, 版本) 跑过，各覆盖多少天/多少样本——给前端的下拉。

    列出来而不是写死：换了模型之后界面上要能看到新的那个，
    而写死的话人会以为新模型没跑。
    """
    rows = (await db.execute(
        select(SampleInferenceRun.model_tag, SampleInferenceRun.mode,
               SampleInferenceRun.sample_id)
    )).all()
    agg: dict[tuple[str, str], set] = defaultdict(set)
    for tag, mode, sid in rows:
        agg[(tag, mode)].add(sid)
    out = [{"model_tag": t, "mode": m, "n_samples": len(v)}
           for (t, m), v in agg.items()]
    out.sort(key=lambda x: (-x["n_samples"], x["model_tag"], x["mode"]))
    return out


async def _imu_to_dog(db: AsyncSession) -> dict[str, str]:
    """IMU 编号 → 狗名。

    **跟皮肤评估用同一套映射**（imu_keys_of_dog）。各写各的话，同一个样本
    在两个页面上会被判给不同的狗——而两边看起来都对。
    """
    rows = (await db.execute(select(Dog.dog_code, Dog.name, Dog.imu))).all()
    out: dict[str, str] = {}
    for code, name, imu in rows:
        for key in imu_keys_of_dog(imu, code):
            out[key] = name or code or key
    return out


async def daily(db: AsyncSession, date_from: date, date_to: date,
                model_tag: str, mode: str,
                dog_ids: list[int] | None = None) -> list[dict]:
    """按 (日期, 狗) 汇总各类行为的时长和次数。

    一天一只狗可能有好几个样本（分段采集），这里是**求和**。

    狗是从 sample_code 里解析出 IMU 编号再映射的，**不是用 Sample.dog_id**
    ——那一列在实际数据里基本是空的，按它分组会把所有狗collapse 成一行。
    """
    imu_map = await _imu_to_dog(db)
    q = (
        select(SampleInferenceRun, Sample)
        .join(Sample, Sample.id == SampleInferenceRun.sample_id)
        .where(
            SampleInferenceRun.model_tag == model_tag,
            SampleInferenceRun.mode == mode,
            Sample.session_date.is_not(None),
            Sample.session_date >= date_from,
            Sample.session_date <= date_to,
        )
    )
    buckets: dict[tuple, dict] = {}
    for run, sample in (await db.execute(q)).all():
        imu = _imu_of(sample.sample_code) or "未知设备"
        key = (sample.session_date, imu)
        b = buckets.get(key)
        if b is None:
            b = buckets[key] = {
                "stat_date": sample.session_date.isoformat(),
                "imu": imu,
                "dog_name": imu_map.get(imu),
                "n_samples": 0,
                "n_windows": 0,
                "missing_seconds": 0.0,
                "seconds": defaultdict(float),
                "counts": defaultdict(int),
                # 有没有时长数据。老的行没有 label_seconds（那一列是后加的，
                # 历史不回填），要跟"跑了但确实是 0 秒"分开——前者是
                # "不知道"，后者是"知道，是 0"
                "has_seconds": False,
            }
        b["n_samples"] += 1
        b["n_windows"] += int(run.n_windows or 0)
        b["missing_seconds"] += float(run.missing_seconds or 0.0)
        secs = _loads(run.label_seconds)
        if secs:
            b["has_seconds"] = True
            for k, v in secs.items():
                b["seconds"][k] += float(v or 0.0)
        for k, v in _loads(run.label_counts).items():
            b["counts"][k] += int(v or 0)

    out = []
    for b in buckets.values():
        # 这一天出现过的类别 = 模型的类别。按固定顺序排，没出现的补 0——
        # 缺列的话两天的表对不齐，而"没出现"和"是 0"在行为统计里是一回事
        seen = [x for x in LABEL_ORDER if x in b["seconds"] or x in b["counts"]]
        extra = sorted(set(b["seconds"]) | set(b["counts"]) - set(LABEL_ORDER))
        labels = seen + [x for x in extra if x not in seen]
        out.append({
            "stat_date": b["stat_date"],
            "imu": b["imu"],
            "dog_name": b["dog_name"],
            "n_samples": b["n_samples"],
            "n_windows": b["n_windows"],
            "missing_seconds": round(b["missing_seconds"], 1),
            "has_seconds": b["has_seconds"],
            "labels": labels,
            "seconds": {k: round(b["seconds"].get(k, 0.0), 1) for k in labels},
            "counts": {k: int(b["counts"].get(k, 0)) for k in labels},
        })
    out.sort(key=lambda r: (r["stat_date"], r["dog_name"] or "", r["imu"]),
             reverse=True)
    return out
