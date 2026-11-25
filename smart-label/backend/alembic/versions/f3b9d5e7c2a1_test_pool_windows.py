"""test_pool_windows：独立的测试数据池表（与训练数据池双池隔离、支持拨入训练池）

Revision ID: f3b9d5e7c2a1
Revises: f2a8c4e6b1d9
"""

import sqlalchemy as sa
from alembic import op

revision = "f3b9d5e7c2a1"
down_revision = "f2a8c4e6b1d9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "test_pool_windows" not in set(insp.get_table_names()):
        op.create_table(
            "test_pool_windows",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("task_id", sa.BigInteger(), sa.ForeignKey("tasks.id"), nullable=False),
            sa.Column("sample_id", sa.BigInteger(), sa.ForeignKey("samples.id"), nullable=False),
            sa.Column("start_ms", sa.Integer(), nullable=True),
            sa.Column("end_ms", sa.Integer(), nullable=True),
            sa.Column("status", sa.String(24), nullable=False, server_default="active"),
            sa.Column("checked_by", sa.BigInteger(), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("checked_at", sa.DateTime(), nullable=True),
            sa.Column("note", sa.String(300), nullable=True),
            sa.Column("source_set_id", sa.BigInteger(), nullable=True),
            sa.Column("moved_by", sa.BigInteger(), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("moved_at", sa.DateTime(), nullable=True),
            sa.Column("created_by", sa.BigInteger(), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
            sa.UniqueConstraint("task_id", "start_ms", "end_ms", name="uq_test_pool_window"),
        )
        op.create_index("ix_test_pool_windows_task_id", "test_pool_windows", ["task_id"])
        op.create_index("ix_test_pool_windows_sample_id", "test_pool_windows", ["sample_id"])
        op.create_index("ix_test_pool_windows_status", "test_pool_windows", ["status"])


def downgrade() -> None:
    op.drop_table("test_pool_windows")
