"""
视觉标注接口跑在真数据库上的测试（存得进、读得回、覆盖得干净）。

这是上一轮明确留下的验证缺口：当时只测了纯函数和"非法输入会不会被挡住"，
没测"存进去能不能原样读回来"。而那一段恰恰最容易静默出错——字段拼错、JSON 存成
字符串的字符串、覆盖保存没删干净，纯函数测试一个都发现不了。

数据库是真的 sqlite（见 conftest.py 的说明），接口函数也是真的，没有重写一份逻辑。
"""

import json
import os

import pytest
from fastapi import HTTPException

from app.api.v1 import vision as api
from app.models.user import User, UserRole
from app.models.vision_annotation import VisionAnnotation, VisionAsset
from app.services import vision_service as svc

_JPEG = bytes.fromhex("ffd8ffe000104a46494600010100000100010000ffdb004300" + "10" * 64 + "ffd9")
_P1 = "2026-09-01-ok/巴利/a.jpg"
_P2 = "2026-09-01-ok/巴利/b.jpg"


@pytest.fixture()
def album(tmp_path, monkeypatch):
    """临时素材库，照片是真文件——路径沙箱会去 stat 它们"""
    from app.core.config import settings

    material = tmp_path / "material"
    for rel in (_P1, _P2):
        p = material / "口腔验证" / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(_JPEG)
    monkeypatch.setattr(settings, "material_root", str(material))
    monkeypatch.setattr(settings, "oral_dir", "口腔验证")
    monkeypatch.setattr(settings, "nas_root", str(tmp_path / "nas"))
    return material


@pytest.fixture()
def user(db, run):
    u = User(username="tester", display_name="测试员", password_hash="x", role=UserRole.admin, is_active=True)
    db.add(u)
    run(db.commit())
    return u


def _save(run, db, user, **kw):
    body = api.SaveIn(album="oral", path=_P1, **kw)
    return run(api.save_annotations(body, db=db, user=user))


def test_存进去能原样读回来(album, db, user, run):
    _save(
        run, db, user,
        items=[
            {"label_code": "canine", "bbox": [0.1, 0.2, 0.3, 0.4], "attrs": {"ci": 2, "tooth_code": 104}},
            {"label_code": "molar", "bbox": [0.5, 0.5, 0.2, 0.2], "attrs": {}},
        ],
        asset_attrs={"view_code": "left"},
        width=1920, height=1080,
    )
    got = run(api.get_annotations(album="oral", path=_P1, db=db, user=user))["data"]

    assert [i["label_code"] for i in got["items"]] == ["canine", "molar"]
    # bbox 必须是数字列表，不是 JSON 字符串——这一条错了前端画不出框，但后端不报错
    assert got["items"][0]["bbox"] == [0.1, 0.2, 0.3, 0.4]
    assert got["items"][0]["attrs"] == {"ci": 2, "tooth_code": 104}
    assert got["asset"]["attrs"] == {"view_code": "left"}
    assert got["asset"]["state"] == "done"
    assert (got["asset"]["width"], got["asset"]["height"]) == (1920, 1080)


def test_没标过的图返回默认状态而不是报错(album, db, user, run):
    got = run(api.get_annotations(album="oral", path=_P2, db=db, user=user))["data"]
    assert got["items"] == []
    assert got["asset"]["state"] == "todo"


def test_再次保存是覆盖不是追加(album, db, user, run):
    _save(run, db, user, items=[{"label_code": "canine", "bbox": [0.1, 0.1, 0.1, 0.1]}])
    _save(run, db, user, items=[{"label_code": "molar", "bbox": [0.2, 0.2, 0.2, 0.2]}])

    got = run(api.get_annotations(album="oral", path=_P1, db=db, user=user))["data"]
    assert [i["label_code"] for i in got["items"]] == ["molar"], "旧的框没删干净，攒成了两份"
    rows = run(db.execute(VisionAnnotation.__table__.select())).all()
    assert len(rows) == 1, "库里残留了上一次的行"


