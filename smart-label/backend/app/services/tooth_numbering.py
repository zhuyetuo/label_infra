"""
逐颗牙的 modified Triadan 编号：从一张照片上已经画好的框，推出每颗牙的三位数牙位。

为什么是几何后处理而不是让模型学 42 个类别：
  - 42 类在几百张的量级上必然不收敛，每类平均一两百个实例，罕见牙位只剩十几个；
  - 缺牙时整排编号错位，而缺牙在小型犬和短头犬里是常态；
  - 编号本质是牙弓上的**拓扑属性**，不是视觉类别——同一颗牙换个视角，
    "这是前臼齿"不变，"它是第几颗"也不变。该让模型学的是前者。

所以模型只学 4 个粗类（门齿/犬齿/前臼齿/臼齿），编号在这里用纯几何推。
纯函数、无模型、可单元测试——这是选这条路线的一半理由。

—— 这套算法在反驳阶段被压得比初版保守得多，几条硬约束都是那时加的： ——

1. **锚点不足就不猜**。Triadan 的 "rule of 4 and 9"：每象限犬齿恒为 x04、
   第一臼齿恒为 x09。但 x09 在非麻醉掀唇照里经常根本拍不到，只剩一个锚点时
   递推变成开放式序列，整象限会系统性平移。所以两个锚点必须同时可见，
   否则整张图不给号。
2. **缺牙留空号，不递补**。相邻间距明显大于中位间距时判定中间缺了一颗，
   编号跳过去。这条是短头犬不崩的关键。
3. **保留拒识**。宁可某颗牙不给号，也不要给一个自洽但整体错位的结果——
   后者会被当成高置信度结果接受。
4. **verdict 说清楚为什么**。给不出号时要让标注员看懂是"没拍到锚点"还是
   "牙太少"，而不是一句"失败"。
"""

from dataclasses import dataclass

# 每象限的牙型构成（modified Triadan）：
#   门齿 x01-x03、犬齿 x04、前臼齿 x05-x08、臼齿 x09 起
#   上颌（1/2 象限）2 颗臼齿 → 止于 x10；下颌（3/4 象限）3 颗 → 止于 x11
_UPPER_QUADRANTS = (1, 2)

_TYPE_RANGES_UPPER = {
    "incisor": (1, 3),
    "canine": (4, 4),
    "premolar": (5, 8),
    "molar": (9, 10),
}
_TYPE_RANGES_LOWER = {
    "incisor": (1, 3),
    "canine": (4, 4),
    "premolar": (5, 8),
    "molar": (9, 11),
}

# 两个锚点：犬齿恒为 x04，第一臼齿恒为 x09
_ANCHOR_CANINE = 4
_ANCHOR_FIRST_MOLAR = 9

# 相邻牙的间距超过中位间距的这个倍数，就判定中间缺了一颗（留空号）。
# 太小会把正常的牙缝当缺牙、把编号推飞；太大则缺牙识别不出来、整排后移。
_GAP_RATIO = 1.6


@dataclass
class Tooth:
    """一颗牙：框 + 粗类。index 是调用方的原始下标，用来把结果对回去。"""

    index: int
    label_code: str
    bbox: tuple[float, float, float, float]  # 归一化 [x, y, w, h]

    @property
    def cx(self) -> float:
        return self.bbox[0] + self.bbox[2] / 2

    @property
    def cy(self) -> float:
        return self.bbox[1] + self.bbox[3] / 2


def quadrant_of(view_code: str, is_upper: bool) -> int | None:
    """视角 + 上下颌 → 象限号。

    1=右上 2=左上 3=左下 4=右下（从狗自己的角度看）。
    掀唇拍左颊看到的是狗的左侧，也就是 2（上）/ 3（下）。
    正面视角同时看到左右两侧，一个象限号盖不住——正面照不推号。
    """
    if view_code == "left":
        return 2 if is_upper else 3
    if view_code == "right":
        return 1 if is_upper else 4
    return None


