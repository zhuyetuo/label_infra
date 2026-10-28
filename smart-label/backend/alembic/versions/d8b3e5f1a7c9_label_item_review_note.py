"""片段加「审核标的问题」：退回时能具体到哪几条片段

以前只能整个任务退回，标注员拿回去不知道该看哪几条。

Revision ID: d8b3e5f1a7c9
Revises: c6a1f3e8d2b4
"""

import sqlalchemy as sa

from alembic import op

revision = "d8b3e5f1a7c9"
down_revision = "c6a1f3e8d2b4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("annotation_label_items", sa.Column("review_note", sa.String(length=300), nullable=True,
                                                      comment="审核标的问题"))
    op.add_column("annotation_label_items", sa.Column("review_flag_by", sa.BigInteger(), nullable=True))
    op.add_column("annotation_label_items", sa.Column("review_flag_at", sa.DateTime(), nullable=True))
    op.create_foreign_key("fk_label_items_review_flag_by", "annotation_label_items", "users",
                          ["review_flag_by"], ["id"])


def downgrade() -> None:
    op.drop_constraint("fk_label_items_review_flag_by", "annotation_label_items", type_="foreignkey")
    op.drop_column("annotation_label_items", "review_flag_at")
    op.drop_column("annotation_label_items", "review_flag_by")
    op.drop_column("annotation_label_items", "review_note")
