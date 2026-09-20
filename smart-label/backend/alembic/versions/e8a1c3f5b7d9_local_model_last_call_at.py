"""本地模型快照加「最近一次调用时间」（local_model_snapshots.last_call_at）

视觉服务的计数在它自己内存里，重启就归零，"最近一次调用"跟着丢。每次采集把它
报的 last_at 记到快照行上（只往后走），重启也不影响已经记下的时间。

Revision ID: e8a1c3f5b7d9
Revises: d7f9b2c4e6a8
"""

import sqlalchemy as sa
from alembic import op

revision = "e8a1c3f5b7d9"
down_revision = "d7f9b2c4e6a8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("local_model_snapshots")}
    if "last_call_at" not in cols:
        op.add_column("local_model_snapshots", sa.Column("last_call_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("local_model_snapshots", "last_call_at")
