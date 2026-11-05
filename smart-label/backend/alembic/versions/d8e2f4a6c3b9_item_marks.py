"""片段标记：复合类别 / 边界拿不准 / 画面跟 IMU 对不上 / 其它（可以打好几个）+ 备注

Revision ID: d8e2f4a6c3b9
Revises: c7e9a1b3d5f6
"""

import sqlalchemy as sa
from alembic import op

revision = "d8e2f4a6c3b9"
down_revision = "c7e9a1b3d5f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("annotation_label_items", sa.Column(
        "marks", sa.String(length=200), nullable=True, comment="标记，逗号分开：compound / boundary / av_mismatch / other"))
    op.add_column("annotation_label_items", sa.Column("mark_note", sa.String(length=300), nullable=True, comment="标记的备注"))


def downgrade() -> None:
    op.drop_column("annotation_label_items", "mark_note")
    op.drop_column("annotation_label_items", "marks")
