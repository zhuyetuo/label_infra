"""补数据：入档皮肤没填的，用建档时填的「皮肤」

狗档案上的「皮肤」是建档时就填了的；「入档皮肤」是后来才加的列，老档案全是空的，
皮肤评估里鼠标放狗名上就显示「未填」。拿现在的「皮肤」补一次（之后两列各管各的）。

Revision ID: a4d7e2b9c1f6
Revises: f2c8a1d5b7e9
"""

from alembic import op

revision = "a4d7e2b9c1f6"
down_revision = "f2c8a1d5b7e9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE dogs SET intake_skin_level = skin_level WHERE intake_skin_level IS NULL AND skin_level IS NOT NULL")


def downgrade() -> None:
    pass
