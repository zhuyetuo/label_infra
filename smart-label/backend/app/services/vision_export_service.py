"""
把视觉标注导出成 YOLO 检测数据集。

目录刻意跟 IMU 那套分开（data_train_vision，不是 data_train）：
training_export_service.list_datasets() 是扫 data_train 下每个带 meta.json 的目录、
原样返回给模型训练页的，delete_dataset(name) 又只按名字删。写进同一个目录会串台
（训练页上冒出读不懂的条目、label_stats 去找不存在的 merged_tmp.json），同名还会
互相覆盖、跨类型误删。

核心逻辑（哪些图进、进哪个 split、每行写什么）是纯函数 plan_dataset，不碰文件也不碰
数据库，可以直接测；write_dataset 只负责把 plan 落成文件。
"""

import hashlib
import json
import os
import re
import shutil
from datetime import datetime

from app.core.config import settings
from app.services import vision_service

VISION_TRAIN_DIR = "data_train_vision"
_NAME_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
_SAFE_RE = re.compile(r"[^A-Za-z0-9_.\-]+")


class ExportError(Exception):
    pass


def dataset_root(name: str) -> str:
    if not _NAME_RE.match(name):
        raise ExportError("数据集名只能用字母、数字、下划线、短横线，最长 64 个字符")
    return os.path.join(settings.nas_root, VISION_TRAIN_DIR, name)


def to_yolo_line(class_id: int, bbox: list[float]) -> str:
    """[x, y, w, h]（左上角原点）→ YOLO 的 `cls cx cy w h`（中心点）。

    这个换算错了不会报任何错，只会让模型学到系统性偏移半个框的目标位置——
    所以它必须是一个能被单独测的函数。
    """
    x, y, w, h = bbox
    return f"{class_id} {x + w / 2:.6f} {y + h / 2:.6f} {w:.6f} {h:.6f}"


# 切分的最小单位就是「组」（日期/狗 = 一次拍摄）。同一次拍摄的照片往往是连拍、
# 互为近邻，散到 train 和 val 两边会让 val 指标虚高。定义在 vision_service 里，
# 指派、审核、导出共用同一个——三处各写一份迟早走岔。
_group_of = vision_service.group_of


def _split_of(group: str, val_ratio: float) -> str:
    """按组名哈希决定 train/val。

    用哈希而不是随机：同一批标注不管导出多少次，切分结果完全一样，
    否则今天的 val 里躺着昨天的 train，指标就没法比了。
    """
    if val_ratio <= 0:
        return "train"
    if val_ratio >= 1:
        return "val"
    bucket = int(hashlib.sha1(group.encode("utf-8")).hexdigest()[:8], 16) % 1000
    return "val" if bucket < val_ratio * 1000 else "train"


def _safe_stem(rel_path: str, index: int) -> str:
    """导出用的文件名：路径拍平 + 去掉非 ASCII。

    中文目录名（狗名、"（未归类）"）直接进文件名，在不同工具链里会踩到各种编码坑；
    拍平之后靠 manifest.json 回查原图，比赌工具链兼容可靠。
    """
    flat = rel_path.rsplit(".", 1)[0].replace("/", "__")
    safe = _SAFE_RE.sub("_", flat).strip("_")
    return f"{index:05d}_{safe}" if safe else f"{index:05d}"


