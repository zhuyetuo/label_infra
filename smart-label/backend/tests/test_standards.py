"""评级标准原件：上传（同名不覆盖、留历史版本）、列表最新在前、凭证下载"""
from fastapi.testclient import TestClient

from app.api.v1 import standards as api
from app.core.deps import get_current_user
from app.main import app
from app.models.user import User, UserRole


def _admin():
    return User(id=1, username="boss", display_name="管理员", role=UserRole.admin, is_active=True,
                is_outsourced=False, must_change_password=False, token_version=0)


def test_上传_列表_下载(tmp_path, monkeypatch):
    monkeypatch.setattr(api.settings, "nas_root", str(tmp_path))
    monkeypatch.setattr(api.settings, "log_dir", str(tmp_path / "logs"))   # 上传后后台转 PDF 的缓存别落到代码目录里
    app.dependency_overrides[get_current_user] = _admin
    try:
        c = TestClient(app)
        r1 = c.post("/api/v1/standards/skin/upload", files={"file": ("犬只皮肤评估-2026.11.pptx", b"v1")})
        assert r1.json()["data"]["name"] == "犬只皮肤评估-2026.11.pptx"
        r2 = c.post("/api/v1/standards/skin/upload", files={"file": ("犬只皮肤评估-2026.11.pptx", b"v2")})
        assert r2.json()["data"]["name"] != "犬只皮肤评估-2026.11.pptx"      # 同名不覆盖
        assert c.post("/api/v1/standards/skin/upload", files={"file": ("x.exe", b"x")}).status_code == 422
        files = c.get("/api/v1/standards/skin").json()["data"]["files"]
        assert len(files) == 2
        f = files[0]
        got = c.get("/api/v1/standards/skin/file", params={"name": f["name"], "token": f["token"]})
        assert got.status_code == 200 and got.content in (b"v1", b"v2")
        assert c.get("/api/v1/standards/skin/file", params={"name": f["name"], "token": "bad"}).status_code == 403
        assert c.get("/api/v1/standards/skin/file", params={"name": "../../etc/passwd.pdf", "token": f["token"]}).status_code == 403
    finally:
        app.dependency_overrides.clear()


def test_在线看_PDF原样_没装LibreOffice时说清楚(tmp_path, monkeypatch):
    import shutil
    monkeypatch.setattr(api.settings, "nas_root", str(tmp_path))
    monkeypatch.setattr(api.settings, "log_dir", str(tmp_path / "logs"))
    monkeypatch.setattr(shutil, "which", lambda name: None)
    app.dependency_overrides[get_current_user] = _admin
    try:
        c = TestClient(app)
        c.post("/api/v1/standards/skin/upload", files={"file": ("a.pdf", b"%PDF-1.4 x")})
        c.post("/api/v1/standards/skin/upload", files={"file": ("b.pptx", b"pk")})
        fs = {f["name"]: f for f in c.get("/api/v1/standards/skin").json()["data"]["files"]}
        r = c.get("/api/v1/standards/skin/view", params={"name": "a.pdf", "token": fs["a.pdf"]["token"]})
        assert r.status_code == 200 and r.headers["content-type"].startswith("application/pdf")
        r = c.get("/api/v1/standards/skin/view", params={"name": "b.pptx", "token": fs["b.pptx"]["token"]})
        assert r.status_code == 501 and "LibreOffice" in r.json()["msg"]
    finally:
        app.dependency_overrides.clear()
