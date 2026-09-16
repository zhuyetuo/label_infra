"""口腔评估打分（周医生那张加权表）。

选这套而不是 CI/GI 指数，是因为档位就是周医生实际在用的、权重也是他定的，
标注员对着参考图选档就行，不用先学一套指数。CI/GI 那套暂时只在界面上留了提示。

**照片上推不出牙周炎分期（I–IV 期）**：分期要靠牙周探诊深度和 X 光看牙槽骨吸收。
所以这套打分里没有分期这一项，也不该有人从总分去倒推分期。
"""

from __future__ import annotations

import pytest

from app.services import vision_service as svc


def _full(**over):
    a = {"oral_redness": 0, "oral_swelling": 0, "oral_calculus": 0}
    a.update(over)
    return a


# ── 加起来就是总分 ────────────────────────────────────────────────────────


def test_all_zero():
    assert svc.oral_score(_full())["total"] == 0


def test_all_max_is_the_advertised_max():
    got = svc.oral_score(_full(oral_redness=20, oral_swelling=20, oral_calculus=20))
    assert got["total"] == 60
    assert got["max"] == svc.ORAL_SCORE_MAX == 60


def test_sums_the_three():
    assert svc.oral_score(
        _full(oral_redness=10, oral_swelling=15, oral_calculus=5))["total"] == 30


# ── 缺项不当 0 算 ─────────────────────────────────────────────────────────


def test_missing_item_has_no_total():
    """**漏填和"确实是 0"在总分上长得一模一样。**

    没填牙结石就给 20 分的话，那条"20 分"会被当成"看过了，结石没问题"。
    """
    got = svc.oral_score({"oral_redness": 20})
    assert got["total"] is None
    assert got["complete"] is False
    assert got["missing"] == ["牙龈肿胀", "牙结石"]


def test_empty_attrs_is_not_zero():
    got = svc.oral_score({})
    assert got["total"] is None and len(got["missing"]) == 3


def test_a_zero_that_was_actually_filled_counts_as_complete():
    """填了 0 跟没填是两回事——填了 0 是"看过了，正常"。"""
    got = svc.oral_score(_full())
    assert got["complete"] is True and got["missing"] == []


def test_junk_value_does_not_silently_score():
    """手工改库/老数据里冒出个不在表上的值，当没填处理，**不四舍五入到最近的档**。"""
    assert svc.oral_score(_full(oral_calculus=7))["total"] is None


def test_bool_is_not_a_score():
    """Python 里 False == 0，不挡的话 False 会被当成"填了 0 分"。

    前端传个 false 过来（某个开关控件填错了键），这张照片就会显示"已评 0 分，
    正常"——而其实没人评过。
    """
    got = svc.oral_score(_full(oral_redness=False))
    assert got["total"] is None
    assert got["missing"] == ["牙龈发红"]


# ── 存取校验 ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("key,ok,bad", [
    ("oral_redness", 20, 15),      # 发红只有 0/10/20，没有 15
    ("oral_swelling", 15, 5),      # 肿胀有 15、没有 5
    ("oral_calculus", 5, 15),      # 结石有 5、没有 15
])
def test_only_the_table_values_are_accepted(key, ok, bad):
    """三项的档位**各不相同**，不能拿一套通用的 0/10/15/20 去校验。"""
    assert str(ok) in svc.clean_attrs({key: ok})
    with pytest.raises(svc.VisionError):
        svc.clean_attrs({key: bad})


def test_score_items_are_in_the_catalog_as_asset_attrs():
    """要能在"这张图整体"里填，不是挂在某个框上——一张照片一个评分。"""
    keys = [a["key"] for a in svc.catalog("oral")["asset_attrs"]]
    for it in svc.catalog("oral")["score_scheme"]["items"]:
        assert it["key"] in keys


def test_catalog_marks_them_so_the_panel_can_split_them_out():
    attrs = {a["key"]: a for a in svc.catalog("oral")["asset_attrs"]}
    assert attrs["oral_redness"].get("score_item") is True
    # 视角/上下颌不是评分项，不该被算进总分那一段
    assert not attrs["view_code"].get("score_item")


def test_option_labels_lead_with_the_points():
    """选项上看得到分数，标注员才知道自己选的是几分。"""
    attrs = {a["key"]: a for a in svc.catalog("oral")["asset_attrs"]}
    for key in ("oral_redness", "oral_swelling", "oral_calculus"):
        for o in attrs[key]["options"]:
            assert o["label"].startswith(str(o["value"])), (key, o)


# ── 口径只有一份 ──────────────────────────────────────────────────────────


def test_scheme_matches_what_clean_attrs_accepts():
    """catalog 给前端的档位，跟保存时校验的值域**必须是同一套**。

    分家的话界面上选得出来、保存时被拒，而错误信息只会说"值不在合法范围里"。
    """
    for it in svc.catalog("oral")["score_scheme"]["items"]:
        for p in it["points"]:
            assert str(p) in svc.clean_attrs({it["key"]: p})


def test_max_equals_the_sum_of_the_scheme():
    scheme = svc.catalog("oral")["score_scheme"]
    assert scheme["max"] == sum(max(i["points"]) for i in scheme["items"])


def test_skin_album_has_no_score_scheme():
    """皮肤那套是 CADESI-4，不是这张表——别把口腔的打分渲染到皮肤页上。"""
    assert "score_scheme" not in svc.catalog("skin")


def test_scheme_says_staging_is_out_of_scope():
    """写在界面上，不只写在代码注释里——不然读分数的人会自己去倒推分期。"""
    scheme = svc.catalog("oral")["score_scheme"]
    assert "分期" in scheme["note"]
    assert "CI/GI" in scheme["todo"], "另一套还没做，界面上要留个提示"
