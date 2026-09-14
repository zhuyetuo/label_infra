"""画面扫描结果：这份样本的这一路视频里有没有狗

来自 vision_service 的 COCO 预训练检测。存下来是为了让样本/任务列表不用点进去
就知道这段该不该看——一整段没狗的片段，现在只有看到波形是平的、或者点开视频
才发现。

一路一行（不是一份样本一行）：影棚一份样本三路视频拍的是同一个空间的不同角度，
cam1 没狗不代表 cam2 没狗。

Revision ID: b2d5f8a1c493
Revises: a7c3e5d9f142
"""

import sqlalchemy as sa
from alembic import op

revision = "b2d5f8a1c493"
down_revision = "a7c3e5d9f142"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sample_vision_scans",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("sample_id", sa.BigInteger(), nullable=False),
        sa.Column("cam", sa.String(length=10), nullable=False, comment="cam1 / cam2 / cam3"),
        sa.Column("state", sa.String(length=10), nullable=False, server_default="ok", comment="ok / failed"),
        sa.Column("error", sa.String(length=500), nullable=True),
        sa.Column("verdict", sa.String(length=20), nullable=True),
        sa.Column("no_dog_ratio", sa.Numeric(5, 3), nullable=True,
                  comment="扫不成时必须为 NULL，不能填 1——那会被读成「确认没狗」"),
        sa.Column("max_dogs", sa.Integer(), nullable=True),
        sa.Column("sampled", sa.Integer(), nullable=True),
        sa.Column("frames_with_dog", sa.Integer(), nullable=True),
        sa.Column("duration_sec", sa.Numeric(10, 2), nullable=True),
        sa.Column("timeline", sa.Text(), nullable=True, comment="JSON [[秒, 几只], ...]；不存框"),
        sa.Column("every_sec", sa.Numeric(5, 2), nullable=True),
        sa.Column("conf", sa.Numeric(4, 3), nullable=True),
        sa.Column("weights", sa.String(length=100), nullable=True),
        sa.Column("scanned_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["sample_id"], ["samples.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ux_sample_vision_scans_sample_cam", "sample_vision_scans",
                    ["sample_id", "cam"], unique=True)


def downgrade() -> None:
    op.drop_index("ux_sample_vision_scans_sample_cam", table_name="sample_vision_scans")
    op.drop_table("sample_vision_scans")
