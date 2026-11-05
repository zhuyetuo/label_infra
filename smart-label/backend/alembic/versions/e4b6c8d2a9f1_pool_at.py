"""手动加入数据池的时间（数据池「刚进池的先」排序用）

Revision ID: e4b6c8d2a9f1
Revises: d8e2f4a6c3b9
"""

import sqlalchemy as sa
from alembic import op

revision = "e4b6c8d2a9f1"
down_revision = "d8e2f4a6c3b9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("annotation_label_items", sa.Column("pool_at", sa.DateTime(), nullable=True, comment="手动加入数据池的时间"))


def downgrade() -> None:
    op.drop_column("annotation_label_items", "pool_at")
