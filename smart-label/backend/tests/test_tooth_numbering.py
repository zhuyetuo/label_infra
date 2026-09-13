"""
逐颗牙 Triadan 编号的测试。纯几何、不需要数据库也不需要模型。

这里守的是反驳阶段定下的几条硬约束——每一条都是"不守会给出一个自洽但整体
错位的结果"，而自洽的错误最危险：它看起来完全正常，会被当成高置信度结果接受。

  1. 两个锚点（犬齿 x04、第一臼齿 x09）必须同时可见，缺一个就整排不给号
  2. 缺牙留空号，不递补
  3. 宁可拒识，不要硬给
  4. 正面照不推号（一个象限号盖不住左右两侧）
"""

import pytest

from app.services import tooth_numbering as tn


def _row(codes_and_x, y=0.3, w=0.05, h=0.1):
    """按给定的 x 位置摆一排牙。codes_and_x: [(label_code, cx), ...]"""
    return [{"label_code": c, "bbox": [x - w / 2, y - h / 2, w, h]} for c, x in codes_and_x]


# 一个典型的左颊上颌：门齿 3 颗、犬齿、前臼齿 4 颗、臼齿 1 颗，均匀排开。
# 左侧象限（2）在图像上中线在左，所以 x 从小到大 = 从前往后。
_LEFT_UPPER = _row([
    ("incisor", 0.10), ("incisor", 0.16), ("incisor", 0.22),
    ("canine", 0.28),
    ("premolar", 0.34), ("premolar", 0.40), ("premolar", 0.46), ("premolar", 0.52),
    ("molar", 0.58),
])


def test_一排完整的牙推出连续编号():
    got = tn.suggest("left", _LEFT_UPPER)
    assert got["verdict"] == "ok", got["reason"]
    codes = [s["tooth_code"] for s in got["suggestions"]]
    assert codes == [201, 202, 203, 204, 205, 206, 207, 208, 209]


# 右颊：中线在图像右侧，所以门齿 x 大、臼齿 x 小（左颊布局的镜像）
_RIGHT_UPPER = _row([
    ("molar", 0.10),
    ("premolar", 0.16), ("premolar", 0.22), ("premolar", 0.28), ("premolar", 0.34),
    ("canine", 0.40),
    ("incisor", 0.46), ("incisor", 0.52), ("incisor", 0.58),
])


def test_右颊是_100_象限():
    """右侧象限在图像上中线在右，所以顺序要反过来数。"""
    got = tn.suggest("right", _RIGHT_UPPER)
    assert got["verdict"] == "ok", got["reason"]
    codes = sorted(s["tooth_code"] for s in got["suggestions"])
    assert codes == [101, 102, 103, 104, 105, 106, 107, 108, 109]
    by_index = {s["index"]: s["tooth_code"] for s in got["suggestions"]}
    assert by_index[8] == 101, "x 最大的那颗在右颊里应该是最靠前的门齿"
    assert by_index[0] == 109


def test_布局跟声称的视角对不上就拒识():
    """把左颊的布局当右颊传进来（视角填错、或者照片本身就是反的），
    推出来的序列会整体错位。第二个锚点的校验正好挡住这种情况——
    这是"宁可拒识不要硬给"最实际的一个用处。"""
    got = tn.suggest("right", _LEFT_UPPER)
    assert got["suggestions"] == []
    assert got["verdict"] == "no_anchor"
    assert "对不上" in got["reason"]


def test_缺牙留空号而不是整排前移():
    """短头犬和小型犬缺牙是常态。递补的话，缺牙之后的每一颗都会少一号，
    而结果看起来完全连续——最危险的那种错。"""
    teeth = _row([
        ("incisor", 0.10), ("incisor", 0.16), ("incisor", 0.22),
        ("canine", 0.28),
        ("premolar", 0.34),
        # 这里缺了 206（间距是别处的两倍）
        ("premolar", 0.46), ("premolar", 0.52),
        ("molar", 0.58),
    ])
    got = tn.suggest("left", teeth)
    assert got["verdict"] == "ok", got["reason"]
    codes = [s["tooth_code"] for s in got["suggestions"]]
    assert codes == [201, 202, 203, 204, 205, 207, 208, 209], f"没留空号：{codes}"


