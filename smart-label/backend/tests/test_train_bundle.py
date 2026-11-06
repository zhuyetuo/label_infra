"""训练记录「导出训练数据」：原始 CSV + 标签 + 参数打成 zip，边打包边发。"""

import io
import json
import zipfile

from app.core.config import settings
from app.services import train_bundle


def _ds(root, name, csv_rel):
    d = root / "data_train" / name
    d.mkdir(parents=True)
    tasks = [{"id": 1, "data": {"csv": csv_rel, "sample_code": "S1", "sample_rate_hz": 50},
              "annotations": [{"id": 1, "result": [{"value": {"start": "2026-11-01 10:00:00.000", "end": "2026-11-01 10:00:03.000",
                                                              "start_ms": 0, "end_ms": 3000, "timeserieslabels": ["抓挠", "抓挠-头颈"]}}]}]}]
    (d / "merged_tmp.json").write_text(json.dumps(tasks, ensure_ascii=False), encoding="utf-8")
    (d / "meta.json").write_text("{}", encoding="utf-8")
    return f"data_train/{name}/merged_tmp.json"


def test_bundle_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "nas_root", str(tmp_path))
    (tmp_path / "imu").mkdir()
    (tmp_path / "imu" / "a.csv").write_text("ts,ax\n" + "1,2\n" * 5000)
    spec = {"date": "a", "export_json": _ds(tmp_path, "a", "imu/a.csv"),
            "extra_datasets": [{"date": "b", "export_json": _ds(tmp_path, "b", "imu/a.csv")},
                               {"date": "gone", "export_json": "data_train/gone/merged_tmp.json"}],
            "window_s": 2.0}
    p = train_bundle.plan(spec)
    s = train_bundle.summary(p)
    assert s["datasets"] == ["a", "b"] and s["n_csv"] == 1 and s["n_segments"] == 2
    assert any("gone" in m for m in s["missing"])
    blob = b"".join(train_bundle.stream(p, {"dataset": spec}))
    zf = zipfile.ZipFile(io.BytesIO(blob))
    names = set(zf.namelist())
    assert {"README.txt", "train_spec.json", "csv/imu/a.csv", "datasets/a/merged_tmp.json",
            "datasets/b/labels.csv", "datasets/a/meta.json"} <= names
    assert zf.read("csv/imu/a.csv") == (tmp_path / "imu" / "a.csv").read_bytes()
    lab = zf.read("datasets/a/labels.csv").decode("utf-8-sig")
    assert "抓挠-头颈" in lab and "csv/imu/a.csv" in lab and "3.0" in lab
    assert json.loads(zf.read("train_spec.json"))["dataset"]["window_s"] == 2.0


def test_token():
    t = train_bundle.issue_token(5)
    assert train_bundle.verify_token(5, t)
    assert not train_bundle.verify_token(6, t)
    assert not train_bundle.verify_token(5, "1.abc")


def test_stream_abort_stops_builder(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "nas_root", str(tmp_path))
    (tmp_path / "imu").mkdir()
    import os
    (tmp_path / "imu" / "a.csv").write_bytes(os.urandom(8 << 20))
    p = train_bundle.plan({"date": "a", "export_json": _ds(tmp_path, "a", "imu/a.csv")})
    g = train_bundle.stream(p, {})
    next(g)
    g.close()  # 下载断开：打包线程要自己停，不能卡死
    import threading, time
    for _ in range(50):
        if not any(t.name == "train-bundle" and t.is_alive() for t in threading.enumerate()):
            break
        time.sleep(0.1)
    assert not any(t.name == "train-bundle" and t.is_alive() for t in threading.enumerate())
