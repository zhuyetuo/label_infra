"""add tooth_photo_results table

Revision ID: b7d2e9a04c31
Revises: f3a9c4e21b78
Create Date: 2026-09-07

「牙齿识别」页：素材库 NAS 上的口腔照片每张最近一次 YOLO 检测结果，页面列目录
时给缩略图挂角标用。照片文件不动，只存相对路径 + 结果 JSON；rel_path 唯一，
重新检测整行覆盖。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'b7d2e9a04c31'
down_revision = 'f3a9c4e21b78'
branch_labels = None
depends_on = None


def _has_table(conn, name: str) -> bool:
    return name in sa.inspect(conn).get_table_names()


def upgrade() -> None:
    conn = op.get_bind()
    if _has_table(conn, 'tooth_photo_results'):
        return
    op.create_table(
        'tooth_photo_results',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('rel_path', sa.String(length=500), nullable=False),
        sa.Column('folder', sa.String(length=100), nullable=False),
        sa.Column('dog_folder', sa.String(length=100), nullable=False),
        sa.Column('dog_id', sa.BigInteger(), nullable=True),
        sa.Column('detections', sa.Text(), nullable=False),
        sa.Column('n_detections', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('top_class', sa.String(length=100), nullable=True),
        sa.Column('top_conf', sa.Float(), nullable=True),
        sa.Column('model_conf', sa.Float(), nullable=False),
        sa.Column('width', sa.Integer(), nullable=True),
        sa.Column('height', sa.Integer(), nullable=True),
        sa.Column('detected_by', sa.BigInteger(), nullable=True),
        sa.Column('detected_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('rel_path'),
        sa.ForeignKeyConstraint(['dog_id'], ['dogs.id']),
        sa.ForeignKeyConstraint(['detected_by'], ['users.id']),
    )


def downgrade() -> None:
    op.drop_table('tooth_photo_results')
