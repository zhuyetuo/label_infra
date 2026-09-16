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


# ── 重新扫描要回头修已有样本 ───────────────────────────────────────────────


def test_rescan_backfills_existing_samples(db, run, monkeypatch):
    """**删掉标注项目重建没用**——samples 表一行都没动。

    扫描只处理没见过的 sample_code，已有样本的 video_duration_sec 不会回头补，
    所以界面上还是 `08:00:14 ~ ?`。真实情况就是这样：用户删了项目重新生成，
    问号照旧，只有手动跑 backfill_video_probe 才好。

    修法跟采样率那个字段一样：每次扫描顺手补一遍缺时长的。
    """
    import app.services.sample_import_service as mod
    from app.models.sample import Sample

    good = Sample(sample_code="s_ok", video_cam1_path="a.mp4", imu_csv_path="a.csv", created_by=1)
    broken = Sample(sample_code="s_bad", video_cam1_path="b.mp4", imu_csv_path="b.csv", created_by=1)
    keep = Sample(sample_code="s_keep", video_cam1_path="c.mp4", imu_csv_path="c.csv", created_by=1,
                  video_duration_sec=1234, video_fps=25.0,
                  video_resolution="640x480")
    # 缺时长、但**帧率分辨率是有的**：那次探测成功过，只是 duration 没读出来。
    # 补时长可以，别拿另一路的参数去盖——各路机位分辨率可能不一样
    partial = Sample(sample_code="s_partial", video_cam1_path="a.mp4",
                     imu_csv_path="d.csv", created_by=1,
                     video_fps=25.0, video_resolution="640x480")
    for s in (good, broken, keep, partial):
        db.add(s)
    run(db.commit())

    def fake(nas_root, cams):
        if cams.get(1) == "a.mp4":
            return {"duration_sec": 3585, "fps": 50.0,
                    "width": 1280, "height": 720}, None
        return None, "cam1 ffprobe 退出码 1：moov atom not found"

    monkeypatch.setattr(mod, "probe_any_cam", fake)
    n = run(mod._backfill_video_duration(db, "/nas"))

    assert n == 2
    # 从库里重新查，**不要**用手上那个 ORM 对象——expire_on_commit=False，
    # 它拿的是缓存值，update 写没写进去根本看不出来
    from sqlalchemy import select

    rows = run(db.execute(select(
        Sample.sample_code, Sample.video_duration_sec, Sample.video_fps,
        Sample.video_resolution))).all()
    got = {r[0]: tuple(r[1:]) for r in rows}

    assert got["s_ok"] == (3585, 50.0, "1280x720")
    # 探不出来的留空，下次扫描再试——**不要**写个 0 进去装作修好了
    assert got["s_bad"][0] is None
    # 已经有值的不参与，更不能被别的机位的分辨率盖掉
    assert got["s_keep"] == (1234, 25.0, "640x480")
    assert got["s_partial"] == (3585, 25.0, "640x480"), \
        "时长要补上，但原有的帧率/分辨率不能被 1280x720 盖掉"


def test_rescan_reports_how_many_are_still_broken(db, run, monkeypatch):
    """扫描日志里要看得见还剩几个探不出来，否则这事又悄悄过去了。"""
    import app.services.sample_import_service as mod
    from app.models.sample import Sample

    db.add(Sample(sample_code="s1", video_cam1_path="a.mp4", imu_csv_path="a.csv", created_by=1))
    db.add(Sample(sample_code="s2", video_cam1_path="b.mp4", imu_csv_path="b.csv", created_by=1))
    run(db.commit())
    monkeypatch.setattr(mod, "probe_any_cam", lambda r, c: (
        ({"duration_sec": 100, "fps": 25.0, "width": 1, "height": 2}, None)
        if c.get(1) == "a.mp4" else (None, "坏了")))
    mod._progress.detail.clear()
    run(mod._backfill_video_duration(db, "/nas"))
    line = " ".join(mod._progress.detail)
    assert "补上 1 个样本的视频时长" in line
    assert "还有 1 个探不出来" in line


def test_rescan_calls_the_backfill(monkeypatch):
    """_do_scan 里必须真的调它——写了函数不挂上去等于没写。"""
    import inspect

    import app.services.sample_import_service as mod

    src = inspect.getsource(mod._do_scan)
    code = "\n".join(l for l in src.splitlines() if not l.strip().startswith("#"))
    assert "_backfill_video_duration(" in code
