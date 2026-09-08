"""狗档案加「场所」（影棚 / 狗场），并把已经写在备注里的搬过去

Revision ID: a7c9e1b3d5f8
Revises: f4b6d8a2c5e7
"""

import sqlalchemy as sa
from alembic import op

revision = "a7c9e1b3d5f8"
down_revision = "f4b6d8a2c5e7"
branch_labels = None
depends_on = None

# 场所以前是手写在备注里的，就这两个值；顺手搬到新列，不用人再录一遍
_KNOWN = ("影棚", "狗场")


def upgrade() -> None:
    op.add_column("dogs", sa.Column("site", sa.String(length=50), nullable=True, comment="场所：影棚 / 狗场"))
    for name in _KNOWN:
        op.execute(sa.text("UPDATE dogs SET site = :s WHERE remark = :s").bindparams(s=name))


def downgrade() -> None:
    op.drop_column("dogs", "site")
