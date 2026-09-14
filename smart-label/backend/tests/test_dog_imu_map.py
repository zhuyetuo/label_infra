"""
IMU 设备号 → 是哪只狗，这张表从哪儿来。

起因是一个看不见的漏：皮肤页几乎每个地方都吃 `opts.imu_dog_default_map`
（周报表那排「机位/狗」按钮就是 `Object.keys(它)`），而 `/skin/options`
以前是把 label_service 的响应原样透传的——那张表是**写死的**，只有
IMU1..IMU8（影棚那四只狗）。

于是狗场后来加的六只狗（IMU9..IMU20）在界面上整个不存在。不报错、不提示，
看着像是"这几只还没数据"，人会去查采集端、查样本，查半天。

正确的来源是 `imu_dog_map()`：远端那张当底，本地狗档案登记的盖上去、补进来。
狗档案本来就是人在这套系统里自己维护的，它说了算。
"""

import pytest

from app.services.dog_name_service import imu_keys_of_dog, merge_imu_map, sort_imu_map


# ── 一只狗登记的设备号怎么解析 ──────────────────────────────────────────

@pytest.mark.parametrize("imu_field,dog_code,expected", [
    ("IMU9,IMU10", "5", ["IMU9", "IMU10"]),
    ("IMU9，IMU10", "5", ["IMU9", "IMU10"]),   # 中文逗号，大家就是这么填的
    ("9,10", "5", ["IMU9", "IMU10"]),          # 只写数字，也是常见填法
    (" imu9 , 10 ", "5", ["IMU9", "IMU10"]),   # 空格和大小写
    ("IMU19,IMU20", "10", ["IMU19", "IMU20"]),
    ("", "7", ["IMU7"]),                       # 没填 → 按编号当设备号（老约定）
    (None, "7", ["IMU7"]),
    ("", "小白", []),                           # 没填、编号又不是数字 → 认不出来
])
def test_设备号怎么填都认得出来(imu_field, dog_code, expected):
    assert imu_keys_of_dog(imu_field, dog_code) == expected


# ── 排序：十只狗以上必然踩到 ────────────────────────────────────────────

def test_按数字排不按字符串排():
    """这是十只狗以上必然出现的问题：字符串排会排成
    IMU1, IMU10, IMU11, ..., IMU2, IMU20, IMU3...
    界面上那排按钮直接就是这个顺序，看着像是漏了一半。"""
    m = {f"IMU{i}": f"狗{i}" for i in [3, 20, 1, 11, 2, 10, 19]}
    assert list(sort_imu_map(m)) == ["IMU1", "IMU2", "IMU3", "IMU10", "IMU11", "IMU19", "IMU20"]


def test_排序不丢东西也不改值():
    m = {f"IMU{i}": f"狗{i}" for i in range(1, 21)}
    s = sort_imu_map(m)
    assert s == m and len(s) == 20
    assert list(s) == [f"IMU{i}" for i in range(1, 21)]


def test_认不出数字的键排在最后但不丢():
    """真出现了说明档案填得不规范，但不能因此把它吞掉——吞掉就等于
    "有只狗在界面上消失了"，正是这次要修的那个毛病。"""
    m = {"IMU2": "b", "怪键": "x", "IMU1": "a"}
    assert list(sort_imu_map(m)) == ["IMU1", "IMU2", "怪键"]


def test_空表不炸():
    assert sort_imu_map({}) == {}


# ── 合并：本地狗档案要能盖住、也要能补充远端 ────────────────────────────

_merge = merge_imu_map   # 跑的是服务里那个真函数，不在测试里重写一遍规则


# 现场的样子：远端写死了影棚四只，狗档案里有十只
_REMOTE = {"IMU1": "bibi", "IMU2": "bibi", "IMU3": "巴利", "IMU4": "巴利",
           "IMU5": "lulu", "IMU6": "lulu", "IMU7": "小满", "IMU8": "小满"}
_DOGS = [
    ("1", "bibi", "IMU1,IMU2"), ("2", "巴利", "IMU3,IMU4"),
    ("3", "lulu", "IMU5,IMU6"), ("4", "小满", "IMU7,IMU8"),
    ("5", "小白", "IMU9,IMU10"), ("6", "流浪柯基", "IMU11,IMU12"),
    ("7", "流浪小金毛", "IMU13,IMU14"), ("8", "旺财", "IMU15,IMU16"),
    ("9", "大金毛", "IMU17,IMU18"), ("10", "东德", "IMU19,IMU20"),
]


def test_狗场新增的六只狗进得来():
    """就是这次报上来的问题：周报表只列得出 IMU1-4。"""
    m = _merge(_REMOTE, _DOGS)
    assert len(m) == 20, m
    for i in range(9, 21):
        assert f"IMU{i}" in m, f"IMU{i} 没进来——狗场那六只又要在界面上消失"
    assert m["IMU9"] == "小白" and m["IMU20"] == "东德"


def test_只用远端的话就是漏的():
    """把这次修的东西反过来断言一次：光透传远端，狗场六只一个都没有。
    没有这条，以后有人把 /skin/options 改回透传也不会有测试变红。"""
    assert len(sort_imu_map(_REMOTE)) == 8
    assert not any(f"IMU{i}" in _REMOTE for i in range(9, 21))


def test_本地档案跟远端冲突时本地说了算():
    """远端那张是写死的、改不动；狗档案是人在这套系统里自己维护的。"""
    m = _merge({"IMU9": "远端瞎写的"}, [("5", "小白", "IMU9,IMU10")])
    assert m["IMU9"] == "小白"


def test_远端拿不到也照样有本地的十只():
    """label_service 没起/超时时，退回只用本地档案，而不是整个空掉。"""
    m = _merge({}, _DOGS)
    assert len(m) == 20
    assert m["IMU1"] == "bibi" and m["IMU19"] == "东德"


def test_没填名字的狗不进表():
    """名字空着的话，界面上会显示成 'IMU9 '，还不如退回只显示设备号。"""
    m = _merge({}, [("5", "  ", "IMU9"), ("6", "旺财", "IMU15")])
    assert "IMU9" not in m
    assert m["IMU15"] == "旺财"
