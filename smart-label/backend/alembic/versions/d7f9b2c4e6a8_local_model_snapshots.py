"""本地模型计数的上一次快照落表（local_model_snapshots）

API 进程和调度器进程都会采集，快照存库两边才不会重复算差值。

Revision ID: d7f9b2c4e6a8
Revises: c6e8a1b3d5f7
"""

import sqlalchemy as sa
from alembic import op

revision = "d7f9b2c4e6a8"
down_revision = "c6e8a1b3d5f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "local_model_snapshots" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "local_model_snapshots",
        sa.Column("model_key", sa.String(length=20), primary_key=True),
        sa.Column("calls", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("frames", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("errors", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_ms", sa.Float(), nullable=False, server_default="0"),
        sa.Column("taken_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("local_model_snapshots")