def test_清空框之后状态还在(album, db, user, run):
    """全删光 + 标 done = 显式负样本。asset 行必须留着，不能跟着框一起消失——
    它消失了，导出时这张图就从「确认没有目标」退回「还没标」。"""
    _save(run, db, user, items=[{"label_code": "canine", "bbox": [0.1, 0.1, 0.1, 0.1]}])
    _save(run, db, user, items=[], state="done")

    got = run(api.get_annotations(album="oral", path=_P1, db=db, user=user))["data"]
    assert got["items"] == []
    assert got["asset"]["state"] == "done"


def test_跳过要记下原因(album, db, user, run):
    _save(run, db, user, items=[], state="skipped", skip_reason="糊了")
    got = run(api.get_annotations(album="oral", path=_P1, db=db, user=user))["data"]
    assert got["asset"]["state"] == "skipped"
    assert got["asset"]["skip_reason"] == "糊了"


def test_bbox_越界会被夹回去(album, db, user, run):
    _save(run, db, user, items=[{"label_code": "canine", "bbox": [-0.5, 0.9, 5.0, 5.0]}])
    box = run(api.get_annotations(album="oral", path=_P1, db=db, user=user))["data"]["items"][0]["bbox"]
    assert box == [0.0, 0.9, 1.0, 0.1], box


def test_不存在的照片存不进去(album, db, user, run):
    # 保存走 400（请求里给的路径不对），读取走 404（这张图没有）——两条路都不能放行
    with pytest.raises(HTTPException) as e:
        run(api.save_annotations(api.SaveIn(album="oral", path="不存在/x.jpg", items=[]), db=db, user=user))
    assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e2:
        run(api.get_annotations(album="oral", path="不存在/x.jpg", db=db, user=user))
    assert e2.value.status_code == 404


def test_路径穿越存不进去(album, db, user, run):
    for bad in ("../../etc/passwd", "..", "巴利/../../../../etc/hosts"):
        with pytest.raises(HTTPException) as e:
            run(api.save_annotations(api.SaveIn(album="oral", path=bad, items=[]), db=db, user=user))
        assert e.value.status_code == 400, bad


def test_统计按类别和状态汇总(album, db, user, run):
    _save(run, db, user, items=[
        {"label_code": "canine", "bbox": [0.1, 0.1, 0.1, 0.1]},
        {"label_code": "canine", "bbox": [0.3, 0.3, 0.1, 0.1]},
        {"label_code": "molar", "bbox": [0.5, 0.5, 0.1, 0.1]},
    ])
    run(api.save_annotations(api.SaveIn(album="oral", path=_P2, items=[], state="skipped"), db=db, user=user))

    got = run(api.stats(album="oral", db=db, user=user))["data"]
    assert got["total_boxes"] == 3
    assert {r["label_code"]: r["n"] for r in got["by_label"]} == {"canine": 2, "molar": 1}
    assert {r["state"]: r["n"] for r in got["by_state"]} == {"done": 1, "skipped": 1}


def test_两个相册的标注互不干扰(album, db, user, run, tmp_path, monkeypatch):
    """oral 和 skin 是两套类别。相册串了的话，导出时会把对方的框全丢掉。"""
    from app.core.config import settings

    skin_rel = "2026-09-01-ok/lulu/s.jpg"
    p = tmp_path / "material" / "皮肤" / skin_rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(_JPEG)
    monkeypatch.setattr(settings, "skin_photo_dir", "皮肤")

    _save(run, db, user, items=[{"label_code": "canine", "bbox": [0.1, 0.1, 0.1, 0.1]}])
    run(api.save_annotations(
        api.SaveIn(album="skin", path=skin_rel, items=[{"label_code": "erythema", "bbox": [0.2, 0.2, 0.2, 0.2]}]),
        db=db, user=user,
    ))

    assert run(api.stats(album="oral", db=db, user=user))["data"]["total_boxes"] == 1
    assert run(api.stats(album="skin", db=db, user=user))["data"]["total_boxes"] == 1
    oral = run(api.get_annotations(album="oral", path=_P1, db=db, user=user))["data"]
    assert [i["label_code"] for i in oral["items"]] == ["canine"]


