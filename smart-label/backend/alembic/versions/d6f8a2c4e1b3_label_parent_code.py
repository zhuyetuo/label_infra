"""标签模板条目带上级 code：套模板时能把父子关系一起带到项目里

层级标签：舔身体 → 前爪 → 前左爪。项目标签早就有 parent_id，模板条目一直没有，
套用之后父子关系就丢了。加 parent_code（同一模板内引用另一条的 code）。

Revision ID: d6f8a2c4e1b3
Revises: c5e7a9b1d3f2
"""

import sqlalchemy as sa
from alembic import op

revision = "d6f8a2c4e1b3"
down_revision = "c5e7a9b1d3f2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    cols = {c["name"] for c in sa.inspect(conn).get_columns("label_template_items")}
    if "parent_code" not in cols:
        op.add_column("label_template_items", sa.Column("parent_code", sa.String(length=50), nullable=True))


def downgrade() -> None:
    op.drop_column("label_template_items", "parent_code")
