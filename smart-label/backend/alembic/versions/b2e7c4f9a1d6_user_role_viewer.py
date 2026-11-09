"""账号角色加「访客」viewer：能看全部、不能改

Revision ID: b2e7c4f9a1d6
Revises: a9d3f6b2e8c4
"""

import sqlalchemy as sa
from alembic import op

revision = "b2e7c4f9a1d6"
down_revision = "a9d3f6b2e8c4"
branch_labels = None
depends_on = None

_OLD = ("super_admin", "admin", "annotator", "reviewer")
_NEW = _OLD + ("viewer",)


def upgrade() -> None:
    op.alter_column("users", "role", existing_type=sa.Enum(*_OLD, name="userrole"),
                    type_=sa.Enum(*_NEW, name="userrole"), existing_nullable=False)


def downgrade() -> None:
    op.execute("UPDATE users SET role = 'annotator', is_active = 0 WHERE role = 'viewer'")
    op.alter_column("users", "role", existing_type=sa.Enum(*_NEW, name="userrole"),
                    type_=sa.Enum(*_OLD, name="userrole"), existing_nullable=False)
