"""samples 记下每份 CSV 的采样率

整套流程原来假设所有样本一个采样率（label_service 的 DEVICE_HZ，默认 50）。
实际不是：8-11 之前的数据是采集端就已经从 100Hz 降到 16Hz 存下来的，8-11 起
才是 50Hz 原始流。按 50Hz 去处理 16Hz 的文件，重采样和特征窗口全错，模型输出
没有意义——训练那边本来就是按天声明 Hz 的（train_custom.sh 的 --source_hz /
--extra_date DATE:HZ），平台这边也得把它记下来才对得上。

导入时量出来（前几百行相邻时间戳差值的中位数），量不出来留空。

Revision ID: c9e3f5b7d1a4
Revises: b8d2f4a6c9e1
"""

import sqlalchemy as sa
from alembic import op

revision = "c9e3f5b7d1a4"
down_revision = "b8d2f4a6c9e1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("samples", sa.Column("sample_hz", sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("samples", "sample_hz")
