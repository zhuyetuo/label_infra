#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
HICC_PetCollar 设备自检（跟平台「设备调试 → 一键自检」同一套算法、同一套判定）
==========================================================================

三种用法：

  1. 自己测（电脑蓝牙直连项圈，要 PB_RAW_STREAM=1 的调试固件）：
       python petcollar_selftest.py run --minutes 5 --static
       python petcollar_selftest.py run --minutes 10 --address EA:CB:30:12:30:25 --tag 固件v1.3_桌面
     结果在 selftest_<时间>/ 下：raw.csv、behavior.csv、result.json、report.md

  2. 复现别人的结果（拿平台下载的压缩包里的 raw.csv 重算一遍）：
       python petcollar_selftest.py analyze raw.csv --static
       python petcollar_selftest.py analyze raw.csv --expect-hz 31.25 -o out/

  3. 多次 / 多人的结果放一起比：
       python petcollar_selftest.py compare result_a.json result_b.json selftest_xxx/
       （给目录就读里面的 result.json）

口径（平台和这个脚本一样）：
  - 采样率 / 帧间隔 / 板子时钟 / 底噪全部按**板子时间戳**（0x08 的 DP 0x0A）算；蓝牙晚到、成批到不影响。
  - 丢帧 = 板子时间戳上的缝（间隔 > 1.5 个周期）。**分不清是蓝牙丢的还是板子没发**——
    「缝出现时电脑这边也卡了」只是线索；要分清得固件给 0x08 加样本序号（见报告末尾的建议）。
  - 板子时钟 = 板上时间 − 电脑时间，每 2 秒取最大的那个（蓝牙只会让样本晚到），Theil–Sen 拟合斜率 → ppm。
    电脑时间要准（一般 Windows / macOS 默认自动对时）。
  - 底噪要项圈**静置平放**：短时噪声用一阶差分估（去掉慢漂移），稳定性看每 10 秒均值怎么走。

依赖：分析只用标准库；run 要 pip install bleak；有 matplotlib 的话 report 目录里会多几张图。
raw.csv 列：dev_ts_ms（板子时间戳）, host_ts_ms（电脑收到的 Unix 毫秒）, acc_x_g, acc_y_g, acc_z_g
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import json
import math
import os
import sys
import time
from datetime import datetime, timezone

# ── 协议（HICC_PetCollar v2.0）────────────────────────────────────────────

DEVICE_NAME = "HICC_PetCollar"
UUID_TX = "a6ed0202-d344-460a-8075-b9e8ec90d71b"    # Notify: 0x06 校时请求 / 0x07 当前行为 / 0x09 片段
UUID_TX2 = "a6ed0203-d344-460a-8075-b9e8ec90d71b"   # Notify: 0x08 原始采样镜像（调试固件才有）
UUID_RX = "a6ed0204-d344-460a-8075-b9e8ec90d71b"    # Write : 校时应答 / 0x0A 确认
CMD_TIME, CMD_BEHAVIOR, CMD_RAW, CMD_SEGMENT, CMD_ACK = 0x06, 0x07, 0x08, 0x09, 0x0A
DP_TS, DP_AX, DP_AY, DP_AZ = 0x0A, 0x17, 0x18, 0x19


def parse_frame(b: bytes):
    if len(b) < 7 or b[0] != 0x55 or b[1] != 0xAA or b[2] != 0x00:
        return None
    n = (b[4] << 8) | b[5]
    if len(b) < 7 + n or (sum(b[:6 + n]) & 0xFF) != b[6 + n]:
        return None
    return b[3], b[6:6 + n]


def parse_dps(payload: bytes) -> dict:
    out, pos = {}, 0
    while pos + 4 <= len(payload):
        dpid, dtype = payload[pos], payload[pos + 1]
        dl = (payload[pos + 2] << 8) | payload[pos + 3]
        raw = payload[pos + 4:pos + 4 + dl]
        pos += 4 + dl
        if dtype == 0x02 and raw:
            out[dpid] = int.from_bytes(raw, "big", signed=True)
        elif dtype == 0x04 and raw:
            out[dpid] = raw[0]
    return out


def build_frame(cmd: int, body: bytes) -> bytes:
    f = bytes([0x55, 0xAA, 0x00, cmd, (len(body) >> 8) & 0xFF, len(body) & 0xFF]) + body
    return f + bytes([sum(f) & 0xFF])


