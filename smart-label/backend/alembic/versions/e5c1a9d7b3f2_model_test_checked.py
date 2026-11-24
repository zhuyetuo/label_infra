"""model_test_items.checked_by / checked_at：人工核对过这一段

Revision ID: e5c1a9d7b3f2
Revises: d3b8f1a6c4e9
"""

import sqlalchemy as sa
from alembic import op

revision = "e5c1a9d7b3f2"
down_revision = "d3b8f1a6c4e9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("model_test_items")}
    if "checked_by" not in cols:
        op.add_column("model_test_items", sa.Column("checked_by", sa.BigInteger(), sa.ForeignKey("users.id"), nullable=True))
    if "checked_at" not in cols:
        op.add_column("model_test_items", sa.Column("checked_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("model_test_items", "checked_at")
    op.drop_column("model_test_items", "checked_by")
