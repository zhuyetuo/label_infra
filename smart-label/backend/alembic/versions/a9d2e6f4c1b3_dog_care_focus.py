"""dogs.care_focus：重点护理的狗（皮肤跟踪表 / 趋势图可以只看这几只）

Revision ID: a9d2e6f4c1b3
Revises: f1a7c3e9b2d4
"""

import sqlalchemy as sa
from alembic import op

revision = "a9d2e6f4c1b3"
down_revision = "f1a7c3e9b2d4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("dogs")}
    if "care_focus" not in cols:
        op.add_column("dogs", sa.Column("care_focus", sa.Boolean(), nullable=False, server_default=sa.false(),
                                        comment="重点护理：皮肤跟踪重点盯这几只"))


def downgrade() -> None:
    op.drop_column("dogs", "care_focus")