def test_没看到犬齿就整排不给号():
    """只剩一个锚点时递推是开放式的，整象限会系统性平移——
    而那种错法自洽、看不出来。所以宁可不给。"""
    teeth = _row([
        ("incisor", 0.10), ("incisor", 0.16),
        ("premolar", 0.34), ("premolar", 0.40),
        ("molar", 0.58),
    ])
    got = tn.suggest("left", teeth)
    assert got["suggestions"] == []
    assert got["verdict"] == "no_anchor"
    assert "犬齿" in got["reason"]


def test_没看到臼齿就只给犬齿和门齿():
    """用户手机随手拍，两个锚点同时入镜的比例不高——这是主路径不是边角料。

    整排不给号是对的（避免自洽的整体错位），但"一颗都不给"浪费了两类本来就
    确定的牙：犬齿（一个象限只有一颗，看见就是 x04）、以及犬齿和中线之间的门齿
    （正好 3 颗，往中线数就是 03/02/01）。前臼齿不给——05 还是 06 全看中间
    缺没缺牙，没有第二个锚点分不出来。"""
    teeth = _row([
        ("incisor", 0.10), ("incisor", 0.16), ("incisor", 0.22),
        ("canine", 0.28),
        ("premolar", 0.34), ("premolar", 0.40),
    ])
    got = tn.suggest("left", teeth)
    assert got["verdict"] == "partial"
    by_index = {s["index"]: s["tooth_code"] for s in got["suggestions"]}
    assert by_index == {0: 201, 1: 202, 2: 203, 3: 204}
    assert 4 not in by_index and 5 not in by_index, "前臼齿不该给号"
    assert "臼齿" in got["reason"]


def test_没看到犬齿则一颗都不给():
    """退路的前提是犬齿在——没有它，门齿也定不了是第几颗。"""
    teeth = _row([
        ("incisor", 0.10), ("incisor", 0.16),
        ("premolar", 0.34), ("premolar", 0.40),
    ])
    got = tn.suggest("left", teeth)
    assert got["suggestions"] == []
    assert got["verdict"] == "no_anchor"


def test_只拍到一颗犬齿也能给号():
    """随手拍最常见的情形之一：只有半张嘴、几颗牙。"""
    teeth = _row([("canine", 0.30), ("premolar", 0.38)])
    got = tn.suggest("left", teeth)
    by_index = {s["index"]: s["tooth_code"] for s in got["suggestions"]}
    assert by_index == {0: 204}, "犬齿不靠序列就能确定"


def test_退路不会跨过非门齿继续数():
    """犬齿往中线方向如果夹着别的类别，说明排序或分类有问题，到此为止——
    硬数下去就会把前臼齿标成门齿位。"""
    teeth = _row([
        ("incisor", 0.04), ("premolar", 0.10), ("incisor", 0.16),
        ("canine", 0.28),
        ("premolar", 0.40),
    ])
    got = tn.suggest("left", teeth)
    by_index = {s["index"]: s["tooth_code"] for s in got["suggestions"]}
    assert by_index == {3: 204, 2: 203}, by_index


def test_两个锚点对不上就整排不给号():
    """犬齿和第一臼齿之间应该正好隔 4 个座位（05-08）。隔得对不上，
    说明中间的缺牙判断错了，这时候给出来的号是自洽的但整体错位的。"""
    teeth = _row([
        ("canine", 0.28),
        ("premolar", 0.34), ("premolar", 0.40),   # 只有 2 颗前臼齿，中间没有大间距
        ("molar", 0.46),                           # 推出来第一臼齿会是 07，不是 09
    ])
    got = tn.suggest("left", teeth)
    assert got["suggestions"] == [], "锚点自相矛盾时连犬齿都不能给——见下一条"
    assert got["verdict"] == "no_anchor"
    assert "对不上" in got["reason"]


