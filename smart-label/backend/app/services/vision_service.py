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
    # 牙龈单独成一类，不是只做牙框上的 GI 属性。
    #
    # 为什么要有这一类：GI 挂在牙框上时，模型只知道"这颗牙附近有炎症"，学不到
    # "红肿的是**哪一条**龈缘"——炎症长在龈缘那条带上，跟牙冠是两个区域，
    # 牙框里绝大部分像素是牙面。要让模型直接看牙龈，就得有牙龈自己的框/多边形。
    #
    # **必须追加在最后**：导出的 class_id 就是这个列表的下标，插在中间会让已经
    # 导出的数据集、已经训好的权重里的 class_id 整体错位。
    {"code": "gingiva", "name": "牙龈", "color": "#e11d48", "hotkey": "5"},
]

# 牙齿四类的 code，给"这个属性只对哪些类别有意义"用。
_TOOTH_ONLY = ["incisor", "canine", "premolar", "molar"]

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
#
# only_for：这个属性只对哪些类别有意义，前端据此只显示相关的几项。不填 = 所有类别都显示。
# 这只是显示层的筛选，**不是校验**：老数据里牙框上填过的键照样读得出来、导得出去，
# 不会因为加了这个字段变成"不认识的属性"。
_TOOTH_ATTRS = [
    {"key": "tooth_code", "name": "牙位", "type": "tooth_code", "only_for": _TOOTH_ONLY,
     "help": "modified Triadan 三位数。看不出来就留空——留空比猜一个错的好，猜错会顺着牙弓传播成整排错位。"},
    {"key": "ci", "name": "牙结石 CI", "type": "grade", "options": _GRADE_0_3, "only_for": _TOOTH_ONLY,
     "help": "Calculus Index 0-3：0 无可见结石，3 牙面大部分被覆盖。"},
    {"key": "gi", "name": "牙龈 GI", "type": "grade", "options": _GRADE_0_3,
     "help": "Gingivitis Index 0-3：0 无炎症，1 轻微发红不出血，2 发红+探触出血，3 自发出血。"
             "牙框上填 = 这颗牙旁边的龈缘；牙龈框上填 = 这条龈缘本身。两处都能填，"
             "老数据里填在牙框上的照样有效。"},
    # ↓ 牙龈专用。分成"颜色 / 肿胀 / 出血"三项而不是只留一个 GI：
    # GI 是把三件事糅成一个数的临床量表，标注员之间一致性差（同一张图有人打 1 有人打 2）；
    # 拆开之后每一项都是照片上看得见的事实，模型也能各学各的。GI 仍然保留，两者不冲突。
    {"key": "gum_color", "name": "牙龈颜色", "type": "select", "only_for": ["gingiva"],
     "options": [
         {"value": "pink", "label": "粉红（正常）"},
         {"value": "red", "label": "发红"},
         {"value": "dark_red", "label": "暗红/紫红"},
         {"value": "pale", "label": "苍白"},
         {"value": "pigmented", "label": "色素沉着（天生黑斑）"},
         {"value": "unknown", "label": "看不出（光线/白平衡）"},
     ],
     "help": "「色素沉着」是很多犬天生的黑色斑块，不是病变——不单列出来的话会被当成暗红标进去。"
             "手机白平衡会把整张图偏暖，拿不准就选「看不出」。"},
    {"key": "gum_swelling", "name": "肿胀", "type": "grade", "only_for": ["gingiva"],
     "options": [
         {"value": 0, "label": "0 平贴牙面"},
         {"value": 1, "label": "1 龈缘略增厚"},
         {"value": 2, "label": "2 龈缘圆钝外翻"},
         {"value": 3, "label": "3 明显肿大/增生"},
     ],
     "help": "只看龈缘那条带的形态：正常是薄薄一片贴着牙面、边缘是刀刃状的。"},
    {"key": "gum_bleeding", "name": "出血", "type": "select", "only_for": ["gingiva"],
     "options": [
         {"value": "none", "label": "无"},
         {"value": "present", "label": "看得到血/血痂"},
         {"value": "unknown", "label": "看不出"},
     ],
     "help": "照片只能看到「有没有血」。GI 量表里的「探触出血」要用牙周探针压一下才知道，"
             "照片上判断不了，别拿这一项去凑 GI=2。"},
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

# ── 口腔评估打分（周医生那张加权表） ──────────────────────────────────────
#
# 三项各自的档位**就是分值**（0/10/20 这些数字是周医生定的，不是我们配的），
# 相加得总分。存的是分值本身而不是档位序号：兽医读导出的时候看到的就是他那张
# 表上的数，不用再对一遍映射。代价是万一以后调权重，老数据得跑一次迁移——
# 这件事写在这里，免得到时候直接改 _ORAL_SCORE_ITEMS 了事、把历史分数改成
# 另一套口径而没人发现。
#
# **不做 PD 分期（牙周炎 I–IV 期）**：分期要靠牙周探诊深度和 X 光看牙槽骨吸收，
# 一张掀唇照片给不了。硬从照片上"推"一个期数出来，读的人会当成诊断。
#
# 另一套方案（CI/GI 指数 0–3）**还没做**——逐颗牙的 CI/GI 已经有了（框属性
# _TOOTH_ATTRS 里的 ci/gi），缺的是整张图按指数算总分那一套。界面上留了提示。
_ORAL_SCORE_ITEMS = [
    {"key": "oral_redness", "name": "牙龈发红", "points": [0, 10, 20],
     "labels": ["0 正常粉红", "10 局部发红", "20 明显发红/大面积"]},
    {"key": "oral_swelling", "name": "牙龈肿胀", "points": [0, 10, 15, 20],
     "labels": ["0 平贴牙面", "10 龈缘略增厚", "15 龈缘圆钝外翻", "20 明显肿大/增生"]},
    {"key": "oral_calculus", "name": "牙结石", "points": [0, 5, 10, 20],
     "labels": ["0 无可见结石", "5 少量点状", "10 成片附着", "20 大部分牙面被覆盖"]},
]

#: 三项都满分。前端画进度条要用，别在两边各写一个 60。
ORAL_SCORE_MAX = sum(max(x["points"]) for x in _ORAL_SCORE_ITEMS)


def oral_score(attrs: dict) -> dict:
    """三项相加 → {total, items, missing, complete}。

    **缺项不当 0 算**。三项里漏填一项而总分照给的话，一条"20 分，轻"会盖住
    一张其实没看牙结石的照片——漏填和"确实没有"在总分上长得一模一样。所以
    没填全的时候 total 给 None，missing 说清楚缺哪几项。
    """
    items, missing, total = [], [], 0
    for spec in _ORAL_SCORE_ITEMS:
        v = attrs.get(spec["key"])
        if not isinstance(v, int) or isinstance(v, bool) or v not in spec["points"]:
            missing.append(spec["name"])
            items.append({"key": spec["key"], "name": spec["name"], "points": None})
            continue
        total += v
        items.append({"key": spec["key"], "name": spec["name"], "points": v})
    return {"total": None if missing else total, "max": ORAL_SCORE_MAX,
            "items": items, "missing": missing, "complete": not missing}


# 图级属性：一张照片整体的信息，不属于某个框。
_TOOTH_ASSET_ATTRS = [
    *[
        {"key": s["key"], "name": s["name"], "type": "grade", "score_item": True,
         "options": [{"value": p, "label": lb} for p, lb in zip(s["points"], s["labels"])],
         "help": "周医生那张表的档位，选项前面的数字就是分值，三项相加是总分。"
                 "拿不准就先别填——漏填和「确实是 0」在总分上分不开，所以没填全不给总分。"}
        for s in _ORAL_SCORE_ITEMS
    ],
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
    out = {"album": album, "domain": domain, **DOMAINS[domain]}
    if domain == "tooth":
        # 打分口径只有这一份。前端照着渲染和算总分，**不另抄一遍那几个数字**——
        # 抄一遍的话调权重时界面上的总分和导出的总分会不一样，而且没人会发现
        out["score_scheme"] = {
            "name": "口腔评估",
            "max": ORAL_SCORE_MAX,
            "items": [{"key": s["key"], "name": s["name"], "points": s["points"]}
                      for s in _ORAL_SCORE_ITEMS],
            "note": "分期（牙周炎 I–IV 期）不在这里：要靠牙周探诊深度和 X 光看牙槽骨吸收，"
                    "照片上推不出来。",
            "todo": "另一套 CI/GI 指数（0–3）的整图总分还没做；逐颗牙的 CI/GI 已经可以在框上填。",
        }
    return out


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
    # 就是「这张照片的父目录」。原来写的是 parts[:2]，对当时仅有的两种形状
    # （日期/狗/图、日期/图）跟父目录完全等价；狗场那批多一层
    # （树/日期/狗/品类/图），按 parts[:2] 会把好几只狗算成同一组——
    # 后果是标注员看得见不该看的图，正是这个函数要防的事。
    return "/".join(parts[:-1])


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


#: 一个掩膜最多留多少个点。SAM 出的轮廓动辄几百个点，一张图几十个框的话
#: JSON 能到几 MB——存得下，但每次打开这张图都要传一遍，标注员那边就是卡。
#: 100 个点足够描一颗牙的轮廓（它本来就是个圆角方块）。
MAX_POLYGON_POINTS = 100


def normalize_polygon(poly) -> list[list[float]] | None:
    """归一化掩膜轮廓：[[x, y], ...]，全部裁到 0-1。给 None / 空 / 点太少都返回 None。

    跟 bbox 一样是**裁**不是报错：SAM 偶尔会吐出边界外一两个像素，
    为这个弹错等于让标注员替模型的浮点误差买单。

    点太多就等距抽稀，不是截断——截断会把轮廓剪掉一截，变成一条开口的折线；
    抽稀只是让边变粗糙，形状还是那个形状。
    """
    if poly is None:
        return None
    if not isinstance(poly, (list, tuple)):
        raise VisionError("polygon 应该是 [[x, y], ...]")
    pts: list[list[float]] = []
    for p in poly:
        if not isinstance(p, (list, tuple)) or len(p) != 2:
            raise VisionError("polygon 的每个点应该是 [x, y]")
        try:
            x, y = float(p[0]), float(p[1])
        except (TypeError, ValueError) as e:
            raise VisionError("polygon 里有不是数字的值") from e
        pts.append([round(min(max(x, 0.0), 1.0), 6), round(min(max(y, 0.0), 1.0), 6)])
    # 少于 3 个点围不成面，存了也没用，还会让下游画出一条线
    if len(pts) < 3:
        return None
    if len(pts) > MAX_POLYGON_POINTS:
        step = len(pts) / MAX_POLYGON_POINTS
        pts = [pts[int(i * step)] for i in range(MAX_POLYGON_POINTS)]
    return pts


def load_polygon(raw: str | None) -> list[list[float]] | None:
    if not raw:
        return None
    try:
        val = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if isinstance(val, list) and len(val) >= 3:
        try:
            return [[float(p[0]), float(p[1])] for p in val]
        except (TypeError, ValueError, IndexError):
            return None
    return None


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
    "gum_swelling": frozenset(range(4)),
    "gum_color": frozenset(["pink", "red", "dark_red", "pale", "pigmented", "unknown"]),
    "gum_bleeding": frozenset(["none", "present", "unknown"]),
    "severity": frozenset(range(4)),
    "area_band": frozenset(range(4)),
    "visibility": frozenset(["clear", "partial", "occluded", "not_captured"]),
    "view_code": frozenset(["left", "right", "front", "unknown"]),
    "need_vet": frozenset(["yes"]),
    "jaw": frozenset(["upper", "lower", "both"]),
    "body_site": frozenset(
        x["value"] for x in _SKIN_ASSET_ATTRS[0]["options"]
    ),
    # 口腔评估三项：合法值就是那张表上的分值本身（不是 0-3 档位号）
    **{s["key"]: frozenset(s["points"]) for s in _ORAL_SCORE_ITEMS},
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
        "polygon": load_polygon(getattr(row, "polygon", None)),
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
