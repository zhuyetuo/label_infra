"""疑似抓挠也能标「待定」（分两种原因）

Revision ID: d2f4a6c8e1b3
Revises: c1e3f5a7b9d2
"""

import sqlalchemy as sa
from alembic import op

revision = "d2f4a6c8e1b3"
down_revision = "c1e3f5a7b9d2"
branch_labels = None
depends_on = None

_OLD = ("pending", "confirmed", "rejected")
_NEW = ("pending", "confirmed", "rejected", "uncertain")


def upgrade() -> None:
    op.alter_column(
        "ai_candidates",
        "status",
        type_=sa.Enum(*_NEW, name="candidatestatus"),
        existing_type=sa.Enum(*_OLD, name="candidatestatus"),
        existing_nullable=False,
        existing_server_default="pending",
    )
    op.add_column(
        "ai_candidates",
        sa.Column("uncertain_reason", sa.String(length=16), nullable=True, comment="待定原因：no_view / ambiguous"),
    )


def downgrade() -> None:
    op.drop_column("ai_candidates", "uncertain_reason")
    op.alter_column(
        "ai_candidates",
        "status",
        type_=sa.Enum(*_OLD, name="candidatestatus"),
        existing_type=sa.Enum(*_NEW, name="candidatestatus"),
        existing_nullable=False,
        existing_server_default="pending",
    )
