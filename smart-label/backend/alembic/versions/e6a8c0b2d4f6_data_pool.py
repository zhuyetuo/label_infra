"""数据池：审核通过的片段自动在池里；另外可以手动加入 / 移出

pool_state：空 = 自动（seg_status=approved 就在池里）/ in = 手动加入 / out = 手动移出

Revision ID: e6a8c0b2d4f6
Revises: d2a4c6e8f0b1
"""

import sqlalchemy as sa

from alembic import op

revision = "e6a8c0b2d4f6"
down_revision = "d2a4c6e8f0b1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("annotation_label_items", sa.Column("pool_state", sa.String(length=4), nullable=True,
                                                      comment="数据池：空=自动（审核通过即在池）/ in=手动加入 / out=手动移出"))
    op.create_index("ix_annotation_label_items_pool_state", "annotation_label_items", ["pool_state"])


def downgrade() -> None:
    op.drop_index("ix_annotation_label_items_pool_state", table_name="annotation_label_items")
    op.drop_column("annotation_label_items", "pool_state")
