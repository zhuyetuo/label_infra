"""看皮肤照片提速：目录扫描缓存、批量凭证、缩略图"""
import os

from PIL import Image

from app.api.v1 import material as api
from app.services import tooth_service as svc


def test_扫描结果缓存_过期先给旧的(monkeypatch):
    calls = []
    monkeypatch.setattr(svc, "list_photos", lambda album: calls.append(album) or [{"folder": f"f{len(calls)}"}])
    monkeypatch.setattr(svc, "scan_report", lambda album: [])
    svc._list_cache.clear()
    a = svc.list_photos_cached("skin")
    b = svc.list_photos_cached("skin")
    assert a == b and len(calls) == 1
    # 过期：马上返回旧的，后台再扫
    t, f, r = svc._list_cache["skin"]
    svc._list_cache["skin"] = (t - svc.LIST_TTL_S - 1, f, r)
    c = svc.list_photos_cached("skin")
    assert c[0] == a[0]
    svc._list_cache.clear()


def test_缩略图_缩小并缓存(tmp_path, monkeypatch):
    monkeypatch.setattr(api.settings, "log_dir", str(tmp_path / "logs"))
    src = tmp_path / "big.jpg"
    Image.new("RGB", (3000, 2000), "red").save(src)
    out = api._thumb(str(src), 360)
    with Image.open(out) as im:
        assert max(im.size) == 360
    assert api._thumb(str(src), 360) == out and os.path.getsize(out) < os.path.getsize(src)


def test_批量凭证(db, run):
    from tests.test_segment_review import _world
    w = _world(db, run)
    got = run(api.photo_tokens("skin", api.TokensIn(paths=["a/b/1.jpg", "a/b/2.jpg"]), w.ann))["data"]
    assert set(got) == {"a/b/1.jpg", "a/b/2.jpg"}
    assert svc.verify_photo_token("a/b/1.jpg", got["a/b/1.jpg"], "skin")
