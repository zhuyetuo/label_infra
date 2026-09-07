"""skin_records: 记录 C 值来源（AI 版 / 人工版）

Revision ID: a1c9d2e3f4b5
Revises: d4c8f1a2b905
Create Date: 2026-09-07

皮肤评估 PM 版从标注平台拉取抓挠统计后，一次能看到 AI 版和人工版两个 C 值，
保存记录时把用的是哪个（c_source）以及两个版本的 C 值/档位都存下来，历史记录里
直接对比模型输出 vs 人工输出。
"""
from alembic import op
import sqlalchemy as sa

revision = 'a1c9d2e3f4b5'
down_revision = 'd4c8f1a2b905'
branch_labels = None
depends_on = None

_COLS = [
    sa.Column('c_source', sa.String(length=10), nullable=True, comment='ai / human / manual / stats'),
    sa.Column('c_value_ai', sa.Float(), nullable=True),
    sa.Column('c_tier_ai', sa.String(length=4), nullable=True),
    sa.Column('c_value_human', sa.Float(), nullable=True),
    sa.Column('c_tier_human', sa.String(length=4), nullable=True),
]


def upgrade() -> None:
    conn = op.get_bind()
    existing = {c['name'] for c in sa.inspect(conn).get_columns('skin_records')}
    for col in _COLS:
        if col.name not in existing:
            op.add_column('skin_records', col)


def downgrade() -> None:
    for col in reversed(_COLS):
        op.drop_column('skin_records', col.name)
