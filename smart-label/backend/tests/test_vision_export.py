"""
视觉标注导出的测试。不需要数据库——导出的核心是纯函数 plan_dataset，
落盘那步只要一个临时目录。

这里的重点不是"跑通"，是守住三条一错就会静默毁掉数据集、而且事后查不出来的规则：

  1. state='done' 且零个框 → 空 txt（真背景图）；state='todo' → 一律不进。
     分不清这两者，模型会从漏标的图上学到"这里不该有目标"。
  2. 一张图的框要是全被丢弃（类别不在表里），整张排除，**绝不能**当成负样本。
     这条是写测试时才发现的：一张皮肤类别混进口腔相册的图正好走到那条路上，
     被当成了"人工确认过这里没有牙"。
  3. bbox 从左上角原点换算到 YOLO 的中心点。算错不报任何错，只会让模型
     系统性地学偏半个框。
"""

import json
import os

import pytest

from app.services import vision_export_service as exp

# 最小的合法 JPEG：复制、取大小都要真走一遍文件系统，空文件糊弄不过去
_JPEG = bytes.fromhex("ffd8ffe000104a46494600010100000100010000ffdb004300" + "10" * 64 + "ffd9")

_PHOTOS = [
    "2026-09-01-ok/巴利/a.jpg",
    "2026-09-01-ok/巴利/b.jpg",
    "2026-09-01-ok/lulu/c.jpg",
    "2026-09-02-ok/bibi/d.jpg",
    "2026-09-02-ok/bibi/e.png",
    "2026-09-02-ok/（未归类）/f.jpg",
    "2026-09-03-ok/巴利/g.jpg",
]

_ASSETS = [
    {"rel_path": "2026-09-01-ok/巴利/a.jpg", "state": "done"},
    {"rel_path": "2026-09-01-ok/巴利/b.jpg", "state": "done"},      # 零框 → 负样本
    {"rel_path": "2026-09-01-ok/lulu/c.jpg", "state": "done"},
    {"rel_path": "2026-09-02-ok/bibi/d.jpg", "state": "todo"},      # 有框也不该进
    {"rel_path": "2026-09-02-ok/bibi/e.png", "state": "skipped"},
    {"rel_path": "2026-09-02-ok/（未归类）/f.jpg", "state": "done"},  # 框全被丢 → 整张排除
    {"rel_path": "2026-09-03-ok/巴利/g.jpg", "state": "done"},
]

_BOXES = {
    "2026-09-01-ok/巴利/a.jpg": [
        {"label_code": "canine", "bbox": [0.1, 0.1, 0.2, 0.2]},
        {"label_code": "incisor", "bbox": [0.5, 0.5, 0.1, 0.1]},
    ],
    "2026-09-01-ok/lulu/c.jpg": [{"label_code": "molar", "bbox": [0.0, 0.0, 1.0, 1.0]}],
    # 皮肤的类别混进了口腔相册（改过类别名、或者手工改库留下的脏数据）
    "2026-09-02-ok/（未归类）/f.jpg": [{"label_code": "erythema", "bbox": [0.2, 0.2, 0.1, 0.1]}],
    "2026-09-03-ok/巴利/g.jpg": [{"label_code": "premolar", "bbox": [0.3, 0.3, 0.2, 0.2]}],
    "2026-09-02-ok/bibi/d.jpg": [{"label_code": "canine", "bbox": [0, 0, 0.5, 0.5]}],
}


@pytest.fixture()
def nas(tmp_path, monkeypatch):
    """临时的素材库 + NAS，照片是真文件"""
    from app.core.config import settings

    material = tmp_path / "material"
    for rel in _PHOTOS:
        p = material / "口腔验证" / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(_JPEG)
    monkeypatch.setattr(settings, "material_root", str(material))
    monkeypatch.setattr(settings, "oral_dir", "口腔验证")
    monkeypatch.setattr(settings, "nas_root", str(tmp_path / "nas"))
    return tmp_path