def test_锚点矛盾时连犬齿都不给():
    """两个锚点互相矛盾，最可能的原因是视角填反了（或者照片本身是镜像的）。
    而象限号那一位完全来自视角——视角错了，连犬齿都会给成 104 而不是 204。
    有理由怀疑视角时，一颗都不给，并在原因里点名让人先确认视角。"""
    teeth = _row([
        ("canine", 0.28), ("premolar", 0.34), ("premolar", 0.40), ("molar", 0.46),
    ])
    got = tn.suggest("left", teeth)
    assert got["suggestions"] == []
    assert "视角" in got["reason"]


def test_正面照不推号():
    """正面同时看到左右两侧，一个象限号盖不住。"""
    got = tn.suggest("front", _LEFT_UPPER)
    assert got["suggestions"] == []
    assert got["verdict"] == "bad_view"


def test_上下颌分开推各自的象限():
    upper = _row([
        ("incisor", 0.10), ("incisor", 0.16), ("incisor", 0.22), ("canine", 0.28),
        ("premolar", 0.34), ("premolar", 0.40), ("premolar", 0.46), ("premolar", 0.52),
        ("molar", 0.58),
    ], y=0.25)
    lower = _row([
        ("incisor", 0.10), ("incisor", 0.16), ("incisor", 0.22), ("canine", 0.28),
        ("premolar", 0.34), ("premolar", 0.40), ("premolar", 0.46), ("premolar", 0.52),
        ("molar", 0.58),
    ], y=0.75)
    got = tn.suggest("left", upper + lower)
    codes = sorted(s["tooth_code"] for s in got["suggestions"])
    assert codes[:9] == [201, 202, 203, 204, 205, 206, 207, 208, 209]
    assert codes[9:] == [301, 302, 303, 304, 305, 306, 307, 308, 309]
    assert got["per_jaw"]["upper"]["quadrant"] == 2
    assert got["per_jaw"]["lower"]["quadrant"] == 3


def test_上下颌按中位数切不按固定阈值():
    """照片里嘴的位置千差万别。用固定的 0.5 切，稍微仰拍一点就会把
    整个下颌判成上颌，然后两个象限全错。"""
    # 整张嘴都在画面上半部分
    upper = _row([("canine", 0.28), ("premolar", 0.34), ("premolar", 0.40),
                  ("premolar", 0.46), ("premolar", 0.52), ("molar", 0.58)], y=0.12)
    lower = _row([("canine", 0.28), ("premolar", 0.34), ("premolar", 0.40),
                  ("premolar", 0.46), ("premolar", 0.52), ("molar", 0.58)], y=0.30)
    got = tn.suggest("left", upper + lower)
    assert got["per_jaw"]["upper"]["quadrant"] == 2
    assert got["per_jaw"]["lower"]["quadrant"] == 3
    assert got["per_jaw"]["upper"]["n"] == 6 and got["per_jaw"]["lower"]["n"] == 6


def test_牙太少不给号():
    got = tn.suggest("left", _row([("canine", 0.3)]))
    assert got["suggestions"] == []
    assert got["verdict"] == "too_few"


def test_多颗犬齿说明分错类了不给号():
    teeth = _row([("canine", 0.20), ("canine", 0.28), ("premolar", 0.34),
                  ("premolar", 0.40), ("premolar", 0.46), ("premolar", 0.52), ("molar", 0.58)])
    got = tn.suggest("left", teeth)
    assert got["suggestions"] == []
    assert "唯一" in got["reason"]


def test_推出来的号必须跟粗类对得上():
    """座位号说这是 x05（前臼齿位），而这颗被标成了门齿——两者对不上时
    这颗不给号，而不是硬按座位号给。"""
    teeth = _row([
        ("incisor", 0.10), ("incisor", 0.16), ("incisor", 0.22),
        ("canine", 0.28),
        ("incisor", 0.34),   # ← 座位 05，但标成了门齿
        ("premolar", 0.40), ("premolar", 0.46), ("premolar", 0.52),
        ("molar", 0.58),
    ])
    got = tn.suggest("left", teeth)
    assert got["verdict"] == "ok"
    by_index = {s["index"]: s["tooth_code"] for s in got["suggestions"]}
    assert 4 not in by_index, "座位号跟粗类对不上的那颗不该给号"
    assert by_index[5] == 206


