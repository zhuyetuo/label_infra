"""label_definitions.template_item_id (跟随模板颜色用)

Revision ID: f3a9c4e21b78
Revises: e4b8c2d17f56
Create Date: 2026-09-07

套用模板时把项目标签跟来源的模板条目关联起来；之后改模板颜色会同步更新
所有还关联着的项目标签（见 label_templates.py 的 _replace_items /
propagate_color）。项目标签的颜色被人工改过之后会解除关联，改模板颜色就
不再影响它了——这是刻意的：一旦手动改过，说明这个项目想自己管这个颜色。
模板条目被删掉时这里跟着置空（ondelete=SET NULL），不会因为 FK 报错。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'f3a9c4e21b78'
down_revision = 'e4b8c2d17f56'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("label_definitions")}
    if "template_item_id" not in cols:
        op.add_column(
            "label_definitions",
            sa.Column("template_item_id", sa.BigInteger(), nullable=True, comment="来源的模板条目，用于跟随模板颜色"),
        )
        op.create_foreign_key(
            "fk_label_definitions_template_item_id",
            "label_definitions",
            "label_template_items",
            ["template_item_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    op.drop_constraint("fk_label_definitions_template_item_id", "label_definitions", type_="foreignkey")
    op.drop_column("label_definitions", "template_item_id")
