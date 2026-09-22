"""
现场布局：哪个摄像头拍哪个单间、哪只狗（哪个 IMU）住哪间、哪个是公共区。

来源是采集端 witmotion_imu 仓库里的 sites/狗场1.env、狗场2.env、影棚.env（CAMERAS /
DEVICES / PAIRS），这里照抄成一张表。**改了那边的配对要同步改这里**——两边都是
人写死的，没有自动同步；测试里有一条守着"每个 IMU 都有归属"。

用处：视频文件名里带 `_cam{N}_imu{M}`，一看就知道这一路是这只狗自己单间的摄像头
（画面里只有它，能直接对上它的 IMU），还是公共区（几只狗同在，画面里那只不一定
是它）。大模型看视频找动作 / 找相似只该在能对上的那几路上跑。

    狗场   6 个单间各一狗一摄像头（cam1~6），cam7 公共区俯拍（狗场2 那台电脑接的）
           每间两个 IMU 轮换（一个在狗身上、一个充电），归属同一只狗
    影棚   4 只狗共处，3 个摄像头全是公共的（cam1~3），IMU 1~8 两两轮换归 4 只狗
"""

from __future__ import annotations

import re

# 场地别名（采集端 SITE_ALIAS / 日期目录后缀里出现的字样）→ 布局键
SITE_KEYS = {
    "gouchang": "gouchang", "狗场": "gouchang",
    "yingpeng": "yingpeng", "影棚": "yingpeng",
}

# imu 号 → (所在单间的摄像头号, 狗代号)。摄像头号是采集端 CAMERAS 里的机位号，
# 也就是视频文件名里 _cam{N}_ 的 N。None = 没有自己的单间（影棚）
LAYOUT: dict[str, dict] = {
    "gouchang": {
        "public_cams": {7},
        "imu": {
            9: (1, "xiaobai"), 10: (1, "xiaobai"),      # 小白 比熊       1 号单间
            11: (2, "keji"), 12: (2, "keji"),           # 流浪柯基        2 号单间
            13: (3, None), 14: (3, None),               # 3 号单间（狗名见狗档案）
            15: (4, "wangcai"), 16: (4, "wangcai"),     # 旺财 法斗       4 号单间
            17: (5, "dajinmao"), 18: (5, "dajinmao"),   # 大金毛 金毛     5 号单间
            19: (6, "dongde"), 20: (6, "dongde"),       # 东德            6 号单间
        },
    },
    "yingpeng": {
        "public_cams": {1, 2, 3},
        "imu": {
            1: (None, "bibi"), 2: (None, "bibi"),
            3: (None, "bali"), 4: (None, "bali"),
            5: (None, "lulu"), 6: (None, "lulu"),
            7: (None, "xima"), 8: (None, "xima"),
        },
    },
}

# 一个布局键底下还分几处场地：日期目录里只写了 gouchang，没写是 1 号还是 2 号，
# 分界只能靠机位号。而这件事代码里早就记着两处：
#
#   「狗场是两台采集机各录一半房间（cam1~3 + cam4~7）」 sample_import_service
#   「cam7 公共区俯拍（狗场2 那台电脑接的）」            本文件开头
#
# 所以 cam1~3 是 1 号机（1~3 号单间），cam4~6 是 2 号机（4~6 号单间）。
# **cam7 单独算一档**：它插在 2 号机上，但一台俯拍看的是全部六间，
# 把它算成「2 号机的」会让人以为前三间没有公共区画面。影棚只有一处。
#
# 这张表只用来**给人看和按场地筛**，不参与"能不能对上 IMU"的判断（那个看
# public_cams）。分错了的代价是筛选里少几路，不是把公共区的狗错认成这条 IMU 的。
SITE_PARTS: dict[str, list[tuple[str, set[int]]]] = {
    # cam7 单独一档：**它拍的是全部六间**（画面里 1~6 号都在），只是插在 2 号机上。
    # 归到「狗场2」等于说它只属于后三间，而那正是现在 imu9~14 看不到公共区的
    # 由来——2026-09-22 实测：imu14 的样本只有一路，imu20 的有两路
    "gouchang": [("狗场·1号机", {1, 2, 3}), ("狗场·2号机", {4, 5, 6}), ("狗场·公共区", {7})],
    "yingpeng": [("影棚", {1, 2, 3})],
}


def site_part(site: str | None, cam: int | None) -> str | None:
    """这一路属于哪一处场地（狗场1 / 狗场2 / 影棚）。认不出来 None，不猜。"""
    for name, cams in SITE_PARTS.get(site or "", []):
        if cam in cams:
            return name
    return None


_CAM_IMU_RE = re.compile(r"_cam(\d+)(?:_imu(\d+))?", re.IGNORECASE)
_IMU_RE = re.compile(r"_imu(\d+)", re.IGNORECASE)


def site_of(*hints: str | None) -> str | None:
    """从样本编号 / 日期目录 / 路径里认场地。认不出来 None，不猜。"""
    for h in hints:
        low = (h or "").lower()
        for k, v in SITE_KEYS.items():
            if k.lower() in low:
                return v
    return None


def parse_cam_imu(path: str | None) -> tuple[int | None, int | None]:
    """视频路径里的 (摄像头号, imu 号)。公共区的文件名是 _cam7_raw，没有 imu。"""
    m = _CAM_IMU_RE.search(path or "")
    if not m:
        return None, None
    return int(m.group(1)), (int(m.group(2)) if m.group(2) else None)


def imu_of(sample_code: str | None) -> int | None:
    m = _IMU_RE.search(sample_code or "")
    return int(m.group(1)) if m else None


def classify(video_path: str | None, sample_code: str | None, day_dir: str | None = None) -> str:
    """这一路视频对这只狗（样本的 IMU）来说是什么：

        own      它自己单间的摄像头，画面里只有它 → 能直接对上 IMU
        public   公共区 / 多狗同场 → 画面里那只不一定是它
        unknown  认不出场地或摄像头号（老数据、别的场地）→ 按 own 处理，别把老数据挡掉
    """
    site = site_of(sample_code, day_dir, video_path)
    cam, _ = parse_cam_imu(video_path)
    imu = imu_of(sample_code)
    if site is None or cam is None:
        return "unknown"
    lay = LAYOUT[site]
    if cam in lay["public_cams"]:
        return "public"
    room = lay["imu"].get(imu, (None, None))[0] if imu is not None else None
    if room is None:
        return "unknown"
    return "own" if room == cam else "public"


def dog_code_of(sample_code: str | None, day_dir: str | None = None) -> str | None:
    """采集端配置里这个 IMU 归哪只狗（代号）。正式的狗名以平台狗档案为准，这个只是兜底。"""
    site = site_of(sample_code, day_dir)
    imu = imu_of(sample_code)
    if site is None or imu is None:
        return None
    return LAYOUT[site]["imu"].get(imu, (None, None))[1]