@pytest.mark.parametrize("quadrant,expected_last", [(1, 10), (2, 10), (3, 11), (4, 11)])
def test_上颌到_10_下颌到_11(quadrant, expected_last):
    """犬上颌只有 2 颗臼齿，止于 x10；下颌 3 颗，到 x11。
    也就是说 111/211 不存在——这条在 vision_service 的属性校验里也守着。"""
    ranges = tn._TYPE_RANGES_UPPER if quadrant in (1, 2) else tn._TYPE_RANGES_LOWER
    assert ranges["molar"][1] == expected_last


def test_推不出号时要说清楚为什么():
    """标注员要看懂是"没拍到锚点"还是"牙太少"，而不是一句"失败"——
    前者他可以换个角度重拍，后者只能接着标。"""
    for teeth, kw in (
        (_row([("incisor", 0.1), ("incisor", 0.2)]), "锚点"),
        (_row([("canine", 0.3)]), "太少"),
    ):
        got = tn.suggest("left", teeth)
        assert got["reason"], "没说原因"
        assert kw in got["reason"] or kw in got["verdict"], got["reason"]


# ── 只拍到一排牙（用户随手拍最常见的情形） ──────────────────────────────

def test_只有一排牙时说明上下颌是猜的():
    """几何上根本分不出这排是上颌还是下颌，默认会全判成上颌。
    不说出来的话，一张下排牙的照片会静默地拿到 2xx 而不是 3xx。"""
    teeth = _row([
        ("incisor", 0.10), ("incisor", 0.16), ("incisor", 0.22), ("canine", 0.28),
        ("premolar", 0.34), ("premolar", 0.40), ("premolar", 0.46), ("premolar", 0.52),
        ("molar", 0.58),
    ], y=0.3)
    got = tn.suggest("left", teeth)
    assert got["per_jaw"]["upper"]["jaw_guessed"] is True
    assert "猜" in got["per_jaw"]["upper"]["reason"]
    assert "上下颌" in got["per_jaw"]["upper"]["reason"]


def test_人填了下颌就按下颌给号():
    teeth = _row([
        ("incisor", 0.10), ("incisor", 0.16), ("incisor", 0.22), ("canine", 0.28),
        ("premolar", 0.34), ("premolar", 0.40), ("premolar", 0.46), ("premolar", 0.52),
        ("molar", 0.58),
    ], y=0.3)
    got = tn.suggest("left", teeth, jaw="lower")
    codes = sorted(s["tooth_code"] for s in got["suggestions"])
    assert codes == [301, 302, 303, 304, 305, 306, 307, 308, 309], "没按下颌算"
    assert got["per_jaw"]["lower"]["jaw_guessed"] is False
    assert "猜" not in got["per_jaw"]["lower"]["reason"]


def test_上下都拍到时不提示猜():
    upper = _row([("incisor", 0.10), ("incisor", 0.16), ("incisor", 0.22), ("canine", 0.28),
                  ("premolar", 0.34), ("premolar", 0.40), ("premolar", 0.46), ("premolar", 0.52),
                  ("molar", 0.58)], y=0.25)
    lower = _row([("incisor", 0.10), ("incisor", 0.16), ("incisor", 0.22), ("canine", 0.28),
                  ("premolar", 0.34), ("premolar", 0.40), ("premolar", 0.46), ("premolar", 0.52),
                  ("molar", 0.58)], y=0.75)
    got = tn.suggest("left", upper + lower)
    assert got["per_jaw"]["upper"]["jaw_guessed"] is False
    assert got["per_jaw"]["lower"]["jaw_guessed"] is False


def test_看不出视角就不推号():
    """用户随手拍有不少分不清左右颊的。填错比不填糟得多——象限号全错。"""
    for v in ("unknown", "front", ""):
        got = tn.suggest(v, _LEFT_UPPER)
        assert got["suggestions"] == [], v
        assert got["verdict"] == "bad_view", v