def _split_jaw(teeth: list[Tooth]) -> tuple[list[Tooth], list[Tooth]]:
    """按纵向位置把牙分成上颌和下颌。

    用中位 cy 一刀切，而不是固定的 0.5：照片里嘴的位置千差万别，
    固定阈值在稍微仰拍一点的图上就会把整个下颌判成上颌。
    """
    if len(teeth) < 2:
        return (teeth, []) if teeth else ([], [])
    ys = sorted(t.cy for t in teeth)
    mid = (ys[len(ys) // 2] + ys[(len(ys) - 1) // 2]) / 2
    upper = [t for t in teeth if t.cy <= mid]
    lower = [t for t in teeth if t.cy > mid]
    return upper, lower


def _median(xs: list[float]) -> float:
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def number_one_arch(teeth: list[Tooth], quadrant: int) -> dict:
    """给一个象限（半边牙弓）里的牙推编号。

    返回 {assignments: {index: code}, verdict: str, reason: str}
    verdict: ok / no_anchor / too_few
    """
    if len(teeth) < 2:
        return {"assignments": {}, "verdict": "too_few", "reason": "这个象限的牙太少，推不出序列"}

    ranges = _TYPE_RANGES_UPPER if quadrant in _UPPER_QUADRANTS else _TYPE_RANGES_LOWER
    last_seat = ranges["molar"][1]

    # 沿牙弓从中线往后排。掀唇照里牙弓近似横向排布，用 cx 排序；
    # 哪一端是中线由象限决定（右侧象限在图像上通常是从右往左越来越靠后）。
    from_left = quadrant in (2, 3)  # 狗的左侧：图像上中线在左
    ordered = sorted(teeth, key=lambda t: t.cx, reverse=not from_left)

    # 两个锚点都必须在：只剩一个的话递推是开放式的，整象限会系统性平移，
    # 而那种错法自洽、看起来完全正常
    canine = [i for i, t in enumerate(ordered) if t.label_code == "canine"]
    molars = [i for i, t in enumerate(ordered) if t.label_code == "molar"]
    if not canine or not molars:
        missing = "犬齿" if not canine else "第一臼齿"
        return _anchor_only(
            ordered, quadrant,
            f"这个象限没看到{missing}，凑不齐两个锚点（开放式往后数会整排一起错位，"
            f"而且看不出来）。",
        )
    # 同一象限里理论上只有一颗犬齿。多于一颗说明分错类或者跨象限了，不猜
    if len(canine) > 1:
        return {"assignments": {}, "verdict": "no_anchor",
                "reason": "这个象限认出了多颗犬齿，锚点不唯一——多半是分错类或者这张图跨了象限。"}

    ci = canine[0]
    mi = min(molars)  # 最靠前的臼齿就是第一臼齿 x09
    return _full_sequence(ordered, quadrant, ci, mi, ranges, last_seat)


def _anchor_only(teeth: list[Tooth], quadrant: int, reason: str) -> dict:
    """凑不齐两个锚点时的退路：**只给能单独确定的那几颗**。

    用户手机随手拍的照片里，犬齿和第一臼齿同时入镜的比例不高。整排不给号是对的
    （避免自洽的整体错位），但"一颗都不给"就浪费了两类本来就确定的牙：

      - **犬齿**：一个象限只有一颗，形态独一无二，看见就是 x04。不依赖任何序列。
      - **犬齿和中线之间的门齿**：正好 3 颗，从犬齿往中线数就是 03 / 02 / 01。
        也不依赖第二个锚点——门齿的总数是固定的，中间缺一颗也只会让靠中线那侧
        少给一个号，不会让已给的号错位。

    前臼齿和臼齿不给：05 还是 06 全看中间缺没缺牙，没有第二个锚点分不出来。
    """
    canine = [i for i, t in enumerate(teeth) if t.label_code == "canine"]
    if len(canine) != 1:
        return {"assignments": {}, "verdict": "no_anchor", "reason": reason}

    ci = canine[0]
    out = {teeth[ci].index: quadrant * 100 + _ANCHOR_CANINE}
    # 从犬齿往中线方向（ordered 里下标变小的方向）数门齿
    seat = _ANCHOR_CANINE
    for k in range(ci - 1, -1, -1):
        if teeth[k].label_code != "incisor":
            break  # 中间夹了别的类别，说明排序或分类有问题，到此为止
        seat -= 1
        if seat < 1:
            break
        out[teeth[k].index] = quadrant * 100 + seat

    return {
        "assignments": out,
        "verdict": "partial",
        "reason": f"{reason}只给了犬齿和它前面的门齿——这几颗不靠序列就能确定；"
                  f"前臼齿和臼齿没有第二个锚点分不出是第几颗，留空等你填。",
    }


def _full_sequence(ordered, quadrant, ci, mi, ranges, last_seat) -> dict:
    """两个锚点都在时，沿牙弓推完整序列"""

    # 用两个锚点之间的实际牙数，算出"一个座位"的平均间距，再据此判缺牙
    gaps = [abs(ordered[k + 1].cx - ordered[k].cx) for k in range(len(ordered) - 1)]
    med_gap = _median([g for g in gaps if g > 0]) if any(g > 0 for g in gaps) else 0.0

    # 从犬齿往两边推，遇到大间距就跳号（留空号，不递补）
    seats: dict[int, int] = {ci: _ANCHOR_CANINE}
    seat = _ANCHOR_CANINE
    for k in range(ci + 1, len(ordered)):
        step = 1
        if med_gap > 0 and gaps[k - 1] > med_gap * _GAP_RATIO:
            # 中间缺了牙：按间距估计缺了几个座位，编号跳过去
            step = max(1, round(gaps[k - 1] / med_gap))
        seat += step
        seats[k] = seat
    seat = _ANCHOR_CANINE
    for k in range(ci - 1, -1, -1):
        step = 1
        if med_gap > 0 and gaps[k] > med_gap * _GAP_RATIO:
            step = max(1, round(gaps[k] / med_gap))
        seat -= step
        seats[k] = seat

    # 第二个锚点校验：推出来的第一臼齿座位号必须落在 x09。
    # 对不上说明中间的缺牙判断错了，整排不可信
    if seats.get(mi) != _ANCHOR_FIRST_MOLAR:
        # 这里**不能**退到"只给锚点牙"：两个锚点互相矛盾，最可能的原因就是视角填反了
        # （或者照片本身是镜像的）。而象限号那一位完全来自视角——视角错了，
        # 连犬齿都会给成 104 而不是 204。有理由怀疑视角时，一颗都不给。
        return {
            "assignments": {}, "verdict": "no_anchor",
            "reason": f"按犬齿推到第一臼齿是 {seats.get(mi)} 号、跟锚点 {_ANCHOR_FIRST_MOLAR} 对不上。"
                      f"多半是视角填反了，或者中间的缺牙判断错了。视角一错象限号就全错，"
                      f"所以这张图一颗都不给号——请先确认视角。",
        }

    out: dict[int, int] = {}
    for k, t in enumerate(ordered):
        s = seats[k]
        if s < 1 or s > last_seat:
            continue  # 推到象限外面去了，这颗不给号（而不是硬塞一个）
        lo, hi = ranges.get(t.label_code, (0, 0))
        if not (lo <= s <= hi):
            continue  # 座位号跟这颗牙的粗类对不上，不给号
        out[t.index] = quadrant * 100 + s

    # 同一象限不能有重号。真出现了说明排序或缺牙判断有问题，整排不给
    if len(set(out.values())) != len(out):
        # 同上：重号说明排序或缺牙判断有问题，牵连到象限，不退到锚点牙
        return {"assignments": {}, "verdict": "no_anchor",
                "reason": "推出来有重号，说明排序或缺牙判断有问题，整排不可信。"}

    return {"assignments": out, "verdict": "ok", "reason": ""}


def suggest(view_code: str, boxes: list[dict], jaw: str | None = None) -> dict:
    """入口：给一张照片上的框推牙位。

    boxes：[{label_code, bbox}]，顺序即返回里的 index。
    返回 {suggestions: [{index, tooth_code}], verdict, reason, per_jaw: {...}}

    **这是建议，不是结论**：接口把它当候选返回，界面上默认逐颗确认。
    案例级"整图一个号都没错"才是能开批量接受的判据，逐颗准确率不是——
    牙位错误是象限块状相关的，逐颗平均很高也可能对应过半个体有整段错位。
    """
    if view_code not in ("left", "right"):
        return {
            "suggestions": [], "verdict": "bad_view", "per_jaw": {},
            "reason": "只有左颊/右颊的照片能推牙位。正面照同时看到左右两侧，一个象限号盖不住。",
        }

    teeth = [
        Tooth(index=i, label_code=b.get("label_code", ""), bbox=tuple(b.get("bbox") or (0, 0, 0, 0)))
        for i, b in enumerate(boxes)
    ]
    teeth = [t for t in teeth if t.bbox[2] > 0 and t.bbox[3] > 0]
    if len(teeth) < 2:
        return {"suggestions": [], "verdict": "too_few", "per_jaw": {}, "reason": "框太少，推不出牙弓序列"}

    # 上下颌：人填了就信人的，没填才按纵向位置猜。
    #
    # 猜是有条件的：照片里上下两排牙都在时，中位 cy 一刀切是可靠的。但用户随手拍
    # 经常只拍到一排——这时候几何上**根本分不出**这排是上颌还是下颌，而默认会
    # 全判成上颌，象限号整个错掉（204 而不是 304）。所以只有一排时要说出来。
    guessed = False
    if jaw == "upper":
        upper, lower = teeth, []
    elif jaw == "lower":
        upper, lower = [], teeth
    else:
        upper, lower = _split_jaw(teeth)
        guessed = not upper or not lower

    out: dict[int, int] = {}
    per_jaw = {}
    for jaw_name, group, is_upper in (("upper", upper, True), ("lower", lower, False)):
        if not group:
            continue
        q = quadrant_of(view_code, is_upper)
        r = number_one_arch(group, q)
        reason = r["reason"]
        if guessed and r["assignments"]:
            reason = ("这张图只看到一排牙，上下颌是按位置猜的（默认当成上颌）——"
                      "要是下排，象限号就全错了，请在右栏把「上下颌」填上再推一次。" + reason)
        per_jaw[jaw_name] = {
            "quadrant": q, "verdict": r["verdict"], "reason": reason,
            "n": len(group), "jaw_guessed": guessed,
        }
        out.update(r["assignments"])

    verdicts = {v["verdict"] for v in per_jaw.values()}
    if not out:
        reason = "；".join(v["reason"] for v in per_jaw.values() if v["reason"]) or "推不出牙位"
        return {"suggestions": [], "verdict": "no_anchor" if "no_anchor" in verdicts else "too_few",
                "per_jaw": per_jaw, "reason": reason}

    return {
        "suggestions": [{"index": i, "tooth_code": c} for i, c in sorted(out.items())],
        "verdict": "ok" if verdicts == {"ok"} else "partial",
        "per_jaw": per_jaw,
        "reason": "；".join(v["reason"] for v in per_jaw.values() if v["reason"]),
    }