def test_导出跑通整条链路(album, db, user, run):
    """从接口存 → 从接口导 → 落盘的文件真能对上。这是整条链路唯一一次端到端。"""
    _save(run, db, user, items=[
        {"label_code": "canine", "bbox": [0.1, 0.1, 0.2, 0.2]},
        {"label_code": "incisor", "bbox": [0.5, 0.5, 0.1, 0.1]},
    ])
    run(api.save_annotations(api.SaveIn(album="oral", path=_P2, items=[], state="done"), db=db, user=user))

    meta = run(api.export_dataset(api.ExportIn(album="oral", name="e2e", val_ratio=0.0), db=db, user=user))["data"]
    assert meta["n_images"] == 2
    assert meta["total_boxes"] == 2
    assert meta["negatives"]["train"] == 1  # _P2 标完且零框

    from app.services import vision_export_service as exp
    root = exp.dataset_root("e2e")
    txts = sorted(os.listdir(os.path.join(root, "labels", "train")))
    assert len(txts) == 2
    content = {t: open(os.path.join(root, "labels", "train", t), encoding="utf-8").read() for t in txts}
    assert sum(1 for v in content.values() if v == "") == 1, "负样本应该正好一个空 txt"
    lines = [ln for v in content.values() for ln in v.splitlines()]
    assert set(lines) == {"1 0.200000 0.200000 0.200000 0.200000", "0 0.550000 0.550000 0.100000 0.100000"}

    manifest = json.load(open(os.path.join(root, "manifest.json"), encoding="utf-8"))
    assert {m["rel_path"] for m in manifest} == {_P1, _P2}


def test_没有标完的图就导出会明确报错(album, db, user, run):
    _save(run, db, user, items=[{"label_code": "canine", "bbox": [0.1, 0.1, 0.1, 0.1]}], state="todo")
    with pytest.raises(HTTPException) as e:
        run(api.export_dataset(api.ExportIn(album="oral", name="empty", val_ratio=0.0), db=db, user=user))
    assert e.value.status_code == 400
    assert "标完" in str(e.value.detail)


def test_迁移和模型的列必须一一对应():
    """模型加了列、迁移忘了建，是最经典的坑：本地 create_all 能跑，上线就 500。"""
    import ast

    src = open("alembic/versions/c8e1a4d70f52_add_vision_prototype_tables.py", encoding="utf-8").read()
    mig = {}
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.Call) and getattr(node.func, "attr", "") == "create_table":
            mig[node.args[0].value] = {
                a.args[0].value for a in node.args[1:]
                if isinstance(a, ast.Call) and getattr(a.func, "attr", "") == "Column"
            }
    for model in (VisionAsset, VisionAnnotation):
        cols = {c.name for c in model.__table__.columns}
        assert mig.get(model.__tablename__) == cols, model.__tablename__


def test_属性里的_none_不会被存下来(album, db, user, run):
    """前端清空一个下拉会传 None 过来。存成 null 的话，读回去前端到处要判空。"""
    _save(run, db, user, items=[{"label_code": "canine", "bbox": [0.1, 0.1, 0.1, 0.1], "attrs": {"ci": 1, "gi": None}}])
    attrs = run(api.get_annotations(album="oral", path=_P1, db=db, user=user))["data"]["items"][0]["attrs"]
    assert attrs == {"ci": 1}


def test_脏数据不会让接口炸掉(album, db, user, run):
    """手工改库、或者以后改了字段格式，读的时候不能整页打不开。"""
    _save(run, db, user, items=[{"label_code": "canine", "bbox": [0.1, 0.1, 0.1, 0.1]}])
    row = run(db.execute(VisionAnnotation.__table__.select())).first()
    run(db.execute(
        VisionAnnotation.__table__.update()
        .where(VisionAnnotation.__table__.c.id == row.id)
        .values(bbox="这不是json", attrs="也不是")
    ))
    run(db.commit())

    got = run(api.get_annotations(album="oral", path=_P1, db=db, user=user))["data"]
    assert got["items"][0]["bbox"] == [0.0, 0.0, 0.0, 0.0]
    assert got["items"][0]["attrs"] == {}


