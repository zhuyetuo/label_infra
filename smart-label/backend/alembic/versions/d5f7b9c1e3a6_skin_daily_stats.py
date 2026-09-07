"""skin_daily_stats：项目联动算出来的每日抓挠统计落库

Revision ID: d5f7b9c1e3a6
Revises: c3e5a7b9d2f4
Create Date: 2026-09-07
"""
from alembic import op
import sqlalchemy as sa

revision = 'd5f7b9c1e3a6'
down_revision = 'c3e5a7b9d2f4'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    if 'skin_daily_stats' in sa.inspect(conn).get_table_names():
        return
    op.create_table(
        'skin_daily_stats',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('stat_date', sa.Date(), nullable=False),
        sa.Column('imu', sa.String(length=20), nullable=False),
        sa.Column('source', sa.String(length=10), nullable=False),
        sa.Column('events', sa.Text(), nullable=False),
        sa.Column('wear_seconds', sa.Float(), nullable=False, server_default='0'),
        sa.Column('stats', sa.Text(), nullable=True),
        sa.Column('c_inputs', sa.Text(), nullable=True),
        sa.Column('c_value', sa.Float(), nullable=True),
        sa.Column('c_tier', sa.String(length=4), nullable=True),
        sa.Column('tasks', sa.Text(), nullable=True),
        sa.Column('ai_mode', sa.String(length=40), nullable=True),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('stat_date', 'imu', 'source', name='uq_skin_daily_date_imu_source'),
    )
    op.create_index('ix_skin_daily_stats_stat_date', 'skin_daily_stats', ['stat_date'])


def downgrade() -> None:
    op.drop_index('ix_skin_daily_stats_stat_date', table_name='skin_daily_stats')
    op.drop_table('skin_daily_stats')