def build_time_frame() -> bytes:
    n = datetime.now(timezone.utc)
    return build_frame(CMD_TIME, bytes([0x01, (n.year - 2000) & 0xFF, n.month, n.day, n.hour, n.minute, n.second]))


# ── 统计小工具（跟平台 utils/selfTest.ts 同一套：分位数线性插值、总体标准差、JS 的四舍五入）──

def jround(x: float) -> int:
    """JS 的 Math.round（.5 往上），Python 的 round 是银行家舍入，对不上平台"""
    return math.floor(x + 0.5)


def q(xs, p):
    if not xs:
        return float("nan")
    s = sorted(xs)
    k = (len(s) - 1) * p
    lo = math.floor(k)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def mean(xs):
    return sum(xs) / len(xs) if xs else float("nan")


def std(xs):
    if not xs:
        return float("nan")
    m = mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / len(xs))


def lin_slope(t, y):
    mt, my = mean(t), mean(y)
    sxx = sum((x - mt) ** 2 for x in t)
    return sum((x - mt) * (y[i] - my) for i, x in enumerate(t)) / sxx if sxx > 0 else 0.0


def robust_slope(pts):
    """Theil–Sen 斜率 + 残差 MAD 估的误差（不怕蓝牙卡顿那几个大坑）"""
    if len(pts) < 10:
        return None, None, None
    step = max(1, len(pts) // 150)
    sub = [p for i, p in enumerate(pts) if i % step == 0]
    sl = []
    for i in range(len(sub)):
        for j in range(i + 1, len(sub)):
            dt = sub[j][0] - sub[i][0]
            if dt >= 10:
                sl.append((sub[j][1] - sub[i][1]) / dt)
    if not sl:
        return None, None, None
    slope = q(sl, 0.5)
    icpt = q([p[1] - slope * p[0] for p in pts], 0.5)
    res = [abs(p[1] - slope * p[0] - icpt) for p in pts]
    sigma = 1.4826 * q(res, 0.5)
    T = pts[-1][0] - pts[0][0]
    err = sigma * math.sqrt(12) / (math.sqrt(len(pts)) * T) if T > 0 else None
    return slope, err, sigma


def fin(x):
    return x is not None and isinstance(x, (int, float)) and math.isfinite(x)


# ── 分析 ──────────────────────────────────────────────────────────────────

def analyze(raw, expect_hz=31.25, device="", kind="pc", started_at=None, static_claimed=True, behav_ts=None):
    """raw: [(dev_ts_ms, host_ts_ms, ax, ay, az), ...]，host_ts_ms 是电脑收到时的 Unix 毫秒"""
    start = 0
    for i in range(1, len(raw)):
        a, b = raw[i - 1][0], raw[i][0]
        if a is not None and b is not None and (b - a > 10_000 or b - a < -1000):
            start = i
    s = [r for r in raw[start:] if r[0] is not None]
    n = len(s)
    dev = [r[0] for r in s]
    host = [r[1] for r in s]
    iv = [dev[i + 1] - dev[i] for i in range(n - 1)]
    pos = [x for x in iv if x > 0]
    P = q(pos, 0.5) if pos else 1000 / expect_hz
    span_dev = (dev[-1] - dev[0]) / 1000 if n > 1 else 0
    span_host = (host[-1] - host[0]) / 1000 if n > 1 else 0

    # 采样率：每 10 秒（按板子时间）。hz = 到手几个；sensor_hz = 帧间隔中位数换算的传感器节奏
    blocks = []
    if n > 1:
        cnt, ivs = {}, {}
        for i in range(n):
            k = math.floor((dev[i] - dev[0]) / 10_000)
            cnt[k] = cnt.get(k, 0) + 1
            if i > 0 and dev[i] - dev[i - 1] > 0:
                ivs.setdefault(k, []).append(dev[i] - dev[i - 1])
        last = math.floor((dev[-1] - dev[0]) / 10_000)
        for k in range(last):
            m = q(ivs.get(k, []), 0.5)
            blocks.append({"t": k * 10, "hz": cnt.get(k, 0) / 10, "sensorHz": 1000 / m if fin(m) and m > 0 else float("nan")})

    normal = [x for x in iv if 0 < x <= P * 1.5]
    alt = 0
    for i in range(1, len(iv)):
        a, b = iv[i - 1], iv[i]
        if (a > P * 1.15 and 0 < b < P * 0.85) or (0 < a < P * 0.85 and P * 1.15 < b <= P * 1.5):
            alt += 1
    hist = {}
    for x in iv:
        k = max(0, min(jround(x), jround(P * 3)))
        hist[k] = hist.get(k, 0) + 1

    gaps, sizes, lost, stall = [], {"1": 0, "2": 0, "3": 0, "4+": 0}, 0, 0
    for i, x in enumerate(iv):
        if x > P * 1.5:
            missing = max(1, jround(x / P) - 1)
            hg = host[i + 1] - host[i]
            lost += missing
            sizes["4+" if missing >= 4 else str(missing)] += 1
            if hg > max(300, x):
                stall += 1
            gaps.append({"t": (dev[i] - dev[0]) / 1000, "ms": x, "missing": missing, "hostGapMs": hg})

    bucket = {}
    for d, h in zip(dev, host):
        off = d - h
        k = math.floor((h - host[0]) / 2000)
        if k not in bucket or off > bucket[k]:
            bucket[k] = off
    keys = sorted(bucket)[:-1]
    cpts = [(k * 2, bucket[k]) for k in keys]
    fit = [p for p in cpts if p[0] >= 10]
    slope, err, jit = robust_slope(fit)
    fit_s = fit[-1][0] - fit[0][0] if fit else 0

    ax = [r[2] for r in s]
    ay = [r[3] for r in s]
    az = [r[4] for r in s]
    mag = [math.sqrt(r[2] ** 2 + r[3] ** 2 + r[4] ** 2) for r in s]
    nb = []
    if n > 1:
        acc = {}
        for r in s:
            k = math.floor((r[0] - dev[0]) / 10_000)
            a = acc.setdefault(k, [0.0, 0.0, 0.0, 0])
            a[0] += r[2]
            a[1] += r[3]
            a[2] += r[4]
            a[3] += 1
        for k in sorted(acc):
            a = acc[k]
            if a[3] >= 10:
                nb.append({"t": k * 10, "ax": a[0] / a[3], "ay": a[1] / a[3], "az": a[2] / a[3]})

    def axis(name, v, key):
        d = [v[i + 1] - v[i] for i in range(len(v) - 1)]
        bm = [b[key] for b in nb]
        return {"name": name, "mean": mean(v), "std": std(v) * 1000, "short": std(d) / math.sqrt(2) * 1000,
                "p2p": (max(v) - min(v)) * 1000 if v else float("nan"),
                "blockRange": (max(bm) - min(bm)) * 1000 if bm else float("nan"),
                "slopePerMin": lin_slope([b["t"] / 60 for b in nb], bm) * 1000 if len(bm) >= 3 else float("nan")}

    axes = [axis("X", ax, "ax"), axis("Y", ay, "ay"), axis("Z", az, "az")]
    is_static = all(a["short"] < 30 for a in axes) and std(mag) * 1000 < 50
    bt = [t for t in (behav_ts or []) if n > 1 and dev[0] <= t <= dev[-1]]

    rep = {
        "meta": {"device": device, "kind": kind, "startedAt": started_at or (host[0] if host else 0), "durationS": span_host,
                 "expectHz": expect_hz, "staticClaimed": static_claimed, "n": n, "droppedHead": start},
        "rate": {"periodMs": P, "sensorHz": 1000 / P, "byDevHz": (n - 1) / span_dev if span_dev > 0 else float("nan"),
                 "byHostHz": (n - 1) / span_host if span_host > 0 else float("nan"), "blocks": blocks},
        "iv": {"mean": mean(iv), "std": std(iv), "jitterStd": std(normal), "min": min(iv) if iv else float("nan"),
               "max": max(iv) if iv else float("nan"), "p1": q(iv, .01), "p5": q(iv, .05), "p50": q(iv, .5), "p95": q(iv, .95), "p99": q(iv, .99),
               "within10": sum(1 for x in normal if abs(x - P) <= P * 0.1) / len(normal) * 100 if normal else float("nan"),
               "dup": sum(1 for x in iv if x <= 0), "alternating": alt, "hist": [{"ms": k, "n": hist[k]} for k in sorted(hist)]},
        "gaps": {"n": len(gaps), "lost": lost, "lossPct": lost / (n + lost) * 100 if n + lost > 0 else 0,
                 "maxMs": max((g["ms"] for g in gaps), default=0), "perMin": len(gaps) / (span_dev / 60) if span_dev > 0 else 0,
                 "withHostStall": stall, "sizes": sizes, "list": gaps[:500]},
        "clock": {"offStartMs": cpts[0][1] if cpts else float("nan"), "offEndMs": cpts[-1][1] if cpts else float("nan"),
                  "ppm": slope * 1000 if slope is not None else None, "ppmErr": err * 1000 if err is not None else None,
                  "jitterMs": jit, "fitS": fit_s, "pts": [{"t": t, "off": o} for t, o in cpts]},
        "noise": {"isStatic": is_static, "axes": axes, "magMean": mean(mag), "magStd": std(mag) * 1000, "blocks": nb},
        "behav": {"n": len(bt), "perMin": len(bt) / (span_dev / 60) if span_dev > 0 else 0},
        "items": [],
    }
    rep["items"] = judge(rep)
    return rep


def f(x, d=2):
    return "-" if not fin(x) else f"{x:.{d}f}"


def judge(r):
    it = []

    def add(group, name, value, status, note=None):
        it.append({"group": group, "name": name, "value": value, "status": status, **({"note": note} if note else {})})

    E = r["meta"]["expectHz"]
    rate, ivr, gp, c, nz = r["rate"], r["iv"], r["gaps"], r["clock"], r["noise"]
    dev = (rate["sensorHz"] / E - 1) * 100
    add("采样率", "传感器采样率（按帧间隔中位数）", f"{f(rate['sensorHz'])} Hz（周期 {f(rate['periodMs'], 1)} ms，标称 {E:g} Hz，{'+' if dev >= 0 else ''}{f(dev, 1)}%）",
        "ok" if abs(dev) <= 2 else "warn" if abs(dev) <= 5 else "fail",
        "跟标称对不上。时间戳可信时（见下面「板子时钟」），就是传感器实际的输出速率：查 ODR 配置 / 传感器内部振荡器" if abs(dev) > 2 else None)
    add("采样率", "实际到手（含丢帧，按板子时间）", f"{f(rate['byDevHz'])} 个/秒", "info")
    bh = [b["sensorHz"] for b in rate["blocks"] if fin(b["sensorHz"])]
    if len(bh) >= 3:
        rng = max(bh) - min(bh)
        got = [b["hz"] for b in rate["blocks"]]
        add("采样率", "采样率稳定性（每 10 秒的传感器节奏）", f"{f(min(bh))} ~ {f(max(bh))} Hz，波动 {f(rng)} Hz（实际到手 {f(min(got), 1)} ~ {f(max(got), 1)} 个/秒）",
            "ok" if rng <= rate["sensorHz"] * 0.02 else "warn" if rng <= rate["sensorHz"] * 0.05 else "fail",
            "传感器节奏本身在变：时钟源不稳 / ODR 被改过 / 读 FIFO 的方式有问题" if rng > rate["sensorHz"] * 0.02 else "到手个数的波动是丢帧造成的，看「丢帧」")
    add("帧间隔", f"在 {f(rate['periodMs'], 1)}±10% ms 内（不含丢帧的缝）", f"{f(ivr['within10'], 1)}%",
        "ok" if ivr["within10"] >= 99 else "warn" if ivr["within10"] >= 95 else "fail")
    add("帧间隔", "间隔抖动（不含丢帧的缝）", f"标准差 {f(ivr['jitterStd'], 2)} ms · p1 {f(ivr['p1'], 0)} / p50 {f(ivr['p50'], 0)} / p99 {f(ivr['p99'], 0)} ms",
        "ok" if ivr["jitterStd"] <= rate["periodMs"] * 0.1 else "warn" if ivr["jitterStd"] <= rate["periodMs"] * 0.2 else "fail")
    alt_lim = max(3, r["meta"]["n"] * 0.005)
    add("帧间隔", "一会长一会短（交替）", f"{ivr['alternating']} 次", "ok" if ivr["alternating"] <= alt_lim else "warn",
        "间隔长短交替：通常是固件按整 ms 打时间戳（34/35 交替），或者读 FIFO 的节奏跟采样不同步" if ivr["alternating"] > alt_lim else None)
    add("帧间隔", "时间戳没走（0 ms 间隔）", f"{ivr['dup']} 次", "fail" if ivr["dup"] else "ok",
        "同一个时间戳出现两次：重复发送，或者时间戳分辨率不够" if ivr["dup"] else None)
    add("丢帧", "丢帧率（时间戳上的缝）", f"{f(gp['lossPct'], 2)}%（{gp['lost']} 个，{gp['n']} 处，最长 {f(gp['maxMs'], 0)} ms）",
        "ok" if gp["lossPct"] <= 0.1 else "warn" if gp["lossPct"] <= 1 else "fail")
    if gp["n"]:
        pct = gp["withHostStall"] / gp["n"] * 100
        add("丢帧", "缝出现时电脑这边也卡了", f"{gp['withHostStall']} / {gp['n']} 处（{f(pct, 0)}%）", "info",
            "大多伴随蓝牙卡顿：更像是蓝牙 / 发送队列丢的" if pct >= 70 else "大多不伴随蓝牙卡顿：更像板子那边没发出来（读 FIFO 漏了 / 队列满了丢）" if pct <= 30
            else "两种都有。要分清得固件给 0x08 加样本序号")
    if c["fitS"] < 60 or c["ppm"] is None:
        add("板子时钟", "时钟快慢（相对电脑）", "-" if c["ppm"] is None else f"{f(c['ppm'], 0)} ppm（±{f(c['ppmErr'], 0)}）", "info",
            "测得太短（要 1 分钟以上，测漂移建议 10 分钟+）")
    else:
        sure = abs(c["ppm"]) > 3 * (c["ppmErr"] or 0)
        per_day = c["ppm"] * 86400 / 1e6
        add("板子时钟", "时钟快慢（相对电脑）", f"{'+' if c['ppm'] >= 0 else ''}{f(c['ppm'], 0)} ppm（±{f(c['ppmErr'], 0)}，约每天{'快' if per_day >= 0 else '慢'} {f(abs(per_day), 1)} 秒）",
            "ok" if (not sure or abs(c["ppm"]) <= 100) else "warn" if abs(c["ppm"]) <= 1000 else "fail",
            "在测量误差以内，看不出快慢" if not sure else "超过 0.1%：多半不是晶振（±20 ppm），是 RC 时钟或时间戳算法的问题" if abs(c["ppm"]) > 1000 else None)
    add("板子时钟", "板子比电脑", f"开始 {f(c['offStartMs'], 0)} ms → 结束 {f(c['offEndMs'], 0)} ms",
        "warn" if fin(c["offEndMs"]) and abs(c["offEndMs"]) > 5000 else "info", "差好几秒：多半没校时" if fin(c["offEndMs"]) and abs(c["offEndMs"]) > 5000 else None)
    if c["jitterMs"] is not None:
        add("板子时钟", "时间戳抖动（扣掉趋势后）", f"{f(c['jitterMs'], 1)} ms", "info", "含蓝牙延迟的抖动，只当参考")
    if not nz["isStatic"]:
        add("三轴", "底噪 / 稳定性", "测试期间项圈动了", "info", "底噪要静置平放测：短时噪声超过 30 mg，这几项不下结论")
    else:
        for a in nz["axes"]:
            add("三轴", f"{a['name']} 轴底噪（短时）", f"{f(a['short'], 2)} mg rms（总 std {f(a['std'], 2)} mg，峰峰 {f(a['p2p'], 1)} mg）",
                "ok" if a["short"] <= 5 else "warn" if a["short"] <= 15 else "fail")
        for a in nz["axes"]:
            if not fin(a["blockRange"]):
                continue
            add("三轴", f"{a['name']} 轴稳定性（每 10 秒均值）", f"均值 {f(a['mean'], 4)} g · 漂了 {f(a['blockRange'], 2)} mg · {f(a['slopePerMin'], 2)} mg/分钟",
                "ok" if a["blockRange"] <= 5 else "warn" if a["blockRange"] <= 20 else "fail")
        md = (nz["magMean"] - 1) * 1000
        add("三轴", "合加速度（静置应为 1 g）", f"{f(nz['magMean'], 4)} g（{'+' if md >= 0 else ''}{f(md, 1)} mg）",
            "ok" if abs(md) <= 30 else "warn" if abs(md) <= 80 else "fail", "偏离 1 g：量程 / 比例因子 / 零偏没校准" if abs(md) > 30 else None)
    if r["behav"]["n"]:
        add("行为上报", "0x07 当前行为", f"{r['behav']['n']} 条，每分钟 {f(r['behav']['perMin'], 1)} 条", "info")
    return it


# ── 输出 ──────────────────────────────────────────────────────────────────

STATUS_TXT = {"ok": "通过", "warn": "注意", "fail": "不通过", "info": "参考"}


def to_markdown(r) -> str:
    m = r["meta"]
    fails = sum(1 for i in r["items"] if i["status"] == "fail")
    warns = sum(1 for i in r["items"] if i["status"] == "warn")
    out = ["# 设备自检报告", "",
           f"设备 **{m['device'] or '-'}** · 开始 {datetime.fromtimestamp((m['startedAt'] or 0) / 1000).strftime('%Y-%m-%d %H:%M:%S')} · "
           f"时长 {m['durationS'] / 60:.1f} 分钟 · {m['n']} 个样本 · 标称 {m['expectHz']:g} Hz · {'测试时静置' if m['staticClaimed'] else '未声明静置'}"
           + (f" · 标签 {m['tag']}" if m.get("tag") else ""), "",
           f"结论：{'**' + str(fails) + ' 项不通过**' if fails else '没有不通过的项'}{f'，{warns} 项需要注意' if warns else ''}", "",
           "| 分组 | 项目 | 结果 | 判定 |", "|---|---|---|---|"]
    for i in r["items"]:
        note = f"<br>_{i['note']}_" if i.get("note") else ""
        out.append(f"| {i['group']} | {i['name']} | {i['value']}{note} | {STATUS_TXT[i['status']]} |")
    if r["gaps"]["list"]:
        out += ["", "## 丢帧的缝（前 30 处）", "", "| 第几秒 | 间隔 ms | 缺几个 | 电脑这边间隔 ms |", "|---|---|---|---|"]
        out += [f"| {g['t']:.1f} | {g['ms']:.0f} | {g['missing']} | {g['hostGapMs']:.0f} |" for g in r["gaps"]["list"][:30]]
    return "\n".join(out) + "\n"


def print_items(r):
    w = max(len(i["name"]) for i in r["items"]) + 2
    g = None
    for i in r["items"]:
        if i["group"] != g:
            g = i["group"]
            print(f"\n【{g}】")
        print(f"  {i['name']:<{w}} {i['value']}   [{STATUS_TXT[i['status']]}]")
        if i.get("note"):
            print(f"  {'':<{w}}   ↳ {i['note']}")


def plots(r, out_dir):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return []
    files = []
    fig, ax = plt.subplots(2, 2, figsize=(12, 7))
    b = r["rate"]["blocks"]
    ax[0][0].plot([x["t"] for x in b], [x["sensorHz"] for x in b], label="sensor")
    ax[0][0].plot([x["t"] for x in b], [x["hz"] for x in b], label="delivered")
    ax[0][0].set_title("rate per 10 s (Hz)")
    ax[0][0].legend()
    h = r["iv"]["hist"]
    ax[0][1].bar([x["ms"] for x in h], [x["n"] for x in h])
    ax[0][1].set_yscale("log")
    ax[0][1].set_title("frame interval (ms)")
    pts = r["clock"]["pts"]
    if pts:
        ax[1][0].plot([p["t"] for p in pts], [p["off"] - pts[0]["off"] for p in pts])
    ax[1][0].set_title("board - PC (ms, from 0)")
    nb = r["noise"]["blocks"]
    for k in ("ax", "ay", "az"):
        if nb:
            ax[1][1].plot([x["t"] for x in nb], [(x[k] - nb[0][k]) * 1000 for x in nb], label=k)
    ax[1][1].set_title("10 s mean drift (mg)")
    ax[1][1].legend()
    fig.tight_layout()
    p = os.path.join(out_dir, "charts.png")
    fig.savefig(p, dpi=110)
    files.append(p)
    return files


def write_outputs(r, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "result.json"), "w", encoding="utf-8") as fp:
        json.dump(r, fp, ensure_ascii=False, indent=1, default=lambda x: None)
    with open(os.path.join(out_dir, "report.md"), "w", encoding="utf-8") as fp:
        fp.write(to_markdown(r))
    plots(r, out_dir)


