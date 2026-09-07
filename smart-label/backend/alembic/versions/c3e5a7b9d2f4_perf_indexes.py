"""热点表补索引：任务列表/草稿统计/审核/样本按日期 全都在裸表扫

Revision ID: c3e5a7b9d2f4
Revises: b2d4e6f8a1c3
Create Date: 2026-09-07

之前只有 tasks.project_id 一个索引。任务列表要按 (task_id, round_no) 聚合草稿段数和
各类别段数，annotation_records / annotation_label_items 上没有任何索引，样本上万之后
每次刷新任务页都是几次全表扫 + 大表 JOIN，慢查询把连接占住，再叠上批量预标注就把
连接池耗光（见 PR #199）。这里把 WHERE/JOIN/ORDER BY 用到的列补齐。
"""
from alembic import op
import sqlalchemy as sa

revision = 'c3e5a7b9d2f4'
down_revision = 'b2d4e6f8a1c3'
branch_labels = None
depends_on = None

# (表, 索引名, 列)
_INDEXES = [
    ("tasks", "ix_tasks_sample_id", ["sample_id"]),
    ("tasks", "ix_tasks_status", ["status"]),
    ("tasks", "ix_tasks_assigned_to", ["assigned_to"]),
    ("tasks", "ix_tasks_reviewer_id", ["reviewer_id"]),
    ("tasks", "ix_tasks_locked_by", ["locked_by"]),
    ("tasks", "ix_tasks_parent_task_id", ["parent_task_id"]),
    # 任务页默认按创建时间倒序；带项目筛选时走这个复合索引
    ("tasks", "ix_tasks_project_created", ["project_id", "created_at"]),
    # 草稿/片段统计的两个 JOIN 条件
    ("annotation_records", "ix_ann_records_task_round", ["task_id", "round_no"]),
    ("annotation_label_items", "ix_ann_items_record", ["annotation_record_id"]),
    ("annotation_label_items", "ix_ann_items_label", ["label_id"]),
    ("review_records", "ix_review_records_task_round", ["task_id", "round_no"]),
    # 皮肤联动/训练集导出按日期范围捞样本
    ("samples", "ix_samples_session_date", ["session_date"]),
    ("samples", "ix_samples_dog_id", ["dog_id"]),
]


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    tables = set(insp.get_table_names())
    for table, name, cols in _INDEXES:
        if table not in tables:
            continue
        existing = {i["name"] for i in insp.get_indexes(table)}
        if name in existing:
            continue
        op.create_index(name, table, cols)


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    tables = set(insp.get_table_names())
    for table, name, _cols in reversed(_INDEXES):
        if table not in tables:
            continue
        if name in {i["name"] for i in insp.get_indexes(table)}:
            op.drop_index(name, table_name=table)
