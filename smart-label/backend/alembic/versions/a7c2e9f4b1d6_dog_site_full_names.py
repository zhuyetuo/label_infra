"""狗档案「场所」改用场地全称：狗场 → 深圳雷诺狗场，影棚 → 公司影棚

新增了佛山博朗旺狗场，「狗场」两个字已经分不清是哪个了。深圳雷诺狗场暂停合作，
档案和历史样本都留着。只改这一列的值，不动表结构。

Revision ID: a7c2e9f4b1d6
Revises: e1f3a5b7c9d2
"""

import sqlalchemy as sa

from alembic import op

revision = "a7c2e9f4b1d6"
down_revision = "e1f3a5b7c9d2"
branch_labels = None
depends_on = None

_RENAMES = (("狗场", "深圳雷诺狗场"), ("影棚", "公司影棚"))


def upgrade() -> None:
    for old, new in _RENAMES:
        op.execute(f"UPDATE dogs SET site = '{new}' WHERE site = '{old}'")
    op.alter_column("dogs", "site", existing_type=sa.String(length=50), existing_nullable=True,
                    comment="场所：公司影棚 / 深圳雷诺狗场 / 佛山博朗旺狗场")


def downgrade() -> None:
    for old, new in _RENAMES:
        op.execute(f"UPDATE dogs SET site = '{old}' WHERE site = '{new}'")
    op.alter_column("dogs", "site", existing_type=sa.String(length=50), existing_nullable=True,
                    comment="场所：影棚 / 狗场")
