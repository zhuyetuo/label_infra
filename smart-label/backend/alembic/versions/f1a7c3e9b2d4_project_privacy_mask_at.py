"""projects.privacy_mask_at：最近一次点「一键遮罩」的时间（项目行上标出哪些项目做过遮罩）

Revision ID: f1a7c3e9b2d4
Revises: e8b4c2f7a9d1
"""

import sqlalchemy as sa
from alembic import op

revision = "f1a7c3e9b2d4"
down_revision = "e8b4c2f7a9d1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("projects")}
    if "privacy_mask_at" not in cols:
        op.add_column("projects", sa.Column("privacy_mask_at", sa.DateTime(), nullable=True,
                                            comment="最近一次一键遮罩的时间（做过遮罩的项目）"))
    # 已经开着遮罩的项目肯定做过
    op.execute("UPDATE projects SET privacy_mask_at = NOW() WHERE privacy_mask = 1 AND privacy_mask_at IS NULL")


def downgrade() -> None:
    op.drop_column("projects", "privacy_mask_at")
