"""
牙齿识别：素材库 NAS 上的口腔照片目录浏览 + 调 imu_train/label_service 的 YOLO 检测。

目录约定（material_root/oral_dir 下，实际 NAS 就是这个结构）：
    /home/toky/alg_material/口腔验证/
    ├── 2026-08-21-ok/        日期目录，后缀 -ok 表示这天的照片已整理好；"2026-09-09-" 是还没拍的空目录
    │   ├── Bali/             狗名目录（早期 Bali/Bibi/Lulu/杜小满-马尔济斯，9 月起 巴利/bibi/lulu/小满，大小写和中英文不统一，原样显示）
    │   │   ├── 20260824-200554.jpg
    │   │   └── Thumbs.db     Windows 缩略图缓存，按扩展名过滤掉
    │   └── 杜小满-马尔济斯/
    └── 2026-08-30-ok/
        └── 微信图片_xxx.jpg  偶尔有散图直接放在日期目录下，列到"（未归类）"
照片只读不写；检测结果落 tooth_photo_results 表。图片给浏览器看走
/tooth/photos/stream?path=&token=，token 是按路径签的短期 HMAC（跟 media token
一个思路，只是绑定路径而不是 media_files.id——这批照片不是样本，不进 media_files）。
"""

import hashlib
import hmac
import json
import os
import re
import time

import httpx

from app.core.config import settings

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
_DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})(-.*)?$")


class ToothError(Exception):
    pass


# 素材库里按"日期/狗/照片"组织的相册：oral=口腔照片（牙齿识别页），skin=皮肤瘙痒问诊照片（皮肤评估页）
ALBUMS = {"oral": lambda: settings.oral_dir, "skin": lambda: settings.skin_photo_dir}

# 「一棵树里两种都有」的素材（狗场合作那批）比上面的约定多一层：
#     <树>/<日期>/<狗>/<品类>/*.jpg
# 品类靠名字里的关键字认，**不按编号**——现场那批里 003金毛秃子 底下的皮肤目录
# 叫 皮肤瘙痒-...-002、005金毛年糕 底下的口腔目录叫 口腔牙齿-...-004，编号是错的。
# 按编号分会把照片挂到别的狗名下，而且不报错。
MIXED_KEYWORDS = {"oral": ("口腔", "牙齿"), "skin": ("皮肤", "瘙痒")}


def mixed_dirs() -> list[str]:
    return [d.strip() for d in (settings.mixed_photo_dirs or "").split(",") if d.strip()]


def _category_album(name: str) -> str | None:
    """品类目录名 → 属于哪个相册。两组关键字都不沾就返回 None（不猜）。"""
    for album, kws in MIXED_KEYWORDS.items():
        if any(k in name for k in kws):
            return album
    return None


def album_root(album: str = "oral") -> str:
    if album not in ALBUMS:
        raise ToothError(f"未知相册: {album}")
    return os.path.join(settings.material_root, ALBUMS[album]())


def oral_root() -> str:
    return album_root("oral")


def _under(root: str, rel_path: str) -> str | None:
    """root + rel_path，realpath 之后必须仍在 root 之内且是个文件；否则 None。"""
    root = os.path.realpath(root)
    full = os.path.realpath(os.path.join(root, rel_path))
    if full != root and not full.startswith(root + os.sep):
        return None
    return full if os.path.isfile(full) else None


def material_rel(rel_path: str, album: str = "oral") -> str:
    """相册内相对路径 → **相对素材库根**的路径。

    这是给 vision_service 用的：它只认相对素材库根的路径（它那边的沙箱根就是
    素材库），而平台内部一直用的是"相对相册目录"。

    两种形状，跟 resolve_photo 同一套判据，**不能只做前者**：

      老形状  2026-09-01-ok/巴利/a.jpg
              → 口腔验证/2026-09-01-ok/巴利/a.jpg        （补上相册目录）
      混合树  雷喏斯达-狗场合作/雷喏斯达20260914/.../x.jpg
              → 原样                                      （它本来就是相对根的）

    只做前者的话，狗场那批会被拼成
    `口腔验证/雷喏斯达-狗场合作/...`——vision_service 那边报"文件不存在"，
    而路径看起来又挺像回事，很难一眼看出多了一层。2026-09-15 就是这么炸的。
    """
    try:
        first = (clean_rel_path(rel_path).split("/") or [""])[0]
    except ToothError:
        first = ""
    if first in mixed_dirs():
        return rel_path
    return f"{ALBUMS[album]()}/{rel_path}"


