"""
画面扫描结果：这份样本的视频里有没有狗。

这一整个功能只有一个价值：让标注员**不用点进去**就知道这段该不该看。
而它只有一种搞砸的方式——

    把「没扫成」表现成「确认没狗」。

这两个的后果是相反的：前者要人去查为什么没扫成，后者让人放心跳过这一段。
混了的话，一次服务没起就能让一整天的素材被静默跳过，不报任何错。

所以下面一半的测试都在守这条线。
"""

import json

import pytest

from app.models.sample_vision_scan import STATE_FAILED, STATE_OK
from app.services import vision_scan_service as vs


class _S:
    """够用的假样本：只有视频路径和 id。"""

    def __init__(self, c1="a/cam1.mp4", c2=None, c3=None, sid=1, code="s1"):
        self.id = sid
        self.sample_code = code
        self.video_cam1_path = c1
        self.video_cam2_path = c2
        self.video_cam3_path = c3


# ── 哪几路要扫 ──────────────────────────────────────────────────────────

def test_只扫有路径的那几路():
    """cam2/cam3 允许为空：狗场一间一狗一摄像头，早期还有单路的。
    缺路数不是数据有问题，是场地就那样——不该因此报错或补个空结果。"""
    assert vs.video_paths(_S()) == [("cam1", "a/cam1.mp4")]
    assert len(vs.video_paths(_S(c2="b.mp4", c3="c.mp4"))) == 3


@pytest.mark.parametrize("bad", ["", "   ", None])
def test_空路径不算一路(bad):
    assert vs.video_paths(_S(c2=bad)) == [("cam1", "a/cam1.mp4")]


# ── 「没扫成」和「确认没狗」必须分得开 ──────────────────────────────────

def test_扫失败的行不带任何结论():
    """留空的意思是"不知道"，填个数会被读成"知道，答案是这个"。"""
    row = vs.failed_row(1, "cam1", "连不上视觉服务：ConnectError")
    assert row["state"] == STATE_FAILED
    assert row["no_dog_ratio"] is None, "填 1 的话列表上就成了「确认没狗」"
    assert row["verdict"] is None and row["max_dogs"] is None and row["sampled"] is None
    assert "连不上" in row["error"]


def test_扫了但一帧都没采到也不给比例():
    """服务那边返回 verdict=unknown、no_dog_ratio=None。原样透传，
    不能因为"看着像 0 只狗"就补个 1。"""
    r = {"verdict": "unknown", "no_dog_ratio": None, "max_dogs": 0,
         "sampled": 0, "frames_with_dog": 0, "frames": []}
    row = vs.scan_to_row(1, "cam1", r, "yolo26n.pt")
    assert row["state"] == STATE_OK
    assert row["verdict"] == "unknown"
    assert row["no_dog_ratio"] is None


def test_真扫出没狗才给比例():
    r = {"verdict": "no_dog", "no_dog_ratio": 1.0, "max_dogs": 0, "sampled": 12,
         "frames_with_dog": 0, "duration_sec": 60.0, "every_sec": 5.0, "conf": 0.35,
         "frames": [{"t": i * 5, "n_dogs": 0} for i in range(12)]}
    row = vs.scan_to_row(1, "cam1", r, "yolo26n.pt")
    assert row["verdict"] == "no_dog" and row["no_dog_ratio"] == 1.0
    assert row["weights"] == "yolo26n.pt"


# ── 多路怎么合成一个结论 ────────────────────────────────────────────────

def _r(cam, verdict, state=STATE_OK):
    return {"cam": cam, "verdict": verdict, "state": state}


def test_任意一路看见狗就算有狗():
    """影棚三路拍的是同一个空间的不同角度，cam1 空着不代表狗不在场。
    漏判的方向是安全的（人多看一段），反过来会让人跳过真有素材的样本。"""
    assert vs.sample_verdict([_r("cam1", "no_dog"), _r("cam2", "has_dog"),
                              _r("cam3", "no_dog")]) == "has_dog"


def test_全都没狗才算没狗():
    assert vs.sample_verdict([_r("cam1", "no_dog"), _r("cam2", "no_dog")]) == "no_dog"


def test_有一路没看成就不能说确认没狗():
    """cam1 说没狗、cam2 压根没扫成——狗完全可能就在 cam2 里。
    这时候说 no_dog 就是在替一段没看过的视频下结论。"""
    assert vs.sample_verdict([_r("cam1", "no_dog"), _r("cam2", "unknown")]) == "unknown"


def test_全都没扫成是_unknown_不是没狗():
    rows = [_r("cam1", None, STATE_FAILED), _r("cam2", None, STATE_FAILED)]
    assert vs.sample_verdict(rows) == "unknown"


def test_没扫过跟扫过没狗是两回事():
    """没扫过 = 这个功能还没跑到它；扫过没狗 = 跑过了、确认没有。
    列表上要显示成不同的东西，不然人分不清"这段不用看"和"这段还没查"。"""
    assert vs.sample_verdict([]) == "unscanned"


def test_大部分空镜排在有狗后面没狗前面():
    """狗场关笼子那种：一小时里狗只出现几分钟。既不能当成没狗（真有素材），
    也不该跟全程有狗一样对待（人得知道大部分是空的）。"""
    assert vs.sample_verdict([_r("cam1", "mostly_empty"), _r("cam2", "no_dog")]) == "mostly_empty"
    assert vs.sample_verdict([_r("cam1", "mostly_empty"), _r("cam2", "has_dog")]) == "has_dog"


def test_失败的那一路不参与投票():
    """一路失败、一路确认有狗 → 还是有狗。失败的那路只是没信息，
    不该把一个确定的结论拖成 unknown。"""
    assert vs.sample_verdict([_r("cam1", None, STATE_FAILED), _r("cam2", "has_dog")]) == "has_dog"


# ── 时间线：给第3/4步按时间对齐用 ───────────────────────────────────────

def test_时间线存时刻只数和紧凑的框():
    """一小时按 5 秒采样是 720 个点。框只在有狗的点上带、存成 [x,y,w,h,conf] 数组
    不带 key（复查画面要叠框；带 key 的 dict 会大三倍）。没狗的点还是 [t, n] 两项。"""
    frames = [{"t": 0.0, "n_dogs": 1, "boxes": [{"bbox": [0, 0, 1, 1], "conf": 0.9}]},
              {"t": 5.0, "n_dogs": 0, "boxes": []}]
    raw = vs.compact_timeline(frames)
    assert json.loads(raw) == [[0.0, 1, [[0.0, 0.0, 1.0, 1.0, 0.9]]], [5.0, 0]]
    assert "bbox" not in raw and "conf" not in raw
    # 一小时一只狗控制在几十 KB 以内
    many = [{"t": i * 5.0, "n_dogs": 1, "boxes": [{"bbox": [0.1234, 0.2345, 0.3456, 0.4567], "conf": 0.876}]} for i in range(720)]
    assert len(vs.compact_timeline(many)) < 40_000


def test_时间线读得回来():
    frames = [{"t": i * 5.0, "n_dogs": i % 2} for i in range(10)]
    assert vs.load_timeline(vs.compact_timeline(frames)) == [[i * 5.0, i % 2] for i in range(10)]


@pytest.mark.parametrize("raw", [None, "", "不是JSON", "123", '"abc"'])
def test_时间线坏了不炸(raw):
    """库里的 JSON 脏掉时（手工改库、以后换存储格式），列表页还得能打开。"""
    assert vs.load_timeline(raw) == []


def test_扫不成时没有时间线():
    assert vs.failed_row(1, "cam1", "x")["timeline"] is None