@pytest.fixture()
def plan():
    return exp.plan_dataset("oral", _ASSETS, _BOXES, val_ratio=0.34)


def test_bbox_转成_yolo_中心点():
    # 左上角 [x, y, w, h] → 中心点 cx cy w h。算错不会报错，只会让模型学偏半个框
    assert exp.to_yolo_line(2, [0.0, 0.0, 0.5, 0.5]) == "2 0.250000 0.250000 0.500000 0.500000"
    assert exp.to_yolo_line(0, [0.5, 0.5, 0.5, 0.5]) == "0 0.750000 0.750000 0.500000 0.500000"


def test_未标和跳过的图不进数据集(plan):
    paths = {i["rel_path"] for i in plan["items"]}
    assert "2026-09-02-ok/bibi/d.jpg" not in paths  # todo，哪怕库里有框
    assert "2026-09-02-ok/bibi/e.png" not in paths  # skipped
    assert plan["excluded"]["todo"] == 1
    assert plan["excluded"]["skipped"] == 1


def test_标完且零框才是负样本(plan):
    negatives = [i["rel_path"] for i in plan["items"] if i["is_negative"]]
    assert negatives == ["2026-09-01-ok/巴利/b.jpg"]


def test_框全被丢弃的图不能变成负样本(plan):
    """这是写测试时发现的真 bug。

    f.jpg 唯一的框是个皮肤类别，在口腔相册里认不出来被丢掉，于是它的标注行为空——
    如果就这么当成负样本，等于告诉模型"这张图里没有牙"，而它其实是标着东西的。
    正确做法是整张排除并出声。
    """
    assert "2026-09-02-ok/（未归类）/f.jpg" not in {i["rel_path"] for i in plan["items"]}
    assert plan["excluded"]["all_boxes_dropped"] == 1
    assert len(plan["dropped_boxes"]) == 1
    assert "erythema" in plan["dropped_boxes"][0]


def test_类别顺序固定且计数正确(plan):
    # class_id 就是这个顺序，要原样写进 meta.json/data.yaml，
    # 否则以后说不清某个权重里的 class_id 3 是哪一类
    assert plan["class_names"] == ["门齿", "犬齿", "前臼齿", "臼齿"]
    assert plan["boxes_per_class"] == {"门齿": 1, "犬齿": 1, "前臼齿": 1, "臼齿": 1}


def test_同一次拍摄不跨_split(plan):
    # 同一个「日期/狗」目录往往是连拍、互为近邻，散到两边会让 val 指标虚高
    by_group: dict[str, set[str]] = {}
    for it in plan["items"]:
        by_group.setdefault(it["group"], set()).add(it["split"])
    assert all(len(v) == 1 for v in by_group.values()), by_group


def test_重复导出的切分完全一致(plan):
    again = exp.plan_dataset("oral", _ASSETS, _BOXES, val_ratio=0.34)
    assert [i["split"] for i in again["items"]] == [i["split"] for i in plan["items"]]


