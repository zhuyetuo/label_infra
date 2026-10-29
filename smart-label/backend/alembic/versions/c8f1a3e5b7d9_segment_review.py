"""片段级审核：每条片段单独「通过 / 退回」，按类别领一批来审

Revision ID: c8f1a3e5b7d9
Revises: b6e8a1c3d5f7
"""

import sqlalchemy as sa

from alembic import op

revision = "c8f1a3e5b7d9"
down_revision = "b6e8a1c3d5f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("annotation_label_items", sa.Column("seg_status", sa.String(length=12), nullable=True,
                                                      comment="片段审核：空=待审 / approved / returned"))
    op.add_column("annotation_label_items", sa.Column("seg_reviewed_by", sa.BigInteger(), nullable=True))
    op.add_column("annotation_label_items", sa.Column("seg_reviewed_at", sa.DateTime(), nullable=True))
    op.add_column("annotation_label_items", sa.Column("seg_claimed_by", sa.BigInteger(), nullable=True))
    op.add_column("annotation_label_items", sa.Column("seg_claim_expires_at", sa.DateTime(), nullable=True))
    op.create_foreign_key("fk_items_seg_reviewed_by", "annotation_label_items", "users", ["seg_reviewed_by"], ["id"])
    op.create_foreign_key("fk_items_seg_claimed_by", "annotation_label_items", "users", ["seg_claimed_by"], ["id"])
    op.create_index("ix_annotation_label_items_seg_status", "annotation_label_items", ["seg_status"])
    op.create_index("ix_annotation_label_items_seg_claimed_by", "annotation_label_items", ["seg_claimed_by"])


def downgrade() -> None:
    t = "annotation_label_items"
    op.drop_index("ix_annotation_label_items_seg_claimed_by", table_name=t)
    op.drop_index("ix_annotation_label_items_seg_status", table_name=t)
    op.drop_constraint("fk_items_seg_claimed_by", t, type_="foreignkey")
    op.drop_constraint("fk_items_seg_reviewed_by", t, type_="foreignkey")
    for c in ("seg_claim_expires_at", "seg_claimed_by", "seg_reviewed_at", "seg_reviewed_by", "seg_status"):
        op.drop_column(t, c)
