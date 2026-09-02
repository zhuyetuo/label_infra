"""add projects; scope tasks and labels to a project

Revision ID: b3d51a90c7e2
Revises: eafeecd9f7a7
Create Date: 2026-09-03

同一批数据在不同业务场景下要标的东西不一样，所以引入项目：任务和标签都挂到
项目下。已有数据不能丢，这里建一个"默认项目"把存量任务/标签全部归进去，再把
project_id 收紧成 NOT NULL。
"""

import sqlalchemy as sa
from alembic import op

revision = "b3d51a90c7e2"
down_revision = "eafeecd9f7a7"
branch_labels = None
depends_on = None

DEFAULT_PROJECT_NAME = "默认项目"


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("description", sa.String(length=500), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.Column("created_by", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=True),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )

    # 先允许为空，回填之后再收紧
    op.add_column("tasks", sa.Column("project_id", sa.BigInteger(), nullable=True))
    op.add_column("label_definitions", sa.Column("project_id", sa.BigInteger(), nullable=True))

    conn = op.get_bind()
    has_legacy = conn.execute(
        sa.text("SELECT (SELECT COUNT(*) FROM tasks) + (SELECT COUNT(*) FROM label_definitions)")
    ).scalar()

    if has_legacy:
        # created_by 挂到最早的管理员身上；没有管理员就退而取任意用户
        owner_id = conn.execute(
            sa.text("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
        ).scalar()
        if owner_id is None:
            owner_id = conn.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()

        if owner_id is not None:
            conn.execute(
                sa.text(
                    "INSERT INTO projects (name, description, is_active, created_by) "
                    "VALUES (:name, :desc, 1, :owner)"
                ),
                {
                    "name": DEFAULT_PROJECT_NAME,
                    "desc": "引入项目功能前已有的任务和标签，自动归入这个项目",
                    "owner": owner_id,
                },
            )
            project_id = conn.execute(
                sa.text("SELECT id FROM projects WHERE name = :name"), {"name": DEFAULT_PROJECT_NAME}
            ).scalar()
            conn.execute(sa.text("UPDATE tasks SET project_id = :pid"), {"pid": project_id})
            conn.execute(sa.text("UPDATE label_definitions SET project_id = :pid"), {"pid": project_id})

    # 没有存量数据（全新库）时不会有孤儿行，可以直接收紧
    op.alter_column("tasks", "project_id", existing_type=sa.BigInteger(), nullable=False)
    op.alter_column("label_definitions", "project_id", existing_type=sa.BigInteger(), nullable=False)

    op.create_index("ix_tasks_project_id", "tasks", ["project_id"])
    op.create_foreign_key("fk_tasks_project", "tasks", "projects", ["project_id"], ["id"])
    op.create_index("ix_label_definitions_project_id", "label_definitions", ["project_id"])
    op.create_foreign_key("fk_labels_project", "label_definitions", "projects", ["project_id"], ["id"])

    # code 改成项目内唯一
    op.drop_constraint("code", "label_definitions", type_="unique")
    op.create_unique_constraint("uq_label_project_code", "label_definitions", ["project_id", "code"])


def downgrade() -> None:
    op.drop_constraint("uq_label_project_code", "label_definitions", type_="unique")
    op.create_unique_constraint("code", "label_definitions", ["code"])

    op.drop_constraint("fk_labels_project", "label_definitions", type_="foreignkey")
    op.drop_index("ix_label_definitions_project_id", table_name="label_definitions")
    op.drop_constraint("fk_tasks_project", "tasks", type_="foreignkey")
    op.drop_index("ix_tasks_project_id", table_name="tasks")

    op.drop_column("label_definitions", "project_id")
    op.drop_column("tasks", "project_id")
    op.drop_table("projects")
