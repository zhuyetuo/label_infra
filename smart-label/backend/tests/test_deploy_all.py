"""一键部署脚本：三个服务一个都不能漏，跳过开关要真的跳过，语法得过。

真跑不了（要 docker、要网），用 DRY_RUN=1 看它打算跑哪些命令。
"""

import os
import subprocess

import pytest

DEPLOY = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "deploy"))
SCRIPT = os.path.join(DEPLOY, "deploy_all.sh")

pytestmark = pytest.mark.skipif(not os.path.exists(SCRIPT), reason="找不到 deploy_all.sh")


def _dry(tmp_path, **env):
    imu = tmp_path / "imu_train"
    (imu / ".git").mkdir(parents=True)
    e = {**os.environ, "DRY_RUN": "1", "IMU_TRAIN_DIR": str(imu), "HOME": str(tmp_path), **env}
    r = subprocess.run(["bash", SCRIPT], capture_output=True, text=True, env=e, timeout=60)
    return r.returncode, r.stdout + r.stderr


def test_语法():
    assert subprocess.run(["bash", "-n", SCRIPT]).returncode == 0


def test_三个服务一个不漏_顺序对(tmp_path):
    rc, out = _dry(tmp_path)
    assert rc == 0, out
    cmds = [l.strip()[2:] for l in out.splitlines() if l.strip().startswith("$ ")]
    assert any("label_infra" in c and "pull" in c for c in cmds) or any("pull --ff-only" in c for c in cmds)
    assert "bash up.sh" in cmds
    assert "bash label_service/up.sh -u" in cmds and "bash label_service/up.sh -d" in cmds
    assert "bash vision_service/run.sh down" in cmds and "bash vision_service/run.sh -d" in cmds
    assert cmds.index("bash up.sh") < cmds.index("bash label_service/up.sh -u") < cmds.index("bash vision_service/run.sh -d")
    assert "全部部署完成" in out


def test_跳过开关(tmp_path):
    rc, out = _dry(tmp_path, SKIP_PLATFORM="1", SKIP_LABEL="1")
    assert rc == 0
    assert "bash up.sh" not in out and "label_service/up.sh" not in out
    assert "vision_service/run.sh -d" in out


def test_gpu_开关传给_label_service(tmp_path):
    rc, out = _dry(tmp_path, DEPLOY_GPU="1")
    assert "label_service/up.sh -g -u" in out and "label_service/up.sh -g -d" in out


def test_imu_train_不在就跳过第二步(tmp_path):
    e = {**os.environ, "DRY_RUN": "1", "IMU_TRAIN_DIR": str(tmp_path / "nope"), "HOME": str(tmp_path)}
    r = subprocess.run(["bash", SCRIPT], capture_output=True, text=True, env=e, timeout=60)
    assert r.returncode == 0 and "不存在，跳过" in r.stdout and "label_service" not in r.stdout.split("2/3")[1].split("3/3")[0]
