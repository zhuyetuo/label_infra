"""users 加 temp_password_enc：系统发的临时密码加密存一份，超级管理员可回看，本人改密码后清空

Revision ID: c5d8e1f3a7b9
Revises: b2e7c4f9a1d6
"""

import sqlalchemy as sa
from alembic import op

revision = "c5d8e1f3a7b9"
down_revision = "b2e7c4f9a1d6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("temp_password_enc", sa.Text(), nullable=True,
                                     comment="系统发的临时密码（加密），本人改密码后清空"))


def downgrade() -> None:
    op.drop_column("users", "temp_password_enc")
