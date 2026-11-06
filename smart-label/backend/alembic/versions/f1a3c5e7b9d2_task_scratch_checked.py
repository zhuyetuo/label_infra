"""任务上记「抓挠复核完」：谁、什么时候（皮肤评估里看复核进度用，原来只记在复核人自己的浏览器里）

Revision ID: f1a3c5e7b9d2
Revises: e4b6c8d2a9f1
"""

import sqlalchemy as sa
from alembic import op

revision = "f1a3c5e7b9d2"
down_revision = "e4b6c8d2a9f1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("scratch_checked_by", sa.BigInteger(), nullable=True, comment="抓挠复核完的人（users.id）"))
    op.add_column("tasks", sa.Column("scratch_checked_at", sa.DateTime(), nullable=True, comment="抓挠复核完的时间"))


def downgrade() -> None:
    op.drop_column("tasks", "scratch_checked_at")
    op.drop_column("tasks", "scratch_checked_by")
