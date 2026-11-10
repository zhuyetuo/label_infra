"""补数据：以前在皮肤评估里「抓挠复核完」的任务，抓挠片段补成审核通过（跟项目页片段审核同步）

Revision ID: e7b2c9d4f1a3
Revises: d3a6f8b1c4e2
"""

from alembic import op

revision = "e7b2c9d4f1a3"
down_revision = "d3a6f8b1c4e2"
branch_labels = None
depends_on = None

_JOIN = """
    annotation_label_items ali
    JOIN annotation_records ar ON ar.id = ali.annotation_record_id
    JOIN tasks t ON t.id = ar.task_id AND ar.round_no = t.round_no
    JOIN label_definitions ld ON ld.id = ali.label_id
"""
# 抓挠和它的细类（抓挠-头颈耳…）；退回的、待定的、已有结论的不动
_WHERE = """
    t.scratch_checked_by IS NOT NULL AND ld.display_name LIKE '抓挠%'
    AND ali.seg_status IS NULL AND ali.review_note IS NULL AND ali.uncertain = 0
"""


def upgrade() -> None:
    if op.get_bind().dialect.name != "mysql":
        return
    op.execute(f"UPDATE {_JOIN} SET ali.ai_confirmed = 1 WHERE {_WHERE} "
               "AND ali.source_type = 'ai_generated' AND ali.is_modified = 0")
    op.execute(f"UPDATE {_JOIN} SET ali.seg_status = 'approved', ali.seg_reviewed_by = t.scratch_checked_by, "
               f"ali.seg_reviewed_at = t.scratch_checked_at WHERE {_WHERE}")


def downgrade() -> None:
    pass
