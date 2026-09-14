"""
「要标的那只狗，到底在不在这段画面里」。

场景：标注员认领一份样本，打开、看波形、翻视频，十分钟之后才发现这段里那只狗
压根不在画面里（戴着 IMU 跑到别的房间、被抱去洗澡、摄像头拍的是隔壁那间）。

这里**不做重识别模型**，只用确定性的信息：场地是不是一间一狗、画面里有没有狗、
档案登记了没有。能判的给结论，判不了的明说判不了。

而"判不了"必须是一个**明确的第三档**，这是整个功能成不成立的关键：
  判不了时说"不在" → 影棚每份样本都被标成"狗不在"，人看两次发现是错的就
                      再也不看这个提示，功能等于没做
  判不了时说"在"   → 什么都没说，白占一列
"""

import pytest

from app.services.dog_presence_service import ABSENT, PRESENT, UNKNOWN, is_one_dog_site, presence


def _rows(verdict, ratio=None, max_dogs=None, state="ok", cam="cam1"):
    return [{"cam": cam, "state": state, "verdict": verdict,
             "no_dog_ratio": ratio, "max_dogs": max_dogs}]


# ── 场地认得出来吗 ──────────────────────────────────────────────────────

@pytest.mark.parametrize("code,day,expect", [
    ("multicam_20260913_gouchang_cam1_imu9", None, True),
    ("multicam_20260913_170012882_cam1_imu9", "2026_9_13_gouchang", True),
    ("multicam_20260913_170012882_cam1_imu1", "2026_9_13_yingpeng", False),
    ("multicam_20260913_170012882_cam1_imu1", "2026_9_14_yingpeng2", False),
    ("multicam_20260904_020013893_cam1_imu1", None, False),      # 认不出来 → 不当成一间一狗
])
def test_一间一狗的场地认得出来(code, day, expect):
    assert is_one_dog_site(code, day) is expect


def test_认不出场地时不猜成一间一狗():
    """猜错的方向是有偏的：猜成"一间一狗"会让影棚的样本拿到一个**错的确定结论**，
    而那个结论看起来跟对的一模一样。"""
    assert is_one_dog_site("随便什么", "随便什么") is False


# ── 画面里没狗：跟场地无关，一定不在 ────────────────────────────────────

@pytest.mark.parametrize("code,day", [
    ("x_gouchang_y", None),                 # 一间一狗
    ("x", "2026_9_13_yingpeng"),            # 多狗同场
])
def test_整段没狗就一定不在画面里(code, day):
    """不管几只狗共用一个空间——画面里没有狗，那只狗就一定不在画面里。
    这是唯一一条在多狗场地也能下确定结论的。"""
    r = presence(code, day, _rows("no_dog", ratio=1.0), "小白")
    assert r["state"] == ABSENT and "小白" in r["reason"]


# ── 一间一狗：有狗就是那只 ──────────────────────────────────────────────

def test_一间一狗有狗就是那只():
    r = presence("x_gouchang_y", None, _rows("has_dog", ratio=0.1, max_dogs=1), "小白")
    assert r["state"] == PRESENT and "小白" in r["reason"]


def test_一间一狗但大部分时间空镜_算在但要说清楚():
    """狗场关笼子那种：一小时里狗只出现几分钟。判成"在"是对的（它确实在），
    但不把"大部分时间不在画面里"说出来的话，人还是得从头看到尾。"""
    r = presence("x_gouchang_y", None, _rows("mostly_empty", ratio=0.9, max_dogs=1), "小白")
    assert r["state"] == PRESENT
    assert "90%" in r["reason"]


# ── 多狗同场：必须说判不了 ──────────────────────────────────────────────

def test_影棚有狗但判不出是哪只():
    """说"在"是瞎猜（画面里四只，哪只是 bibi 不知道）；
    说"不在"会让人跳过真有素材的样本。只能说判不了。"""
    r = presence("x", "2026_9_13_yingpeng", _rows("has_dog", ratio=0.1, max_dogs=4), "bibi")
    assert r["state"] == UNKNOWN
    assert "多只狗同场" in r["reason"] and "4 只" in r["reason"]


