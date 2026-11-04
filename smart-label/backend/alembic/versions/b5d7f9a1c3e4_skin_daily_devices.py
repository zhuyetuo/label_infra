"""皮肤日统计：一只狗两个项圈合成一行时，记每个设备戴了多久、哪几段

Revision ID: b5d7f9a1c3e4
Revises: a3c5e7f9b1d2
"""

import sqlalchemy as sa

from alembic import op

revision = "b5d7f9a1c3e4"
down_revision = "a3c5e7f9b1d2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("skin_daily_stats", sa.Column("devices", sa.Text(), nullable=True,
                                                comment="JSON [{imu, worn_s, spans}]"))


def downgrade() -> None:
    op.drop_column("skin_daily_stats", "devices")
