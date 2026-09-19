"""本地模型调用量按小时落表（local_model_stats）

视觉服务的计数在进程内存里，重启归零、没有时间维度。平台定时拉快照记差值，
「调用统计」页才能按天 / 周 / 月看每个模型的用量。

Revision ID: c6e8a1b3d5f7
Revises: b5d7f9a2c4e6
"""

import sqlalchemy as sa
from alembic import op

revision = "c6e8a1b3d5f7"
down_revision = "b5d7f9a2c4e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "local_model_stats" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "local_model_stats",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("model_key", sa.String(length=20), nullable=False, index=True),
        sa.Column("hour", sa.DateTime(), nullable=False, index=True),
        sa.Column("calls", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("frames", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("errors", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_ms", sa.Float(), nullable=False, server_default="0"),
        sa.UniqueConstraint("model_key", "hour", name="uq_local_model_stat_hour"),
    )


def downgrade() -> None:
    op.drop_table("local_model_stats")
