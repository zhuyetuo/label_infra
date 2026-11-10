"""单张照片拍摄不合格标记（汇总给狗场）

Revision ID: f2c8a1d5b7e9
Revises: e7b2c9d4f1a3
"""

import sqlalchemy as sa
from alembic import op

revision = "f2c8a1d5b7e9"
down_revision = "e7b2c9d4f1a3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "photo_flags",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("album", sa.String(20), nullable=False),
        sa.Column("folder", sa.String(200), nullable=False, comment="日期目录（含来源前缀）"),
        sa.Column("dog_folder", sa.String(200), nullable=False, comment="狗名目录"),
        sa.Column("filename", sa.String(200), nullable=False),
        sa.Column("reason", sa.String(20), nullable=False, comment="blurry/dark/no_skin/blocked/far/other"),
        sa.Column("note", sa.String(300), nullable=True),
        sa.Column("user_id", sa.BigInteger(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        sa.UniqueConstraint("album", "folder", "dog_folder", "filename", name="uq_photo_flag"),
    )


def downgrade() -> None:
    op.drop_table("photo_flags")
