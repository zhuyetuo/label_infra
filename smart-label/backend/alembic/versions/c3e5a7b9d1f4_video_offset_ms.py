"""样本的每路视频各自带一个时间偏移

为什么需要：狗场两台采集机各自开机，时间戳差几秒，落成两个 session
（multicam_20260920_000016301 / _000012130）。而 cam7 一台俯拍看的是全部六间，
本该挂给六间的狗——可它的文件名带着 2 号机那串时间戳，跨不过去。

平台原来的假设是「每路视频的第 0 秒 = IMU CSV 第一行」，所有路共用一个原点。
把另一台机器的视频挂上来而不带偏移，那一路上**每一条标注都会差 4 秒**——
4 秒足够把一次抓挠对到隔壁动作上，而且错得看不出来。所以先有这一列，
才谈得上挂。

含义：**这一路视频的第 0 秒，在样本时间轴上是第几毫秒**。
  offset = 0      跟样本同一个原点（原来所有视频都是这样，所以默认 0，行为不变）
  offset = -4171  这一路比样本早开 4.171 秒
  换算：视频时刻 = 样本时刻 - offset

存成 JSON（{"cam2": -4171}）而不是三个列：只有跨 session 挂过来的那一路才有
偏移，绝大多数样本这一栏是空的；而且以后要记"这个偏移是怎么算出来的"时，
JSON 里加个键就行，不用再来一次迁移。

Revision ID: c3e5a7b9d1f4
Revises: b2d4f6a8c0e1
"""

import sqlalchemy as sa
from alembic import op

revision = "c3e5a7b9d1f4"
down_revision = "b2d4f6a8c0e1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("samples", sa.Column("video_offsets_ms", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("samples", "video_offsets_ms")
