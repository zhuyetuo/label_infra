"""NAS 原始数据里的冗余文件：检测 + 清理。

采集端（`multicam_*`）在录制目录里会留下几类中间文件，正常情况下现场跑
`witmotion_imu/cleanup_gouchang.sh` 清掉再上传 NAS。偶尔忘了跑，NAS 上就会多出
几份同一段数据——最占地方的是「未配对的原始视频副本」（一份几 GB，真拷贝）。

这里按清理脚本的同一套规则识别：公用机位跟站点配置走（只有狗场 cam7）；其余只认
能证明「跟另一份是同一份数据」的（硬链接同 inode，或大小一致且首尾抽样一致）。
删之前还会再问一遍数据库：任何被样本 / 素材库引用的路径都不动。

规则（对应 cleanup_gouchang.sh 的 5 类）：
1. `{base}_camN_raw.mp4`：同目录有 `{base}_camN_imu*_raw.mp4` 且同一份数据 → 删未配对的；
2. 公用机位（只有狗场 cam7，见 `_SHARED_CAM_BY_SITE`）：配对副本都是同一份数据，
   删配对的、留未配对的 `cam7_raw.mp4`；其它场地**不碰配对文件**——博朗旺一间
   两只项圈、影棚各路配对 CSV 都是平台要用的，内容一样但文件名各自被引用；
3. `{base}_meta.csv`；
4. `{base}.csv`（合并流水）和 `{base}_imuM_raw.csv`（未裁剪整段）。

永远不碰：配对的视频 / CSV（除非确认是上述重复副本且未被引用）、`_resampled`、
以及任何认不出的文件。
"""
from __future__ import annotations

import os
import re
from collections import defaultdict
from datetime import date

from app.services import site_layout

CATEGORY_LABELS = {
    "unpaired_video": "未配对的原始视频副本",
    "shared_paired_video": "公用机位重复视频",
    "shared_paired_csv": "同一段 IMU 的重复 CSV",
    "meta_csv": "录制元信息",
    "merged_csv": "合并后的总流水",
    "imu_raw_csv": "未裁剪的整段流水",
}

# 哪个场地有"一台相机拍全场"的公用机位（采集端 sites/*.env 的 SHARED_CAM）。
# 只有 狗场2 配了 7；影棚 / 博朗旺 / 狗场1 都是 none。平台只认公用机位那份
# 未配对的 `{base}_camN_raw.mp4`，配对的都是重复副本。
_SHARED_CAM_BY_SITE: dict[str, int] = {"gouchang": 7}

_DIR_DATE = re.compile(r"^(\d{4})_(\d{1,2})_(\d{1,2})(?:_|$)")
_PAIR_VIDEO = re.compile(r"^(?P<base>.+)_cam(?P<cam>\d+)_imu(?P<imu>\d+)_raw\.mp4$", re.I)
_RAW_VIDEO = re.compile(r"^(?P<base>.+)_cam(?P<cam>\d+)_raw\.mp4$", re.I)
_PAIR_CSV = re.compile(r"^(?P<base>.+)_cam(?P<cam>\d+)_imu(?P<imu>\d+)_raw\.csv$", re.I)
_IMU_RAW_CSV = re.compile(r"^(?P<base>.+)_imu(?P<imu>\d+)_raw\.csv$", re.I)


def date_of_dir(name: str) -> str | None:
    m = _DIR_DATE.match(name)
    if not m:
        return None
    try:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
    except ValueError:
        return None


