"""狗档案加一列体型（大/中/小）

不按体重自动分：同样 13kg，法斗是中型，小体金毛是大型幼犬，光看数字分不出来。
而抓挠的幅度和频率跟体型直接相关——大型犬一次抓挠的加速度峰值和小型犬不是一
个量级，以后要按体型分组看指标、甚至分体型训模型，都得先有这一列。

Revision ID: d1f4a7c92b6e
Revises: c9e3f5b7d1a4
"""

import sqlalchemy as sa
from alembic import op

revision = "d1f4a7c92b6e"
down_revision = "c9e3f5b7d1a4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("dogs", sa.Column("size", sa.String(length=10), nullable=True, comment="体型：大 / 中 / 小"))


def downgrade() -> None:
    op.drop_column("dogs", "size")
