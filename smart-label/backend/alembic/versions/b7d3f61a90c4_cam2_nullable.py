"""样本的第二路视频允许为空

Revision ID: b7d3f61a90c4
Revises: a2c5e8b31d47

路数是场地决定的，不是数据完不完整：
  - 狗场的小单间是一间一狗一摄像头，一只狗的样本天生只有一路视频
  - 狗场的草地/公共活动区和影棚一样，一个大空间多路摄像头多只狗
  - 更早的单摄像头录制（multi_*）也是一路
原来 video_cam2_path 非空，等于把"只有一路"的场地整个挡在门外——扫描时直接
跳过，一条样本都进不来。cam1 仍然必填：一路视频都没有的话，标注无从谈起。
"""

from alembic import op
import sqlalchemy as sa

revision = "b7d3f61a90c4"
down_revision = "a2c5e8b31d47"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("samples", "video_cam2_path",
                    existing_type=sa.String(length=500), nullable=True)


def downgrade() -> None:
    # 回滚前得先处理掉 cam2 为空的行，否则加不回 NOT NULL
    op.execute("DELETE FROM samples WHERE video_cam2_path IS NULL")
    op.alter_column("samples", "video_cam2_path",
                    existing_type=sa.String(length=500), nullable=False)
