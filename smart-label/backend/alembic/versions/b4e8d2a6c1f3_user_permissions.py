"""账号加一列单独开的功能权限

角色管一大块（管理员页面整页只给管理员）；这一列让管理员给某个账号单独开几样，
比如实习生只开「狗档案」和「牙齿识别」。逗号分隔的功能键，见 app/core/permissions.py。

Revision ID: b4e8d2a6c1f3
Revises: a7c2e9f4b1d6
"""

import sqlalchemy as sa

from alembic import op

revision = "b4e8d2a6c1f3"
down_revision = "a7c2e9f4b1d6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("permissions", sa.String(length=500), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "permissions")
