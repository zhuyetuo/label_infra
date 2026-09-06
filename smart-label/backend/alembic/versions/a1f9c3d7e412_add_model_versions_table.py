"""add model_versions table

Revision ID: a1f9c3d7e412
Revises: 50ae139f0fd6
Create Date: 2026-09-06

algo_service 独立部署后，训练任务提交给它跑（POST /api/v1/label/train），
label_infra 这边只存一行记录关联它返回的 job_id，靠轮询或者它训练完的回调
刷新 status/model_version/metrics，见 app/services/algo_client.py、
app/api/v1/model_versions.py。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'a1f9c3d7e412'
down_revision = '50ae139f0fd6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'model_versions',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('algo_job_id', sa.BigInteger(), nullable=False),
        sa.Column(
            'status',
            sa.Enum('queued', 'running', 'done', 'failed', name='modeltrainstatus'),
            nullable=False,
            server_default='queued',
        ),
        sa.Column('model_type', sa.String(length=32), nullable=False),
        sa.Column('dataset_spec', sa.Text(), nullable=False),
        sa.Column('model_version', sa.String(length=64), nullable=True),
        sa.Column('model_path', sa.String(length=500), nullable=True),
        sa.Column('metrics', sa.Text(), nullable=True),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('created_by', sa.BigInteger(), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id']),
    )
    op.create_index('ix_model_versions_algo_job_id', 'model_versions', ['algo_job_id'])


def downgrade() -> None:
    op.drop_index('ix_model_versions_algo_job_id', table_name='model_versions')
    op.drop_table('model_versions')
    sa.Enum(name='modeltrainstatus').drop(op.get_bind(), checkfirst=True)
