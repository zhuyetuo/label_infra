"""缺时长的样本重探：cam1 坏了要顺着往下试，失败原因要分清楚。

界面上那个 `08:00:14 ~ ?` 和总时长 `-` 就是 video_duration_sec 为空。
导入时 `probe_video` 把所有异常都吞掉返回 None（超时、截断、编码坏都一样），
而样本照样建——于是缺时长这件事**一声不吭**。

比"探测失败"更要紧的是**为什么失败**：文件不在要补文件，文件坏了要转码，
两者混成一句话的话，人会对着一个根本不存在的文件反复重试。
"""

from __future__ import annotations

import pytest

from app.scripts.backfill_video_probe import (
    MISSING,
    NO_PATH,
    OK,
    UNREADABLE,
    probe_sample,
)


@pytest.fixture
def nas(tmp_path):
    (tmp_path / "data_raw").mkdir()
    return tmp_path


def _fake_probe(monkeypatch, ok_names: set[str]):
    """只有名字在 ok_names 里的文件 probe 得出来，其余返回 None。"""
    import app.scripts.backfill_video_probe as mod
    import os

    def fake(path):
        if os.path.basename(path) in ok_names:
            return {"duration_sec": 3585, "width": 1920, "height": 1080, "fps": 25.0}
        return None

    monkeypatch.setattr(mod, "probe_video", fake)


def _touch(nas, name):
    p = nas / "data_raw" / name
    p.write_bytes(b"")
    return f"data_raw/{name}"


# ── 正常路径 ──────────────────────────────────────────────────────────────


def test_uses_cam1_when_it_works(nas, monkeypatch):
    a = _touch(nas, "a.mp4")
    b = _touch(nas, "b.mp4")
    _fake_probe(monkeypatch, {"a.mp4", "b.mp4"})
    kind, got, used = probe_sample(str(nas), [a, b, None])
    assert kind == OK
    assert got["duration_sec"] == 3585
    assert used == a, "cam1 能探出来就该用 cam1"


def test_falls_through_to_cam2_when_cam1_is_broken(nas, monkeypatch):
    """**cam1 坏了不代表 cam2 也坏。**

    同一次录制各路时长一样，顺着往下试就能救回来——只探 cam1 的话
    这个样本会白白留在"缺时长"里。
    """
    a = _touch(nas, "broken.mp4")
    b = _touch(nas, "good.mp4")
    _fake_probe(monkeypatch, {"good.mp4"})
    kind, got, used = probe_sample(str(nas), [a, b, None])
    assert kind == OK
    assert used == b


def test_skips_a_missing_cam1_and_uses_cam2(nas, monkeypatch):
    b = _touch(nas, "good.mp4")
    _fake_probe(monkeypatch, {"good.mp4"})
    kind, _got, used = probe_sample(str(nas), ["data_raw/gone.mp4", b, None])
    assert kind == OK and used == b


# ── 三种失败要分得开 ──────────────────────────────────────────────────────


def test_no_path_at_all(nas, monkeypatch):
    _fake_probe(monkeypatch, set())
    assert probe_sample(str(nas), [None, None, None])[0] == NO_PATH
    assert probe_sample(str(nas), ["", "  ", None])[0] == NO_PATH


def test_all_files_missing(nas, monkeypatch):
    """文件不在 —— 补文件或删样本，**重试没有意义**。"""
    _fake_probe(monkeypatch, set())
    kind, got, _ = probe_sample(str(nas), ["data_raw/x.mp4", "data_raw/y.mp4", None])
    assert kind == MISSING
    assert got is None


def test_file_exists_but_unreadable(nas, monkeypatch):
    """文件在、ffprobe 读不出来 —— 转码或重采，**跟"文件不在"是两回事**。"""
    a = _touch(nas, "broken.mp4")
    _fake_probe(monkeypatch, set())
    assert probe_sample(str(nas), [a, None, None])[0] == UNREADABLE


def test_one_missing_one_unreadable_reports_unreadable(nas, monkeypatch):
    """有一个文件确实在（只是读不出来）→ 报"读不出来"，不报"文件不在"。

    报成"文件不在"的话，人会去找一个其实就在那儿的文件。
    """
    b = _touch(nas, "broken.mp4")
    _fake_probe(monkeypatch, set())
    assert probe_sample(str(nas), ["data_raw/gone.mp4", b, None])[0] == UNREADABLE


# ── 时长为 0 不算成功 ─────────────────────────────────────────────────────


def test_zero_duration_is_not_accepted(nas, monkeypatch):
    """ffprobe 有时能读出流信息但 duration 是 0/缺失。

    当成功写进去的话，界面上从 `?` 变成 `-`，**看起来像修好了**，
    而实际还是没有时长。
    """
    import app.scripts.backfill_video_probe as mod

    a = _touch(nas, "a.mp4")
    monkeypatch.setattr(mod, "probe_video",
                        lambda p: {"duration_sec": 0, "width": 1920,
                                   "height": 1080, "fps": 25.0})
    assert probe_sample(str(nas), [a, None, None])[0] == UNREADABLE


def test_none_duration_is_not_accepted(nas, monkeypatch):
    import app.scripts.backfill_video_probe as mod

    a = _touch(nas, "a.mp4")
    monkeypatch.setattr(mod, "probe_video",
                        lambda p: {"duration_sec": None, "width": 1920,
                                   "height": 1080, "fps": 25.0})
    assert probe_sample(str(nas), [a, None, None])[0] == UNREADABLE
