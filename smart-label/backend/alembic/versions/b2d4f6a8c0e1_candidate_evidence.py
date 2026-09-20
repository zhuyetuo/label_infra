"""候选加一列 evidence：模型看到了什么 + 为什么这么判

为什么要存下来：画面候选（reason=vision）现在只给标签和置信度，人复核时看到
「舔身体 62%」还是得点开视频才知道对不对。模型本来就在回答里写了依据，不存
就白问了。

它也是调试用的：一句「侧卧，头转向身后，口鼻接触左后肢」说明模型看懂了；
一句「一只狗趴在地毯上」说明它根本没看清——这两种的解法完全不同，而没有
这一列的话，只能看着一堆置信度反复猜。

Revision ID: b2d4f6a8c0e1
Revises: e8a1c3f5b7d9
"""

import sqlalchemy as sa
from alembic import op

revision = "b2d4f6a8c0e1"
down_revision = "e8a1c3f5b7d9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ai_candidates", sa.Column(
        "evidence", sa.String(300), nullable=True,
        comment="模型看到了什么 + 为什么这么判。IMU 来的候选为空"))


def downgrade() -> None:
    op.drop_column("ai_candidates", "evidence")
