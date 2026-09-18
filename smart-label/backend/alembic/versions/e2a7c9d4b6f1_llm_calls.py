"""大模型调用记录表：每次调用的 token / 花费 / 耗时，给「大模型 API」页的统计面板

Revision ID: e2a7c9d4b6f1
Revises: d6f8a2c4e1b3
"""

import sqlalchemy as sa
from alembic import op

revision = "e2a7c9d4b6f1"
down_revision = "d6f8a2c4e1b3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    if "llm_calls" in sa.inspect(conn).get_table_names():
        return
    op.create_table(
        "llm_calls",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("provider", sa.String(length=20), nullable=False),
        sa.Column("model", sa.String(length=100), nullable=False),
        sa.Column("purpose", sa.String(length=20), nullable=False, server_default="seek"),
        sa.Column("project_id", sa.BigInteger(), nullable=True),
        sa.Column("task_id", sa.BigInteger(), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("est_usd", sa.Float(), nullable=False, server_default="0"),
        sa.Column("latency_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("ok", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.Column("error", sa.String(length=300), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_llm_calls_provider", "llm_calls", ["provider"])
    op.create_index("ix_llm_calls_created_at", "llm_calls", ["created_at"])


def downgrade() -> None:
    op.drop_table("llm_calls")
