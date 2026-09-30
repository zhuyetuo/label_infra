"""标注条目：人最后一次动它的时间和人——算每一类片段确认耗时要用

Revision ID: e1f3a5b7c9d2
Revises: d8e2f4a6b1c3
"""

import sqlalchemy as sa
from alembic import op

revision = "e1f3a5b7c9d2"
down_revision = "d8e2f4a6b1c3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("annotation_label_items",
                  sa.Column("touched_at", sa.DateTime(), nullable=True, comment="人最后一次改/确认这条的时间"))
    op.add_column("annotation_label_items",
                  sa.Column("touched_by", sa.BigInteger(), sa.ForeignKey("users.id"), nullable=True,
                            comment="最后一次改/确认这条的人"))


def downgrade() -> None:
    op.drop_column("annotation_label_items", "touched_by")
    op.drop_column("annotation_label_items", "touched_at")
