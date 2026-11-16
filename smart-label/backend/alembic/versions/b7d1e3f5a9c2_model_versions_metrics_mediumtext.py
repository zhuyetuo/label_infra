"""训练记录的 metrics 改 MEDIUMTEXT：数据集一大就超过 TEXT 的 64KB

metrics 里除了指标，还有训练集统计（每个类别一行）和待复核片段列表。数据池全部（1450 个任务）训一次，
这一段 JSON 就有 100KB 出头，写回时 MySQL 报 1406 Data too long——平台上这条记录会一直停在「排队中」，
训练其实早就完了。dataset_spec 一起改，提交时带的归并表 / 一起训练的数据集多了也会长。

Revision ID: b7d1e3f5a9c2
Revises: d4e9b2c7a1f5
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "b7d1e3f5a9c2"
down_revision = "d4e9b2c7a1f5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if op.get_bind().dialect.name == "mysql":
        op.alter_column("model_versions", "metrics", existing_type=sa.Text(), type_=mysql.MEDIUMTEXT(),
                        existing_nullable=True)
        op.alter_column("model_versions", "dataset_spec", existing_type=sa.Text(), type_=mysql.MEDIUMTEXT(),
                        existing_nullable=False)


def downgrade() -> None:
    if op.get_bind().dialect.name == "mysql":
        op.alter_column("model_versions", "metrics", existing_type=mysql.MEDIUMTEXT(), type_=sa.Text(),
                        existing_nullable=True)
        op.alter_column("model_versions", "dataset_spec", existing_type=mysql.MEDIUMTEXT(), type_=sa.Text(),
                        existing_nullable=False)
