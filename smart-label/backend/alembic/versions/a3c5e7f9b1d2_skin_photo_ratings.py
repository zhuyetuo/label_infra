"""皮肤照片评级：兽医 / 实习生看问诊照片给每只狗那一次评 S0 / S1 / S2 / 看不清

Revision ID: a3c5e7f9b1d2
Revises: e6a8c0b2d4f6
"""

import sqlalchemy as sa

from alembic import op

revision = "a3c5e7f9b1d2"
down_revision = "e6a8c0b2d4f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "skin_photo_ratings",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("album", sa.String(length=20), nullable=False, server_default="skin"),
        sa.Column("folder", sa.String(length=200), nullable=False, comment="日期目录（含来源前缀）"),
        sa.Column("dog_folder", sa.String(length=200), nullable=False, comment="狗名目录"),
        sa.Column("user_id", sa.BigInteger(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("grade", sa.String(length=10), nullable=False, comment="S0 / S1 / S2 / unsure"),
        sa.Column("note", sa.String(length=500), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        sa.UniqueConstraint("album", "folder", "dog_folder", "user_id", name="uq_skin_photo_rating"),
    )
    op.create_index("ix_skin_photo_ratings_user_id", "skin_photo_ratings", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_skin_photo_ratings_user_id", table_name="skin_photo_ratings")
    op.drop_table("skin_photo_ratings")
