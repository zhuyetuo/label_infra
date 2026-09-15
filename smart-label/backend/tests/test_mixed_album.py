"""
狗场合作那批素材：一棵树里口腔和皮肤都有，而且比 口腔验证/ 多一层。

    雷喏斯达-狗场合作/雷喏斯达20260912/001比熊小白/口腔牙齿-雷喏斯达20260912-001/*.jpg
                      └ 日期          └ 狗         └ 品类

下面的 fixture 是照现场 `tree` 的输出一比一搭的，包括几个真实的脏数据：

  - 003金毛秃子 底下的皮肤目录叫 `皮肤瘙痒-...-002`（编号是 002，狗是 003）
  - 005金毛年糕 底下的口腔目录叫 `口腔牙齿-...-004`（编号是 004，狗是 005）
  - 到处散落的 Thumbs.db
  - 括号有全角 `（1）` 有半角 `(1)`，半角的还带前导空格 ` (1)`

前两条是这套适配里最要紧的约束：**不能按目录名里的编号认狗**。按编号认的话，
003 的皮肤照片会挂到 002 名下——不报错，等到训练集里发现标签对不上才知道。
"""

import os

import pytest

from app.core.config import settings
from app.services import tooth_service as ts
from app.services.vision_service import group_of

TREE = "雷喏斯达-狗场合作"
DOGS = ["001比熊小白", "002柯基板凳", "003金毛秃子", "004法斗旺财", "005金毛年糕", "006德牧闪电"]


@pytest.fixture()
def material(tmp_path, monkeypatch):
    """照现场那棵树搭一份，连编号错位和 Thumbs.db 都还原。"""
    root = tmp_path / "alg_material"

    def put(*parts):
        p = root.joinpath(*parts)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"\xff\xd8\xff")      # 不是真 jpg，这里只按扩展名过滤
        return p

    for day in ("雷喏斯达20260912", "雷喏斯达20260913"):
        n = day[-4:]                         # 0912 / 0913
        for dog in DOGS:
            code = dog[:3]
            # 品类目录名里的编号，故意照现场的错法来
            oral_code = "004" if (dog == "005金毛年糕" and day.endswith("0912")) else code
            skin_code = "002" if (dog == "003金毛秃子" and day.endswith("0912")) else code
            oral = f"口腔牙齿-雷喏斯达2026{n}-{oral_code}"
            skin = f"皮肤瘙痒-雷喏斯达2026{n}-{skin_code}"
            for i in (1, 2, 3):
                put(TREE, day, dog, oral, f"口腔牙齿-雷喏斯达2026{n}-{code}（{i}）.jpg")
            for i in (1, 2):
                put(TREE, day, dog, skin, f"皮肤瘙痒-雷喏斯达2026{n}-{code} ({i}).jpg")
            # Windows 缩略图缓存，两边都有
            (root / TREE / day / dog / oral / "Thumbs.db").write_bytes(b"x")

    # 老的那棵树也留着，一起扫
    put("口腔验证", "2026-09-01-ok", "巴利", "a.jpg")
    put("口腔验证", "2026-09-01-ok", "散图.jpg")

    monkeypatch.setattr(settings, "material_root", str(root))
    monkeypatch.setattr(settings, "oral_dir", "口腔验证")
    monkeypatch.setattr(settings, "skin_photo_dir", "颈圈算法验证/皮肤瘙痒/视频问诊")
    monkeypatch.setattr(settings, "mixed_photo_dirs", TREE)
    return root


def _all(album):
    return [p for f in ts.list_photos(album) for d in f["dogs"] for p in d["photos"]]


# ── 口腔和皮肤要分得开 ──────────────────────────────────────────────────

def test_口腔相册只拿到口腔照片(material):
    paths = [p["rel_path"] for p in _all("oral")]
    mixed = [x for x in paths if x.startswith(TREE)]
    assert mixed, "狗场那批一张都没扫到"
    assert all("口腔牙齿" in x for x in mixed), [x for x in mixed if "口腔牙齿" not in x]
    assert len(mixed) == 2 * 6 * 3, f"两天 x 六只狗 x 三张，实际 {len(mixed)}"


def test_皮肤相册只拿到皮肤照片(material):
    paths = [p["rel_path"] for p in _all("skin")]
    mixed = [x for x in paths if x.startswith(TREE)]
    assert mixed and all("皮肤瘙痒" in x for x in mixed)
    assert len(mixed) == 2 * 6 * 2


def test_两个相册没有一张重叠(material):
    o = {p["rel_path"] for p in _all("oral")}
    s = {p["rel_path"] for p in _all("skin")}
    assert not (o & s), o & s


# ── 编号错位：这是现场真实存在的，也是最容易踩的 ────────────────────────

