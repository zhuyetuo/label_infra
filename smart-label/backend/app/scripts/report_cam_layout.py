"""每个场地到底有几路视角、每只狗实际挂到了哪几路。

    docker compose exec api python -m app.scripts.report_cam_layout
    docker compose exec api python -m app.scripts.report_cam_layout --date 2026-09-15
    docker compose exec api python -m app.scripts.report_cam_layout --sample 2026_9_15_gouchang_imu9

为什么需要它：「狗场应该是 2 路、影棚 3 路」这件事**在代码里不是写死的**，
是从文件名里的 `_camN_imuM` 配对关系推出来的（见 sample_import_service
的 `_cams_for`）。所以「为什么这只狗有 3 路」的答案只能在**真实文件**里，
猜没有意义。

这个脚本把两边都摆出来：

  ① 库里每个样本实际挂了几路、挂的是哪几个文件
  ② NAS 上那个日期目录的文件结构（哪几路带 imu 号=配对，哪几路不带=公用）

对上了就是数据本来如此；对不上就能看出是导入时分错了，还是样本是在
配对逻辑上线**之前**导入的（那批的 cam 是按"三路共用"挂的，不会自动改）。
"""

from __future__ import annotations

import argparse
import asyncio
import os
import re
import sys
from collections import defaultdict

from sqlalchemy import select

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.sample import Sample

#: 跟 sample_import_service 同一套解析。**引用它、不另抄一份**——
#: 抄一份的话这个报告会跟导入逻辑慢慢分家，而那时候报告本身就成了误导源。
from app.services.sample_import_service import (  # noqa: E402
    _PAIRED_SITE_SUFFIXES,
    _parse_filename,
)

#: 日期 + 站点后缀。**用 search 不用 match**：session_key 前面常常还有别的
#: （真实文件名是 multicam_2026_9_15_gouchang_...），从头匹配一个都对不上。
_SITE_RE = re.compile(r"\d{4}_\d{1,2}_\d{1,2}_([A-Za-z][A-Za-z0-9]*)")


def _site_of(session_key: str) -> str:
    """从 key 里取站点后缀：multicam_2026_9_15_gouchang_imu9 → gouchang。"""
    m = _SITE_RE.search(session_key.split("_imu")[0])
    return m.group(1) if m else "（无站点后缀）"


def _is_paired_site(session_key: str) -> bool:
    return any(_site_of(session_key).lower().endswith(s.lstrip("_"))
               for s in _PAIRED_SITE_SUFFIXES)


# ── ① 库里的实际情况 ──────────────────────────────────────────────────────


async def report_db(date_filter, sample_filter):
    print("① 库里每个样本实际挂了几路\n")
    async with SessionLocal() as db:
        q = select(Sample.sample_code, Sample.session_date,
                   Sample.video_cam1_path, Sample.video_cam2_path,
                   Sample.video_cam3_path)
        if date_filter:
            q = q.where(Sample.session_date == date_filter)
        if sample_filter:
            q = q.where(Sample.sample_code == sample_filter)
        rows = (await db.execute(q)).all()

    if not rows:
        print("   （没有匹配的样本）\n")
        return {}

    # 站点 → 视角数 → 样本数
    by_site: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    detail: dict[str, list[str]] = {}
    for code, _d, c1, c2, c3 in rows:
        cams = [c for c in (c1, c2, c3) if c]
        site = _site_of(code)
        by_site[site][len(cams)] += 1
        detail[code] = cams

    print(f"   {'站点':<16}{'视角数':>8}{'样本数':>8}")
    print("   " + "-" * 32)
    for site in sorted(by_site):
        for n in sorted(by_site[site]):
            print(f"   {site:<16}{n:>8}{by_site[site][n]:>8}")
    print()

    # 同一个站点里视角数不一致 = 值得查：要么数据本来就不齐，
    # 要么一部分样本是在配对逻辑上线之前导入的
    for site, counts in by_site.items():
        if len(counts) > 1:
            print(f"   ⚠ 站点 {site} 里**视角数不一致**：{dict(counts)}")
            print("     常见原因：一部分样本是在「按 IMU 配对」那套逻辑上线之前")
            print("     导入的——那批按「三路共用」挂的 cam，后来不会自动改。")
            print()

    if sample_filter:
        for code, cams in detail.items():
            print(f"   {code} 挂了 {len(cams)} 路：")
            for i, c in enumerate(cams, 1):
                print(f"     cam{i}  {c}")
            print()
    return detail


# ── ② NAS 上的文件结构 ────────────────────────────────────────────────────