def test_未知相册被挡住(db, user, run):
    with pytest.raises(HTTPException) as e:
        run(api.get_labels(album="乱写", user=user))
    assert e.value.status_code == 400
    with pytest.raises(HTTPException):
        run(api.stats(album="乱写", db=db, user=user))


def test_类别体系没有重复热键():
    for a in ("oral", "skin"):
        labels = svc.catalog(a)["labels"]
        assert len({x["hotkey"] for x in labels}) == len(labels), a
        assert len({x["code"] for x in labels}) == len(labels), a


def test_拿不准的图能在列表上筛出来(album, db, user, run):
    """一个人全流程干的时候，"标不准就问兽医"不能是标一张问一次——
    打个标接着往下标，攒一批让兽医一次看完。列表上得能筛出来才成立。"""
    _save(run, db, user, items=[], state="done", asset_attrs={"need_vet": "yes"})
    run(api.save_annotations(api.SaveIn(album="oral", path=_P2, items=[], state="done"), db=db, user=user))

    got = run(api.list_photos(album="oral", db=db, user=user))["data"]
    flags = {p["filename"]: p["need_vet"] for f in got["folders"] for d in f["dogs"] for p in d["photos"]}
    assert flags == {"a.jpg": True, "b.jpg": False}, flags


def test_皮肤第一版只有三类(db, user, run):
    """用户拍板：先做 3 类。砍掉的那三类样本会太少，标了也白标。"""
    got = run(api.get_labels(album="skin", user=user))["data"]
    assert [l["code"] for l in got["labels"]] == ["erythema", "alopecia", "excoriation"]
    assert [l["hotkey"] for l in got["labels"]] == ["1", "2", "3"]


def test_砍掉的皮肤类别存不进去(album, db, user, run, tmp_path, monkeypatch):
    """类别表里没有就一律拒——不然关掉的类别还能从接口塞进来，
    导出时又被当成"不认识的类别"丢弃并整张排除，白标一场。"""
    from app.core.config import settings

    rel = "2026-09-01-ok/lulu/s.jpg"
    p = tmp_path / "material" / "皮肤" / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(_JPEG)
    monkeypatch.setattr(settings, "skin_photo_dir", "皮肤")

    with pytest.raises(HTTPException) as e:
        run(api.save_annotations(
            api.SaveIn(album="skin", path=rel, items=[{"label_code": "crust", "bbox": [0.1, 0.1, 0.1, 0.1]}]),
            db=db, user=user,
        ))
    assert e.value.status_code == 400


@pytest.mark.parametrize("bad", [
    {"tooth_code": 111},   # 犬上颌只有 2 颗臼齿，111/211 不存在
    {"tooth_code": 211},
    {"tooth_code": 999},
    {"ci": 4},             # 分级只有 0-3
    {"ci": -1},
    {"view_code": "背面"},
    {"随便写的键": 1},
])
def test_属性值域在后端也守着(album, db, user, run, bad):
    """值域只写在前端是不够的：接口照收的话，手工调接口或者以后换个前端
    就能写进来，而一个不存在的牙位进了导出，训练时就是个永远学不会的类别。"""
    key = next(iter(bad))
    with pytest.raises(HTTPException) as e:
        if key in ("view_code",):
            _save(run, db, user, items=[], asset_attrs=bad)
        else:
            _save(run, db, user, items=[{"label_code": "canine", "bbox": [0.1, 0.1, 0.1, 0.1], "attrs": bad}])
    assert e.value.status_code == 400, bad


def test_111_被拒时说清楚为什么(album, db, user, run):
    with pytest.raises(HTTPException) as e:
        _save(run, db, user, items=[{"label_code": "canine", "bbox": [0.1, 0.1, 0.1, 0.1], "attrs": {"tooth_code": 111}}])
    assert "不存在" in str(e.value.detail)
    assert "110" in str(e.value.detail), "要告诉他正确的上限是多少"
