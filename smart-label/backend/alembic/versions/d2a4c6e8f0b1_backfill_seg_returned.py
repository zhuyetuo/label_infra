"""片段审核上线前标的「有问题」补成「退回」状态

那时候「有问题」只写了 review_note，还没有 seg_status。不补的话项目页把这些算成
「未审」，标注员的「退回的片段」里也看不到它们。

Revision ID: d2a4c6e8f0b1
Revises: c8f1a3e5b7d9
"""

from alembic import op

revision = "d2a4c6e8f0b1"
down_revision = "c8f1a3e5b7d9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE annotation_label_items SET seg_status = 'returned', "
        "seg_reviewed_by = review_flag_by, seg_reviewed_at = review_flag_at "
        "WHERE review_note IS NOT NULL AND seg_status IS NULL"
    )


def downgrade() -> None:
    # 补的那些分不出来是补的还是后来真退回的，不回退
    pass