def read_raw(path):
    rows = []
    with open(path, encoding="utf-8-sig") as fp:
        for row in csv.DictReader(fp):
            d = row.get("dev_ts_ms") or row.get("t_dev_ms")
            if not d:
                continue
            rows.append((int(float(d)), float(row.get("host_ts_ms") or row.get("t_host_ms") or 0),
                         float(row.get("acc_x_g") or row.get("ax_g")), float(row.get("acc_y_g") or row.get("ay_g")),
                         float(row.get("acc_z_g") or row.get("az_g"))))
    return rows


# ── 自己测：蓝牙直连采集 ──────────────────────────────────────────────────

async def collect(address, seconds):
    from bleak import BleakClient, BleakScanner

    dev = None
    for i in range(3):
        print(f"扫描 {address or DEVICE_NAME}（{i + 1}/3）…")
        found = await BleakScanner.discover(timeout=8.0, return_adv=True)
        cand = [(d, adv) for d, adv in found.values()
                if (address and d.address.upper() == address.upper()) or (not address and (adv.local_name or d.name or "") == DEVICE_NAME)]
        if cand:
            dev = max(cand, key=lambda t: t[1].rssi)[0]
            break
    if dev is None:
        raise SystemExit("没找到设备：确认上电在广播；信号弱时用 --address 指定 MAC")
    rows, behav = [], []
    client = BleakClient(dev, timeout=30.0)

    async def send(fr):
        try:
            await client.write_gatt_char(UUID_RX, fr, response=False)
        except Exception as e:  # noqa: BLE001
            print(f"  ! 写 RX 失败：{e}")

    async def on_notify(_c, data):
        p = parse_frame(bytes(data))
        if not p:
            return
        cmd, payload = p
        if cmd == CMD_TIME:
            await send(build_time_frame())
        elif cmd == CMD_RAW:
            d = parse_dps(payload)
            rows.append((d.get(DP_TS), time.time() * 1000, d.get(DP_AX, 0) / 1e6, d.get(DP_AY, 0) / 1e6, d.get(DP_AZ, 0) / 1e6))
        elif cmd == CMD_BEHAVIOR:
            d = parse_dps(payload)
            if DP_TS in d:
                behav.append(d[DP_TS])
        elif cmd == CMD_SEGMENT and payload:
            n = payload[0]
            seqs = [int.from_bytes(payload[1 + i * 13:5 + i * 13], "big") for i in range(n) if 1 + i * 13 + 13 <= len(payload)]
            if seqs:
                await send(build_frame(CMD_ACK, max(seqs).to_bytes(4, "big")))

    await client.connect()
    print(f"已连接 {dev.address}，采 {seconds / 60:.1f} 分钟（Ctrl+C 提前结束）")
    await client.start_notify(UUID_TX, on_notify)
    try:
        await client.start_notify(UUID_TX2, on_notify)
    except Exception as e:  # noqa: BLE001
        print(f"订阅 0x08（TX2）失败：{e}——要 PB_RAW_STREAM=1 的调试固件")
    await send(build_time_frame())
    t0 = time.monotonic()
    try:
        while client.is_connected and time.monotonic() - t0 < seconds:
            await asyncio.sleep(1)
            el = time.monotonic() - t0
            print(f"\r  {int(el // 60)}:{int(el % 60):02d} / {int(seconds // 60)}:{int(seconds % 60):02d}  已收 {len(rows)} 个", end="", flush=True)
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        print()
        try:
            await client.disconnect()
        except Exception:  # noqa: BLE001
            pass
    if not client.is_connected and time.monotonic() - t0 < seconds - 2:
        print("⚠ 中途断开了，按已收到的数据出报告")
    return dev.address, rows, behav


