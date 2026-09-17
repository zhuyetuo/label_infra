"""deploy_all.sh 只管 web 平台：拉代码、up.sh、探健康。算法服务（imu_train）不碰，只探。

真跑不了（要 docker、要网），用 DRY_RUN=1 看它打算跑什么。
"""

import os
import subprocess

import pytest

DEPLOY = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "deploy"))
SCRIPT = os.path.join(DEPLOY, "deploy_all.sh")

pytestmark = pytest.mark.skipif(not os.path.exists(SCRIPT), reason="找不到 deploy_all.sh")


def _dry(**env):
    e = {**os.environ, "DRY_RUN": "1", **env}
    r = subprocess.run(["bash", SCRIPT], capture_output=True, text=True, env=e, timeout=60)
    return r.returncode, r.stdout + r.stderr


def test_语法():
    assert subprocess.run(["bash", "-n", SCRIPT]).returncode == 0


def test_只动平台_不碰算法服务():
    rc, out = _dry()
    assert rc == 0, out
    cmds = [l.strip()[2:] for l in out.splitlines() if l.strip().startswith("$ ")]
    assert any("pull --ff-only" in c for c in cmds) and "bash up.sh" in cmds
    # 算法服务一个命令都不发：不 pull imu_train、不动 label_service / vision_service
    assert not any("imu_train" in c or "label_service" in c or "vision_service" in c for c in cmds)
    # 但会探它们的地址，不通时告诉人去 imu_train 那边跑
    assert "label_service" in out and "vision_service" in out and "只探不动" in out
    assert "平台部署完成" in out
