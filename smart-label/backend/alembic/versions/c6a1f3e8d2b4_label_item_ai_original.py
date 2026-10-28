"""片段记下 AI 原始判断（类别、起止），已标注片段能显示「AI 判的舔 → 人改成活动」

is_modified 只说"改过"，说不出原来是什么。新加三列在 AI 生成时写入，之后不再改。

回填：没改过的 AI 片段，当前值就是 AI 原始值；改过的老数据原值已找不回，留 NULL。

Revision ID: c6a1f3e8d2b4
Revises: b4e8d2a6c1f3
"""

import sqlalchemy as sa

from alembic import op

revision = "c6a1f3e8d2b4"
down_revision = "b4e8d2a6c1f3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("annotation_label_items", sa.Column("ai_label_id", sa.BigInteger(), nullable=True,
                                                      comment="AI 原始类别"))
    op.add_column("annotation_label_items", sa.Column("ai_start_ms", sa.Integer(), nullable=True,
                                                      comment="AI 原始开始"))
    op.add_column("annotation_label_items", sa.Column("ai_end_ms", sa.Integer(), nullable=True,
                                                      comment="AI 原始结束"))
    op.create_foreign_key("fk_label_items_ai_label", "annotation_label_items", "label_definitions",
                          ["ai_label_id"], ["id"])
    op.execute("UPDATE annotation_label_items SET ai_label_id = label_id, ai_start_ms = start_time_ms, "
               "ai_end_ms = end_time_ms WHERE source_type = 'ai_generated' AND is_modified = 0")


def downgrade() -> None:
    op.drop_constraint("fk_label_items_ai_label", "annotation_label_items", type_="foreignkey")
    op.drop_column("annotation_label_items", "ai_end_ms")
    op.drop_column("annotation_label_items", "ai_start_ms")
    op.drop_column("annotation_label_items", "ai_label_id")
