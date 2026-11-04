"""skin_daily_stats 加 ml 列（ML 版预测结果）

Revision ID: c7e9a1b3d5f6
Revises: b5d7f9a1c3e4
"""
import sqlalchemy as sa
from alembic import op

revision = "c7e9a1b3d5f6"
down_revision = "b5d7f9a1c3e4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("skin_daily_stats", sa.Column("ml", sa.Text(), nullable=True, comment="JSON：ML 版预测"))


def downgrade() -> None:
    op.drop_column("skin_daily_stats", "ml")
