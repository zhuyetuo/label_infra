"""
审查查出来的安全问题的回归测试。

这些都是我自己引入的，而且都是"绿灯下过去的"——之前的测试全过，因为它们
只试了直白的输入。写在单独一个文件里，是为了让它们显眼：这一组失败意味着
权限边界破了，不是功能少了点什么。
"""

import ast

import pytest
from fastapi import HTTPException

from app.api.v1 import vision as api
from app.models.user import User, UserRole
from app.services import vision_service as svc

_JPEG = bytes.fromhex("ffd8ffe000104a46494600010100000100010000ffdb004300" + "10" * 64 + "ffd9")
_G_BALI = "2026-09-01-ok/巴利"
_G_LULU = "2026-09-01-ok/lulu"
_BALI_1 = f"{_G_BALI}/a.jpg"
_LULU_1 = f"{_G_LULU}/c.jpg"
# 绕过用的路径：group_of 只看前两段，算出来是巴利组；realpath 落在 lulu 组
_SNEAKY = f"{_G_BALI}/../lulu/c.jpg"


@pytest.fixture()
def album(tmp_path, monkeypatch):
    from app.core.config import settings

    material = tmp_path / "material"
    for rel in (_BALI_1, _LULU_1):
        p = material / "口腔验证" / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(_JPEG)
    monkeypatch.setattr(settings, "material_root", str(material))
    monkeypatch.setattr(settings, "oral_dir", "口腔验证")
    monkeypatch.setattr(settings, "nas_root", str(tmp_path / "nas"))
    return material


def _mk(db, run, name, role):
    u = User(username=name, display_name=name, password_hash="x", role=role, is_active=True)
    db.add(u)
    run(db.commit())
    return u


@pytest.fixture()
def people(db, run):
    return {
        "admin": _mk(db, run, "adm", UserRole.admin),
        "reviewer": _mk(db, run, "rev", UserRole.reviewer),
        "anna": _mk(db, run, "anna", UserRole.annotator),
        "ben": _mk(db, run, "ben", UserRole.annotator),
    }


@pytest.fixture()
def assigned(db, run, people, album):
    """anna 拿到巴利组，ben 拿到 lulu 组"""
    for group, who in ((_G_BALI, "anna"), (_G_LULU, "ben")):
        run(api.create_assignments(
            api.AssignIn(album="oral", group_keys=[group], assignee_id=people[who].id),
            db=db, user=people["admin"],
        ))
    return people


# ── 相册内横向穿越 ──────────────────────────────────────────────────────
#
# 校验路径的是 realpath（跑出相册根才拦），算 group 的是对原始字符串切片。
# 两者看的不是同一个路径，`..` 夹在中间时就分叉了：
#     group_of("日期/巴利/../lulu/c.jpg") == "日期/巴利"   ← 在 anna 的指派里
#     realpath 之后                      == 日期/lulu/c.jpg ← 是 ben 的图
# 之前的穿越测试只试了跑出相册根的写法（../../etc/passwd），全被 realpath 挡住，
# 所以这条一直是绿的。

def test_穿越路径不能拿到别人组的图片_token(assigned, db, run, people):
    with pytest.raises(HTTPException) as e:
        run(api.photo_token({"album": "oral", "path": _SNEAKY}, db=db, user=people["anna"]))
    assert e.value.status_code in (400, 404)


def test_穿越路径不能读别人组的标注(assigned, db, run, people):
    with pytest.raises(HTTPException) as e:
        run(api.get_annotations(album="oral", path=_SNEAKY, db=db, user=people["anna"]))
    assert e.value.status_code in (400, 404)


def test_穿越路径不能往别人组的图上写框(assigned, db, run, people):
    with pytest.raises(HTTPException) as e:
        run(api.save_annotations(
            api.SaveIn(album="oral", path=_SNEAKY, items=[{"label_code": "canine", "bbox": [0.1, 0.1, 0.2, 0.2]}]),
            db=db, user=people["anna"],
        ))
    assert e.value.status_code in (400, 404)