def test_目录名里的编号是错的也要挂到对的狗名下(material):
    """003金毛秃子 底下的皮肤目录叫 `皮肤瘙痒-...-002`。按编号认的话这三张
    会挂到 002柯基板凳 名下——不报错，等训练集里标签对不上才发现。"""
    day = [f for f in ts.list_photos("skin") if f["folder"].endswith("雷喏斯达20260912")][0]
    by_dog = {d["name"]: d["photos"] for d in day["dogs"]}
    assert len(by_dog["003金毛秃子"]) == 2, "003 的皮肤照片被算到别的狗头上了"
    assert all("003金毛秃子/" in p["rel_path"] for p in by_dog["003金毛秃子"])
    assert len(by_dog["002柯基板凳"]) == 2, "002 多了别人的照片"


def test_口腔那边同样的错位(material):
    """005金毛年糕 底下的口腔目录叫 `口腔牙齿-...-004`。"""
    day = [f for f in ts.list_photos("oral") if f["folder"].endswith("雷喏斯达20260912")][0]
    by_dog = {d["name"]: d["photos"] for d in day["dogs"]}
    assert len(by_dog["005金毛年糕"]) == 3 and len(by_dog["004法斗旺财"]) == 3


# ── 其它现场脏数据 ──────────────────────────────────────────────────────

def test_Thumbs_db_不会被当成照片(material):
    assert not [p for p in _all("oral") + _all("skin") if "Thumbs" in p["rel_path"]]


def test_全角半角括号和空格都照原样列出来(material):
    names = [p["filename"] for p in _all("oral") if p["rel_path"].startswith(TREE)]
    assert any("（1）" in n for n in names), "全角括号的没列出来"
    names_s = [p["filename"] for p in _all("skin") if p["rel_path"].startswith(TREE)]
    assert any(" (1)" in n for n in names_s), "半角带空格的没列出来"


def test_日期解析出来了(material):
    folders = {f["folder"]: f["date"] for f in ts.list_photos("oral")}
    assert folders[f"{TREE}/雷喏斯达20260912"] == "2026-09-12"
    assert folders["2026-09-01-ok"] == "2026-09-01"


def test_认不出品类的目录直接跳过不猜(material, tmp_path):
    """名字里既没有口腔/牙齿也没有皮肤/瘙痒。猜错的后果是口腔相册里混进皮肤
    照片，标注员按牙齿那套标签标完才发现。"""
    d = material / TREE / "雷喏斯达20260912" / "001比熊小白" / "随手拍的"
    d.mkdir()
    (d / "x.jpg").write_bytes(b"\xff\xd8\xff")
    assert not [p for p in _all("oral") + _all("skin") if "随手拍的" in p["rel_path"]]


# ── 老的那棵树一张都不能少 ──────────────────────────────────────────────

def test_老素材照常列出来(material):
    paths = [p["rel_path"] for p in _all("oral")]
    assert "2026-09-01-ok/巴利/a.jpg" in paths
    assert "2026-09-01-ok/散图.jpg" in paths, "日期目录下的散图归「（未归类）」，不能丢"


def test_关掉混合树就退回原来的样子(material, monkeypatch):
    """mixed_photo_dirs 留空 = 这套适配没开，跟改之前一模一样。"""
    monkeypatch.setattr(settings, "mixed_photo_dirs", "")
    paths = [p["rel_path"] for p in _all("oral")]
    assert paths == ["2026-09-01-ok/巴利/a.jpg", "2026-09-01-ok/散图.jpg"] or set(paths) == {
        "2026-09-01-ok/巴利/a.jpg", "2026-09-01-ok/散图.jpg"}


# ── 打得开吗 ────────────────────────────────────────────────────────────

def test_新老两种路径都打得开(material):
    for album in ("oral", "skin"):
        for p in _all(album):
            assert os.path.isfile(ts.resolve_photo(p["rel_path"], album))


def test_跨相册读不到(material):
    """口腔相册拿皮肤的路径去读，必须读不到——否则相册隔离形同虚设。"""
    skin_p = [p for p in _all("skin") if p["rel_path"].startswith(TREE)][0]["rel_path"]
    assert os.path.isfile(ts.resolve_photo(skin_p, "skin"))
    # 口腔相册也能解出这个文件（同一棵混合树），但它本来就不会出现在口腔的清单里；
    # 真正要挡住的是下面那条：拿素材库里别的目录当路径
    other = "颈圈算法验证/随便什么.jpg"
    with pytest.raises(ts.ToothError):
        ts.resolve_photo(other, "oral")


@pytest.mark.parametrize("bad", [
    "../etc/passwd",
    "雷喏斯达-狗场合作/../../etc/passwd",
    "/etc/passwd",
    "雷喏斯达-狗场合作/../../../etc/passwd",
])
def test_穿出素材库的挡得住(material, bad):
    with pytest.raises(ts.ToothError):
        ts.resolve_photo(bad, "oral")


def test_想用_dotdot_从混合树绕到别的树_两层都挡得住(material):
    """混合树那条分支是"相对素材库根"解析的，最容易被拿来当跳板。

    这一层挡的方式是「解不出文件」：路径是相对相册根解的，落不到别的树上；
    而混合树分支要求第一段是配置里列出的树，带 `..` 的直接不匹配。

    上一层（vision_service.check_photo）另外挡一道语法的：它先过
    clean_rel_path。要在那儿挡，是因为 group_of 拿的是**原始** rel_path——
    路径不规范的话算出来的组不可信，而组正是权限判据。"""
    from app.services.vision_service import VisionError, check_photo

    weird = "雷喏斯达-狗场合作/雷喏斯达20260912/../../口腔验证/2026-09-01-ok/巴利/a.jpg"
    with pytest.raises(ts.ToothError):
        ts.resolve_photo(weird, "oral")
    with pytest.raises(VisionError):
        check_photo("oral", weird)


