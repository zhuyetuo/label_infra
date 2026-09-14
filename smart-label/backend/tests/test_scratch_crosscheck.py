"""
抓挠：IMU 说有的时候，画面里到底有没有狗。

不需要任何新模型——把已有的两样东西按时间戳叠起来：IMU 的抓挠片段（毫秒）
和第1步的画面时间线（秒）。画面里没狗的那些抓挠段最值得先看：IMU 在动，
但那不可能是这只狗在画面里抓挠。

两个最容易出、而且出了极难发现的错，下面各有专门的测试：

  1. **秒和毫秒混了**。两边单位不同，混了不会报错，只会让每一段都对到别的
     时间去——而且因为都是"看起来合理的数"，事后极难发现。
  2. **把"没采到"当成"没狗"**。跟前两步同一条规矩：那会让人把一批好的抓挠段
     当成可疑的删掉。
"""

import pytest

from app.services.scratch_crosscheck_service import (
    AGREE, NO_DOG, UNKNOWN, check_many, check_segment, points_in,
)

# 每 5 秒一个点，0-60 秒。前 30 秒有狗，后 30 秒没狗。
TL = [[float(t), 1 if t < 30 else 0] for t in range(0, 61, 5)]


# ── 单位：秒 vs 毫秒 ────────────────────────────────────────────────────

def test_片段是毫秒时间线是秒():
    """10000-20000 毫秒 = 10-20 秒，该落在 10/15/20 这三个采样点上。
    要是把毫秒当成秒去比，这一段会去跟 10000-20000 **秒**对，一个点都取不到。"""
    assert points_in(TL, 10000, 20000) == [1, 1, 1]


def test_单位搞反了会取到空_这条就是防它():
    """把秒当毫秒传进去，换算出来是 0.01-0.02 秒——这个窗口里一个采样点都没有。

    这条不是测实现，是把"混了会怎样"钉下来：一旦哪天有人改了单位约定，
    上面那条（10000-20000 取到三个点）会红，这条会变成"取到了一堆点"也红。
    两条一起，单位这件事就跑不掉。"""
    assert points_in(TL, 10, 20) == []
    # 反过来：把毫秒当秒，10000 秒远超视频时长，同样什么都取不到
    assert points_in(TL, 10_000_000, 20_000_000) == []


def test_边界点算在里面():
    """闭区间。开区间的话，一段正好 10.0-15.0 秒的抓挠会一个点都取不到。"""
    assert points_in(TL, 10000, 15000) == [1, 1]


# ── 对得上 / 对不上 ─────────────────────────────────────────────────────

def test_画面里有狗就是对得上():
    r = check_segment(TL, 0, 25000)
    assert r["state"] == AGREE and "有狗" in r["reason"]


def test_画面里没狗的抓挠段要标出来():
    """IMU 在动但狗不在画面里：IMU 掉了、狗跑到画面外、或者标错了。
    不管哪种都不该直接进训练集。"""
    r = check_segment(TL, 40000, 60000)
    assert r["state"] == NO_DOG
    assert "IMU 可能掉了" in r["reason"]


def test_一半一半算对得上():
    """采样每 5 秒一个点，狗在画面边缘进进出出时漏一两个点是常态。
    要求全中的话几乎每段都会被标成可疑，这一列就没人看了。"""
    r = check_segment(TL, 25000, 35000)     # 25(有) 30(无) 35(无) → 1/3
    assert r["state"] == NO_DOG
    r = check_segment(TL, 20000, 30000)     # 20(有) 25(有) 30(无) → 2/3
    assert r["state"] == AGREE


# ── 「没采到」不是「没狗」 ──────────────────────────────────────────────

def test_没扫过画面不给结论():
    r = check_segment([], 0, 10000)
    assert r["state"] == UNKNOWN and "还没扫过" in r["reason"]


def test_段太短夹在两个采样点中间_不给结论():
    """2 秒的抓挠段夹在 5 秒的采样间隔里，一个点都压不到。
    这是"没采到"，不是"画面里没狗"——判成 no_dog 的话，短抓挠会被整批
    标成可疑，而短抓挠恰恰是最常见的。"""
    r = check_segment(TL, 11000, 13000)
    assert r["state"] == UNKNOWN
    assert "没有画面采样点" in r["reason"] and "5 秒" in r["reason"]


def test_段落在视频时长之外_也不给结论():
    r = check_segment(TL, 200000, 210000)
    assert r["state"] == UNKNOWN


def test_起止时间读不出来的段不给结论():
    out = check_many(TL, [{"id": 1, "start_time_ms": None, "end_time_ms": 5000}])
    assert out["items"][0]["cross"]["state"] == UNKNOWN
    assert "读不出" in out["items"][0]["cross"]["reason"]


# ── 排序：这一列的全部意义是"先看哪几段" ────────────────────────────────

def test_可疑的排最前面():
    """按 id 排的话人还是得从头翻，那跟没有这个功能一样。"""
    segs = [
        {"id": 1, "start_time_ms": 0, "end_time_ms": 20000},          # agree
        {"id": 2, "start_time_ms": 40000, "end_time_ms": 60000},      # no_dog
        {"id": 3, "start_time_ms": 11000, "end_time_ms": 13000},      # unknown
        {"id": 4, "start_time_ms": 5000, "end_time_ms": 25000},       # agree
    ]
    out = check_many(TL, segs)
    assert [it["id"] for it in out["items"]] == [2, 3, 1, 4]
    assert out["counts"] == {AGREE: 2, NO_DOG: 1, UNKNOWN: 1}


def test_同一档里按时间先后排():
    segs = [
        {"id": 1, "start_time_ms": 50000, "end_time_ms": 55000},
        {"id": 2, "start_time_ms": 35000, "end_time_ms": 45000},
    ]
    out = check_many(TL, segs)
    assert [it["id"] for it in out["items"]] == [2, 1]


def test_原来的字段原样带回去():
    """前端要拿 id 和起止时间跳转播放，丢了就跳不过去。"""
    segs = [{"id": 7, "start_time_ms": 0, "end_time_ms": 10000, "label_code": "scratch", "conf": 0.9}]
    it = check_many(TL, segs)["items"][0]
    assert it["id"] == 7 and it["label_code"] == "scratch" and it["conf"] == 0.9


def test_没有片段时不炸():
    out = check_many(TL, [])
    assert out["items"] == [] and out["counts"] == {AGREE: 0, NO_DOG: 0, UNKNOWN: 0}


# ── 时间线脏了也不能炸 ──────────────────────────────────────────────────

@pytest.mark.parametrize("tl", [
    [[None, 1]],
    [["坏", 1]],
    [[0.0, 1], [None, 0]],
])
def test_时间线里有坏点也不炸(tl):
    """库里的 JSON 脏掉时（手工改库、换存储格式），这一页还得能打开。"""
    r = check_segment(tl, 0, 10000)
    assert r["state"] in (AGREE, NO_DOG, UNKNOWN)
