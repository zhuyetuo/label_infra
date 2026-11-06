"""
训练记录「导出训练数据」：把一次训练用到的数据集原样打成一个 zip——
原始 IMU CSV + 标签（不要视频），外加训练参数，拿去别处（自己电脑、别人）复现 / 重训。

包里：
  README.txt                   怎么读
  train_spec.json              提交训练时的全部参数（数据集、采样率、窗口、类别归并、模型参数……）
  datasets/<名字>/merged_tmp.json  喂给训练的那份标签（Label Studio 格式，跟 NAS 上一模一样）
  datasets/<名字>/meta.json        导出时的范围 / 统计（有就带）
  datasets/<名字>/labels.csv       同一份标签摊平成表：一行一段，csv 列指向包里的 CSV
  csv/<NAS 相对路径>               原始 CSV，多个数据集共用的只放一份

CSV 动辄几百 MB，边打包边往外发（不先落盘、不整份进内存），打包线程跟下载速度走。
"""

from __future__ import annotations

import csv
import hashlib
import hmac
import io
import json
import os
import queue
import threading
import time
import zipfile

from app.core.config import settings
from app.services.media_resolver import resolve_nas_path

_TTL = 4 * 3600


class BundleError(Exception):
    pass


# 下载走 <a href>（几百 MB 用 axios 拿成 Blob 会整份进浏览器内存），带不了 Authorization，
# 换一个只认这一条训练记录的短期 token。跟媒体 token 分开签，免得 id 撞上
def issue_token(version_id: int) -> str:
    exp = int(time.time()) + _TTL
    sig = hmac.new(settings.jwt_secret.encode(), f"trainbundle.{version_id}.{exp}".encode(), hashlib.sha256).hexdigest()[:32]
    return f"{exp}.{sig}"


def verify_token(version_id: int, token: str) -> bool:
    try:
        exp_s, sig = token.split(".", 1)
        exp = int(exp_s)
    except (ValueError, AttributeError):
        return False
    if exp < time.time():
        return False
    want = hmac.new(settings.jwt_secret.encode(), f"trainbundle.{version_id}.{exp}".encode(), hashlib.sha256).hexdigest()[:32]
    return hmac.compare_digest(want, sig)


def _ds_name(export_json: str) -> str:
    return os.path.basename(os.path.dirname(export_json.rstrip("/"))) or "dataset"


def plan(spec: dict) -> dict:
    """先把要装什么理清楚（读标签 json、量 CSV 大小）。下载前给界面看个大概，也让错误在开始发之前就报出来。"""
    sources = []
    if spec.get("export_json"):
        sources.append(spec["export_json"])
    for x in spec.get("extra_datasets") or []:
        if x.get("export_json"):
            sources.append(x["export_json"])
    missing: list[str] = []
    if not spec.get("export_json"):
        missing.append(f"主数据集 {spec.get('date')} 不是平台导出的（AI 服务那边的老目录），包里没有")
    for d in spec.get("extra_date") or []:
        missing.append(f"一起训练的 {d} 不是平台导出的（AI 服务那边的老目录），包里没有")
    datasets = []
    csvs: dict[str, int] = {}
    for rel in dict.fromkeys(sources):
        try:
            path = resolve_nas_path(rel)
            with open(path, encoding="utf-8") as f:
                tasks = json.load(f)
        except Exception as e:  # noqa: BLE001
            missing.append(f"数据集 {_ds_name(rel)} 读不到（{e}）——可能已被删除")
            continue
        meta = os.path.join(os.path.dirname(path), "meta.json")
        datasets.append({"name": _ds_name(rel), "rel": rel, "tasks": tasks,
                         "meta": meta if os.path.isfile(meta) else None})
        for t in tasks:
            c = (t.get("data") or {}).get("csv")
            if not c or c in csvs:
                continue
            try:
                csvs[c] = os.path.getsize(resolve_nas_path(c))
            except Exception:  # noqa: BLE001
                csvs[c] = -1
    bad = [c for c, n in csvs.items() if n < 0]
    if bad:
        missing.append(f"{len(bad)} 个 CSV 在 NAS 上找不到：" + "、".join(bad[:5]) + ("…" if len(bad) > 5 else ""))
    if not datasets:
        raise BundleError("这次训练没有可导出的数据集：" + "；".join(missing))
    return {"datasets": datasets, "csvs": {c: n for c, n in csvs.items() if n >= 0}, "missing": missing}


def summary(p: dict) -> dict:
    return {
        "datasets": [d["name"] for d in p["datasets"]],
        "n_csv": len(p["csvs"]),
        "bytes": sum(p["csvs"].values()),
        "n_segments": sum(len(a.get("result") or []) for d in p["datasets"] for t in d["tasks"] for a in t.get("annotations") or []),
        "missing": p["missing"],
    }


