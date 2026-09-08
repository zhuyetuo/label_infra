"""存一份 C 值各项得分，跟踪表要展示「这分怎么来的」

Revision ID: a8c4e6b2d9f3
Revises: f7b3d5a9c1e2
"""

import sqlalchemy as sa
from alembic import op

revision = "a8c4e6b2d9f3"
down_revision = "f7b3d5a9c1e2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "skin_daily_stats",
        sa.Column("c_detail", sa.Text(), nullable=True, comment="JSON：C 值各项得分"),
    )


def downgrade() -> None:
    op.drop_column("skin_daily_stats", "c_detail")
