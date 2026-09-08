"""候选记下确认成了哪个类别（空=抓挠）

Revision ID: c1e3f5a7b9d2
Revises: b9d1f3a5c7e4
"""

import sqlalchemy as sa
from alembic import op

revision = "c1e3f5a7b9d2"
down_revision = "b9d1f3a5c7e4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ai_candidates",
        sa.Column("decided_label_id", sa.BigInteger(), nullable=True, comment="确认成了哪个类别，空=抓挠"),
    )
    op.create_foreign_key(
        "fk_ai_candidates_decided_label", "ai_candidates", "label_definitions", ["decided_label_id"], ["id"]
    )


def downgrade() -> None:
    op.drop_constraint("fk_ai_candidates_decided_label", "ai_candidates", type_="foreignkey")
    op.drop_column("ai_candidates", "decided_label_id")
