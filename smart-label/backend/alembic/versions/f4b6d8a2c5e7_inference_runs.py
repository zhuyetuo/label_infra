"""每个 (样本, 模型, 版本) 各存一份 AI 结果，不再互相覆盖

Revision ID: f4b6d8a2c5e7
Revises: e3a5c7f9b1d4
"""

import sqlalchemy as sa
from alembic import op

revision = "f4b6d8a2c5e7"
down_revision = "e3a5c7f9b1d4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sample_inference_runs",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("sample_id", sa.BigInteger(), nullable=False),
        sa.Column("model_tag", sa.String(length=120), nullable=False),
        sa.Column("model_path", sa.String(length=500), nullable=True),
        sa.Column("mode", sa.String(length=20), nullable=False, comment="stable / viterbi / raw"),
        sa.Column("json_path", sa.String(length=500), nullable=False, comment="NAS 相对路径"),
        sa.Column("n_windows", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("n_segments", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("n_candidates", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("missing_seconds", sa.Float(), nullable=False, server_default="0"),
        sa.Column("label_counts", sa.Text(), nullable=True, comment="JSON {label: n}"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["sample_id"], ["samples.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("sample_id", "model_tag", "mode", name="uq_infer_run_sample_model_mode"),
    )
    op.create_index("ix_sample_inference_runs_sample_id", "sample_inference_runs", ["sample_id"])


def downgrade() -> None:
    op.drop_index("ix_sample_inference_runs_sample_id", table_name="sample_inference_runs")
    op.drop_table("sample_inference_runs")