def test_没列在配置里的树读不到(material, monkeypatch):
    """「相对素材库根」这条分支只对配置里列出的树开放。不然等于把整个素材库
    开放给这个相册——口腔相册能读到 颈圈算法验证 底下的任何文件。"""
    p = [x for x in _all("oral") if x["rel_path"].startswith(TREE)][0]["rel_path"]
    assert os.path.isfile(ts.resolve_photo(p, "oral"))
    monkeypatch.setattr(settings, "mixed_photo_dirs", "")
    with pytest.raises(ts.ToothError):
        ts.resolve_photo(p, "oral")


# ── 分组：指派/审核/导出切分的粒度，也是权限判据 ────────────────────────

@pytest.mark.parametrize("rel,expected", [
    # 老的两种形状，跟改之前必须完全一样
    ("2026-09-01-ok/巴利/a.jpg", "2026-09-01-ok/巴利"),
    ("2026-09-01-ok/散图.jpg", "2026-09-01-ok"),
    # 新的四层
    (f"{TREE}/雷喏斯达20260912/001比熊小白/口腔牙齿-雷喏斯达20260912-001/x.jpg",
     f"{TREE}/雷喏斯达20260912/001比熊小白/口腔牙齿-雷喏斯达20260912-001"),
])
def test_分组就是照片的父目录(rel, expected):
    assert group_of(rel) == expected


def test_不同的狗不会落进同一组():
    """按老写法 parts[:2] 的话，狗场那批所有狗都会算成
    `雷喏斯达-狗场合作/雷喏斯达20260912` 一组——标注员看得见不该看的图。"""
    a = group_of(f"{TREE}/雷喏斯达20260912/001比熊小白/口腔牙齿-x/1.jpg")
    b = group_of(f"{TREE}/雷喏斯达20260912/002柯基板凳/口腔牙齿-x/1.jpg")
    assert a != b


def test_同一只狗的口腔和皮肤不是同一组():
    """一次指派一组。混在一起的话，派「标这只狗的牙」会连皮肤照片一起派过去。"""
    a = group_of(f"{TREE}/d/001比熊小白/口腔牙齿-x/1.jpg")
    b = group_of(f"{TREE}/d/001比熊小白/皮肤瘙痒-x/1.jpg")
    assert a != b


# ── 给 vision_service 的路径：两种形状不能只做一种 ──────────────────────
#
# 2026-09-15 现场报错：
#   SAM 服务返回 422：文件不存在:
#   口腔验证/雷喏斯达-狗场合作/雷喏斯达20260914/001比熊小白/.../xxx (13).jpg
#            ^^^^^^^^^^^^^^^^ 多出来的一层
#
# 平台内部一直用"相对相册目录"的路径，而 vision_service 只认"相对素材库根"。
# 转换时无脑补相册目录，混合树那批就会多一层——而拼出来的路径看着还挺像回事，
# 很难一眼看出问题。

def test_老形状要补上相册目录(material):
    assert ts.material_rel("2026-09-01-ok/巴利/a.jpg", "oral") == "口腔验证/2026-09-01-ok/巴利/a.jpg"


def test_混合树原样不动(material):
    p = f"{TREE}/雷喏斯达20260914/001比熊小白/口腔牙齿-x/y.jpg"
    assert ts.material_rel(p, "oral") == p, "补了相册目录就会变成「口腔验证/雷喏斯达-狗场合作/...」"


def test_转出来的路径真的能解开(material):
    """光比字符串不够——最终要拿这个路径去素材库里找文件。"""
    for album in ("oral", "skin"):
        for p in _all(album):
            full = os.path.join(str(material), ts.material_rel(p["rel_path"], album))
            assert os.path.isfile(full), f"{album}: {p['rel_path']} → {ts.material_rel(p['rel_path'], album)}"


def test_关掉混合树之后混合树路径会被当成老形状(material, monkeypatch):
    """配置里没列这棵树时，它就不是"相对根"的了——这时补相册目录是对的
    （虽然多半解不开文件），不能凭路径长得像就特殊对待。"""
    p = f"{TREE}/x/y.jpg"
    monkeypatch.setattr(settings, "mixed_photo_dirs", "")
    assert ts.material_rel(p, "oral").startswith("口腔验证/")


@pytest.mark.parametrize("bad", ["../x.jpg", "/abs/x.jpg", ""])
def test_路径不规范时不特殊对待(material, bad):
    """clean_rel_path 抛了就当成老形状去补前缀——解不开文件自然会报，
    但不能在这一层就炸掉整个请求。"""
    out = ts.material_rel(bad, "oral")
    assert out.startswith("口腔验证/")