def test_穿越路径不能绕过审核锁定(assigned, db, run, people):
    """更隐蔽的一层：穿越之后查到的是 anna 自己那条指派（open），
    lulu 组那条 approved 根本不会被查到，锁定检查直接落空。"""
    a = [r for r in run(api.list_assignments(album="oral", db=db, user=people["admin"]))["data"]
         if r["group_key"] == _G_LULU][0]
    run(api.save_annotations(api.SaveIn(album="oral", path=_LULU_1, items=[], state="done"), db=db, user=people["ben"]))
    run(api.submit_assignment(a["id"], db=db, user=people["ben"]))
    run(api.review_assignment(a["id"], api.ReviewIn(approve=True, note=None), db=db, user=people["reviewer"]))

    with pytest.raises(HTTPException) as e:
        run(api.save_annotations(
            api.SaveIn(album="oral", path=_SNEAKY, items=[{"label_code": "canine", "bbox": [0.1, 0.1, 0.2, 0.2]}]),
            db=db, user=people["anna"],
        ))
    assert e.value.status_code in (400, 404, 409)


def test_穿越路径不能用_sam_去点别人组的图(assigned, db, run, people, monkeypatch):
    from app.services import vision_sam_client as sam_client

    async def boom(*_a, **_k):
        raise AssertionError("权限没过就调了 SAM")

    monkeypatch.setattr(sam_client, "segment", boom)
    with pytest.raises(HTTPException) as e:
        run(api.sam_segment(
            api.SamIn(album="oral", path=_SNEAKY, points=[{"x": 0.5, "y": 0.5}]),
            db=db, user=people["anna"],
        ))
    assert e.value.status_code in (400, 404)


@pytest.mark.parametrize("bad", ["巴利/../lulu/c.jpg", "./2026-09-01-ok/巴利/a.jpg", "/2026-09-01-ok/巴利/a.jpg", "a//b/c.jpg"])
def test_不规范的路径一律拒掉(album, db, run, people, bad):
    """与其让 group_of 去猜这些写法算哪个组，不如在入口就拒掉。
    正常的前端永远不会发出这种路径。"""
    with pytest.raises(HTTPException):
        run(api.save_annotations(api.SaveIn(album="oral", path=bad, items=[]), db=db, user=people["admin"]))


# ── 鉴权覆盖 ────────────────────────────────────────────────────────────

def test_每个接口都必须有鉴权():
    """把路由从「整个 router 要管理员」改成「每个接口各自声明」的时候，
    /datasets 那两个漏掉了——DELETE 直接 rmtree，而且不需要登录。
    这种漏写没有任何报错，只能靠机械地数一遍。"""
    src = open("app/api/v1/vision.py", encoding="utf-8").read()
    naked = []
    for n in ast.walk(ast.parse(src)):
        if not isinstance(n, (ast.AsyncFunctionDef, ast.FunctionDef)):
            continue
        routes = [d for d in n.decorator_list
                  if isinstance(d, ast.Call) and getattr(d.func, "attr", "") in ("get", "post", "put", "delete")]
        if not routes:
            continue
        defaults = n.args.defaults + [d for d in n.args.kw_defaults if d]
        deps = [ast.unparse(d.args[0]) for d in defaults
                if isinstance(d, ast.Call) and getattr(d.func, "id", "") == "Depends" and d.args]
        if not any("get_current_user" in x or "require_role" in x for x in deps):
            naked.append(f"{routes[0].func.attr.upper()} {routes[0].args[0].value}")
    assert not naked, f"这些接口没有鉴权：{naked}"


def test_数据集列表和删除要管理员(album, db, run, people):
    """直接调 handler 会绕过 FastAPI 的 Depends，所以这里验的是依赖本身——
    上面那条 AST 测试保证了这两个接口确实挂着这个依赖。"""
    from app.core.deps import require_role

    checker = require_role(*api._MANAGERS)
    for who in ("anna", "reviewer"):
        with pytest.raises(HTTPException) as e:
            run(checker(user=people[who]))
        assert e.value.status_code == 403, who
    # 管理员能过
    assert run(checker(user=people["admin"])) is people["admin"]


# ── 不当探针 ────────────────────────────────────────────────────────────

def test_存在与否不能从错误里看出来(assigned, db, run, people):
    """三种情况必须给一模一样的回答，否则标注员可以拿它当探针，
    按 detail 的差别把整个相册的目录结构枚举出来（日期目录和狗名都是可猜的）。"""
    cases = [
        f"{_G_LULU}/c.jpg",        # 真有这张图，但不是 anna 的组
        f"{_G_LULU}/根本没有.jpg",   # 这张图不存在
        "2029-01-01-ok/谁/x.jpg",   # 连目录都不存在
    ]
    seen = set()
    for path in cases:
        with pytest.raises(HTTPException) as e:
            run(api.photo_token({"album": "oral", "path": path}, db=db, user=people["anna"]))
        seen.add((e.value.status_code, str(e.value.detail)))
    assert len(seen) == 1, f"回答不一致，可以当探针用：{seen}"
    # 而且不能把请求里的路径回显出来
    assert all(_G_LULU not in d for _, d in seen)