def resolve_photo(rel_path: str, album: str = "oral") -> str:
    """相对路径 → 绝对路径，realpath 必须仍在允许的目录之内。

    两种形状都认，**顺序不能反**：

      1. 相对相册目录         2026-09-01-ok/巴利/a.jpg
         老数据全是这个形状，库里已经存了一批，改不得。
      2. 相对素材库根，第一段是那棵混合树
         雷喏斯达-狗场合作/雷喏斯达20260912/001比熊小白/口腔牙齿-.../x.jpg
         这批一棵树里两种品类都有，没法归到某一个相册目录下，只能带上树名。

    第二种要额外挡一道：第一段必须是**配置里列出的**混合树。不然
    「相对素材库根」就等于把整个素材库开放给这个相册——口腔相册能读到
    颈圈算法验证 底下的任何文件。
    """
    full = _under(album_root(album), rel_path)
    if full:
        return full

    # 这里只拿它判「第一段是不是配置里的混合树」。路径不规范就当不匹配，
    # 不从这儿抛"非法路径"——这一层的契约一直是"解不出文件就是解不出"，
    # 越权判定在上一层（vision_service.check_photo 先过它自己的 clean_rel_path）。
    try:
        first = (clean_rel_path(rel_path).split("/") or [""])[0]
    except ToothError:
        first = ""
    if first in mixed_dirs():
        full = _under(settings.material_root, rel_path)
        if full:
            return full

    raise ToothError(f"文件不存在: {rel_path}")


def clean_rel_path(rel_path: str) -> str:
    """规范化相对路径，挡掉 .. 穿越和绝对路径。跟 vision_service 那个同名函数
    一个意思，这里另写一份是因为 tooth_service 不能反过来依赖 vision_service。"""
    p = (rel_path or "").replace("\\", "/").strip()
    if not p or p.startswith("/"):
        raise ToothError("非法路径")
    parts = [x for x in p.split("/") if x and x != "."]
    if any(x == ".." for x in parts):
        raise ToothError("非法路径")
    return "/".join(parts)


def list_photos(album: str = "oral") -> list[dict]:
    """扫相册两层目录（日期/狗），返回 [{folder, date, ok, dogs:[{name, photos:[{rel_path, filename, size_bytes}]}]}]，
    日期倒序。几百张图几十个目录，每次现扫就行，不缓存。"""
    root = album_root(album)
    # 主目录不在**不能**直接抛：狗场那批在另一棵树里，主目录没挂载/这个相册
    # 压根没有老素材时，抛出去等于把已经有的照片也一并藏了。两边都没有才算错。
    if not os.path.isdir(root):
        mixed = _list_mixed(album)
        if mixed:
            return mixed
        raise ToothError(f"照片目录不存在: {root}（素材库 NAS 还没挂载？）")
    out = []
    for folder in sorted(os.listdir(root), reverse=True):
        fpath = os.path.join(root, folder)
        if not os.path.isdir(fpath):
            continue
        m = _DATE_RE.match(folder)
        dogs = []
        # 日期目录下直接扔的散图（没放进狗目录的，比如 2026-08-30-ok/微信图片_xxx.jpg）
        # 也列出来，归到"（未归类）"，不然页面上看不到这几张
        stray = []
        for fn in sorted(os.listdir(fpath)):
            if os.path.isfile(os.path.join(fpath, fn)) and os.path.splitext(fn)[1].lower() in IMAGE_EXTS:
                stray.append({"rel_path": f"{folder}/{fn}", "filename": fn, "size_bytes": os.path.getsize(os.path.join(fpath, fn))})
        for dog in sorted(os.listdir(fpath)):
            dpath = os.path.join(fpath, dog)
            if not os.path.isdir(dpath):
                continue
            photos = []
            for fn in sorted(os.listdir(dpath)):
                if os.path.splitext(fn)[1].lower() not in IMAGE_EXTS:
                    continue
                p = os.path.join(dpath, fn)
                photos.append({"rel_path": f"{folder}/{dog}/{fn}", "filename": fn, "size_bytes": os.path.getsize(p)})
            if photos:
                dogs.append({"name": dog, "photos": photos})
        if stray:
            dogs.append({"name": "（未归类）", "photos": stray})
        if dogs:
            out.append({"folder": folder, "date": m.group(1) if m else None, "ok": folder.endswith("-ok"), "dogs": dogs})
    out.extend(_list_mixed(album))
    # 日期目录名两棵树格式不一样（2026-09-01-ok vs 雷喏斯达20260912），
    # 没有共同的可比字段，所以按 folder 字符串倒序——同一棵树内部是对的，
    # 两棵树之间的先后无所谓（页面上本来就是按树分段看的）
    out.sort(key=lambda x: x["folder"], reverse=True)
    return out


