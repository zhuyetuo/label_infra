"""狗档案加机位号和别名：把 PM 狗名、NAS 照片目录名、机位号对上

Revision ID: b9d1f3a5c7e4
Revises: a8c4e6b2d9f3
"""

import sqlalchemy as sa
from alembic import op

revision = "b9d1f3a5c7e4"
down_revision = "a8c4e6b2d9f3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("dogs", sa.Column("imu", sa.String(length=20), nullable=True, comment="机位号，如 IMU1"))
    op.add_column("dogs", sa.Column("aliases", sa.String(length=300), nullable=True, comment="别名，逗号分隔"))


def downgrade() -> None:
    op.drop_column("dogs", "aliases")
    op.drop_column("dogs", "imu")