def test_落盘产出能被_ultralytics_直接吃(nas, plan):
    meta = exp.write_dataset("oral_v1", plan, exported_by="tester")
    root = exp.dataset_root("oral_v1")

    for split in ("train", "val"):
        imgs = {os.path.splitext(f)[0] for f in os.listdir(os.path.join(root, "images", split))}
        lbls = {os.path.splitext(f)[0] for f in os.listdir(os.path.join(root, "labels", split))}
        assert imgs == lbls, f"{split} 的图和标注对不上：{imgs ^ lbls}"

    empty = [
        f
        for split in ("train", "val")
        for f in os.listdir(os.path.join(root, "labels", split))
        if os.path.getsize(os.path.join(root, "labels", split, f)) == 0
    ]
    assert len(empty) == 1, "空 txt 的数量应该正好等于负样本数"

    lines = [
        line
        for split in ("train", "val")
        for f in os.listdir(os.path.join(root, "labels", split))
        if "_a" in f
        for line in open(os.path.join(root, "labels", split, f), encoding="utf-8").read().splitlines()
    ]
    assert set(lines) == {"1 0.200000 0.200000 0.200000 0.200000", "0 0.550000 0.550000 0.100000 0.100000"}

    yaml = open(os.path.join(root, "data.yaml"), encoding="utf-8").read()
    assert "0: 门齿" in yaml and "3: 臼齿" in yaml
    assert meta["kind"] == "vision"      # 跟 IMU 那套 data_train 的条目区分开
    assert meta["copied_bytes"] > 0      # 图片是真复制过去的，不是软链
    assert len(meta["warnings"]) == 2    # 丢了框 + 整张排除，两条都要说出来

    manifest = json.load(open(os.path.join(root, "manifest.json"), encoding="utf-8"))
    assert {m["rel_path"] for m in manifest} == {i["rel_path"] for i in plan["items"]}


def test_重名不覆盖已有数据集(nas, plan):
    exp.write_dataset("oral_v1", plan)
    with pytest.raises(exp.ExportError):
        exp.write_dataset("oral_v1", plan)


@pytest.mark.parametrize("name", ["../etc", "a b", "x/y", "", "中文名"])
def test_非法数据集名被拒(name):
    with pytest.raises(exp.ExportError):
        exp.dataset_root(name)


def test_列出与删除只管视觉数据集(nas, plan):
    exp.write_dataset("oral_v1", plan)
    assert [d["name"] for d in exp.list_datasets()] == ["oral_v1"]
    exp.delete_dataset("oral_v1")
    assert exp.list_datasets() == []


# ── 审核结论必须影响导出 ────────────────────────────────────────────────
#
# 审查查出来的：导出原来只看 asset 的 done/todo，完全不看组被审成什么样。
# 审核员明确打回的一批标注照样进训练集，那「打回」这个动作对训练集就毫无作用，
# 审核等于走个过场。

_ASSETS_REVIEW = [
    {"rel_path": "2026-09-01-ok/巴利/a.jpg", "state": "done", "review_state": "approved"},
    {"rel_path": "2026-09-01-ok/lulu/c.jpg", "state": "done", "review_state": "rejected"},
    {"rel_path": "2026-09-03-ok/巴利/g.jpg", "state": "done", "review_state": None},       # 没指派
    {"rel_path": "2026-09-02-ok/bibi/d.jpg", "state": "done", "review_state": "submitted"},  # 交了还没审
]
_BOXES_REVIEW = {
    "2026-09-01-ok/巴利/a.jpg": [{"label_code": "canine", "bbox": [0.1, 0.1, 0.2, 0.2]}],
    "2026-09-01-ok/lulu/c.jpg": [{"label_code": "molar", "bbox": [0.1, 0.1, 0.2, 0.2]}],
    "2026-09-03-ok/巴利/g.jpg": [{"label_code": "incisor", "bbox": [0.1, 0.1, 0.2, 0.2]}],
    "2026-09-02-ok/bibi/d.jpg": [{"label_code": "premolar", "bbox": [0.1, 0.1, 0.2, 0.2]}],
}


def test_被打回的组不进数据集():
    plan = exp.plan_dataset("oral", _ASSETS_REVIEW, _BOXES_REVIEW, 0.0)
    paths = {i["rel_path"] for i in plan["items"]}
    assert "2026-09-01-ok/lulu/c.jpg" not in paths, "审核员打回的标注进了训练集"
    assert plan["excluded"]["review_rejected"] == 1


def test_默认允许没审过的进去():
    """小团队里管理员常常自己标、自己不审。默认就要求审核通过的话，
    第一版根本导不出东西来——所以默认只挡「明确被打回的」。"""
    plan = exp.plan_dataset("oral", _ASSETS_REVIEW, _BOXES_REVIEW, 0.0)
    paths = {i["rel_path"] for i in plan["items"]}
    assert "2026-09-03-ok/巴利/g.jpg" in paths      # 没指派
    assert "2026-09-02-ok/bibi/d.jpg" in paths      # 交了还没审


