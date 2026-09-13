"""
视觉标注（雏形）的类别体系和存取。

类别体系写死在代码里而不是进 label_definitions 表：雏形阶段这套东西还会反复改，
进了表就要跟标签管理页、标签模板、快捷键位那一整套打交道，而那些都是现有模块。
等类别定下来了再谈迁移。

照片的浏览、路径沙箱、图片流全部复用 tooth_service / material 路由，这里一行都不碰。
"""

import json

from app.services import tooth_service

# 相册 → 这个相册用哪套标签。相册名跟 material 路由保持一致（oral / skin）。
ALBUM_DOMAIN = {"oral": "tooth", "skin": "skin"}

# 牙齿：只建 4 个粗类。牙位（Triadan 三位数）是属性不是类别——42 类在几百张的量级上
# 必然不收敛，而且缺牙时整排编号错位，缺牙在小型犬和短头犬里是常态。
_TOOTH_LABELS = [
    {"code": "incisor", "name": "门齿", "color": "#3b82f6", "hotkey": "1"},
    {"code": "canine", "name": "犬齿", "color": "#f59e0b", "hotkey": "2"},
    {"code": "premolar", "name": "前臼齿", "color": "#10b981", "hotkey": "3"},
    {"code": "molar", "name": "臼齿", "color": "#a855f7", "hotkey": "4"},
]

# 皮肤：按病灶形态，不按疾病名。疾病名要刮片/培养才能确诊，照片上标不准、
# 标注者之间一致性极差，而且一张图常有多种病因共存。
_SKIN_LABELS = [
    {"code": "erythema", "name": "红斑", "color": "#ef4444", "hotkey": "1"},
    {"code": "alopecia", "name": "脱毛", "color": "#f59e0b", "hotkey": "2"},
    {"code": "lichenification", "name": "苔藓化/色素沉着", "color": "#78350f", "hotkey": "3"},
    {"code": "excoriation", "name": "抓伤/糜烂", "color": "#ec4899", "hotkey": "4"},
    {"code": "crust", "name": "痂皮", "color": "#a855f7", "hotkey": "5"},
    {"code": "scale", "name": "皮屑", "color": "#0ea5e9", "hotkey": "6"},
]

_GRADE_0_3 = [
    {"value": 0, "label": "0 无"},
    {"value": 1, "label": "1 轻"},
    {"value": 2, "label": "2 中"},
    {"value": 3, "label": "3 重"},
]

# 每个框可填的属性。type: grade = 0-3 单选；select = 枚举；tooth_code = 牙位选择器。
_TOOTH_ATTRS = [
    {"key": "tooth_code", "name": "牙位", "type": "tooth_code",
     "help": "modified Triadan 三位数。看不出来就留空——留空比猜一个错的好，猜错会顺着牙弓传播成整排错位。"},
    {"key": "ci", "name": "牙结石 CI", "type": "grade", "options": _GRADE_0_3,
     "help": "Calculus Index 0-3：0 无可见结石，3 牙面大部分被覆盖。"},
    {"key": "gi", "name": "牙龈 GI", "type": "grade", "options": _GRADE_0_3,
     "help": "Gingivitis Index 0-3：0 无炎症，3 重度炎症/自发出血。"},
    {"key": "visibility", "name": "可见度", "type": "select",
     "options": [{"value": "clear", "label": "清楚"}, {"value": "partial", "label": "部分遮挡"}, {"value": "occluded", "label": "基本挡住"}],
     "help": "被嘴唇挡住多少。挡住大半的牙，分级不可信，导出时会单独标出来。"},
]

_SKIN_ATTRS = [
    {"key": "severity", "name": "严重度", "type": "grade", "options": _GRADE_0_3,
     "help": "对齐 CADESI-4 的 0-3 打分。"},
    {"key": "area_band", "name": "面积档", "type": "grade",
     "options": [{"value": 0, "label": "0 无"}, {"value": 1, "label": "1 <10%"}, {"value": 2, "label": "2 10-30%"}, {"value": 3, "label": "3 >30%"}],
     "help": "占这个部位的比例，不测绝对面积——手机照片没有标定物，绝对面积跨次不可比。"},
]

