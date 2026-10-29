"""片段起止每次被人改都记一笔（从多少改到多少、谁、什么时候）

Revision ID: a3d5f7b9c2e4
Revises: f9c2b7e4a1d3
"""

import sqlalchemy as sa

from alembic import op

revision = "a3d5f7b9c2e4"
down_revision = "f9c2b7e4a1d3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("annotation_label_items", sa.Column("boundary_edits", sa.Text(), nullable=True,
                                                      comment="起止调整记录 JSON"))


def downgrade() -> None:
    op.drop_column("annotation_label_items", "boundary_edits")
