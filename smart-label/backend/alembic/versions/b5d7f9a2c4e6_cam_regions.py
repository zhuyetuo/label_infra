"""公用机位画面里每个单间占哪一块（cam_regions）

狗场天花板 cam7 一次看到全部单间，跟单间自己的摄像头互补。把 cam7 里的狗算到某个单间
头上，要人先在画面上把每间框出来。

Revision ID: b5d7f9a2c4e6
Revises: a4c6e8b1d3f5
"""

import sqlalchemy as sa
from alembic import op

revision = "b5d7f9a2c4e6"
down_revision = "a4c6e8b1d3f5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "cam_regions" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "cam_regions",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("site", sa.String(length=20), nullable=False),
        sa.Column("cam", sa.Integer(), nullable=False),
        sa.Column("room", sa.Integer(), nullable=False),
        sa.Column("x", sa.Float(), nullable=False),
        sa.Column("y", sa.Float(), nullable=False),
        sa.Column("w", sa.Float(), nullable=False),
        sa.Column("h", sa.Float(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=True),
        sa.UniqueConstraint("site", "cam", "room", name="uq_cam_region"),
    )


def downgrade() -> None:
    op.drop_table("cam_regions")