# 图级属性：一张照片整体的信息，不属于某个框。
_TOOTH_ASSET_ATTRS = [
    {"key": "view_code", "name": "视角", "type": "select",
     "options": [{"value": "left", "label": "左颊"}, {"value": "right", "label": "右颊"}, {"value": "front", "label": "正面"}],
     "help": "决定这张图能推哪个象限的牙位。填错会让整张图的牙位全错。"},
]

_SKIN_ASSET_ATTRS = [
    {"key": "body_site", "name": "部位", "type": "select",
     "options": [{"value": v, "label": n} for v, n in [
         ("ear", "耳廓"), ("periocular", "眼周"), ("muzzle", "口鼻"), ("neck", "颈部"),
         ("axilla", "腋下"), ("forelimb", "前肢"), ("hindlimb", "后肢"), ("paw", "爪/指间"),
         ("abdomen", "腹部"), ("groin", "腹股沟"), ("back", "背部"), ("tail", "尾根"),
     ]],
     "help": "跨次对比是按部位对的（狗身上做图像配准不现实），所以这一项不填的话这张图进不了趋势。"},
]

DOMAINS = {
    "tooth": {"labels": _TOOTH_LABELS, "item_attrs": _TOOTH_ATTRS, "asset_attrs": _TOOTH_ASSET_ATTRS},
    "skin": {"labels": _SKIN_LABELS, "item_attrs": _SKIN_ATTRS, "asset_attrs": _SKIN_ASSET_ATTRS},
}

ASSET_STATES = ("todo", "done", "skipped")


class VisionError(Exception):
    pass


def domain_of(album: str) -> str:
    if album not in ALBUM_DOMAIN:
        raise VisionError(f"未知相册: {album}")
    return ALBUM_DOMAIN[album]


def catalog(album: str) -> dict:
    """这个相册的标签体系，给前端渲染按钮和属性面板"""
    domain = domain_of(album)
    return {"album": album, "domain": domain, **DOMAINS[domain]}


def valid_label_codes(album: str) -> set[str]:
    return {x["code"] for x in DOMAINS[domain_of(album)]["labels"]}


# 视觉页图片 token 的有效期。**不复用 media_token_ttl_hours（4 小时）**：
# 这个 token 是按 (album, rel_path) 签的纯 HMAC，不查库、不带身份、不可吊销，
# 撤销指派/改派/审核通过都传导不到它，只能等它过期。所以这个"等"必须短。
# 前端是点开一张图才换一次 token，10 分钟绰绰有余。
PHOTO_TOKEN_TTL_SEC = 600

_BAD_SEGMENTS = {"", ".", ".."}


def clean_rel_path(rel_path: str) -> str:
    """把请求里的相对路径规范化，不规范就直接拒。

    为什么必须有这个函数：校验路径的是 realpath（只拦跑出相册根的），而算
    group_key 的是对**原始字符串**切片。两者看的不是同一个路径，`..` 夹在中间
    时就分叉了——

        group_of("日期/巴利/../lulu/c.jpg") == "日期/巴利"    ← 在 anna 的指派里
        realpath 之后                       == 日期/lulu/c.jpg ← 是别人的图

    于是权限按 A 组判、文件按 B 组取。这个洞在之前的穿越测试下是绿的，因为
    那几条只试了跑出相册根的写法（../../etc/passwd），全被 realpath 挡住了。

    与其让 group_of 去猜这些写法算哪个组，不如在入口一律拒掉：正常的前端
    永远不会发出带 `..`、`.`、`//` 或开头 `/` 的路径。
    """
    if not isinstance(rel_path, str) or not rel_path.strip():
        raise VisionError("路径不能为空")
    if rel_path.startswith("/") or "\\" in rel_path:
        raise VisionError("非法路径")
    parts = rel_path.split("/")
    if any(p in _BAD_SEGMENTS for p in parts):
        raise VisionError("非法路径")
    return "/".join(parts)


