"""add vision_assignments（视觉标注的指派与审核）

Revision ID: d1f4b82c6ae3
Revises: c8e1a4d70f52
Create Date: 2026-09-13

把一「组」照片（日期目录/狗名 = 一次拍摄）指派给标注员，走 指派 → 提交 →
通过/打回 的最小流程。一张新表，不碰 tasks / annotation_records / task_scope。

album+group_key 唯一：一个组同时只属于一个人。允许多人同时标一组就要处理
"谁的版本算数"，而标注是整张覆盖保存的，两个人来回覆盖谁都不会收到提示。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'd1f4b82c6ae3'
down_revision = 'c8e1a4d70f52'
branch_labels = None
depends_on = None


def _has_table(conn, name: str) -> bool:
    return name in sa.inspect(conn).get_table_names()


def upgrade() -> None:
    conn = op.get_bind()
    if _has_table(conn, 'vision_assignments'):
        return
    op.create_table(
        'vision_assignments',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('album', sa.String(length=20), nullable=False),
        sa.Column('group_key', sa.String(length=200), nullable=False),
        sa.Column('assignee_id', sa.BigInteger(), nullable=False),
        sa.Column('state', sa.String(length=20), nullable=False, server_default='open'),
        sa.Column('review_note', sa.String(length=500), nullable=True),
        sa.Column('reviewed_by', sa.BigInteger(), nullable=True),
        sa.Column('reviewed_at', sa.DateTime(), nullable=True),
        sa.Column('created_by', sa.BigInteger(), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('album', 'group_key', name='uq_vision_assignments_album_group'),
        sa.ForeignKeyConstraint(['assignee_id'], ['users.id']),
        sa.ForeignKeyConstraint(['reviewed_by'], ['users.id']),
        sa.ForeignKeyConstraint(['created_by'], ['users.id']),
    )


def downgrade() -> None:
    conn = op.get_bind()
    if _has_table(conn, 'vision_assignments'):
        op.drop_table('vision_assignments')
