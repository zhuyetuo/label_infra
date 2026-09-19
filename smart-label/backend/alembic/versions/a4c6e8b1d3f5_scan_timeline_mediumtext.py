"""画面扫描的时间线改 MEDIUMTEXT：现在连狗框一起存，复查画面要叠框

一小时 720 个采样点、一只狗，带框约 25KB；两三只狗就顶到 TEXT 的 64KB 上限了。

Revision ID: a4c6e8b1d3f5
Revises: f1a3c5e7b9d2
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "a4c6e8b1d3f5"
down_revision = "f1a3c5e7b9d2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if op.get_bind().dialect.name == "mysql":
        op.alter_column("sample_vision_scans", "timeline", existing_type=sa.Text(), type_=mysql.MEDIUMTEXT(),
                        existing_nullable=True)


def downgrade() -> None:
    if op.get_bind().dialect.name == "mysql":
        op.alter_column("sample_vision_scans", "timeline", existing_type=mysql.MEDIUMTEXT(), type_=sa.Text(),
                        existing_nullable=True)
