"""训练记录「启用」= 出现在项目的版本下拉里

Revision ID: d8e2f4a6b1c3
Revises: c3e5a7b9d1f4
"""

import sqlalchemy as sa
from alembic import op

revision = "d8e2f4a6b1c3"
down_revision = "c3e5a7b9d1f4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "model_versions",
        sa.Column("listed", sa.Boolean(), nullable=False, server_default=sa.false(),
                  comment="启用了才出现在新建项目/预标注/模型对比的版本下拉里"),
    )


def downgrade() -> None:
    op.drop_column("model_versions", "listed")
