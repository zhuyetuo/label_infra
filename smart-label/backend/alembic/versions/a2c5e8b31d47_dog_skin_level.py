"""狗档案加一列当前皮肤状况（正常/轻度/中度/重度）

给挑数据用：重度的那几只抓挠明显更多，训练和验证时想单独看或单独排除，
都得先能按它筛出来。跟皮肤评估那一页按周记录的详细数据不是一回事——那边是
每次评估的原始记录，这里只是档案上的一个当前状态，人工判断、随时可改。

Revision ID: a2c5e8b31d47
Revises: d1f4a7c92b6e
"""

import sqlalchemy as sa
from alembic import op

revision = "a2c5e8b31d47"
down_revision = "d1f4a7c92b6e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dogs",
        sa.Column("skin_level", sa.String(length=10), nullable=True, comment="皮肤状况：正常/轻度/中度/重度"),
    )


def downgrade() -> None:
    op.drop_column("dogs", "skin_level")
