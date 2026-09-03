"""add user remark

Revision ID: ddb287164f5a
Revises: 6d192b94f3b6
Create Date: 2026-09-05

管理员/超级管理员之间给账号做备注用，比如外包身份、实习/兼职、入离职时间——
纯人事记录，跟登录/权限逻辑无关。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'ddb287164f5a'
down_revision = '6d192b94f3b6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('users', sa.Column('remark', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('users', 'remark')
