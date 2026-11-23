"""projects.model_neg：模型判成负例类别（进食 / 饮水 / 嗅闻 / 啃…）的片段要不要输出成候选

web 上补负例标注要开；端侧只报抓挠/活动这些，不需要，关掉即可。

Revision ID: c9e2a4f8b1d7
Revises: a5c7e9f1b3d2
"""

import sqlalchemy as sa
from alembic import op

revision = "c9e2a4f8b1d7"
down_revision = "a5c7e9f1b3d2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("projects")}
    if "model_neg" not in cols:
        op.add_column("projects", sa.Column("model_neg", sa.Boolean(), nullable=False, server_default=sa.true(),
                                            comment="AI 预标注是否输出「模型判成负例类别」的候选（进食/饮水/嗅闻…）"))


def downgrade() -> None:
    op.drop_column("projects", "model_neg")