def test_影棚判不了的时候不会被说成不在():
    """这条是整个功能的成败：判不了时说"不在"，影棚每份样本都会挂一个错提示。"""
    r = presence("x", "2026_9_13_yingpeng", _rows("has_dog", max_dogs=2), "bibi")
    assert r["state"] != ABSENT


# ── 各种"还不知道" ──────────────────────────────────────────────────────

def test_没扫过画面就是判不了():
    r = presence("x_gouchang_y", None, [], "小白")
    assert r["state"] == UNKNOWN and "还没扫" in r["reason"]


def test_扫了没扫成也是判不了而且要说不是没狗():
    """这条直接接住第2步那条规矩：没扫成 ≠ 没狗。
    这里要是把 unknown 当成 no_dog，就会输出"狗不在画面里"这个确定结论。"""
    r = presence("x_gouchang_y", None, _rows(None, state="failed"), "小白")
    assert r["state"] == UNKNOWN
    assert "不是没狗" in r["reason"]


def test_档案没登记是哪只狗就无从判起():
    """这不是画面的问题，是档案没填——提示语要指向去哪儿修，不然人会去查视频。"""
    r = presence("x_gouchang_y", None, _rows("has_dog", max_dogs=1), None)
    assert r["state"] == UNKNOWN and "狗档案" in r["reason"]


# ── 多路：哪一路说了算 ──────────────────────────────────────────────────

def test_多路里只要一路一直看得到狗就不算大部分空镜():
    """多路拍同一个空间。取"没狗比例"最大的那一路的话，一路空镜就能把整份
    样本说成没素材——而另一路可能全程都拍得到。"""
    rows = [
        {"cam": "cam1", "state": "ok", "verdict": "mostly_empty", "no_dog_ratio": 0.95, "max_dogs": 1},
        {"cam": "cam2", "state": "ok", "verdict": "has_dog", "no_dog_ratio": 0.05, "max_dogs": 1},
    ]
    r = presence("x_gouchang_y", None, rows, "小白")
    assert r["state"] == PRESENT
    assert "95%" not in r["reason"], "不该拿最空的那一路来说事"


def test_一路没狗一路没扫成_不能说不在():
    """cam1 说没狗、cam2 没扫成——狗完全可能就在 cam2 里。"""
    rows = [
        {"cam": "cam1", "state": "ok", "verdict": "no_dog", "no_dog_ratio": 1.0, "max_dogs": 0},
        {"cam": "cam2", "state": "failed", "verdict": None, "no_dog_ratio": None, "max_dogs": None},
    ]
    r = presence("x_gouchang_y", None, rows, "小白")
    assert r["state"] == UNKNOWN, "有一路没看成就不能下'不在'这个确定结论"


# ── 每一条 unknown 都得说清楚为什么 ────────────────────────────────────

@pytest.mark.parametrize("code,day,rows,dog", [
    ("x_gouchang_y", None, [], "小白"),
    ("x_gouchang_y", None, _rows(None, state="failed"), "小白"),
    ("x_gouchang_y", None, _rows("has_dog", max_dogs=1), None),
    ("x", "2026_9_13_yingpeng", _rows("has_dog", max_dogs=3), "bibi"),
])
def test_判不了的时候一定带上原因(code, day, rows, dog):
    """只给一个"判不了"的话，人不知道该去扫描、去填档案、还是这就是没法判。"""
    r = presence(code, day, rows, dog)
    assert r["state"] == UNKNOWN
    # 不能只给一个光秃秃的"判不了"——每种 unknown 的下一步动作都不一样：
    # 去扫描 / 去填档案 / 这就是没法判
    assert r["reason"] and r["reason"] != "判不了", r
