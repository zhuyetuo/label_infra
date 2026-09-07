"""ai_candidates：疑似抓挠候选 + 人工确认/排除

Revision ID: b2d4e6f8a1c3
Revises: a1c9d2e3f4b5
Create Date: 2026-09-07
"""
from alembic import op
import sqlalchemy as sa

revision = 'b2d4e6f8a1c3'
down_revision = 'a1c9d2e3f4b5'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    if 'ai_candidates' in sa.inspect(conn).get_table_names():
        return
    op.create_table(
        'ai_candidates',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('task_id', sa.BigInteger(), nullable=False),
        sa.Column('round_no', sa.SmallInteger(), nullable=False),
        sa.Column('label_name', sa.String(length=50), nullable=False),
        sa.Column('start_time_ms', sa.Integer(), nullable=False),
        sa.Column('end_time_ms', sa.Integer(), nullable=False),
        sa.Column('confidence', sa.Float(), nullable=True),
        sa.Column('spec', sa.Float(), nullable=True),
        sa.Column('reason', sa.String(length=20), nullable=False),
        sa.Column('status', sa.Enum('pending', 'confirmed', 'rejected', name='candidatestatus'), nullable=False, server_default='pending'),
        sa.Column('decided_by', sa.BigInteger(), nullable=True),
        sa.Column('decided_at', sa.DateTime(), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=True),
        sa.ForeignKeyConstraint(['task_id'], ['tasks.id']),
        sa.ForeignKeyConstraint(['decided_by'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_ai_candidates_task_id', 'ai_candidates', ['task_id'])


def downgrade() -> None:
    op.drop_index('ix_ai_candidates_task_id', table_name='ai_candidates')
    op.drop_table('ai_candidates')
