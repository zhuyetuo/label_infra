"""疑似片段（候选）也能调起止，跟已标注片段一样每次调整记一笔

Revision ID: b6e8a1c3d5f7
Revises: a3d5f7b9c2e4
"""

import sqlalchemy as sa

from alembic import op

revision = "b6e8a1c3d5f7"
down_revision = "a3d5f7b9c2e4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ai_candidates", sa.Column("boundary_edits", sa.Text(), nullable=True, comment="起止调整记录 JSON"))


def downgrade() -> None:
    op.drop_column("ai_candidates", "boundary_edits")