def plan_dataset(
    album: str,
    assets: list[dict],
    boxes_by_path: dict[str, list[dict]],
    val_ratio: float = 0.2,
    only_approved: bool = False,
) -> dict:
    """纯函数：决定哪些图进数据集、进哪个 split、每张的标注行写什么。

    assets：[{rel_path, state}]；boxes_by_path：{rel_path: [{label_code, bbox}]}

    三条规则写死在这里，不做成开关：
      - state='done' 且零个框 → **显式负样本**，写一个空 txt（ultralytics 认空 txt
        为纯背景图）。这是 vision_assets 那张表存在的全部理由。
      - state='todo' → 一律不进。分不清「没标」和「没目标」就会把漏标当负样本，
        模型学到「这里不该有牙」，而且事后查不出来。
      - state='skipped' → 不进。人明确说了这张不要（糊了/没拍到）。
    """
    domain = vision_service.domain_of(album)
    labels = vision_service.DOMAINS[domain]["labels"]
    # class_id 就是这个顺序，必须原样写进 meta.json 和 data.yaml——不记下来，
    # 以后就永远说不清某个权重里的 class_id 3 是哪一类
    class_names = [lb["name"] for lb in labels]
    class_of = {lb["code"]: i for i, lb in enumerate(labels)}

    items: list[dict] = []
    skipped = {
        "todo": 0, "skipped": 0, "unknown_state": 0, "all_boxes_dropped": 0,
        # 审核层面被排除的：被打回的一律不要（审核员明确说了这批有问题），
        # only_approved 时连没审过的也不要
        "review_rejected": 0, "review_not_approved": 0, "bad_bbox": 0,
    }
    dropped_boxes: list[str] = []
    index = 0
    for a in sorted(assets, key=lambda r: r["rel_path"]):
        state = a.get("state") or "todo"
        if state != "done":
            skipped[state if state in skipped else "unknown_state"] += 1
            continue

        # 审核结论必须影响导出，否则「打回」这个动作对训练集毫无作用——
        # 审核员说了这批有问题，它照样进训练集，那审核就是走个过场。
        review = a.get("review_state")
        if review == "rejected":
            skipped["review_rejected"] += 1
            continue
        if only_approved and review != "approved":
            skipped["review_not_approved"] += 1
            continue

        raw = boxes_by_path.get(a["rel_path"], [])
        lines = []
        n_dropped = 0
        for b in raw:
            cid = class_of.get(b["label_code"])
            if cid is None:
                # 类别改过名、或者库里是别的相册的脏数据。丢掉但要出声——
                # 静默丢标注是最难查的那种数据集问题
                dropped_boxes.append(f"{a['rel_path']}: {b['label_code']}")
                n_dropped += 1
                continue
            bbox = b.get("bbox") or []
            # 库里的 bbox 脏掉时（手工改库、以后换了存储格式），读接口是兜住了的
            # ——返回 [0,0,0,0] 让页面还能打开。但导出不能跟着兜：一条零面积的
            # YOLO 行不会报错，只会悄悄进训练集教模型认一个不存在的目标。
            if len(bbox) != 4 or bbox[2] <= 0 or bbox[3] <= 0 or any(not (0.0 <= v <= 1.0) for v in bbox):
                dropped_boxes.append(f"{a['rel_path']}: 非法 bbox {bbox}")
                skipped["bad_bbox"] += 1
                n_dropped += 1
                continue
            lines.append(to_yolo_line(cid, bbox))
        if raw and not lines and n_dropped:
            # 这张图本来是有标注的，只是全被丢了。这时候**绝不能**让它变成负样本——
            # 那等于告诉模型"这里什么都没有"，而它其实标着东西。整张排除掉，并记下来。
            # 这条是测出来的：一张皮肤类别混进口腔相册的图，正好走到这条路上。
            skipped["all_boxes_dropped"] = skipped.get("all_boxes_dropped", 0) + 1
            continue
        group = _group_of(a["rel_path"])
        items.append({
            "rel_path": a["rel_path"],
            "stem": _safe_stem(a["rel_path"], index),
            "split": _split_of(group, val_ratio),
            "group": group,
            "lines": lines,
            "is_negative": not lines,
        })
        index += 1

    counts = {"train": 0, "val": 0}
    boxes_per_class = {n: 0 for n in class_names}
    negatives = {"train": 0, "val": 0}
    for it in items:
        counts[it["split"]] += 1
        if it["is_negative"]:
            negatives[it["split"]] += 1
        for ln in it["lines"]:
            boxes_per_class[class_names[int(ln.split(" ", 1)[0])]] += 1

    return {
        "album": album,
        "domain": domain,
        "class_names": class_names,
        "items": items,
        "counts": counts,
        "negatives": negatives,
        "boxes_per_class": boxes_per_class,
        "total_boxes": sum(boxes_per_class.values()),
        "excluded": skipped,
        "dropped_boxes": dropped_boxes,
        "val_ratio": val_ratio,
        "only_approved": only_approved,
    }


def write_dataset(name: str, plan: dict, exported_by: str | None = None) -> dict:
    """把 plan 落成 ultralytics 能直接吃的目录。

    图片是**复制**不是软链：软链跨挂载点在换机器训练时会静默失效，而这批图一共
    几百张、每张一两兆，复制出来是个自包含的快照，可复现。
    """
    root = dataset_root(name)
    if os.path.exists(root):
        raise ExportError(f"数据集 {name} 已经存在了，换个名字（或者先把旧的删掉）")

    dirs = {
        (kind, split): os.path.join(root, kind, split)
        for kind in ("images", "labels")
        for split in ("train", "val")
    }
    for d in dirs.values():
        os.makedirs(d, exist_ok=True)

    manifest = []
    copied_bytes = 0
    failed: list[str] = []
    try:
        return _write_files(root, dirs, plan, manifest, failed, copied_bytes, name, exported_by)
    except Exception:
        # 中途炸了（NAS 断了、盘满了）要把半截目录清掉：留着的话这个名字就被占死，
        # 重导会报"已经存在了"，而目录里是个残缺的数据集——比没有更坏
        shutil.rmtree(root, ignore_errors=True)
        raise


