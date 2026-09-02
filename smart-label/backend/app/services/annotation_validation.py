"""标签不允许时间重叠的校验（决策③）。草稿阶段不强制，提交时强制。"""

from app.schemas.task import LabelItemIn


def find_first_overlap(items: list[LabelItemIn]) -> tuple[LabelItemIn, LabelItemIn] | None:
    """按 start_time_ms 排序后扫描，返回第一对重叠的标签；无重叠返回 None。"""
    ordered = sorted(items, key=lambda it: it.start_time_ms)
    prev: LabelItemIn | None = None
    for item in ordered:
        if item.start_time_ms >= item.end_time_ms:
            # 非法区间本身也算"冲突"，提交时一并拦截
            return item, item
        if prev is not None and item.start_time_ms < prev.end_time_ms:
            return prev, item
        if prev is None or item.end_time_ms > prev.end_time_ms:
            prev = item
    return None
