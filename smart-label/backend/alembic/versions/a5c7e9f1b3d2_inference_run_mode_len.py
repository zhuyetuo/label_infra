"""sample_inference_runs.mode 加宽

训练记录模型的版本串是 `srv:train49@viterbi_precise` 这种完整 spec，
29 个字符装不进原来的 varchar(20)，整条登记失败——评测跑批看起来"跑完了"，
实际上一条结果都没存下。端侧以后也可能带 `edge:<tag>@viterbi_precise`，
留到 64。

Revision ID: a5c7e9f1b3d2
Revises: c3a9e5f7b1d2
"""

import sqlalchemy as sa

from alembic import op

revision = "a5c7e9f1b3d2"
down_revision = "c3a9e5f7b1d2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "sample_inference_runs",
        "mode",
        existing_type=sa.String(length=20),
        type_=sa.String(length=64),
        existing_nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        "sample_inference_runs",
        "mode",
        existing_type=sa.String(length=64),
        type_=sa.String(length=20),
        existing_nullable=False,
    )