def scan_nas(root: str, session_prefix: str = "") -> dict:
    """扫出每个 session 的 {配对, 公用, 每个 imu 会挂几路}。

    **纯函数（只读文件系统），跟打印分开**：判断"这只狗该有几路"的规则
    在这里，测试直接对着它验，不用去 parse 打印出来的字符串。
    """
    # session_key → imu → {cam: 文件名}，以及不带 imu 号的那些
    paired: dict[str, dict[int, dict[int, str]]] = defaultdict(lambda: defaultdict(dict))
    shared: dict[str, dict[int, str]] = defaultdict(dict)
    seen_any = False
    for _dirpath, _dirs, files in os.walk(root):
        for fname in files:
            if not fname.lower().endswith(".mp4"):
                continue
            parsed = _parse_filename(fname)
            if parsed is None:
                # 不带 imu 号的（{base}_camN_raw.mp4）在导入那边算"公用"
                m = re.match(r"^(.+?)_cam(\d+)_raw$", os.path.splitext(fname)[0])
                if m and (not session_prefix or session_prefix in m.group(1)):
                    shared[m.group(1)][int(m.group(2))] = fname
                    seen_any = True
                continue
            session_key, cam_idx, imu_idx, _dog = parsed
            # **包含**而不是开头：真实 session_key 是
            # multicam_2026_9_15_gouchang，不以日期打头
            if session_prefix and session_prefix not in session_key:
                continue
            paired[session_key][imu_idx][cam_idx] = fname
            seen_any = True

    out: dict[str, dict] = {}
    for session_key in sorted(set(paired) | set(shared)):
        sh = shared.get(session_key) or {}
        own = paired.get(session_key, {})
        # **这一路有配对文件的话，那个不带 imu 号的就不算公用**——
        # 当公用挂给所有狗的话，每只狗都会看到别人房间的画面
        pc = {c for cams in own.values() for c in cams}
        真公用 = {c: f for c, f in sh.items() if c not in pc}
        out[session_key] = {
            "site": _site_of(session_key),
            "paired_site": _is_paired_site(session_key),
            "shared_cams": sorted(真公用),
            "unshared_named": sorted(set(sh) - set(真公用)),
            # samples 表只有三个位置，所以最多 3 路
            "per_imu": {imu: {"own": sorted(cams),
                              "n": min(len(set(cams) | set(真公用)), 3)}
                        for imu, cams in sorted(own.items())},
        }
    return out


def report_nas(session_prefix):
    print("② NAS 上那个目录的文件结构\n")
    # 跟导入那边同一个根目录：nas_root/data_raw
    root = os.path.join(settings.nas_root, settings.data_raw_dir)
    if not os.path.isdir(root):
        print(f"   ✗ 找不到 {root}，跳过\n")
        return

    info = scan_nas(root, session_prefix)
    if not info:
        print("   （没扫到匹配的视频文件）\n")
        return

    for session_key, g in info.items():
        flag = "按 IMU 配对" if g["paired_site"] else "三路共用"
        print(f"   {session_key}   站点={g['site']}   导入规则={flag}")
        if g["shared_cams"]:
            print(f"     公用（不带 imu 号、且这一路没有配对文件）：cam{g['shared_cams']}")
        if g["unshared_named"]:
            print(f"     有 {len(g['unshared_named'])} 个不带 imu 号的文件"
                  f"（cam{g['unshared_named']}），但那几路**都有配对文件**，")
            print("     所以导入时不当公用（否则每只狗会看到别人房间）")
        for imu_idx, d in g["per_imu"].items():
            print(f"     imu{imu_idx:<3} 自己配对 cam{d['own']}"
                  f"  + 公用 cam{g['shared_cams']}"
                  f"  → 导入会挂 {d['n']} 路")
        print()


def main() -> int:
    import datetime as dt

    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", help="只看某一天（YYYY-MM-DD）")
    ap.add_argument("--sample", help="只看某个样本（会列出它挂的每一路文件）")
    ap.add_argument("--session-prefix", default="",
                    help="② 那段只扫 key 里含这一段的目录，如 2026_9_15")
    args = ap.parse_args()

    d = dt.date.fromisoformat(args.date) if args.date else None
    asyncio.run(report_db(d, args.sample))
    prefix = args.session_prefix
    if not prefix and args.sample:
        prefix = args.sample.split("_imu")[0]
    report_nas(prefix)

    print("怎么读这份报告")
    print("  · 同一个站点里视角数不一致 → 多半是新旧两批导入规则混在一起")
    print("  · ② 里「自己配对」超过 1 路 → 这只狗本来就有多路属于自己的画面，")
    print("    3 路是对的，不是 bug")
    print("  · ② 说「导入会挂 2 路」而 ① 里是 3 路 → 那个样本是**规则上线之前**")
    print("    导入的，重扫不会改它（导入只补空位和失效的路径，不动还在的文件）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
