"""草稿读出去的 origin_item_id 必须是它自己的 id。

**这个洞让所有人工纠正都白做了。** origin_item_id 只是入参字段，库里没有
这一列，所以 `LabelItemOut.model_validate(ORM对象)` 取不到、落回默认 None。
前端原样带回来存草稿时，后端 `existing_by_id.get(None)` 找不到原件，就把每
一条都当成新增——老行删掉、建一批新行、`is_modified` 硬编码成 False。

实测表现（2026-09-22，任务 #44674）：把一条 AI 片段从「抓挠」改成
「抓挠-头颈耳」，存草稿，再进来——标签留住了，状态却退回「AI 待确认」，
看着就像改了个寂寞，人只好退出去重进再点一次「通过」。
"""

from app.schemas.task import LabelItemOut


def _row(**kw):
    base = dict(id=7, label_id=1, start_time_ms=0, end_time_ms=1000,
                source_type="ai_generated", is_modified=True, ai_confidence=0.8,
                ai_confirmed=False, uncertain=False, uncertain_reason=None,
                from_candidate_id=None, created_by=None)
    return LabelItemOut(**{**base, **kw})


def test_没带origin时用自己的id填上():
    assert _row().origin_item_id == 7


def test_显式带了origin就不动它():
    """从候选确认出来那种场景会显式给 origin，别覆盖掉。"""
    assert _row(origin_item_id=3).origin_item_id == 3


def test_纠正状态能原样读回来():
    """is_modified 要跟着出去——前端据它显示「AI 已纠正」并收起「通过」按钮。"""
    r = _row(is_modified=True, ai_confirmed=False)
    assert r.is_modified is True
    assert r.origin_item_id == r.id