def _list_mixed(album: str) -> list[dict]:
    """扫「一棵树里两种品类都有」的素材：<树>/<日期>/<狗>/<品类>/*.jpg。

    rel_path 带上树名，因为这批归不到任何一个相册目录下——resolve_photo 那边
    据此走「相对素材库根」的分支。
    """
    out = []
    for tree in mixed_dirs():
        troot = os.path.join(settings.material_root, tree)
        if not os.path.isdir(troot):
            continue
        for folder in sorted(os.listdir(troot), reverse=True):
            fpath = os.path.join(troot, folder)
            if not os.path.isdir(fpath):
                continue
            dogs = []
            for dog in sorted(os.listdir(fpath)):
                dpath = os.path.join(fpath, dog)
                if not os.path.isdir(dpath):
                    continue
                photos = []
                for cat in sorted(os.listdir(dpath)):
                    cpath = os.path.join(dpath, cat)
                    # 品类目录认不出来就跳过，不猜：猜错的后果是口腔相册里
                    # 混进皮肤照片，标注员按牙齿那套标签去标，标完才发现
                    if not os.path.isdir(cpath) or _category_album(cat) != album:
                        continue
                    for fn in sorted(os.listdir(cpath)):
                        if os.path.splitext(fn)[1].lower() not in IMAGE_EXTS:
                            continue
                        fp = os.path.join(cpath, fn)
                        photos.append({
                            "rel_path": f"{tree}/{folder}/{dog}/{cat}/{fn}",
                            "filename": fn,
                            "size_bytes": os.path.getsize(fp),
                        })
                if photos:
                    dogs.append({"name": dog, "photos": photos})
            if dogs:
                out.append({"folder": f"{tree}/{folder}", "date": _mixed_date(folder),
                            "ok": True, "dogs": dogs})
    return out


_MIXED_DATE_RE = re.compile(r"(\d{4})(\d{2})(\d{2})")


def _mixed_date(folder: str) -> str | None:
    """雷喏斯达20260912 → 2026-09-12。取不出就 None，不硬猜。"""
    m = _MIXED_DATE_RE.search(folder)
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None


# ── 路径签名 token ──────────────────────────────────────────────────────

def issue_photo_token(rel_path: str, album: str = "oral") -> str:
    expires_at = int(time.time()) + settings.media_token_ttl_hours * 3600
    payload = f"{album}:{rel_path}:{expires_at}"
    sig = hmac.new(settings.jwt_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{expires_at}.{sig}"


def verify_photo_token(rel_path: str, token: str, album: str = "oral") -> bool:
    try:
        expires_at_str, sig = token.split(".", 1)
        expires_at = int(expires_at_str)
    except (ValueError, AttributeError):
        return False
    if expires_at < int(time.time()):
        return False
    payload = f"{album}:{rel_path}:{expires_at}"
    expected = hmac.new(settings.jwt_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]
    return hmac.compare_digest(expected, sig)


# ── 调 label_service 检测 ─────────────────────────────────────────────

async def detect_remote(rel_path: str, conf: float | None, with_image: bool, top_k: int = 1) -> dict:
    """label_service 的 MATERIAL_ROOT 跟这边 material_root 是同一目录，它要的 path 是
    相对 MATERIAL_ROOT 的，所以前面拼上 oral_dir。"""
    url = f"{settings.algo_service_url.rstrip('/')}/api/v1/tooth/detect"
    payload = {"path": f"{settings.oral_dir}/{rel_path}", "conf": conf, "with_image": with_image, "top_k": top_k}
    try:
        async with httpx.AsyncClient(timeout=settings.algo_infer_timeout_sec) as client:
            resp = await client.post(url, json=payload)
    except httpx.RequestError as e:
        raise ToothError(f"无法连接 AI 服务 ({url}): {e}") from e
    if resp.status_code == 503:
        raise ToothError("AI 服务没有牙齿模型权重（label_service 的 TOOTH_WEIGHTS），先训练或配置权重")
    if resp.status_code != 200:
        raise ToothError(f"AI 服务返回 {resp.status_code}: {resp.text[:300]}")
    return resp.json()


def summarize(detections: list[dict]) -> tuple[str | None, float | None]:
    if not detections:
        return None, None
    top = max(detections, key=lambda d: d["confidence"])
    return top["class_name"], float(top["confidence"])


def result_to_dict(r) -> dict:
    return {
        "rel_path": r.rel_path, "folder": r.folder, "dog_folder": r.dog_folder, "dog_id": r.dog_id,
        "detections": json.loads(r.detections or "[]"), "n_detections": r.n_detections,
        "top_class": r.top_class, "top_conf": r.top_conf, "model_conf": r.model_conf,
        "width": r.width, "height": r.height, "detected_at": r.detected_at.isoformat() if r.detected_at else None,
    }
