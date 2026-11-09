"""狗档案加入档时的皮肤情况（等级 + 说明）

Revision ID: d3a6f8b1c4e2
Revises: c5d8e1f3a7b9
"""

import sqlalchemy as sa
from alembic import op

revision = "d3a6f8b1c4e2"
down_revision = "c5d8e1f3a7b9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("dogs", sa.Column("intake_skin_level", sa.String(10), nullable=True, comment="入档时皮肤：正常/轻度/中度/重度"))
    op.add_column("dogs", sa.Column("intake_skin_note", sa.String(500), nullable=True,
                                    comment="入档时皮肤情况说明：部位、症状、在不在用药"))


def downgrade() -> None:
    op.drop_column("dogs", "intake_skin_note")
    op.drop_column("dogs", "intake_skin_level")
