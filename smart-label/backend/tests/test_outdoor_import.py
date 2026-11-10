"""博朗旺户外 3 号机：只有拍全场的 cam7~9（不带 imu 号）+ 各项圈 CSV，也要导成样本"""
from app.services import sample_import_service as svc
from app.services import site_layout


def _touch(p):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x")


def test_户外那台_每只狗挂拍全场的三路(tmp_path):
    day = tmp_path / "data_raw" / "2026_11_11_bolangwang"
    # 1 号机：一间一狗
    _touch(day / "multicam_20261111_090000100_cam1_imu9_raw.mp4")
    _touch(day / "multicam_20261111_090000100_cam1_imu9_raw.csv")
    # 户外 3 号机：三路不带 imu 号 + 两个项圈的 CSV
    for c in (7, 8, 9):
        _touch(day / f"multicam_20261111_090003500_cam{c}_raw.mp4")
    for i in (11, 15):
        _touch(day / f"multicam_20261111_090003500_cam7_imu{i}_raw.csv")
    groups = svc._scan_filesystem(str(tmp_path / "data_raw"), str(tmp_path))
    g = groups["multicam_20261111_090003500"]
    assert svc.session_has_video(g)
    videos = g.get("videos") or {}
    shared = {c: videos[c] for c in (1, 2, 3) if c in videos}
    for imu in (11, 15):
        cams = svc.cams_for_imu(g, imu, shared, svc.genuinely_shared_cams(g))
        assert sorted(cams) == [1, 2, 3]
        assert [p.rsplit("_", 2)[-2] for _, p in sorted(cams.items())] == ["cam7", "cam8", "cam9"]
    # 1 号机那场不受影响：只有自己那间
    g1 = groups["multicam_20261111_090000100"]
    v1 = g1.get("videos") or {}
    cams1 = svc.cams_for_imu(g1, 9, {c: v1[c] for c in (1, 2, 3) if c in v1}, svc.genuinely_shared_cams(g1))
    assert list(cams1.values()) == ["data_raw/2026_11_11_bolangwang/multicam_20261111_090000100_cam1_imu9_raw.mp4"]
    assert site_layout.site_part("bolangwang", 8) == "佛山博朗旺·户外"
