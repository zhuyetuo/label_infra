"""
SAM 辅助在平台这一侧的行为，重点是**用不了的时候会怎样**。

SAM 服务是可选的：没配就是关着的，配了也可能没起来、没装 sam2、没下权重。
这几种情况在这个团队里是常态，不是异常。所以它们必须一律变成"按钮置灰 + 说清
原因"，而不是 500 红叉——后者会让标注员以为系统坏了，然后来问。

真正的分割要 GPU 和权重，这台机器上测不了，这里也没假装测。测的是：
没配 / 连不上 / 那边说模型没加载 / 那边返回了个不合法的框，四条路各自怎么收场；
以及权限——能改这张图的人才能用 SAM 点它。
"""

import pytest
from fastapi import HTTPException

from app.api.v1 import vision as api
from app.models.user import User, UserRole
from app.services import vision_sam_client as sam_client

_JPEG = bytes.fromhex("ffd8ffe000104a46494600010100000100010000ffdb004300" + "10" * 64 + "ffd9")
_P1 = "2026-09-01-ok/巴利/a.jpg"


@pytest.fixture()
def album(tmp_path, monkeypatch):
    from app.core.config import settings

    material = tmp_path / "material"
    p = material / "口腔验证" / _P1
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(_JPEG)
    monkeypatch.setattr(settings, "material_root", str(material))
    monkeypatch.setattr(settings, "oral_dir", "口腔验证")
    return material


@pytest.fixture()
def admin(db, run):
    u = User(username="a1", display_name="管理员", password_hash="x", role=UserRole.admin, is_active=True)
    db.add(u)
    run(db.commit())
    return u


def _seg(run, db, user):
    body = api.SamIn(album="oral", path=_P1, points=[{"x": 0.5, "y": 0.5, "label": 1}])
    return run(api.sam_segment(body, db=db, user=user))


def test_没配就是关着的_状态如实说(run, admin, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "vision_service_url", "")
    st = run(api.sam_status(user=admin))["data"]
    assert st["available"] is False
    assert "VISION_SERVICE_URL" in st["error"], "得说清楚是没配，不然运维会去查网络"


def test_没配的时候点一下是_503_不是_500(album, db, run, admin, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "vision_service_url", "")
    with pytest.raises(HTTPException) as e:
        _seg(run, db, admin)
    assert e.value.status_code == 503, "500 会被当成 bug 弹红叉，503 才是「这个能力暂时没有」"


def test_连不上的时候也是_503(album, db, run, admin, monkeypatch):
    from app.core.config import settings

    # 一个几乎肯定没人监听的端口。连不上要在几秒内变成 503，不能挂在那儿
    monkeypatch.setattr(settings, "vision_service_url", "http://127.0.0.1:9")
    with pytest.raises(HTTPException) as e:
        _seg(run, db, admin)
    assert e.value.status_code == 503
    assert "连不上" in str(e.value.detail)


def test_那边说模型没加载时把原话带回来(album, db, run, admin, monkeypatch):
    """不带回来的话，运维得两头猜：到底是平台没配，还是那台机器没下权重。"""

    async def fake(*_a, **_k):
        raise sam_client.SamUnavailable("权重不存在：/opt/sam/xxx.pt")

    monkeypatch.setattr(sam_client, "segment", fake)
    with pytest.raises(HTTPException) as e:
        _seg(run, db, admin)
    assert e.value.status_code == 503
    assert "权重不存在" in str(e.value.detail)


def test_那边返回不合法的框会被拦住(album, db, run, admin, monkeypatch):
    """SAM 返回零面积框（点在背景上就可能），照收的话库里就多一条画不出来的框。"""

    async def fake(*_a, **_k):
        return {"bbox": [0.5, 0.5, 0.0, 0.0], "polygon": None, "score": 0.1}

    monkeypatch.setattr(sam_client, "segment", fake)
    with pytest.raises(HTTPException) as e:
        _seg(run, db, admin)
    assert e.value.status_code == 502


def test_正常返回时框被归一化过(album, db, run, admin, monkeypatch):
    async def fake(*_a, **_k):
        return {"bbox": [-0.1, 0.2, 5.0, 0.3], "polygon": [[0.1, 0.1], [0.2, 0.2], [0.3, 0.1]], "score": 0.93}

    monkeypatch.setattr(sam_client, "segment", fake)
    got = _seg(run, db, admin)["data"]
    assert got["bbox"] == [0.0, 0.2, 1.0, 0.3], "越界的框要夹回去，不能原样入库"
    assert got["score"] == 0.93
    assert len(got["polygon"]) == 3


def test_路径带上了相册目录那一层(album, db, run, admin, monkeypatch):
    """vision_service 那边的路径是相对素材库根的，少了 口腔验证/ 这一层就读不到文件。"""
    seen = {}

    async def fake(path, points, box=None):
        seen["path"] = path
        seen["points"] = points
        return {"bbox": [0.1, 0.1, 0.2, 0.2], "polygon": None, "score": 0.9}

    monkeypatch.setattr(sam_client, "segment", fake)
    _seg(run, db, admin)
    assert seen["path"] == f"口腔验证/{_P1}"
    assert seen["points"] == [{"x": 0.5, "y": 0.5, "label": 1}]


def test_不给点也不给框会被拒(album, db, run, admin):
    with pytest.raises(HTTPException) as e:
        run(api.sam_segment(api.SamIn(album="oral", path=_P1), db=db, user=admin))
    assert e.value.status_code == 400


def test_像素坐标进不来():
    """坐标一律归一化。前端拿到的图是缩放过的，传像素两边迟早对不齐。"""
    import pydantic

    with pytest.raises(pydantic.ValidationError):
        api.SamIn(album="oral", path=_P1, points=[{"x": 640, "y": 480}])


def test_改不了这张图的人用不了_sam(album, db, run, admin, monkeypatch):
    """SAM 跟保存走同一条权限判据。否则等于开了个后门：谁都能拿它去探
    别人组里的照片存不存在。"""
    anna = User(username="anna", display_name="anna", password_hash="x", role=UserRole.annotator, is_active=True)
    db.add(anna)
    run(db.commit())

    async def fake(*_a, **_k):
        raise AssertionError("权限没过就调了 SAM")

    monkeypatch.setattr(sam_client, "segment", fake)
    with pytest.raises(HTTPException) as e:
        _seg(run, db, anna)
    assert e.value.status_code == 404


def test_不存在的照片点不了(album, db, run, admin):
    with pytest.raises(HTTPException) as e:
        run(api.sam_segment(
            api.SamIn(album="oral", path="没有/这张.jpg", points=[{"x": 0.5, "y": 0.5}]),
            db=db, user=admin,
        ))
    assert e.value.status_code == 400
