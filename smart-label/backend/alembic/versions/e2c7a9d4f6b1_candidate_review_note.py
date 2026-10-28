"""疑似片段（候选）也能标「这条判断有问题」，退回时具体到哪几条

Revision ID: e2c7a9d4f6b1
Revises: d8b3e5f1a7c9
"""

import sqlalchemy as sa

from alembic import op

revision = "e2c7a9d4f6b1"
down_revision = "d8b3e5f1a7c9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ai_candidates", sa.Column("review_note", sa.String(length=300), nullable=True,
                                             comment="审核标的问题"))
    op.add_column("ai_candidates", sa.Column("review_flag_by", sa.BigInteger(), nullable=True))
    op.add_column("ai_candidates", sa.Column("review_flag_at", sa.DateTime(), nullable=True))
    op.create_foreign_key("fk_ai_candidates_review_flag_by", "ai_candidates", "users",
                          ["review_flag_by"], ["id"])


def downgrade() -> None:
    op.drop_constraint("fk_ai_candidates_review_flag_by", "ai_candidates", type_="foreignkey")
    op.drop_column("ai_candidates", "review_flag_at")
    op.drop_column("ai_candidates", "review_flag_by")
    op.drop_column("ai_candidates", "review_note")
