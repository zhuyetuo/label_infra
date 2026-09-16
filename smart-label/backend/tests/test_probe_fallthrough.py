"""导入时探视频时长：超时要重试、cam1 不行要往下试、全失败要说出来。

背景（真实数据，2026-09-15）：7 个样本建出来时 video_duration_sec 是空的，
界面上 `08:00:14 ~ ?`、总时长 `-`。事后单独重探**全部**探得出来，其中一个
用的还是 cam1 —— 就是导入时用的那一路。同一个文件当时失败、现在成功，
说明失败的是**探测本身**（8 路并发读 NAS 顶到 30 秒超时），不是文件。

所以「删掉项目重新导一遍」并不能可靠地修好它：下一次超时可能换一批样本。
要改的是探测本身。
"""

from __future__ import annotations

import subprocess

import pytest

from app.services.sample_import_service import probe_any_cam
from app.utils import ffprobe


_OK_JSON = (
    '{"streams":[{"width":1280,"height":720,"r_frame_rate":"25/1"}],'
    '"format":{"duration":"3585.0"}}'
)


class _Ran:
    def __init__(self, stdout):
        self.stdout = stdout


# ── 超时 = 重试一次，别的失败 = 不重试 ────────────────────────────────────


def test_timeout_is_retried_once_with_a_longer_timeout(monkeypatch):
    """第一次超时就放弃的话，那 7 个样本还是会缺时长。"""
    seen: list[int] = []

    def fake_run(cmd, **kw):
        seen.append(kw["timeout"])
        if len(seen) == 1:
            raise subprocess.TimeoutExpired(cmd, kw["timeout"])
        return _Ran(_OK_JSON)

    monkeypatch.setattr(subprocess, "run", fake_run)
    got, why = ffprobe.probe_video_reason("/x.mp4")
    assert why is None
    assert got["duration_sec"] == 3585
    assert seen == [ffprobe.PROBE_TIMEOUT_S, ffprobe.PROBE_RETRY_TIMEOUT_S], \
        "重试必须用更长的超时——同样的 30 秒再试一次多半还是超时"


def test_timeout_twice_says_it_timed_out(monkeypatch):
    """报「超时」而不是「探测失败」：超时可以重试，文件坏了重试没用。"""
    def fake_run(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, kw["timeout"])

    monkeypatch.setattr(subprocess, "run", fake_run)
    got, why = ffprobe.probe_video_reason("/x.mp4")
    assert got is None
    assert "超时" in why


def test_broken_file_is_not_retried(monkeypatch):
    """ffprobe 非零退出 = 文件真的读不出来，**重试纯属浪费**（每次 30 秒）。"""
    calls = []

    def fake_run(cmd, **kw):
        calls.append(1)
        raise subprocess.CalledProcessError(1, cmd, stderr="moov atom not found")

    monkeypatch.setattr(subprocess, "run", fake_run)
    got, why = ffprobe.probe_video_reason("/x.mp4")
    assert got is None and len(calls) == 1
    assert "moov atom not found" in why, "原因要带上 ffprobe 自己说的话"


def test_probe_video_still_returns_just_the_dict(monkeypatch):
    """老调用方（backfill 脚本等）拿到的还是 dict / None。"""
    monkeypatch.setattr(subprocess, "run", lambda cmd, **kw: _Ran(_OK_JSON))
    assert ffprobe.probe_video("/x.mp4")["fps"] == 25.0


# ── cam1 不行就往下试 ─────────────────────────────────────────────────────


def _fake_probe(monkeypatch, ok: set[str], reason="超时"):
    import app.services.sample_import_service as mod

    def fake(path):
        if path.split("/")[-1] in ok:
            return {"duration_sec": 3585, "width": 1280, "height": 720, "fps": 25.0}, None
        return None, reason

    monkeypatch.setattr(mod, "probe_video_reason", fake)
    monkeypatch.setattr(mod.os.path, "isfile", lambda p: True)


def test_uses_cam1_when_it_works(monkeypatch):
    _fake_probe(monkeypatch, {"a.mp4", "b.mp4"})
    got, why = probe_any_cam("/nas", {1: "a.mp4", 2: "b.mp4"})
    assert why is None and got["duration_sec"] == 3585


def test_falls_through_to_cam2(monkeypatch):
    """**只探 cam1 就是那 7 个样本缺时长的直接原因。**"""
    calls: list[str] = []
    import app.services.sample_import_service as mod

    def fake(path):
        calls.append(path)
        if path.endswith("b.mp4"):
            return {"duration_sec": 3585, "fps": 25.0, "width": 1280, "height": 720}, None
        return None, "超时"

    monkeypatch.setattr(mod, "probe_video_reason", fake)
    monkeypatch.setattr(mod.os.path, "isfile", lambda p: True)
    got, why = probe_any_cam("/nas", {1: "a.mp4", 2: "b.mp4", 3: "c.mp4"})
    assert why is None and got["duration_sec"] == 3585
    assert len(calls) == 2, "第二路成功之后就不该再探第三路"


def test_zero_duration_is_not_accepted(monkeypatch):
    """duration 为 0 写进去的话，界面从 `?` 变成 `-`，**看着像修好了**。"""
    import app.services.sample_import_service as mod

    monkeypatch.setattr(mod, "probe_video_reason",
                        lambda p: ({"duration_sec": 0, "fps": 25.0}, None))
    monkeypatch.setattr(mod.os.path, "isfile", lambda p: True)
    got, why = probe_any_cam("/nas", {1: "a.mp4"})
    assert got is None and why


# ── 全失败要带原因 ────────────────────────────────────────────────────────


def test_all_fail_reports_every_cam_and_its_reason(monkeypatch):
    """一句「探测失败」会让人对着一个**不存在的文件**反复重试。"""
    import app.services.sample_import_service as mod

    monkeypatch.setattr(mod, "probe_video_reason", lambda p: (None, "超时"))
    monkeypatch.setattr(mod.os.path, "isfile",
                        lambda p: not p.endswith("gone.mp4"))
    got, why = probe_any_cam("/nas", {1: "gone.mp4", 2: "b.mp4"})
    assert got is None
    assert "cam1 文件不在" in why
    assert "cam2 超时" in why


def test_no_cam_paths_at_all(monkeypatch):
    got, why = probe_any_cam("/nas", {})
    assert got is None and why == "没有视频路径"


@pytest.mark.parametrize("slots", [{2: "b.mp4", 1: "a.mp4"}, {3: "c.mp4", 1: "a.mp4"}])
def test_slots_are_tried_in_numeric_order(monkeypatch, slots):
    """dict 的插入顺序不能决定先探哪一路——cam1 永远第一个。"""
    calls: list[str] = []
    import app.services.sample_import_service as mod

    monkeypatch.setattr(mod, "probe_video_reason",
                        lambda p: (calls.append(p), (None, "超时"))[1])
    monkeypatch.setattr(mod.os.path, "isfile", lambda p: True)
    probe_any_cam("/nas", slots)
    assert calls[0].endswith("a.mp4")
