"""session_cam_maps + samples.video_cams：摄像头重插后人工纠正机位

Revision ID: b7d4c2a9e6f1
Revises: a9d2e6f4c1b3
"""

import sqlalchemy as sa
from alembic import op

revision = "b7d4c2a9e6f1"
down_revision = "a9d2e6f4c1b3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    if "session_cam_maps" not in tables:
        op.create_table(
            "session_cam_maps",
            sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column("session_key", sa.String(length=100), nullable=False,
                      comment="文件名里那串开机时刻，如 multicam_20260920_000016301"),
            sa.Column("site", sa.String(length=20), nullable=True, comment="场地：gouchang / bolangwang"),
            sa.Column("mapping", sa.JSON(), nullable=False,
                      comment='{"1": 2} = 文件写 cam1，实际拍的是 2 号单间'),
            sa.Column("updated_by", sa.BigInteger(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
            sa.ForeignKeyConstraint(["updated_by"], ["users.id"]),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("session_key", name="uq_session_cam_map"),
        )
        op.create_index("ix_session_cam_maps_session_key", "session_cam_maps", ["session_key"])

    cols = {c["name"] for c in sa.inspect(bind).get_columns("samples")}
    if "video_cams" not in cols:
        op.add_column("samples", sa.Column(
            "video_cams", sa.JSON(), nullable=True,
            comment='人工核对过的真实机位：{"cam1": 2, "cam2": 7}'))


def downgrade() -> None:
    op.drop_column("samples", "video_cams")
    op.drop_table("session_cam_maps")
