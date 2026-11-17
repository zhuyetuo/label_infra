"""数据池人工复审标记：看过 / 已入池 / 错乱

旧的导出数据集里有一批片段从没经过人工复审就混进了数据池（当年 AI 给的就认了）。
在「训练数据集 → 详情」里一条条过一遍，标记存在这三列：
  pool_review    空 = 没看过 / in = 已入池 / seen = 看过没放入 / bad = 错乱不适合
  pool_review_by 谁标的
  pool_review_at 什么时候标的
跟 pool_state（池子的最终状态）分开：标记是"人看过没有"的记录，池子在不在由
pool_state / seg_status 决定，标记 in / seen / bad 时会一起写 pool_state。

这里**不加外键**：这张表在线上一直有事务在动，ADD FOREIGN KEY 要等元数据锁，
AI 预标注跑着的时候会等到 Lock wait timeout（第一次部署就卡在这里）；列本身
存的是用户 id，跟 pool_state 那几个字段一样不做库级约束。

Revision ID: c3a9e5f7b1d2
Revises: b7d1e3f5a9c2
"""

import sqlalchemy as sa

from alembic import op

revision = "c3a9e5f7b1d2"
down_revision = "b7d1e3f5a9c2"
branch_labels = None
depends_on = None

_TABLE = "annotation_label_items"


def upgrade() -> None:
    # 第一次部署时三列已经加上、只差索引，重跑不能报 Duplicate column
    insp = sa.inspect(op.get_bind())
    cols = {c["name"] for c in insp.get_columns(_TABLE)}
    if "pool_review" not in cols:
        op.add_column(_TABLE, sa.Column(
            "pool_review", sa.String(length=8), nullable=True,
            comment="数据池复审：空=没看过 / in=已入池 / seen=看过没放入 / bad=错乱不适合"))
    if "pool_review_by" not in cols:
        op.add_column(_TABLE, sa.Column("pool_review_by", sa.BigInteger(), nullable=True,
                                        comment="谁做的数据池复审"))
    if "pool_review_at" not in cols:
        op.add_column(_TABLE, sa.Column("pool_review_at", sa.DateTime(), nullable=True, comment="数据池复审时间"))
    indexes = {i["name"] for i in insp.get_indexes(_TABLE)}
    if "ix_annotation_label_items_pool_review" not in indexes:
        op.create_index("ix_annotation_label_items_pool_review", _TABLE, ["pool_review"])


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    indexes = {i["name"] for i in insp.get_indexes(_TABLE)}
    if "ix_annotation_label_items_pool_review" in indexes:
        op.drop_index("ix_annotation_label_items_pool_review", table_name=_TABLE)
    cols = {c["name"] for c in insp.get_columns(_TABLE)}
    for c in ("pool_review_at", "pool_review_by", "pool_review"):
        if c in cols:
            op.drop_column(_TABLE, c)
