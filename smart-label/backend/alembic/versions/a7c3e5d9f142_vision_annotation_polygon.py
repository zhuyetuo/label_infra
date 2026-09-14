"""vision_annotations 加 polygon：把 SAM 算出来的掩膜存下来

SAM 每次分割同时返回框和掩膜轮廓（mask_to_shapes），但表里只有 bbox——
掩膜算完就扔。以后想训分割模型，几百张图得从头重标一遍。

可空：手画的框本来就没有掩膜，老数据也全是 None。导出分割格式时，没有掩膜的
退回用框的四个角，不会因为这一列空着就丢样本。

Revision ID: a7c3e5d9f142
Revises: d1f4b82c6ae3
"""

import sqlalchemy as sa
from alembic import op

revision = "a7c3e5d9f142"
down_revision = "d1f4b82c6ae3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "vision_annotations",
        sa.Column("polygon", sa.Text(), nullable=True,
                  comment="JSON [[x,y], ...]，归一化到 0-1。SAM 出的掩膜轮廓；手画的框为 None"),
    )


def downgrade() -> None:
    op.drop_column("vision_annotations", "polygon")
