"""模型类别名 ↔ 标签模板名的别名表。

**这张表管的是"数据会不会被悄悄丢掉"。** 预标注写库时按名字找标签，对不上
就丢那一段，只在跑的那一刻弹一句提示。

实测 2026-09-23：模型输出 活动/睡觉/抓挠/未佩戴，而模板里是 活动/静止-休息
（子级睡眠）/抓挠/未佩戴——「睡觉」这个名字模板里根本没有。结果狗睡了 58.9
分钟、模型整段报「睡觉」，一段都没写进去，工作台上就是一个 58.9 分钟的
「未预测片段」，看着像模型罢工了。
"""

import app.services.behavior_labels as behavior_labels
from app.services.model_label_alias import ALIASES, resolve


def _template_names() -> set[str]:
    """现在这张内置模板里所有的显示名（含各级子标签）。"""
    tree = next(
        v for v in vars(behavior_labels).values()
        if isinstance(v, list) and v and isinstance(v[0], tuple) and len(v[0]) == 5
    )

    def walk(nodes):
        out = []
        for n in nodes:
            out.append(n[1])
            out += walk(n[4] if len(n) == 5 else n[2])
        return out

    return set(walk(tree))


def test_别名指向的名字模板里必须真的有():
    """写错了不会报错，只会继续悄悄丢——这正是这张表要解决的问题本身。"""
    names = _template_names()
    missing = {k: v for k, v in ALIASES.items() if v not in names}
    assert not missing, f"这些别名指向模板里不存在的名字：{missing}"


def test_模型那四个类别现在全都对得上():
    """训练那张重映射表的值就是模型会输出的类别。一个都不能落下。"""
    names = _template_names()
    by_name = {n: i for i, n in enumerate(sorted(names), start=1)}
    for c in ("活动", "睡觉", "抓挠", "未佩戴"):
        assert resolve(c, by_name) is not None, f"模型类别「{c}」对不上任何标签，会被静默丢掉"


def test_睡觉映射到静止休息而不是睡眠():
    """IMU 能说的是"它没动"，说不了"它睡着了"——映射到父级，别替人下更强的结论。"""
    assert ALIASES["睡觉"] == "静止/休息"


def test_真标签永远优先于别名():
    """哪天模板里真加了一个叫「睡觉」的标签，得是它说了算，不能被别名劫走。"""
    assert resolve("睡觉", {"睡觉": 7, "静止/休息": 9}) == 7


def test_对不上就老实返回None():
    """「戴摘项圈」「伸懒腰」这些模板里确实没有，该照旧记进 unmatched 提醒人。"""
    assert resolve("伸懒腰", {"活动": 1}) is None
    assert resolve("压根不存在的类别", {"活动": 1}) is None


def test_别名指向的标签不在项目里时不硬塞():
    """项目用的是老模板、没有「静止/休息」——那就该报对不上，而不是塞给别人。"""
    assert resolve("睡觉", {"活动": 1, "抓挠": 2}) is None