def _same_data(pa: str, pb: str) -> bool:
    """硬链接（同 inode），或大小一致且首尾抽样内容一致，才认为是同一份数据。

    小文件（CSV）不能只比大小：同一场地按小时切段，两段时长一样时字节数
    也会一样。抽样读首尾各 256 KB——不同录段的首行时间戳/传感器值就不一样；
    整份读完一晚上 10 GB 要一两分钟，检测按钮等不起。视频动辄几 GB，不读，
    跟清理脚本 same_data 一样信大小。
    """
    try:
        a, b = os.stat(pa), os.stat(pb)
    except OSError:
        return False
    if a.st_ino == b.st_ino and a.st_dev == b.st_dev:
        return True
    if a.st_size <= 0 or a.st_size != b.st_size:
        return False
    if a.st_size <= 64 * 1024 * 1024:
        span = 256 * 1024
        try:
            with open(pa, "rb") as fa, open(pb, "rb") as fb:
                if fa.read(span) != fb.read(span):
                    return False
                if a.st_size > span:
                    fa.seek(-span, os.SEEK_END)
                    fb.seek(-span, os.SEEK_END)
                    if fa.read(span) != fb.read(span):
                        return False
        except OSError:
            return False
    return True


def scan_day(directory: str, referenced: set[str], nas_root: str) -> dict:
    """扫一个 `data_raw/<日期_场地>` 目录，返回可删文件清单（不删任何东西）。"""
    try:
        names = os.listdir(directory)
    except OSError as e:
        return {"dir": os.path.basename(directory), "date": date_of_dir(os.path.basename(directory)),
                "items": [], "error": f"{type(e).__name__}: {e}"}

    names = [n for n in names if not n.startswith(".")]
    abspath = {n: os.path.join(directory, n) for n in names}
    regular = {n for n in names if os.path.isfile(abspath[n]) and not os.path.islink(abspath[n])}

    def rel(n: str) -> str:
        return os.path.relpath(abspath[n], nas_root).replace(os.sep, "/")

    paired_videos: dict[tuple[str, str], list[str]] = defaultdict(list)
    unpaired_videos: list[tuple[str, str, str]] = []
    paired_csvs: dict[tuple[str, str], list[str]] = defaultdict(list)

    for n in regular:
        if m := _PAIR_VIDEO.match(n):
            paired_videos[(m.group("base"), m.group("cam"))].append(n)
        elif m := _RAW_VIDEO.match(n):
            unpaired_videos.append((n, m.group("base"), m.group("cam")))
        elif m := _PAIR_CSV.match(n):
            paired_csvs[(m.group("base"), m.group("imu"))].append(n)

    reason: dict[str, str] = {}

    # 采集端 `sites/*.env` 里只有 狗场2 配了 SHARED_CAM=7：那一台天花板相机
    # 拍全部六间，配对出来的 6 份文件名指向同一段视频，平台只认未配对的
    # `{base}_cam7_raw.mp4`。其它场地是 none——博朗旺每间两只项圈（同一只狗）
    # 的配对文件、影棚 cam1~3 各自的配对 CSV 都是平台要用的，**不能当重复删**。
    # 所以这里跟站点配置走，不按"公共区"猜（那是画面内容，不是文件归属）。
    shared_cam = _SHARED_CAM_BY_SITE.get(site_layout.site_of(os.path.basename(directory)) or "")

    # 1) 公用机位（狗场 cam7）的配对副本：跟未配对那份同一份数据，删配对、留未配对
    if shared_cam is not None:
        for n, base, cam in unpaired_videos:
            if cam != str(shared_cam):
                continue
            peers = [p for p in paired_videos.get((base, cam), []) if _same_data(abspath[n], abspath[p])]
            if len(peers) >= 2:
                for p in peers:
                    reason[p] = "shared_paired_video"
        # 同一 IMU 在别的机位有同一份数据的配对 CSV → 公用机位这份是多余的
        for (base, imu), fs in paired_csvs.items():
            for n in fs:
                m = _PAIR_CSV.match(n)
                if m is None or m.group("cam") != str(shared_cam):
                    continue
                if any(_same_data(abspath[n], abspath[o]) for o in fs if o != n):
                    reason.setdefault(n, "shared_paired_csv")

    # 2) 未配对的 {base}_camN_raw.mp4：同 base/cam 有配对视频且同一份数据 → 它是副本
    for n, base, cam in unpaired_videos:
        if n in reason:
            continue
        if any(_same_data(abspath[n], abspath[p]) for p in paired_videos.get((base, cam), [])):
            reason.setdefault(n, "unpaired_video")

    # 3) 录制中间产物（配对 CSV 不在这里处理，别误删）
    for n in regular:
        low = n.lower()
        if low.endswith("_meta.csv"):
            reason.setdefault(n, "meta_csv")
        elif _IMU_RAW_CSV.match(n) and not _PAIR_CSV.match(n):
            reason.setdefault(n, "imu_raw_csv")
        elif low.endswith(".csv") and "_resampled" not in low and not _PAIR_CSV.match(n):
            stem = n[:-4]
            if not re.search(r"_(cam|imu)\d+", stem, re.I):
                reason.setdefault(n, "merged_csv")

    items = []
    protected = 0
    for n, cat in reason.items():
        if rel(n) in referenced:
            protected += 1
            continue
        try:
            st = os.stat(abspath[n])
            size = st.st_size
            reclaim = size if st.st_nlink <= 1 else 0
        except OSError:
            size = reclaim = 0
        items.append({"name": n, "category": cat, "bytes": size, "reclaim": reclaim})

    by_cat: dict[str, dict] = {}
    for it in items:
        c = by_cat.setdefault(it["category"], {"files": 0, "bytes": 0, "reclaim_bytes": 0})
        c["files"] += 1
        c["bytes"] += it["bytes"]
        c["reclaim_bytes"] += it["reclaim"]

    return {
        "dir": os.path.basename(directory),
        "date": date_of_dir(os.path.basename(directory)),
        "items": items,
        "files": len(items),
        "bytes": sum(it["bytes"] for it in items),
        "reclaim_bytes": sum(it["reclaim"] for it in items),
        "by_category": by_cat,
        "protected": protected,
    }


