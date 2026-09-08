"""片段记住是从哪条候选确认上来的，好退回去

Revision ID: e3a5c7f9b1d4
Revises: d2f4a6c8e1b3
"""

import sqlalchemy as sa
from alembic import op

revision = "e3a5c7f9b1d4"
down_revision = "d2f4a6c8e1b3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "annotation_label_items",
        sa.Column("from_candidate_id", sa.BigInteger(), nullable=True, comment="从哪条候选确认来的"),
    )
    op.create_foreign_key(
        "fk_label_items_from_candidate", "annotation_label_items", "ai_candidates", ["from_candidate_id"], ["id"]
    )


def downgrade() -> None:
    op.drop_constraint("fk_label_items_from_candidate", "annotation_label_items", type_="foreignkey")
    op.drop_column("annotation_label_items", "from_candidate_id")
