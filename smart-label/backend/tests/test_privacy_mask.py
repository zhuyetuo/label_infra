"""隐私遮罩：开了的项目里，除超级管理员外只拿得到遮罩版；没做好宁可 403 也不退回原版。"""

import json
import os

import pytest
from fastapi import HTTPException

from app.api.v1 import media as media_api
from app.api.v1 import projects as projects_api
from app.core.config import settings
from app.core.media_token import issue_media_token, media_token_variant, variant_for
from app.models.media_file import MediaFile, MediaFileType
from app.models.user import User, UserRole
from app.services import privacy_mask as pm
from tests.test_segment_review import _world


@pytest.fixture
def nas(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "nas_root", str(tmp_path))
    (tmp_path / "a.mp4").write_bytes(b"ORIGINAL")
    pm.clear_cache()
    yield tmp_path
    pm.clear_cache()


def _make_masked(nas, rel="a.mp4"):
    src = nas / rel
    dst = nas / pm.MASK_DIR / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(b"MASKED")
    st = os.stat(src)
    (nas / pm.MASK_DIR / (rel + ".json")).write_text(json.dumps(
        {"ok": True, "src": {"size": st.st_size, "mtime": int(st.st_mtime)}}), encoding="utf-8")
    pm.clear_cache()


def _super(db, run):
    u = User(username="root", password_hash="x", display_name="超管", role=UserRole.super_admin)
    db.add(u)
    run(db.commit())
    return u


# ── token 身份 ─────────────────────────────────────────────────────────

def test_token_身份签进去_改不了():
    t = issue_media_token(7, "s")
    assert media_token_variant(7, t) == "s"
    assert media_token_variant(7, issue_media_token(7)) == ""
    # 把普通 token 篡改成超管的不行
    exp, sig = issue_media_token(7).split(".")
    assert media_token_variant(7, f"{exp}.s.{sig}") is None
    assert media_token_variant(8, t) is None


def test_只有超级管理员拿得到原版身份(db, run):
    w = _world(db, run)
    root = _super(db, run)
    assert variant_for(w.admin) == "" and variant_for(w.ann) == "" and variant_for(w.rev) == ""
    assert variant_for(root) == "s" and variant_for(root, want_mask=True) == "m"


# ── 选哪一份 ───────────────────────────────────────────────────────────

def test_没开遮罩_照常原版(db, run, nas):
    w = _world(db, run)
    assert run(pm.pick_video(db, w.ann, "a.mp4")) == "a.mp4"


def test_开了遮罩_没做好_非超管403_不退回原版(db, run, nas):
    w = _world(db, run)
    w.p.privacy_mask = True
    run(db.commit())
    for u in (w.ann, w.rev, w.admin):
        with pytest.raises(HTTPException) as e:
            run(pm.pick_video(db, u, "a.mp4"))
        assert e.value.status_code == 403
    assert run(pm.pick_video(db, _super(db, run), "a.mp4")) == "a.mp4"


def test_开了遮罩_做好了_给遮罩版(db, run, nas):
    w = _world(db, run)
    w.p.privacy_mask = True
    run(db.commit())
    _make_masked(nas)
    assert run(pm.pick_video(db, w.ann, "a.mp4")) == f"{pm.MASK_DIR}/a.mp4"
    root = _super(db, run)
    assert run(pm.pick_video(db, root, "a.mp4")) == "a.mp4"
    assert run(pm.pick_video(db, root, "a.mp4", prefer_mask=True)) == f"{pm.MASK_DIR}/a.mp4"


def test_原视频变了_遮罩版作废(db, run, nas):
    w = _world(db, run)
    w.p.privacy_mask = True
    run(db.commit())
    _make_masked(nas)
    (nas / "a.mp4").write_bytes(b"RE-IMPORTED, LONGER")
    pm.clear_cache()
    with pytest.raises(HTTPException):
        run(pm.pick_video(db, w.ann, "a.mp4"))


# ── 视频流：token 是开关之前签的也挡得住 ────────────────────────────────

class _Req:
    headers: dict = {}


def _stream_body(run, db, fid, token):
    resp = run(media_api.stream_media(fid, token, _Req(), db=db))
    chunks = []

    async def drain():
        async for c in resp.body_iterator:
            chunks.append(c if isinstance(c, bytes) else c.encode())

    run(drain())
    return b"".join(chunks)


def test_视频流_开了遮罩只吐遮罩版_超管照常原版(db, run, nas):
    w = _world(db, run)
    mf = MediaFile(file_type=MediaFileType.raw_video, relative_path="a.mp4", content_type="video/mp4")
    db.add(mf)
    run(db.commit())
    tok_ann = issue_media_token(mf.id, variant_for(w.ann))     # 开遮罩之前签的
    assert _stream_body(run, db, mf.id, tok_ann) == b"ORIGINAL"
    w.p.privacy_mask = True
    run(db.commit())
    pm.clear_cache()
    with pytest.raises(HTTPException) as e:
        _stream_body(run, db, mf.id, tok_ann)
    assert e.value.status_code == 403
    _make_masked(nas)
    assert _stream_body(run, db, mf.id, tok_ann) == b"MASKED"
    root = _super(db, run)
    assert _stream_body(run, db, mf.id, issue_media_token(mf.id, variant_for(root))) == b"ORIGINAL"


