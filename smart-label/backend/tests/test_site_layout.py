"""现场布局表：抄自采集端 sites/*.env。守两件事：表跟配置一致（每个 IMU 有归属），
按文件名能判出"自己单间 / 公共区 / 认不出"。"""

from app.services import site_layout as L


def test_布局表跟采集端配置一致():
    g = L.LAYOUT["gouchang"]
    assert set(g["imu"]) == set(range(9, 21))                # 狗场 imu9~20，六间每间两个
    assert g["public_cams"] == {7}
    rooms = {imu: room for imu, (room, _d) in g["imu"].items()}
    assert rooms[9] == rooms[10] == 1 and rooms[19] == rooms[20] == 6
    assert sorted(set(rooms.values())) == [1, 2, 3, 4, 5, 6]
    y = L.LAYOUT["yingpeng"]
    assert set(y["imu"]) == set(range(1, 9)) and y["public_cams"] == {1, 2, 3}
    dogs = {d for _r, d in y["imu"].values()}
    assert dogs == {"bibi", "bali", "lulu", "xima"}


def test_按文件名判自己单间还是公共区():
    day = "2026_9_13_gouchang"
    # 狗场：imu15 住 4 号单间 → cam4 是自己的，cam7 是公共区，cam5 是别人家的
    assert L.classify(f"data_raw/{day}/multicam_1_cam4_imu15_raw.mp4", "multicam_1_imu15", day) == "own"
    assert L.classify(f"data_raw/{day}/multicam_1_cam7_raw.mp4", "multicam_1_imu15", day) == "public"
    assert L.classify(f"data_raw/{day}/multicam_1_cam5_imu15_raw.mp4", "multicam_1_imu15", day) == "public"
    # 场地只写在目录名里也认得出（编号里没有）
    assert L.classify(f"data_raw/{day}/x_cam1_imu9_raw.mp4", "multicam_2_imu9", day) == "own"
    # 影棚：全公共
    assert L.classify("data_raw/2026_9_13_yingpeng/a_cam1_imu3_raw.mp4", "multicam_3_imu3", "2026_9_13_yingpeng") == "public"
    # 认不出场地 / 没摄像头号 → unknown
    assert L.classify("data_raw/2026_9_1/a_cam1_imu3_raw.mp4", "multicam_4_imu3", "2026_9_1") == "unknown"
    assert L.classify("data_raw/2026_9_13_gouchang/a.mp4", "multicam_5_imu9", "2026_9_13_gouchang") == "unknown"
    assert L.parse_cam_imu("x_cam12_imu3_raw.mp4") == (12, 3) and L.parse_cam_imu("x_cam7_raw.mp4") == (7, None)
    assert L.dog_code_of("multicam_1_imu17", "2026_9_13_gouchang") == "dajinmao"
    assert L.dog_code_of("multicam_1_imu5", "2026_9_13_yingpeng") == "lulu"


def test_狗场按机位号分成两处_影棚一处():
    """日期目录里只写了 gouchang，没写是 1 号还是 2 号。分界靠机位号，
    依据是代码里早就记着的两件事：两台采集机各录一半房间（cam1~3 / cam4~7），
    cam7 是狗场2 那台电脑接的公共区（一台俯拍看六个单间）。

    这张表只用来给人看和按场地筛，不参与"能不能对上 IMU"的判断（那个看
    public_cams）。分错的代价是筛选里少几路，不是把公共区的狗错认成这条 IMU 的。
    """
    from app.services.site_layout import site_part

    assert [site_part("gouchang", c) for c in (1, 2, 3)] == ["狗场1"] * 3
    assert [site_part("gouchang", c) for c in (4, 5, 6, 7)] == ["狗场2"] * 4
    assert [site_part("yingpeng", c) for c in (1, 2, 3)] == ["影棚"] * 3
    # 认不出来就 None，不猜
    assert site_part("gouchang", 9) is None
    assert site_part("gouchang", None) is None
    assert site_part(None, 1) is None