def _labels_csv(tasks: list[dict]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["task_id", "sample_code", "csv", "sample_rate_hz", "start", "end", "start_ms", "end_ms",
                "seconds", "label", "label_chain", "track"])
    for t in tasks:
        d = t.get("data") or {}
        for a in t.get("annotations") or []:
            for seg in a.get("result") or []:
                v = seg.get("value") or {}
                chain = v.get("timeserieslabels") or []
                s_ms, e_ms = v.get("start_ms"), v.get("end_ms")
                w.writerow([t.get("id"), d.get("sample_code"), f"csv/{d.get('csv')}" if d.get("csv") else "",
                            d.get("sample_rate_hz"), v.get("start"), v.get("end"), s_ms, e_ms,
                            round((e_ms - s_ms) / 1000, 3) if s_ms is not None and e_ms is not None else "",
                            chain[-1] if chain else "", "/".join(chain), v.get("track") or ""])
    return ("﻿" + buf.getvalue()).encode("utf-8")  # 带 BOM：Excel 直接打开不乱码


README = """训练数据包（标注平台「训练记录 → 导出训练数据」）

train_spec.json
  提交这次训练时的全部参数：主数据集 / 一起训练的数据集、原始采样率 source_hz、训练采样率 hz、
  轴数 axes、方向无关 channel_mode、短促动作补齐 short_labels、类别归并 label_remap、
  时间窗口 window_s / 滑动步长 stride_s、窗口标签 label_mode、模型参数 model_params 等。
  没填的项是 null，训练时走默认。

datasets/<名字>/merged_tmp.json
  训练读的就是这份（Label Studio 导出格式）。每个任务：
    data.csv            原始 CSV（NAS 相对路径；包里在 csv/ 下同样的路径）
    data.sample_rate_hz 这份 CSV 自己的采样率（数据混了 16Hz / 50Hz 等，按这个重采样，别按一个全局值）
    annotations[0].result[].value
      start / end        绝对时间（跟 CSV 时间戳列对得上）
      start_ms / end_ms  相对 CSV 第一行的毫秒
      timeserieslabels   整条类别链，最后一个最细（如 [抓挠, 抓挠-头颈]）
  只有被标注的时间段算训练数据；没标的时间不是负样本，是不参与训练。
  「待定」片段和采集掉数据的时段导出时已经挖掉。

datasets/<名字>/labels.csv
  同一份标签摊平成表，一行一段，方便看分布；csv 列是包里的路径。
  label = 最细的类别；训练前还要按 train_spec.json 的 label_remap 归并。

datasets/<名字>/meta.json
  导出时的筛选条件和统计。

csv/
  原始 IMU CSV，没有视频。多个数据集用到同一份 CSV 只放一份。
"""


class _Pipe(io.RawIOBase):
    """zipfile 往这里写，下载那头从队列里取。下载断了（abort）就让打包线程停下"""

    def __init__(self, q: queue.Queue, abort: threading.Event):
        self.q, self.abort, self.n = q, abort, 0

    def writable(self):
        return True

    def write(self, b):
        if self.abort.is_set():
            raise BrokenPipeError("下载已断开")
        data = bytes(b)
        while True:
            try:
                self.q.put(data, timeout=1)
                break
            except queue.Full:
                if self.abort.is_set():
                    raise BrokenPipeError("下载已断开") from None
        self.n += len(data)
        return len(data)

    def tell(self):  # zipfile 在不可 seek 的流上也要问位置
        return self.n


def _build(p: dict, spec_doc: dict, out: _Pipe) -> None:
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        zf.writestr("README.txt", README + ("\n没装进来的：\n" + "\n".join(f"  · {m}" for m in p["missing"]) + "\n" if p["missing"] else ""))
        zf.writestr("train_spec.json", json.dumps(spec_doc, ensure_ascii=False, indent=2))
        for d in p["datasets"]:
            base = f"datasets/{d['name']}"
            zf.writestr(f"{base}/merged_tmp.json", json.dumps(d["tasks"], ensure_ascii=False))
            if d["meta"]:
                zf.write(d["meta"], f"{base}/meta.json")
            zf.writestr(f"{base}/labels.csv", _labels_csv(d["tasks"]))
        for rel in p["csvs"]:
            with open(resolve_nas_path(rel), "rb") as src, zf.open(f"csv/{rel}", "w", force_zip64=True) as dst:
                while True:
                    chunk = src.read(1 << 20)
                    if not chunk:
                        break
                    dst.write(chunk)


_END = object()


def stream(p: dict, spec_doc: dict):
    """边打包边往外吐的生成器（给 StreamingResponse）。"""
    q: queue.Queue = queue.Queue(maxsize=32)
    abort = threading.Event()
    err: list[BaseException] = []

    def run():
        try:
            _build(p, spec_doc, _Pipe(q, abort))
        except BaseException as e:  # noqa: BLE001
            err.append(e)
        finally:
            while not abort.is_set():
                try:
                    q.put(_END, timeout=1)
                    break
                except queue.Full:
                    continue

    th = threading.Thread(target=run, daemon=True, name="train-bundle")
    th.start()
    try:
        while True:
            item = q.get()
            if item is _END:
                break
            yield item
        if err and not isinstance(err[0], BrokenPipeError):
            raise err[0]  # 包已经发了一半，只能断掉——浏览器那边会显示下载失败，不会是个坏 zip 当成功
    finally:
        abort.set()
