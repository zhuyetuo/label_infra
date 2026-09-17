"""大模型 API 配置表 + 候选记下是哪个模型给的

「画面找片段」要能选用哪家（Claude / GPT / 豆包 / Gemini）的哪个模型，key 在网页上配，
不再要求 ssh 改环境变量。候选上记 model，不同模型跑同一批才对得出来谁更准。

Revision ID: c5e7a9b1d3f2
Revises: a1c4e8b2d6f0
"""

import sqlalchemy as sa
from alembic import op

revision = "c5e7a9b1d3f2"
down_revision = "a1c4e8b2d6f0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if "llm_providers" not in insp.get_table_names():
        op.create_table(
            "llm_providers",
            sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column("provider", sa.String(length=20), nullable=False),
            sa.Column("display_name", sa.String(length=50), nullable=False),
            sa.Column("api_key", sa.Text(), nullable=True),
            sa.Column("base_url", sa.String(length=300), nullable=True),
            sa.Column("models", sa.Text(), nullable=False, comment="JSON [{name, price_in, price_out}]"),
            sa.Column("default_model", sa.String(length=100), nullable=True),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("1")),
            sa.Column("updated_by", sa.BigInteger(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=True),
            sa.ForeignKeyConstraint(["updated_by"], ["users.id"]),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("provider", name="uq_llm_providers_provider"),
        )
    cols = {c["name"] for c in insp.get_columns("ai_candidates")}
    if "model" not in cols:
        # 允许为空：IMU 来的候选没有模型这一说；老的画面候选也没记
        op.add_column("ai_candidates", sa.Column("model", sa.String(length=80), nullable=True,
                                                 comment="画面候选是哪家哪个模型给的，如 anthropic:claude-opus-5"))


def downgrade() -> None:
    op.drop_column("ai_candidates", "model")
    op.drop_table("llm_providers")
