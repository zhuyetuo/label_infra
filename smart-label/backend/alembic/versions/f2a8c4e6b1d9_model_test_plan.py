"""model_test_sets.plan：选样计划（JSON）

Revision ID: f2a8c4e6b1d9
Revises: e5c1a9d7b3f2
"""

import sqlalchemy as sa
from alembic import op

revision = "f2a8c4e6b1d9"
down_revision = "e5c1a9d7b3f2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("model_test_sets")}
    if "plan" not in cols:
        op.add_column("model_test_sets", sa.Column("plan", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("model_test_sets", "plan")
