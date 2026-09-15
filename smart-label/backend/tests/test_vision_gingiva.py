"""牙龈这一类加进来之后，守住三件一错就静默出问题的事：

  1. class_id 是标签表的下标。牙龈必须追加在最后，否则已经导出的数据集和
     已经训好的权重里，门齿/犬齿/前臼齿/臼齿的 class_id 全部错位。
  2. 推牙位必须把牙龈框排除掉。牙位是沿牙弓递推的，队列里多一个不是牙的框，
     从它往后整段编号后移一位——而且结果自洽，肉眼看不出来。
  3. 老数据照旧。牙框上填过的 gi/牙位/CI 不能因为新增了 only_for 就被拒收。
"""

import pytest

from app.services import tooth_numbering, vision_service


def _codes():
    return [lb["code"] for lb in vision_service.DOMAINS["tooth"]["labels"]]


def test_牙龈追加在最后_四个牙类的下标不变():
    assert _codes()[:4] == ["incisor", "canine", "premolar", "molar"]
    assert _codes()[4] == "gingiva"


def test_每个类别的快捷键不重复():
    hotkeys = [lb["hotkey"] for lb in vision_service.DOMAINS["tooth"]["labels"]]
    assert len(set(hotkeys)) == len(hotkeys)


def _attr(key):
    return next(a for a in vision_service.DOMAINS["tooth"]["item_attrs"] if a["key"] == key)


def test_牙龈属性只对牙龈显示_牙位只对牙显示():
    for k in ("gum_color", "gum_swelling", "gum_bleeding"):
        assert _attr(k)["only_for"] == ["gingiva"]
    assert "gingiva" not in _attr("tooth_code")["only_for"]
    assert "gingiva" not in _attr("ci")["only_for"]
    # GI 两边都能填：老数据是填在牙框上的，不能把它排除掉
    assert "only_for" not in _attr("gi")


def test_只对某些类别显示的属性_照样收得下老数据():
    # only_for 是显示层的筛选，不是校验。牙框上的牙位/CI/GI 必须照旧收
    got = vision_service.clean_attrs({"tooth_code": 104, "ci": 2, "gi": 1})
    assert '"tooth_code": 104' in got


def test_牙龈三项的值域():
    assert vision_service.clean_attrs({"gum_color": "pigmented", "gum_swelling": 3,
                                       "gum_bleeding": "none"})
    for bad in ({"gum_color": "purple"}, {"gum_swelling": 4}, {"gum_bleeding": "on_touch"}):
        with pytest.raises(vision_service.VisionError):
            vision_service.clean_attrs(bad)


def _box(code, cx, cy=0.5, w=0.06, h=0.12):
    return {"label_code": code, "bbox": [cx - w / 2, cy - h / 2, w, h]}


def _arch():
    """左颊上颌一排：犬齿 + 4 前臼齿 + 2 臼齿，从中线往后。"""
    return [_box("canine", 0.10)] + [_box("premolar", 0.20 + i * 0.10) for i in range(4)] \
        + [_box("molar", 0.62), _box("molar", 0.72)]


def test_推牙位_牙龈框不参与递推也不占位():
    boxes = _arch()
    base = tooth_numbering.suggest("left", boxes, jaw="upper")
    assert base["verdict"] == "ok"
    before = {s["index"]: s["tooth_code"] for s in base["suggestions"]}

    # 在牙弓中间插一个牙龈框。不排除的话，它后面的牙全部后移一位
    withgum = _arch()
    withgum.insert(3, _box("gingiva", 0.35, h=0.04))
    after = tooth_numbering.suggest("left", withgum, jaw="upper")
    assert after["verdict"] == "ok"
    # 牙龈自己不给号
    assert 3 not in {s["index"] for s in after["suggestions"]}
    # 其余每颗牙的号跟没有牙龈框时一模一样（下标因插入而后移 1）
    remapped = {(i if i < 3 else i - 1): c
                for i, c in ((s["index"], s["tooth_code"]) for s in after["suggestions"])}
    assert remapped == before