def group_of(rel_path: str) -> str:
    """一张照片属于哪一「组」：`日期目录/狗名`，散图则是 `日期目录`。

    这是三件事共用的同一个概念，所以只能有一个定义：
      - 指派和审核的粒度（一次指派一组，不是一张一张派）
      - 导出时 train/val 的切分单位（同一次拍摄不能散到两边）
      - 标注员能看见哪些照片的判据
    三处各写一份迟早会走岔，而走岔的后果是标注员看得见不该看的图。
    """
    parts = [p for p in rel_path.split("/") if p]
    return "/".join(parts[:2]) if len(parts) >= 3 else (parts[0] if parts else "")


def check_photo(album: str, rel_path: str) -> str:
    """照片必须真的在相册目录里（复用 tooth_service 的路径沙箱，不另写一套）。

    先过 clean_rel_path：路径不规范的话，后面算出来的 group_key 就不可信，
    而 group_key 正是权限判据。
    """
    clean_rel_path(rel_path)
    try:
        return tooth_service.resolve_photo(rel_path, album)
    except tooth_service.ToothError as e:
        raise VisionError(str(e)) from e


def issue_photo_token(album: str, rel_path: str) -> str:
    """按 PHOTO_TOKEN_TTL_SEC 签，不走 tooth_service 那个 4 小时的口径。

    签名算法和校验端（material 的 stream 路由）保持一致，只是有效期短得多。
    """
    import hashlib
    import hmac
    import time

    from app.core.config import settings

    expires_at = int(time.time()) + PHOTO_TOKEN_TTL_SEC
    payload = f"{album}:{rel_path}:{expires_at}"
    sig = hmac.new(settings.jwt_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{expires_at}.{sig}"


def normalize_bbox(bbox) -> list[float]:
    """归一化框：[x, y, w, h]，左上角原点，全部裁到 0-1。

    裁剪而不是报错，是因为画框时鼠标拖出图外是常事，前端已经夹过一次，
    这里兜底——真要因为拖出去 2 像素弹个错，标注员会疯。
    """
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        raise VisionError("bbox 应该是 [x, y, w, h] 四个数")
    try:
        x, y, w, h = (float(v) for v in bbox)
    except (TypeError, ValueError) as e:
        raise VisionError("bbox 里有不是数字的值") from e
    x = min(max(x, 0.0), 1.0)
    y = min(max(y, 0.0), 1.0)
    w = min(max(w, 0.0), 1.0 - x)
    h = min(max(h, 0.0), 1.0 - y)
    if w <= 0 or h <= 0:
        raise VisionError("框的宽高必须大于 0")
    return [round(x, 6), round(y, 6), round(w, 6), round(h, 6)]


def clean_attrs(attrs) -> str:
    """属性存 JSON 字符串。值为 None 的键直接丢掉，省得前端到处判空。"""
    if attrs is None:
        return "{}"
    if not isinstance(attrs, dict):
        raise VisionError("attrs 应该是一个对象")
    return json.dumps({k: v for k, v in attrs.items() if v is not None}, ensure_ascii=False)


def load_attrs(raw: str | None) -> dict:
    """读 attrs。存进去的一定是合法 JSON，但历史/手工改库的脏数据不该让整页打不开。"""
    if not raw:
        return {}
    try:
        val = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return val if isinstance(val, dict) else {}


def annotation_to_dict(row) -> dict:
    return {
        "id": row.id,
        "album": row.album,
        "rel_path": row.rel_path,
        "label_code": row.label_code,
        "bbox": load_bbox(row.bbox),
        "attrs": load_attrs(row.attrs),
        "source": row.source,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def load_bbox(raw: str | None) -> list[float]:
    try:
        val = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return [0.0, 0.0, 0.0, 0.0]
    if isinstance(val, list) and len(val) == 4:
        return [float(v) for v in val]
    return [0.0, 0.0, 0.0, 0.0]


def asset_to_dict(row) -> dict:
    return {
        "album": row.album,
        "rel_path": row.rel_path,
        "state": row.state,
        "skip_reason": row.skip_reason,
        "attrs": load_attrs(row.attrs),
        "width": row.width,
        "height": row.height,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }
