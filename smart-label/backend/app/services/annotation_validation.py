"""标签不允许时间重叠的校验（决策③）。草稿阶段不强制，提交时强制。

什么算"重叠"：默认任意两段时间压在一起就算。传 conflicts(label_a, label_b) 的话只有它说
矛盾的才算——父子（舔 / 舔-前左爪）、不同互斥轨（卧 + 舔）压在一起是允许的，见 label_tracks.py。
"""

from typing import Callable

from app.schemas.task import LabelItemIn


def find_first_overlap(
    items: list[LabelItemIn], conflicts: Callable[[int, int], bool] | None = None
) -> tuple[LabelItemIn, LabelItemIn] | None:
    """按 start_time_ms 排序后扫描，返回第一对矛盾重叠的标签；没有返回 None。"""
    ordered = sorted(items, key=lambda it: it.start_time_ms)
    for i, item in enumerate(ordered):
        if item.start_time_ms >= item.end_time_ms:
            # 非法区间本身也算"冲突"，提交时一并拦截
            return item, item
        for other in ordered[i + 1:]:
            if other.start_time_ms >= item.end_time_ms:
                break
            if conflicts is None or conflicts(item.label_id, other.label_id):
                return item, other
    return None
