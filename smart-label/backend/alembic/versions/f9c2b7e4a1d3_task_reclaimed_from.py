"""任务被超时收回时记下原来是谁的、什么时候收回的

Revision ID: f9c2b7e4a1d3
Revises: e2c7a9d4f6b1
"""

import sqlalchemy as sa

from alembic import op

revision = "f9c2b7e4a1d3"
down_revision = "e2c7a9d4f6b1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("reclaimed_from", sa.BigInteger(), nullable=True,
                                     comment="超时收回前指派给谁"))
    op.add_column("tasks", sa.Column("reclaimed_at", sa.DateTime(), nullable=True, comment="超时收回时间"))
    op.create_foreign_key("fk_tasks_reclaimed_from", "tasks", "users", ["reclaimed_from"], ["id"])


def downgrade() -> None:
    op.drop_constraint("fk_tasks_reclaimed_from", "tasks", type_="foreignkey")
    op.drop_column("tasks", "reclaimed_at")
    op.drop_column("tasks", "reclaimed_from")
