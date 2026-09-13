"""add vision_assets / vision_annotations (视觉标注雏形)

Revision ID: c8e1a4d70f52
Revises: b7d3f61a90c4
Create Date: 2026-09-13

「视觉标注」雏形页：在素材库的口腔/皮肤照片上画框、打类别、填属性。两张新表，
跟现有的 samples / tasks / annotation_* 完全隔离，不改任何现有表的结构。

vision_assets      一张照片在这轮标注里的状态（todo/done/skipped）+ 图级属性。
                   没有它就区分不了「还没标」和「看过了、没有目标」，而这两者
                   在导出训练集时是天差地别。
vision_annotations 照片上的框。bbox 存归一化坐标；attrs 存随类别而变的字段
                   （牙位/分级/严重度），不为每个业务字段开列——雏形阶段类别
                   还会动，开成列每改一次就是一次迁移。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'c8e1a4d70f52'
down_revision = 'b7d3f61a90c4'
branch_labels = None
depends_on = None


def _has_table(conn, name: str) -> bool:
    return name in sa.inspect(conn).get_table_names()


def upgrade() -> None:
    conn = op.get_bind()

    if not _has_table(conn, 'vision_assets'):
        op.create_table(
            'vision_assets',
            sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column('album', sa.String(length=20), nullable=False),
            sa.Column('rel_path', sa.String(length=500), nullable=False),
            sa.Column('state', sa.String(length=20), nullable=False, server_default='todo'),
            sa.Column('skip_reason', sa.String(length=200), nullable=True),
            sa.Column('attrs', sa.Text(), nullable=False),
            sa.Column('width', sa.Integer(), nullable=True),
            sa.Column('height', sa.Integer(), nullable=True),
            sa.Column('updated_by', sa.BigInteger(), nullable=True),
            sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('album', 'rel_path', name='uq_vision_assets_album_path'),
            sa.ForeignKeyConstraint(['updated_by'], ['users.id']),
        )

    if not _has_table(conn, 'vision_annotations'):
        op.create_table(
            'vision_annotations',
            sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column('album', sa.String(length=20), nullable=False),
            sa.Column('rel_path', sa.String(length=500), nullable=False),
            sa.Column('label_code', sa.String(length=40), nullable=False),
            sa.Column('bbox', sa.Text(), nullable=False),
            sa.Column('attrs', sa.Text(), nullable=False),
            sa.Column('source', sa.String(length=20), nullable=False, server_default='human'),
            sa.Column('created_by', sa.BigInteger(), nullable=True),
            sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
            sa.PrimaryKeyConstraint('id'),
            sa.ForeignKeyConstraint(['created_by'], ['users.id']),
        )
        op.create_index('ix_vision_annotations_album_path', 'vision_annotations', ['album', 'rel_path'])


def downgrade() -> None:
    conn = op.get_bind()
    if _has_table(conn, 'vision_annotations'):
        op.drop_index('ix_vision_annotations_album_path', table_name='vision_annotations')
        op.drop_table('vision_annotations')
    if _has_table(conn, 'vision_assets'):
        op.drop_table('vision_assets')
