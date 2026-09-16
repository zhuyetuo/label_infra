"""推理结果索引加「每类总时长」

只有段数的话，日常统计答不了"今天睡了几小时"——"睡觉 8 段"说明不了什么。

Revision ID: a1c4e8b2d6f0
Revises: f7b3d5a9c1e2
"""

import sqlalchemy as sa
from alembic import op

revision = "a1c4e8b2d6f0"
down_revision = "f7b3d5a9c1e2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 允许为空：**历史行不回填**。回填要把 NAS 上几万个 JSON 重读一遍，
    # 而且那些结果里的类别跟现在的模型可能都不是一套。
    # 前端按"这天有没有时长数据"区分显示，不拿 0 冒充"没跑过"
    op.add_column(
        "sample_inference_runs",
        sa.Column("label_seconds", sa.Text(), nullable=True,
                  comment="JSON {label: 总秒数}"),
    )


def downgrade() -> None:
    op.drop_column("sample_inference_runs", "label_seconds")
