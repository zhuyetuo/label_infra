"""设备自检下载包里那个 petcollar_selftest.py（前端 src/assets/ 下，打进压缩包给嵌入式自己跑）。

它的算法跟前端 utils/selfTest.ts 是同一套（逐项对过：同一份 raw.csv 两边 19 项结果一字不差）。
这里钉住它自己算得对：合成一段已知答案的数据（35 ms 周期、丢 3%、时钟慢 300 ppm、3 mg 噪声），看各项。
"""

import importlib.util
import math
import random
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "frontend" / "src" / "assets" / "petcollar_selftest.py"
# 只拷了 backend 的环境（比如后端镜像里跑测试）没有前端目录：跳过，不算失败
pytestmark = pytest.mark.skipif(not SCRIPT.exists(), reason=f"没有 {SCRIPT}（只有后端目录）")


def _load():
    spec = importlib.util.spec_from_file_location("petcollar_selftest", SCRIPT)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _synthetic(drop=0.03, ppm=-300.0, noise_g=0.003, minutes=3):
    rnd = random.Random(7)
    t0 = 1_793_000_000_000
    rows, lost = [], 0
    for i in range(int(minutes * 60_000 / 35)):
        real = i * 35
        if rnd.random() < drop:
            lost += 1
            continue
        dev = round(t0 + real * (1 + ppm * 1e-6))
        host = t0 + real + 40 + rnd.randint(0, 2) * 30
        rows.append((dev, host, 0.012 + rnd.gauss(0, noise_g), -0.021 + rnd.gauss(0, noise_g), 0.995 + rnd.gauss(0, noise_g)))
    return rows, lost


def _item(r, name):
    return next(i for i in r["items"] if i["name"].startswith(name))


def test_脚本算出已知答案():
    m = _load()
    rows, lost = _synthetic()
    r = m.analyze(rows, 31.25, static_claimed=True)
    assert math.isclose(r["rate"]["periodMs"], 35, abs_tol=0.5)
    assert _item(r, "传感器采样率")["status"] == "fail"           # 28.57 vs 31.25
    assert r["gaps"]["lost"] == lost                             # 丢的个数一个不差
    assert math.isclose(r["clock"]["ppm"], -300, abs_tol=20)
    assert r["noise"]["isStatic"] and all(math.isclose(a["short"], 3, rel_tol=0.15) for a in r["noise"]["axes"])
    assert _item(r, "合加速度")["status"] == "ok"


def test_动了就不下底噪结论_读写csv一圈不变(tmp_path):
    m = _load()
    rows, _ = _synthetic(noise_g=0.2)
    r = m.analyze(rows, 31.25)
    assert not r["noise"]["isStatic"] and _item(r, "底噪")["value"] == "测试期间项圈动了"
    p = tmp_path / "raw.csv"
    p.write_text("dev_ts_ms,host_ts_ms,acc_x_g,acc_y_g,acc_z_g\n" + "\n".join(
        f"{d},{int(h)},{x:.6f},{y:.6f},{z:.6f}" for d, h, x, y, z in rows), encoding="utf-8")
    back = m.read_raw(str(p))
    assert len(back) == len(rows)
    m.write_outputs(m.analyze(back, 31.25), str(tmp_path / "out"))
    assert (tmp_path / "out" / "result.json").exists() and (tmp_path / "out" / "report.md").exists()
