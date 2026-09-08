"""片段加「待定」标记：拿不准的留着但不进训练集

Revision ID: e6a8c2d4f7b1
Revises: d5f7b9c1e3a6
"""

import sqlalchemy as sa
from alembic import op

revision = "e6a8c2d4f7b1"
down_revision = "d5f7b9c1e3a6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "annotation_label_items",
        sa.Column(
            "uncertain",
            sa.Boolean(),
            nullable=False,
            server_default="0",
            comment="待定：拿不准，不参与训练",
        ),
    )


def downgrade() -> None:
    op.drop_column("annotation_label_items", "uncertain")