def scan_root(data_raw_dir: str, referenced: dict[str, set[str]], nas_root: str) -> dict:
    """扫所有日期目录；referenced 按目录名给出被数据库引用的相对路径。"""
    days: dict[str, dict] = {}
    scanned = 0
    for name in sorted(os.listdir(data_raw_dir)):
        path = os.path.join(data_raw_dir, name)
        if not os.path.isdir(path) or date_of_dir(name) is None:
            continue
        scanned += 1
        rep = scan_day(path, referenced.get(name, set()), nas_root)
        if not rep.get("files"):
            continue
        d = rep["date"]
        agg = days.setdefault(d, {"date": d, "dirs": [], "files": 0, "bytes": 0,
                                  "reclaim_bytes": 0, "by_category": {}, "protected": 0})
        agg["dirs"].append(rep["dir"])
        agg["files"] += rep["files"]
        agg["bytes"] += rep["bytes"]
        agg["reclaim_bytes"] += rep["reclaim_bytes"]
        agg["protected"] += rep["protected"]
        for cat, c in rep["by_category"].items():
            a = agg["by_category"].setdefault(cat, {"files": 0, "bytes": 0, "reclaim_bytes": 0})
            a["files"] += c["files"]
            a["bytes"] += c["bytes"]
            a["reclaim_bytes"] += c["reclaim_bytes"]
    out = sorted(days.values(), key=lambda x: x["date"], reverse=True)
    return {"dates": out, "scanned_dirs": scanned,
            "total_files": sum(x["files"] for x in out),
            "total_bytes": sum(x["bytes"] for x in out),
            "total_reclaim_bytes": sum(x["reclaim_bytes"] for x in out)}


def clean_day(directory: str, referenced: set[str], nas_root: str) -> dict:
    """重新扫一遍再删，避免拿旧清单误删。被引用的文件一律保留。"""
    rep = scan_day(directory, referenced, nas_root)
    deleted, freed, errors = 0, 0, []
    for it in rep["items"]:
        path = os.path.join(directory, it["name"])
        if not os.path.exists(path):
            continue
        try:
            st = os.stat(path)
            os.remove(path)
            deleted += 1
            if st.st_nlink <= 1:  # 硬链接删掉不释放空间，别把“回收”算大
                freed += st.st_size
        except OSError as e:
            errors.append(f"{it['name']}: {type(e).__name__}")
    return {"dir": rep["dir"], "deleted": deleted, "freed_bytes": freed,
            "protected": rep["protected"], "errors": errors[:20]}