def cmd_run(a):
    started = time.time() * 1000
    try:
        addr, rows, behav = asyncio.run(collect(a.address, a.minutes * 60))
    except KeyboardInterrupt:
        return 1
    if not rows:
        print("一个 0x08 样本都没收到：正式固件不发原始采样，要 PB_RAW_STREAM=1 的调试固件")
        return 2
    out = a.out or f"selftest_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "raw.csv"), "w", newline="", encoding="utf-8") as fp:
        w = csv.writer(fp)
        w.writerow(["dev_ts_ms", "host_ts_ms", "acc_x_g", "acc_y_g", "acc_z_g"])
        for r in rows:
            w.writerow([r[0] if r[0] is not None else "", f"{r[1]:.3f}", f"{r[2]:.6f}", f"{r[3]:.6f}", f"{r[4]:.6f}"])
    with open(os.path.join(out, "behavior.csv"), "w", encoding="utf-8") as fp:
        fp.write("\n".join(["dev_ts_ms", *map(str, behav)]))
    r = analyze(rows, a.expect_hz, f"{DEVICE_NAME} {addr}", "pc", started, a.static, behav)
    r["meta"]["tag"] = a.tag
    r["meta"]["source"] = "petcollar_selftest.py run"
    write_outputs(r, out)
    print_items(r)
    print(f"\n结果：{out}/（raw.csv / result.json / report.md）")
    return 0


