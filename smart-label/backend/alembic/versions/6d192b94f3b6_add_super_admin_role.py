"""add super_admin role

Revision ID: 6d192b94f3b6
Revises: 14a2d182cf05
Create Date: 2026-09-04

超级管理员：跟管理员权限完全一样，唯一区别是超级管理员能删管理员账号，
管理员删不了超级管理员账号（业务逻辑在 api/v1/users.py 里）。

MySQL 的 Enum 是刻在列定义里的（不像 Postgres 是独立类型），加一个新取值
必须用 MODIFY COLUMN 重写整个取值列表，不能像 Postgres 那样 ADD VALUE。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '6d192b94f3b6'
down_revision = '14a2d182cf05'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        'users',
        'role',
        existing_type=sa.Enum('admin', 'annotator', 'reviewer', name='userrole'),
        type_=sa.Enum('super_admin', 'admin', 'annotator', 'reviewer', name='userrole'),
        existing_nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        'users',
        'role',
        existing_type=sa.Enum('super_admin', 'admin', 'annotator', 'reviewer', name='userrole'),
        type_=sa.Enum('admin', 'annotator', 'reviewer', name='userrole'),
        existing_nullable=False,
    )