def test_勾上只要审核通过的就只剩通过的():
    plan = exp.plan_dataset("oral", _ASSETS_REVIEW, _BOXES_REVIEW, 0.0, only_approved=True)
    assert [i["rel_path"] for i in plan["items"]] == ["2026-09-01-ok/巴利/a.jpg"]
    assert plan["excluded"]["review_not_approved"] == 2
    assert plan["excluded"]["review_rejected"] == 1
    assert plan["only_approved"] is True


# ── 脏 bbox 不能悄悄进训练集 ────────────────────────────────────────────

@pytest.mark.parametrize("bad", [[0, 0, 0, 0], [0.1, 0.1, 0, 0.2], [0.1], [-0.5, 0.1, 0.2, 0.2], [0.1, 0.1, 2.0, 0.2]])
def test_非法_bbox_被丢弃而不是写成零面积的行(bad):
    """读接口对脏数据是兜住的（返回 [0,0,0,0] 让页面还能打开），
    导出不能跟着兜——一条零面积的 YOLO 行不报错，只会教模型认一个不存在的目标。"""
    assets = [{"rel_path": "d/x/a.jpg", "state": "done"}]
    plan = exp.plan_dataset("oral", assets, {"d/x/a.jpg": [{"label_code": "canine", "bbox": bad}]}, 0.0)
    assert plan["total_boxes"] == 0
    assert plan["excluded"]["bad_bbox"] == 1
    # 而且这张图不能因此变成"负样本"——它本来是标了东西的
    assert plan["items"] == []
    assert plan["excluded"]["all_boxes_dropped"] == 1


def test_meta_的计数是真正落盘的那些(nas, monkeypatch):
    """中途有图读不到（照片被删/NAS 断）时会跳过，如果 meta 还报 plan 的预估数，
    第一次训练就会发现"怎么比说好的少"，而且没人知道少在哪。"""
    plan = exp.plan_dataset("oral", _ASSETS, _BOXES, val_ratio=0.0)
    from app.services import vision_service as vsvc

    orig = vsvc.check_photo
    gone = "2026-09-01-ok/巴利/a.jpg"

    def flaky(album, rel_path):
        if rel_path == gone:
            raise vsvc.VisionError("文件不存在（模拟导出中途被删）")
        return orig(album, rel_path)

    monkeypatch.setattr(vsvc, "check_photo", flaky)
    meta = exp.write_dataset("partial", plan)

    assert meta["counts"]["train"] == len(plan["items"]) - 1
    assert meta["planned_counts"]["train"] == len(plan["items"]), "计划数要留着，好对出差在哪"
    assert meta["total_boxes"] == 0 or meta["total_boxes"] < plan["total_boxes"]
    assert any("读不到" in w for w in meta["warnings"])


def test_导出中途炸了不留半截目录(nas, plan, monkeypatch):
    """留着的话这个名字就被占死：重导报「已经存在了」，而目录里是个残缺的
    数据集——比没有更坏，因为它看起来像个能用的数据集。"""
    import shutil as _sh

    calls = []
    orig = _sh.copyfile

    def boom(src, dst):
        calls.append(1)
        if len(calls) > 1:
            raise OSError("模拟 NAS 中途断开")
        return orig(src, dst)

    monkeypatch.setattr(exp.shutil, "copyfile", boom)
    with pytest.raises(OSError):
        exp.write_dataset("half", plan)

    assert not os.path.exists(exp.dataset_root("half")), "半截目录没清掉"
    assert exp.list_datasets() == []
    # 名字还能再用
    monkeypatch.setattr(exp.shutil, "copyfile", orig)
    meta = exp.write_dataset("half", plan)
    assert meta["n_images"] > 0
