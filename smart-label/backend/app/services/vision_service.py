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
#
# 第一版只做 3 类（用户拍板）。砍掉的那三类不是不重要，是样本会太少——
# 一类少于一两百张，模型学不动，标了也白标。等这三类标到量、而且实际数据里
# 那三类确实常见，再放开。放开就是把下面注释里那几行加回来的事。
#
# 暂时不启用的：
#   {"code": "lichenification", "name": "苔藓化/色素沉着", "color": "#78350f", "hotkey": "4"},
#   {"code": "crust", "name": "痂皮", "color": "#a855f7", "hotkey": "5"},
#   {"code": "scale", "name": "皮屑", "color": "#0ea5e9", "hotkey": "6"},
# 注意：加回来之前，库里如果已经有这些类别的标注（比如先启用过又关掉），
# 导出时会被当成"不认识的类别"丢弃并整张排除——meta.json 的 warnings 里会说。
_SKIN_LABELS = [
    {"code": "erythema", "name": "红斑", "color": "#ef4444", "hotkey": "1"},
    {"code": "alopecia", "name": "脱毛", "color": "#f59e0b", "hotkey": "2"},
    {"code": "excoriation", "name": "抓伤/糜烂", "color": "#ec4899", "hotkey": "3"},
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
     "options": [
         {"value": "left", "label": "左颊"}, {"value": "right", "label": "右颊"},
         {"value": "front", "label": "正面"}, {"value": "unknown", "label": "看不出"},
     ],
     "help": "决定这张图能推哪个象限的牙位。用户随手拍的照片有不少分不清左右，"
             "这时候选「看不出」——填错比不填糟得多，会让整张图的牙位全错。"
             "正面和看不出都不推号（正面同时看到左右两侧，一个象限号盖不住）。"},
    {"key": "jaw", "name": "上下颌", "type": "select",
     "options": [{"value": "upper", "label": "上颌"}, {"value": "lower", "label": "下颌"}, {"value": "both", "label": "都有"}],
     "help": "只拍到一排牙时一定要填。几何上分不出这排是上还是下，不填会默认当成上颌——"
             "要是下排，整张图的象限号就全错了（204 而不是 304）。上下都拍到就选「都有」。"},
    {"key": "need_vet", "name": "拿不准", "type": "select",
     "options": [{"value": "yes", "label": "等兽医看"}],
     "help": "自己判断不了的（这颗到底几级、这是不是结石）先打这个标，接着往下标。"
             "攒一批之后在列表里筛出来，让兽医一次看完——比标一张问一次高效得多。"},
]

_SKIN_ASSET_ATTRS = [
    {"key": "need_vet", "name": "拿不准", "type": "select",
     "options": [{"value": "yes", "label": "等兽医看"}],
     "help": "自己判断不了的先打标接着往下标，攒一批让兽医一次看完。"},
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


# 犬 modified Triadan 的合法牙位。上颌每象限 10 颗（x01-x10），下颌 11 颗（x01-x11）。
#
# 两个容易记反的点：
#   - 105/205 在犬中**是存在的**（上颌第一前臼齿，单根）。"105/205 缺失"是猫的特征。
#   - 犬真正不存在的是 111/211——上颌只有 2 颗臼齿，止于 110/210。
# 值域只写在前端是不够的：接口照收的话，手工调接口或者以后换个前端就能写进来，
# 而一个不存在的牙位进了导出，训练时就是个永远学不会的类别。
TOOTH_CODES = frozenset(
    [q * 100 + i for q in (1, 2) for i in range(1, 11)]      # 101-110 / 201-210
    + [q * 100 + i for q in (3, 4) for i in range(1, 12)]    # 301-311 / 401-411
)

# 有值域的属性：{属性名: 合法值集合}。按相册分开，因为两套类别的属性不一样。
_ATTR_DOMAINS = {
    "tooth_code": TOOTH_CODES,
    "ci": frozenset(range(4)),
    "gi": frozenset(range(4)),
    "severity": frozenset(range(4)),
    "area_band": frozenset(range(4)),
    "visibility": frozenset(["clear", "partial", "occluded", "not_captured"]),
    "view_code": frozenset(["left", "right", "front", "unknown"]),
    "need_vet": frozenset(["yes"]),
    "jaw": frozenset(["upper", "lower", "both"]),
    "body_site": frozenset(
        x["value"] for x in _SKIN_ASSET_ATTRS[0]["options"]
    ),
}


def clean_attrs(attrs) -> str:
    """属性存 JSON 字符串。值为 None 的键直接丢掉，省得前端到处判空。

    有值域的属性会被校验：牙位 111/211 在犬中不存在，分级只能是 0-3。
    不认识的键一律拒掉——写错一个键名不会有任何报错，只会让那个值永远读不出来，
    而标注员以为自己填过了。
    """
    if attrs is None:
        return "{}"
    if not isinstance(attrs, dict):
        raise VisionError("attrs 应该是一个对象")
    cleaned = {}
    for k, v in attrs.items():
        if v is None:
            continue
        domain = _ATTR_DOMAINS.get(k)
        if domain is None:
            raise VisionError(f"不认识的属性 {k}")
        if v not in domain:
            if k == "tooth_code" and isinstance(v, int) and v in (111, 211):
                raise VisionError("111/211 在犬中不存在（上颌只有 2 颗臼齿，止于 110/210）")
            raise VisionError(f"属性 {k} 的值 {v!r} 不在合法范围里")
        cleaned[k] = v
    return json.dumps(cleaned, ensure_ascii=False)


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