def test_读标注也不能当探针(assigned, db, run, people):
    seen = set()
    for path in (f"{_G_LULU}/c.jpg", f"{_G_LULU}/没有.jpg"):
        with pytest.raises(HTTPException) as e:
            run(api.get_annotations(album="oral", path=path, db=db, user=people["anna"]))
        seen.add((e.value.status_code, str(e.value.detail)))
    assert len(seen) == 1, f"回答不一致：{seen}"


def test_别人组的审核状态不能泄露(assigned, db, run, people):
    """approved 的检查排在归属判断之前时，anna 往 ben 组写会拿到
    409「已通过、锁定了」，而组没通过时是 404——一问就知道别人组审到哪了。"""
    a = [r for r in run(api.list_assignments(album="oral", db=db, user=people["admin"]))["data"]
         if r["group_key"] == _G_LULU][0]
    before = None
    with pytest.raises(HTTPException) as e:
        run(api.save_annotations(api.SaveIn(album="oral", path=_LULU_1, items=[]), db=db, user=people["anna"]))
    before = (e.value.status_code, str(e.value.detail))

    run(api.save_annotations(api.SaveIn(album="oral", path=_LULU_1, items=[], state="done"), db=db, user=people["ben"]))
    run(api.submit_assignment(a["id"], db=db, user=people["ben"]))
    run(api.review_assignment(a["id"], api.ReviewIn(approve=True, note=None), db=db, user=people["reviewer"]))

    with pytest.raises(HTTPException) as e2:
        run(api.save_annotations(api.SaveIn(album="oral", path=_LULU_1, items=[]), db=db, user=people["anna"]))
    after = (e2.value.status_code, str(e2.value.detail))
    assert before == after, f"审核前后回答不一样，泄露了别人组的状态：{before} → {after}"


def test_管理员仍然改不了已通过的组(assigned, db, run, people):
    """修上面那条泄露的时候，很容易把 approved 检查挪到 _is_manager 之后，
    那样「审过的结论管理员也不能静默改」这个不变量就破了。这条守住它。"""
    a = [r for r in run(api.list_assignments(album="oral", db=db, user=people["admin"]))["data"]
         if r["group_key"] == _G_BALI][0]
    run(api.save_annotations(api.SaveIn(album="oral", path=_BALI_1, items=[], state="done"), db=db, user=people["anna"]))
    run(api.submit_assignment(a["id"], db=db, user=people["anna"]))
    run(api.review_assignment(a["id"], api.ReviewIn(approve=True, note=None), db=db, user=people["reviewer"]))

    with pytest.raises(HTTPException) as e:
        run(api.save_annotations(
            api.SaveIn(album="oral", path=_BALI_1, items=[{"label_code": "canine", "bbox": [0.1, 0.1, 0.1, 0.1]}]),
            db=db, user=people["admin"],
        ))
    assert e.value.status_code == 409


# ── token 的有效期与吊销 ────────────────────────────────────────────────

def test_图片_token_的有效期要短(album):
    """token 是按 (album, rel_path) 签的纯 HMAC，不查库、不带身份、不可吊销。
    撤销指派之后它还能用，直到过期——所以这个"直到"必须足够短。
    4 小时（media_token_ttl_hours）对"把人移出项目"来说太长了。"""
    from app.core.config import settings
    from app.services import vision_service as vsvc

    assert vsvc.PHOTO_TOKEN_TTL_SEC <= 900, "视觉页的图片 token 不该复用 4 小时那个口径"
    assert vsvc.PHOTO_TOKEN_TTL_SEC < settings.media_token_ttl_hours * 3600


def test_撤销指派之后旧_token_很快失效(assigned, db, run, people, monkeypatch):
    """能在几分钟内自然失效，比"立刻吊销"便宜得多，也够用。
    这里验的是它确实按短 TTL 签的，不是按 4 小时。"""
    tok = run(api.photo_token({"album": "oral", "path": _BALI_1}, db=db, user=people["anna"]))["data"]["token"]
    expires_at = int(tok.split(".", 1)[0])

    import time
    assert expires_at - int(time.time()) <= svc.PHOTO_TOKEN_TTL_SEC + 2