def _write_files(root, dirs, plan, manifest, failed, copied_bytes, name, exported_by):
    for it in plan["items"]:
        try:
            src = vision_service.check_photo(plan["album"], it["rel_path"])
        except vision_service.VisionError as e:
            # 标注做完之后照片被删了/NAS 断了。跳过这一张，但记下来——
            # 数据集少了图而 meta 里不说，下次对不上数就没人知道为什么
            failed.append(f"{it['rel_path']}: {e}")
            continue
        ext = os.path.splitext(src)[1].lower() or ".jpg"
        img_dst = os.path.join(dirs[("images", it["split"])], it["stem"] + ext)
        shutil.copyfile(src, img_dst)
        copied_bytes += os.path.getsize(img_dst)
        with open(os.path.join(dirs[("labels", it["split"])], it["stem"] + ".txt"), "w", encoding="utf-8") as f:
            f.write("\n".join(it["lines"]) + ("\n" if it["lines"] else ""))
        manifest.append({
            "stem": it["stem"], "rel_path": it["rel_path"], "split": it["split"],
            "n_boxes": len(it["lines"]), "group": it["group"],
        })

    with open(os.path.join(root, "data.yaml"), "w", encoding="utf-8") as f:
        f.write(f"path: {root}\ntrain: images/train\nval: images/val\n\nnames:\n")
        for i, n in enumerate(plan["class_names"]):
            f.write(f"  {i}: {n}\n")

    # 计数按**真正落盘的**算，不用 plan 里的预估：中途有图读不到（照片被删、
    # NAS 断了）时会 continue 掉，两个数就对不上了。meta 是给人看数据集有多大的，
    # 对不上的话第一次训练就会发现"怎么比说好的少"，然后没人知道少在哪
    by_stem = {i["stem"]: i for i in plan["items"]}
    actual_counts = {"train": 0, "val": 0}
    actual_negatives = {"train": 0, "val": 0}
    actual_per_class = {n: 0 for n in plan["class_names"]}
    for m in manifest:
        actual_counts[m["split"]] += 1
        if m["n_boxes"] == 0:
            actual_negatives[m["split"]] += 1
        for ln in by_stem[m["stem"]]["lines"]:
            actual_per_class[plan["class_names"][int(ln.split(" ", 1)[0])]] += 1

    meta = {
        # kind 是给人和以后的代码看的：这个目录不是 IMU 那套 data_train 的东西
        "kind": "vision",
        "name": name,
        "album": plan["album"],
        "domain": plan["domain"],
        "task": "detect",
        "class_names": plan["class_names"],
        "counts": actual_counts,
        "negatives": actual_negatives,
        "boxes_per_class": actual_per_class,
        "total_boxes": sum(actual_per_class.values()),
        "planned_counts": plan["counts"],  # 计划 vs 实际对不上就是有图没读到，看 failed_images
        "excluded": plan["excluded"],
        "only_approved": plan.get("only_approved", False),
        "val_ratio": plan["val_ratio"],
        "n_images": len(manifest),
        "copied_bytes": copied_bytes,
        "warnings": (
            [f"有 {len(plan['dropped_boxes'])} 个框的类别不在当前类别表里，已丢弃"] if plan["dropped_boxes"] else []
        ) + (
            [f"有 {plan['excluded']['all_boxes_dropped']} 张图的框全部被丢弃，整张排除（没有当成负样本）"]
            if plan["excluded"].get("all_boxes_dropped") else []
        ) + (
            [f"有 {plan['excluded']['review_rejected']} 张图所属的组被审核打回了，没进数据集"]
            if plan["excluded"].get("review_rejected") else []
        ) + (
            [f"有 {plan['excluded']['review_not_approved']} 张图所属的组还没审核通过（勾了「只要审核通过的」），没进数据集"]
            if plan["excluded"].get("review_not_approved") else []
        ) + (
            [f"有 {plan['excluded']['bad_bbox']} 个框的坐标不合法（库里的脏数据），已丢弃"]
            if plan["excluded"].get("bad_bbox") else []
        ) + (
            [f"有 {len(failed)} 张图在导出时读不到（照片被删/NAS 断了），没进数据集"] if failed else []
        ),
        "dropped_boxes": plan["dropped_boxes"][:50],
        "failed_images": failed[:50],
        "exported_at": datetime.now().isoformat(timespec="seconds"),
        "exported_by": exported_by,
    }
    with open(os.path.join(root, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    with open(os.path.join(root, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return meta


def list_datasets() -> list[dict]:
    """只列 data_train_vision 下的，不碰 IMU 那套 data_train"""
    root = os.path.join(settings.nas_root, VISION_TRAIN_DIR)
    if not os.path.isdir(root):
        return []
    out = []
    for d in sorted(os.listdir(root), reverse=True):
        p = os.path.join(root, d, "meta.json")
        if not os.path.isfile(p):
            continue
        try:
            with open(p, encoding="utf-8") as f:
                out.append(json.load(f))
        except (OSError, ValueError):
            continue
    return out


def delete_dataset(name: str) -> None:
    root = dataset_root(name)
    # 名字过了白名单还不够：realpath 必须仍在 data_train_vision 之内，
    # 不然一个软链就能让 rmtree 跑到别的地方去
    base = os.path.realpath(os.path.join(settings.nas_root, VISION_TRAIN_DIR))
    real = os.path.realpath(root)
    if real != base and not real.startswith(base + os.sep):
        raise ExportError("非法路径")
    if not os.path.isdir(real):
        raise ExportError(f"数据集 {name} 不存在")
    shutil.rmtree(real)
