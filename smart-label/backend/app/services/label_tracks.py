"""互斥轨：同轨的标签时间上互斥，跨轨可以重叠。

为什么要有它：狗可以**卧着**、**静止**、同时**舔前爪**——姿态、运动状态、具体行为本来
就是同时发生的三件事。全放在一条时间线上互斥的话，标了「舔」就不能标「卧」，真值
就少了一维。分轨之后每一轨各自一条时间线：

  posture   姿态轨   坐 / 卧 / 站 / 姿态转换          任一时刻只有一种姿态
  motion    运动轨   静止休息(睡眠) / 活动(行走…)     任一时刻要么静要么动
  behavior  行为轨   抓挠 / 舔 / 啃 / 蹭 / 进食 / …    具体在干什么，一次一件
  device    设备轨   颈圈松动                         独立，随时可叠

轨是标签的一个字段，子标签没填的沿用上级的（「舔-前左爪」跟「舔」一轨）。
**没填轨的标签全算一轨**（""），互相互斥——老项目所有标签都没轨，行为跟以前一样。

模型侧不用支持多轨：训练导出时按优先级（行为 > 运动 > 姿态）折叠成"一个时刻一个
标签"（见 training_export_service），RF 照旧是单标签分类；三轨各自的标签另外带在
段上，以后想训分轨模型不用重标。设备轨不参与折叠，单独导。
"""

from __future__ import annotations

from typing import Callable

TRACKS: list[tuple[str, str]] = [
    ("behavior", "行为"),
    ("motion", "运动"),
    ("posture", "姿态"),
    ("device", "设备"),
]
TRACK_KEYS = [k for k, _ in TRACKS]
TRACK_NAMES = dict(TRACKS)
# 折叠优先级（前面的赢）。设备轨不在里面：颈圈松不松是另一个模型的事
DEFAULT_PRIORITY = ["behavior", "motion", "posture"]


def normalize(track: str | None) -> str | None:
    """空串 / 不认识的都当没填。"""
    t = (track or "").strip()
    return t if t in TRACK_NAMES else None


def track_of(parent_of: dict[int, int | None], own: dict[int, str | None], label_id: int) -> str:
    """一个标签的有效轨：自己填了用自己的，没填往上找上级；都没有就是 ""（没分轨那一轨）。"""
    cur: int | None = label_id
    seen: set[int] = set()
    while cur is not None and cur not in seen:
        seen.add(cur)
        t = normalize(own.get(cur))
        if t:
            return t
        cur = parent_of.get(cur)
    return ""


def conflict_checker(labels) -> Callable[[int, int], bool]:
    """给一组 LabelDefinition，返回 conflicts(a_id, b_id)：两个标签在时间上重叠算不算矛盾。
    同一个 / 父子（细的本来就在粗的里面）不算；不同轨不算；其余算。"""
    parent_of = {l.id: l.parent_id for l in labels}
    own = {l.id: l.track for l in labels}

    def chain(i: int) -> list[int]:
        out: list[int] = []
        cur: int | None = i
        while cur is not None and cur not in out and cur in parent_of:
            out.append(cur)
            cur = parent_of[cur]
        return out

    def conflicts(a: int, b: int) -> bool:
        if a == b or a in chain(b) or b in chain(a):
            return False
        return track_of(parent_of, own, a) == track_of(parent_of, own, b)

    return conflicts