def cmd_analyze(a):
    rows = read_raw(a.csv)
    if not rows:
        print(f"{a.csv} 里没有数据行")
        return 2
    meta = {}
    side = os.path.join(os.path.dirname(os.path.abspath(a.csv)), "result.json")
    if os.path.exists(side):    # 平台下载的压缩包里带着原来的设置（标称采样率、是否静置）
        try:
            with open(side, encoding="utf-8") as fp:
                meta = (json.load(fp) or {}).get("meta") or {}
        except Exception:  # noqa: BLE001
            meta = {}
    hz = a.expect_hz or meta.get("expectHz") or 31.25
    static = a.static if a.static is not None else meta.get("staticClaimed", True)
    behav = []
    bpath = os.path.join(os.path.dirname(os.path.abspath(a.csv)), "behavior.csv")
    if os.path.exists(bpath):   # 0x07 的板子时间戳（平台的压缩包、run 都会写）
        with open(bpath, encoding="utf-8") as fp:
            behav = [int(float(x)) for x in fp.read().split()[1:] if x.strip()]
    r = analyze(rows, hz, meta.get("device", ""), meta.get("kind", "pc"), meta.get("startedAt"), static, behav)
    r["meta"]["tag"] = a.tag or meta.get("tag")
    r["meta"]["source"] = f"petcollar_selftest.py analyze {os.path.basename(a.csv)}"
    out = a.out or os.path.join(os.path.dirname(os.path.abspath(a.csv)), "reanalyzed")
    write_outputs(r, out)
    print_items(r)
    print(f"\n结果：{out}/（result.json / report.md）")
    return 0


