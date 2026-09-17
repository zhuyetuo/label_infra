"""一键部署脚本：三个服务一个都不能漏，跳过开关要真的跳过，语法得过。

真跑不了（要 docker、要网），用 DRY_RUN=1 看它打算跑哪些命令。
"""

import os
import subprocess

import pytest

DEPLOY = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "deploy"))
SCRIPT = os.path.join(DEPLOY, "deploy_all.sh")

pytestmark = pytest.mark.skipif(not os.path.exists(SCRIPT), reason="找不到 deploy_all.sh")


FAKE_UP = """#!/bin/bash
# 假的 imu_train/up.sh：只把收到的参数和 DRY_RUN/DEPLOY_GPU 打出来
case "${1:-}" in
  deploy) echo "  \$ up.sh deploy args=[$*] DRY_RUN=${DRY_RUN:-} DEPLOY_GPU=${DEPLOY_GPU:-}";;
esac
"""


def _dry(tmp_path, **env):
    imu = tmp_path / "imu_train"
    (imu / ".git").mkdir(parents=True, exist_ok=True)
    (imu / "up.sh").write_text(FAKE_UP)
    e = {**os.environ, "DRY_RUN": "1", "IMU_TRAIN_DIR": str(imu), "HOME": str(tmp_path), **env}
    r = subprocess.run(["bash", SCRIPT], capture_output=True, text=True, env=e, timeout=60)
    return r.returncode, r.stdout + r.stderr


def test_语法():
    assert subprocess.run(["bash", "-n", SCRIPT]).returncode == 0


def test_平台先更新_再交给_imu_train_的_deploy(tmp_path):
    rc, out = _dry(tmp_path)
    assert rc == 0, out
    cmds = [l.strip()[2:] for l in out.splitlines() if l.strip().startswith("$ ")]
    assert any("pull --ff-only" in c for c in cmds)
    assert "bash up.sh" in cmds
    imu = [c for c in cmds if c.startswith("up.sh deploy")]
    assert imu and "DRY_RUN=1" in imu[0] and "args=[deploy]" in imu[0]
    assert cmds.index("bash up.sh") < cmds.index(imu[0])
    assert "全部部署完成" in out


def test_跳过开关变成_only(tmp_path):
    rc, out = _dry(tmp_path, SKIP_PLATFORM="1", SKIP_LABEL="1")
    assert rc == 0
    assert "bash up.sh\n" not in out and "args=[deploy --only vision]" in out
    rc, out = _dry(tmp_path, SKIP_VISION="1")
    assert "args=[deploy --only label]" in out
    rc, out = _dry(tmp_path, SKIP_LABEL="1", SKIP_VISION="1")
    assert "up.sh deploy" not in out and "两个都跳过" in out


def test_gpu_开关传过去(tmp_path):
    rc, out = _dry(tmp_path, DEPLOY_GPU="1")
    assert "DEPLOY_GPU=1" in out


def test_imu_train_不在就跳过第二步(tmp_path):
    e = {**os.environ, "DRY_RUN": "1", "IMU_TRAIN_DIR": str(tmp_path / "nope"), "HOME": str(tmp_path)}
    r = subprocess.run(["bash", SCRIPT], capture_output=True, text=True, env=e, timeout=60)
    assert r.returncode == 0 and "不存在，跳过" in r.stdout and "$ (cd" not in r.stdout
