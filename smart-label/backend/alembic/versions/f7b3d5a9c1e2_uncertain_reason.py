"""待定分两种：画面里没拍到 / 拍到了但看不准

Revision ID: f7b3d5a9c1e2
Revises: e6a8c2d4f7b1
"""

import sqlalchemy as sa
from alembic import op

revision = "f7b3d5a9c1e2"
down_revision = "e6a8c2d4f7b1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "annotation_label_items",
        sa.Column(
            "uncertain_reason",
            sa.String(length=16),
            nullable=True,
            comment="待定原因：no_view / ambiguous",
        ),
    )


def downgrade() -> None:
    op.drop_column("annotation_label_items", "uncertain_reason")
