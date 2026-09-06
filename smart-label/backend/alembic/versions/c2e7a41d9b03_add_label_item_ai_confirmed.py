"""add annotation_label_items.ai_confirmed

Revision ID: c2e7a41d9b03
Revises: a1f9c3d7e412
Create Date: 2026-09-06

AI 预标注出来的片段要经过人"看一眼"：预测对了点"通过"，错了改类别/改起止。
is_modified 只能表达"改过"，表达不了"看过且认可"，所以单独加一个 ai_confirmed。
人工画的片段这个字段没意义，保持 False。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'c2e7a41d9b03'
down_revision = 'a1f9c3d7e412'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("annotation_label_items")}
    if "ai_confirmed" not in cols:
        op.add_column(
            "annotation_label_items",
            sa.Column(
                "ai_confirmed",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
                comment="AI标签是否已被人工确认为正确",
            ),
        )


def downgrade() -> None:
    op.drop_column("annotation_label_items", "ai_confirmed")
