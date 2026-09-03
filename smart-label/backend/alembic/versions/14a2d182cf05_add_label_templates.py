"""add label templates

Revision ID: 14a2d182cf05
Revises: b3d51a90c7e2
Create Date: 2026-09-03

标签模板：常用的一套标签存下来，新建项目直接套用，不用每次重新敲一遍。

顺带把 projects.created_at/updated_at 收成 NOT NULL —— 上一版迁移建表时写成了
可空，跟模型定义对不上，不改的话以后每次 autogenerate 都会重复提这一条。
两个字段都有 server default，现有数据里也没有 NULL，收紧是安全的。
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

# revision identifiers, used by Alembic.
revision = '14a2d182cf05'
down_revision = 'b3d51a90c7e2'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('label_templates',
    sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
    sa.Column('name', sa.String(length=100), nullable=False),
    sa.Column('description', sa.String(length=500), nullable=True),
    sa.Column('created_by', sa.BigInteger(), nullable=False),
    sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('name')
    )
    op.create_table('label_template_items',
    sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
    sa.Column('template_id', sa.BigInteger(), nullable=False),
    sa.Column('code', sa.String(length=50), nullable=False),
    sa.Column('display_name', sa.String(length=50), nullable=False),
    sa.Column('color', sa.String(length=20), nullable=True),
    sa.Column('sort_order', sa.SmallInteger(), nullable=False),
    sa.ForeignKeyConstraint(['template_id'], ['label_templates.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('template_id', 'code', name='uq_tpl_item_code')
    )
    op.create_index(op.f('ix_label_template_items_template_id'), 'label_template_items', ['template_id'], unique=False)
    op.alter_column('projects', 'created_at',
               existing_type=mysql.DATETIME(),
               nullable=False,
               existing_server_default=sa.text('current_timestamp()'))
    op.alter_column('projects', 'updated_at',
               existing_type=mysql.DATETIME(),
               nullable=False,
               existing_server_default=sa.text('current_timestamp()'))


def downgrade() -> None:
    op.alter_column('projects', 'updated_at',
               existing_type=mysql.DATETIME(),
               nullable=True,
               existing_server_default=sa.text('current_timestamp()'))
    op.alter_column('projects', 'created_at',
               existing_type=mysql.DATETIME(),
               nullable=True,
               existing_server_default=sa.text('current_timestamp()'))
    op.drop_index(op.f('ix_label_template_items_template_id'), table_name='label_template_items')
    op.drop_table('label_template_items')
    op.drop_table('label_templates')
