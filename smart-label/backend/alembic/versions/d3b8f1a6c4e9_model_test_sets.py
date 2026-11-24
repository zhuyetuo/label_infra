"""模型测试集：model_test_sets / model_test_items

测试集里的样本不进任何训练导出；冻结后不能增删。

Revision ID: d3b8f1a6c4e9
Revises: c9e2a4f8b1d7
"""

import sqlalchemy as sa
from alembic import op

revision = "d3b8f1a6c4e9"
down_revision = "c9e2a4f8b1d7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    have = set(sa.inspect(bind).get_table_names())
    if "model_test_sets" not in have:
        op.create_table(
            "model_test_sets",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("name", sa.String(100), nullable=False, unique=True),
            sa.Column("note", sa.String(500), nullable=True),
            sa.Column("frozen_at", sa.DateTime(), nullable=True, comment="冻结时间；冻结后不能增删"),
            sa.Column("created_by", sa.BigInteger(), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        )
    if "model_test_items" not in have:
        op.create_table(
            "model_test_items",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("set_id", sa.BigInteger(), sa.ForeignKey("model_test_sets.id"), nullable=False, index=True),
            sa.Column("task_id", sa.BigInteger(), sa.ForeignKey("tasks.id"), nullable=False),
            sa.Column("sample_id", sa.BigInteger(), sa.ForeignKey("samples.id"), nullable=False, index=True),
            sa.Column("start_ms", sa.Integer(), nullable=True),
            sa.Column("end_ms", sa.Integer(), nullable=True),
            sa.Column("note", sa.String(300), nullable=True),
            sa.Column("added_by", sa.BigInteger(), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
            sa.UniqueConstraint("set_id", "task_id", "start_ms", name="uq_model_test_item"),
        )


def downgrade() -> None:
    op.drop_table("model_test_items")
    op.drop_table("model_test_sets")