def cmd_compare(a):
    runs = []
    for p in a.results:
        path = os.path.join(p, "result.json") if os.path.isdir(p) else p
        with open(path, encoding="utf-8") as fp:
            runs.append((p, json.load(fp)))
    order = []
    for _, r in runs:
        for i in r["items"]:
            if i["name"] not in order:
                order.append(i["name"])
    print("| 项目 | " + " | ".join((r["meta"].get("tag") or os.path.basename(os.path.normpath(p))) for p, r in runs) + " |")
    print("|---|" + "---|" * len(runs))
    for n in order:
        cells = []
        for _, r in runs:
            it = next((i for i in r["items"] if i["name"] == n), None)
            cells.append(f"{it['value']} [{STATUS_TXT[it['status']]}]" if it else "-")
        print(f"| {n} | " + " | ".join(cells) + " |")
    return 0


def main():
    ap = argparse.ArgumentParser(description="HICC_PetCollar 设备自检：采样率 / 帧间隔 / 丢帧 / 板子时钟 / 三轴底噪")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("run", help="蓝牙直连项圈采一段，出报告")
    p.add_argument("--minutes", type=float, default=5)
    p.add_argument("--address", help="按 MAC 连（信号弱时比按名字稳）")
    p.add_argument("--expect-hz", type=float, default=31.25)
    p.add_argument("--static", action="store_true", help="项圈静置平放（测底噪必须）")
    p.add_argument("--tag", help="给这次测试起个名字（compare 时当列名），比如 固件v1.3_桌面")
    p.add_argument("-o", "--out", help="输出目录，默认 selftest_<时间>")
    p = sub.add_parser("analyze", help="用 raw.csv 重算一遍")
    p.add_argument("csv")
    p.add_argument("--expect-hz", type=float, default=None, help="默认读同目录 result.json 里的，没有就 31.25")
    p.add_argument("--static", dest="static", action="store_true", default=None)
    p.add_argument("--not-static", dest="static", action="store_false")
    p.add_argument("--tag")
    p.add_argument("-o", "--out")
    p = sub.add_parser("compare", help="多份 result.json（或目录）并排比")
    p.add_argument("results", nargs="+")
    a = ap.parse_args()
    return {"run": cmd_run, "analyze": cmd_analyze, "compare": cmd_compare}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
