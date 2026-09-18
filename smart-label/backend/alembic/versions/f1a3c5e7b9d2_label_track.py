"""标签加「互斥轨」：同轨互斥、跨轨可重叠

狗可以卧着、静止、同时舔前爪——姿态 / 运动状态 / 具体行为本来就是同时发生的。
以前所有标签都在一条时间线上互斥，22 类全放顶层的话「舔」和「卧」就会报冲突。
给标签（和模板条目）加 track：posture / motion / behavior / device；空 = 老行为，
所有没轨的标签仍然互相互斥，老项目不受影响。

Revision ID: f1a3c5e7b9d2
Revises: e2a7c9d4b6f1
"""

import sqlalchemy as sa
from alembic import op

revision = "f1a3c5e7b9d2"
down_revision = "e2a7c9d4b6f1"
branch_labels = None
depends_on = None


def _cols(table: str) -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    # 表名写成字面量：tests/test_vision_api.py 那条"迁移和模型的列一一对应"是按 AST 读的
    if "track" not in _cols("label_definitions"):
        op.add_column("label_definitions", sa.Column("track", sa.String(length=20), nullable=True))
    if "track" not in _cols("label_template_items"):
        op.add_column("label_template_items", sa.Column("track", sa.String(length=20), nullable=True))


def downgrade() -> None:
    op.drop_column("label_template_items", "track")
    op.drop_column("label_definitions", "track")
