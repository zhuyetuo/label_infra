"""sample_code always carries _imu{N} suffix

Revision ID: c7e2f1a9b3d4
Revises: c2e7a41d9b03
Create Date: 2026-09-06

之前只有 1 个 IMU 的会话样本编号不带 _imu{N} 后缀，编号取决于扫描那一刻
目录里有几份 CSV，同一批数据会出现 multicam_xxx 和 multicam_xxx_imu2/3/4
两套命名。这里把没后缀的历史样本按它自己 imu_csv_path 里的 _imu{N} 统一
改名；改名后跟已有样本撞名的（理论上不该有，撞了说明真的是重复导入）
不动，留给人工处理。
"""
import re

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'c7e2f1a9b3d4'
down_revision = 'c2e7a41d9b03'
branch_labels = None
depends_on = None

_IMU_RE = re.compile(r"_imu(\d+)", re.IGNORECASE)


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT id, sample_code, imu_csv_path FROM samples WHERE sample_code NOT REGEXP '_imu[0-9]+$'")
    ).fetchall()
    existing = {r[0] for r in conn.execute(sa.text("SELECT sample_code FROM samples")).fetchall()}
    for sid, code, csv_path in rows:
        m = _IMU_RE.search(csv_path.rsplit("/", 1)[-1])
        if not m:
            continue
        new_code = f"{code}_imu{int(m.group(1))}"
        if new_code in existing:
            continue
        conn.execute(sa.text("UPDATE samples SET sample_code = :new WHERE id = :id"), {"new": new_code, "id": sid})
        existing.add(new_code)


def downgrade() -> None:
    # 改名是幂等的规范化，没有必要也没法安全地退回"有时带后缀有时不带"的状态
    pass
