"""
抓挠：IMU 说有的时候，画面里到底有没有狗。

── 这一步**不需要任何新模型** ──────────────────────────────────────────

它把已经有的两样东西按时间戳叠在一起：

    IMU 那边的抓挠片段（人标的 / AI 预标的）    起止毫秒
    画面扫描的时间线（第1步的产出）            [[秒, 几只], ...]

然后回答一个很朴素的问题：**这段 IMU 说在抓挠的时间里，画面里有狗吗？**

画面里没狗的那些抓挠段，是最值得先看的——IMU 在动、但那不可能是这只狗在
画面里抓挠（它根本不在画面里）。要么是 IMU 掉在地上被碰了，要么是狗跑到
画面外去抓，要么就是标错了。不管哪种，都不该直接进训练集。

── 为什么这一步值得单独做，而不是等视频行为模型 ────────────────────────

视频行为模型要等有标注数据才能训，而标注数据正是这一步攒出来的。先有这个
对照，人确认/否掉的每一段，就是第5步的训练样本。

── 一条要守住的线 ──────────────────────────────────────────────────────

**画面没扫过 / 没扫成的，一律不给结论。** 跟前面两步同一条规矩：
"没看成"表现成"画面里没狗"的话，人会把一批好的抓挠段当成可疑的删掉。
"""

#: 一个抓挠段要跟画面对上，画面里有狗的采样点得占多大比例。
#:
#: 为什么不是 1.0：采样是每 5 秒一个点，一段 3 秒的抓挠可能只压到一个点；
#: 而狗在画面边缘进进出出时，中间漏掉一两个点是常态。要求全中的话，
#: 几乎每一段都会被标成可疑，这一列就没人看了。
#:
#: 为什么不是 0：只压到一个点、那个点还没狗，说明整段大概率不在画面里。
COVERED_RATIO = 0.5

AGREE = "agree"          # IMU 说抓挠，画面里也有狗——正常，不用先看
NO_DOG = "no_dog"        # IMU 说抓挠，但画面里没狗——最值得先看的
UNKNOWN = "unknown"      # 画面没扫过/没扫成/这段时间没采到点——不给结论


def points_in(timeline: list[list[float]], start_ms: float, end_ms: float) -> list[int]:
    """落在 [start, end] 这段时间里的采样点，返回每个点看见几只狗。

    时间线的单位是**秒**（vision_service 返回的就是秒），片段的单位是**毫秒**
    （标注那边一直用毫秒）。这个换算错了不会报错，只会让每一段都对到别的
    时间去——而且因为两边都是"看起来合理的数"，事后极难发现。
    """
    s, e = start_ms / 1000.0, end_ms / 1000.0
    out = []
    for pt in timeline:
        # 库里的 JSON 脏掉时（手工改库、以后换存储格式），这一页还得能打开。
        # 坏点跳过而不是抛——一个坏点不该让整份样本的对照打不开
        try:
            t, n = float(pt[0]), int(pt[1])
        except (TypeError, ValueError, IndexError):
            continue
        if s <= t <= e:
            out.append(n)
    return out


def check_segment(timeline: list[list[float]], start_ms: float, end_ms: float) -> dict:
    """一个抓挠段 → 画面对不对得上。"""
    if not timeline:
        return {"state": UNKNOWN, "reason": "这一路画面还没扫过（或者没扫成）", "points": 0}
    pts = points_in(timeline, start_ms, end_ms)
    if not pts:
        # 片段落在采样点之间（比如 2 秒的段夹在两个 5 秒采样点中间），
        # 或者整段在视频时长之外。都不是"没狗"，是"没采到"
        return {"state": UNKNOWN,
                "reason": f"这段时间里没有画面采样点（每 {int(_gap(timeline)) or 5} 秒采一次，段太短就会夹在中间）",
                "points": 0}
    with_dog = sum(1 for n in pts if n > 0)
    ratio = with_dog / len(pts)
    if ratio >= COVERED_RATIO:
        return {"state": AGREE, "reason": f"这段时间画面里有狗（{with_dog}/{len(pts)} 个采样点）",
                "points": len(pts)}
    return {"state": NO_DOG,
            "reason": f"IMU 说在抓挠，但画面里基本没狗（{with_dog}/{len(pts)} 个采样点有狗）——"
                      f"IMU 可能掉了、或者狗在画面外，先看这段",
            "points": len(pts)}


def _gap(timeline: list[list[float]]) -> float:
    """时间线的采样间隔。只用来把提示语说清楚，算不出来就当 0。"""
    if len(timeline) < 2:
        return 0.0
    try:
        return float(timeline[1][0]) - float(timeline[0][0])
    except (TypeError, ValueError, IndexError):
        return 0.0


def check_many(timeline: list[list[float]], segments: list[dict]) -> dict:
    """一份样本的全部抓挠段。

    segments：[{id, start_time_ms, end_time_ms, ...}]，多余的字段原样带回去，
    前端要拿它跳转播放。
    """
    items = []
    for seg in segments:
        try:
            s = float(seg.get("start_time_ms"))
            e = float(seg.get("end_time_ms"))
        except (TypeError, ValueError):
            items.append({**seg, "cross": {"state": UNKNOWN, "reason": "这一段的起止时间读不出来", "points": 0}})
            continue
        items.append({**seg, "cross": check_segment(timeline, s, e)})

    counts = {AGREE: 0, NO_DOG: 0, UNKNOWN: 0}
    for it in items:
        counts[it["cross"]["state"]] += 1
    # 可疑的排前面：这一列的全部意义就是"先看哪几段"。按 id 排的话，
    # 人还是得从头翻——那跟没有这个功能一样
    order = {NO_DOG: 0, UNKNOWN: 1, AGREE: 2}
    items.sort(key=lambda it: (order[it["cross"]["state"]], it.get("start_time_ms") or 0))
    return {"counts": counts, "items": items}
