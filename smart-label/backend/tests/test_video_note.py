"""路数比该场地应有的少时，界面必须说清少的是哪一种。

**背景（2026-09-23）**：影棚三个机位全是公共的，四只狗共处一室，所以每只狗
都该有 cam1~3 三路。人打开预览只看到一路，而界面一声不吭——只能猜是平台坏了。

少一路有两种完全不同的原因，补救办法也完全不同：

  登记了、媒体库里没有  → 文件没传上 NAS 或还没扫到，去点「立即扫描」
  样本上压根没登记      → 采集时那一路就没录上，平台这边没得补

实测 2026-09-13 的影棚数据里两种都有：00:00~07:00 那几场三路齐全，
08:00 之后只录到 cam1。
"""

from app.api.v1.samples import _video_note
from app.models.sample import Sample
from app.services.site_layout import expected_cams


def _sample(code, *paths):
    s = Sample(sample_code=code)
    s.video_cam1_path, s.video_cam2_path, s.video_cam3_path = (list(paths) + [None, None, None])[:3]
    return s


DAY = "data_raw/2026_9_13_yingpeng"


def test_影棚每只狗该有三路():
    assert sorted(expected_cams("yingpeng", 1)) == [1, 2, 3]


def test_狗场是自己那间加公共区两路():
    """狗场一间一狗一摄像头，再加天花板那路俯拍。"""
    assert sorted(expected_cams("gouchang", 19)) == [6, 7]


def test_三路齐全时不啰嗦():
    paths = [f"{DAY}/multicam_20260913_000031044_cam{c}_imu{c}_raw.mp4" for c in (1, 2, 3)]
    s = _sample("multicam_20260913_000031044_imu1", *paths)
    assert _video_note(s, paths, {p: i for i, p in enumerate(paths)}) is None


def test_登记了但媒体库没有_指路去重扫():
    """样本上有三路，媒体库只认得 cam1——文件没传上或没被扫到。"""
    paths = [f"{DAY}/multicam_20260913_000031044_cam{c}_imu{c}_raw.mp4" for c in (1, 2, 3)]
    note = _video_note(_sample("multicam_20260913_000031044_imu1", *paths), paths, {paths[0]: 1})
    assert note is not None
    assert "该有 3 路" in note and "能播 1 路" in note
    assert "立即扫描" in note
    # 缺的是哪两个文件要点名，不然人不知道去 NAS 上找什么
    assert "cam2_imu2" in note and "cam3_imu3" in note


def test_采集时就没录上_别让人去白扫一遍():
    """22:00 那场 NAS 上只有一个 mp4——这不是媒体库的问题，重扫一百遍也没用。"""
    p = f"{DAY}/multicam_20260913_220010929_cam1_imu1_raw.mp4"
    note = _video_note(_sample("multicam_20260913_220010929_imu1", p), [p, None, None], {p: 1})
    assert note is not None
    assert "能播 1 路" in note and "样本上压根没登记" in note
    assert "立即扫描" not in note, "这种情况重扫没用，别把人往错的方向指"
    assert "缺的是 cam2、cam3" in note


def test_狗场缺公共区那一路_指向补挂而不是去翻NAS():
    """cam7 是另一台采集机录的、属于另一个 session，导入时本来就挂不上。

    这种情况重扫一百遍也没用，NAS 上那个文件也确实在——把人往「去看 NAS」
    指是纯浪费。有专门的「公共区补挂」，说清楚。
    """
    p = "data_raw/2026_9_20_gouchang/multicam_20260920_000016301_cam6_imu19_raw.mp4"
    note = _video_note(_sample("multicam_20260920_000016301_imu19", p), [p, None, None], {p: 1})
    assert note is not None
    assert "公共区补挂" in note
    assert "去 NAS" not in note


def test_认不出场地就不猜():
    """旧数据、外部导入的样本认不出场地——宁可不说，也别报一个假的应有路数。"""
    p = "data_raw/old/whatever_cam1_imu1_raw.mp4"
    assert _video_note(_sample("whatever_imu1", p), [p, None, None], {p: 1}) is None
