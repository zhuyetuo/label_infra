"""samples.is_sensitive / sensitive_note

Revision ID: e4b8c2d17f56
Revises: c7e2f1a9b3d4
Create Date: 2026-09-06

有些样本画面里带敏感隐私信息（比如拍到了人、家里环境等），只允许管理员/
超级管理员看和标，标注员/审核员在任何列表、媒体、IMU 接口里都碰不到。
后续确认不敏感了可以解除。过滤统一走 services/task_scope.py。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'e4b8c2d17f56'
down_revision = 'c7e2f1a9b3d4'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("samples")}
    if "is_sensitive" not in cols:
        op.add_column(
            "samples",
            sa.Column("is_sensitive", sa.Boolean(), nullable=False, server_default=sa.false(), comment="含敏感隐私信息，仅管理员可见"),
        )
    if "sensitive_note" not in cols:
        op.add_column("samples", sa.Column("sensitive_note", sa.String(200), nullable=True, comment="为什么标为敏感"))


def downgrade() -> None:
    op.drop_column("samples", "sensitive_note")
    op.drop_column("samples", "is_sensitive")
