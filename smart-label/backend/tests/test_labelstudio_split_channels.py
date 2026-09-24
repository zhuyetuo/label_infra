"""两路 imu 的 LS 任务要拆成两路：ts1 的标注归 csv1（imu1），ts2 的归 csv2（imu2）。"""

import io
import json
import os
import zipfile

from app.scripts.import_labelstudio_old import split_channels

FIX = os.path.join(os.path.dirname(__file__), "..", "fixtures", "labelstudio_old", "2026_7_17-2026_7_29.zip")


def test_two_imu_task_splits():
    t = {"id": 1, "data": {"csv1": "http://x/multicam_20260715_084939_cam1_imu1_resampled16hz.csv",
                           "csv2": "http://x/multicam_20260715_084939_cam2_imu2_resampled16hz.csv",
                           "video1": "http://x/v1.mp4", "video2": "http://x/v2.mp4"},
         "annotations": [{"result": [
             {"to_name": "ts1", "value": {"timeserieslabels": ["抓挠"]}},
             {"to_name": "ts2", "value": {"timeserieslabels": ["活动"]}},
             {"to_name": "ts2", "value": {"timeserieslabels": ["活动"]}},
             {"to_name": "video", "value": {"timeserieslabels": ["x"]}},   # 没编号的归第一路
         ]}]}
    out = split_channels(t)
    assert [b for b, _ in out] == ["multicam_20260715_084939_cam1_imu1_resampled16hz.csv",
                                   "multicam_20260715_084939_cam2_imu2_resampled16hz.csv"]
    assert [len(rs) for _, rs in out] == [2, 2]


def test_single_channel_unchanged():
    t = {"id": 2, "data": {"csv": "http://x/multi_20260814_105828977_imu1_raw.csv"},
         "annotations": [{"result": [{"to_name": "ts", "value": {}}]}]}
    assert split_channels(t) == [("multi_20260814_105828977_imu1_raw.csv", [{"to_name": "ts", "value": {}}])]


def test_real_fixture_0715_has_two_imu():
    """仓库里那份导出：2026-07-15 那条任务是 csv1 + csv2，15 段归 imu1、17 段归 imu2。"""
    with zipfile.ZipFile(FIX) as z:
        for name in z.namelist():
            if not name.endswith(".json") or "merged" in name:
                continue
            for t in json.loads(z.read(name)):
                if t.get("id") == 472:
                    out = split_channels(t)
                    assert [(b.split("_")[3], len(rs)) for b, rs in out] == [("cam1", 15), ("cam2", 17)]
                    return
    raise AssertionError("fixture 里没找到任务 472")


def test_reset_projects_exists():
    """--reset 那条路以前调了一个不存在的函数，真跑时才 NameError（dry-run 不走这一段）。"""
    from app.scripts import import_labelstudio_old as m
    assert callable(m.reset_projects)