def test_签token时就告诉标注员看不了(db, run, nas):
    w = _world(db, run)
    mf = MediaFile(file_type=MediaFileType.raw_video, relative_path="a.mp4", content_type="video/mp4")
    db.add(mf)
    w.p.privacy_mask = True
    run(db.commit())
    with pytest.raises(HTTPException) as e:
        run(media_api.get_media_token(mf.id, user=w.admin, db=db))
    assert e.value.status_code == 403


# ── 开关 ───────────────────────────────────────────────────────────────

def test_没处理完不让开(db, run, nas):
    w = _world(db, run)
    root = _super(db, run)
    with pytest.raises(HTTPException) as e:
        run(projects_api.privacy_mask_toggle(w.p.id, projects_api.PrivacyMaskToggleIn(enabled=True), db=db, user=root))
    assert e.value.status_code == 409
    _make_masked(nas)
    run(projects_api.privacy_mask_toggle(w.p.id, projects_api.PrivacyMaskToggleIn(enabled=True), db=db, user=root))
    run(db.refresh(w.p))
    assert w.p.privacy_mask is True
    # 关掉随时可以，关了马上恢复原版（缓存清掉）
    run(projects_api.privacy_mask_toggle(w.p.id, projects_api.PrivacyMaskToggleIn(enabled=False), db=db, user=root))
    assert run(pm.pick_video(db, w.ann, "a.mp4")) == "a.mp4"


# ── 别的出画面的口子：夜视 / 缩略图 / 划区域取帧 都只从遮罩版取 ─────────────

def test_夜视和缩略图_也只从遮罩版取(db, run, nas, monkeypatch):
    from app.api.v1 import candidates as cand_api
    from app.api.v1 import daily_stats as ds_api
    from app.api.v1 import samples as samples_api
    from app.services import vision_sam_client as vsc

    w = _world(db, run)
    w.p.privacy_mask = True
    run(db.commit())
    _make_masked(nas)
    seen = []

    async def fake_lowlight(path, *a, **kw):
        seen.append(path)
        return {}

    async def fake_thumb(path, t, **kw):
        seen.append(path)
        return b"jpg"

    monkeypatch.setattr(vsc, "lowlight", fake_lowlight)
    monkeypatch.setattr(vsc, "lowlight_seq", fake_lowlight)
    monkeypatch.setattr(vsc, "embed_thumb", fake_thumb)
    sid = w.t.sample_id
    run(samples_api.sample_lowlight(sid, cam="cam1", t=1.0, db=db, user=w.ann))
    run(samples_api.sample_lowlight_seq(sid, cam="cam1", start=0.0, end=2.0, db=db, user=w.ann))
    run(cand_api.similar_thumb(w.t.id, "a.mp4", 1.0, issue_media_token(w.t.id, variant_for(w.ann)), db=db))
    run(ds_api.frame(sample_id=sid, slot="cam1", t=1.0, token=issue_media_token(sid, variant_for(w.admin)), db=db))
    assert seen == [f"{pm.MASK_DIR}/a.mp4"] * 4
    # 超管的 token：原版
    seen.clear()
    root = _super(db, run)
    run(ds_api.frame(sample_id=sid, slot="cam1", t=1.0, token=issue_media_token(sid, variant_for(root)), db=db))
    assert seen == ["a.mp4"]


def test_先试一个任务_只交这个任务的视频_插到最前(db, run, nas, monkeypatch):
    from app.services import vision_sam_client as vsc

    w = _world(db, run)
    root = _super(db, run)
    got = {}

    async def fake_submit(paths, force=False, **kw):
        got.update(paths=paths, **kw)
        return {"queued": len(paths), "skipped": 0}

    monkeypatch.setattr(vsc, "privacy_mask_submit", fake_submit)
    r = run(projects_api.privacy_mask_run(w.p.id, projects_api.PrivacyMaskRunIn(task_ids=[w.t.id]), db=db, user=root))
    assert r["data"]["queued"] == 1 and got["paths"] == ["a.mp4"] and got["front"] is True
    with pytest.raises(HTTPException):
        run(projects_api.privacy_mask_run(w.p.id, projects_api.PrivacyMaskRunIn(task_ids=[999999]), db=db, user=root))


def test_停止只停这个项目的视频(db, run, nas, monkeypatch):
    from app.services import vision_sam_client as vsc

    w = _world(db, run)
    root = _super(db, run)
    got = {}

    async def fake_ctl(action, paths=None):
        got.update(action=action, paths=paths)
        return {"removed": 1, "stopping": 0}

    monkeypatch.setattr(vsc, "privacy_mask_control", fake_ctl)
    run(projects_api.privacy_mask_control(w.p.id, projects_api.PrivacyMaskControlIn(action="cancel"), db=db, user=root))
    assert got == {"action": "cancel", "paths": ["a.mp4"]}
    run(projects_api.privacy_mask_control(w.p.id, projects_api.PrivacyMaskControlIn(action="pause"), db=db, user=root))
    assert got == {"action": "pause", "paths": None}
