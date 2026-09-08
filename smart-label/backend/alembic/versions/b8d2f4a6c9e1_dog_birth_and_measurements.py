"""狗档案加出生日期，体重/颈围单独一张按次记录的表

Revision ID: b8d2f4a6c9e1
Revises: a7c9e1b3d5f8
"""

import sqlalchemy as sa
from alembic import op

revision = "b8d2f4a6c9e1"
down_revision = "a7c9e1b3d5f8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 年龄存出生日期，不存"几岁"——存岁数第二天就不对了
    op.add_column("dogs", sa.Column("birth_date", sa.Date(), nullable=True, comment="出生日期，年龄按它现算"))
    # 体重会变，「什么时候几公斤」本身就是要看的，所以一次一条
    op.create_table(
        "dog_measurements",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("dog_id", sa.BigInteger(), nullable=False),
        sa.Column("measured_on", sa.Date(), nullable=False),
        sa.Column("weight_kg", sa.Float(), nullable=True),
        sa.Column("neck_cm", sa.Float(), nullable=True, comment="脖子围度"),
        sa.Column("note", sa.String(length=200), nullable=True),
        sa.Column("created_by", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.ForeignKeyConstraint(["dog_id"], ["dogs.id"]),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_dog_measurements_dog_id", "dog_measurements", ["dog_id"])


def downgrade() -> None:
    op.drop_index("ix_dog_measurements_dog_id", table_name="dog_measurements")
    op.drop_table("dog_measurements")
    op.drop_column("dogs", "birth_date")
