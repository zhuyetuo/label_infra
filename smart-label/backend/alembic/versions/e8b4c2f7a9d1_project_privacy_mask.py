"""projects.privacy_mask：项目开了隐私遮罩，标注员 / 审核员只拿得到「狗框以外全黑」的视频

Revision ID: e8b4c2f7a9d1
Revises: a4d7e2b9c1f6
"""

import sqlalchemy as sa
from alembic import op

revision = "e8b4c2f7a9d1"
down_revision = "a4d7e2b9c1f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("projects")}
    if "privacy_mask" not in cols:
        op.add_column("projects", sa.Column("privacy_mask", sa.Boolean(), nullable=False, server_default=sa.false(),
                                            comment="隐私遮罩开着：非超级管理员只拿得到遮罩版视频"))


def downgrade() -> None:
    op.drop_column("projects", "privacy_mask")
