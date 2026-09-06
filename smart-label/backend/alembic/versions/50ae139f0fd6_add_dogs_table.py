"""add dogs table, convert samples.dog_id to FK

Revision ID: 50ae139f0fd6
Revises: ddb287164f5a
Create Date: 2026-09-06

狗的档案表。samples.dog_id 原来是个自由文本字符串（一直没有任何代码路径真正
写过它，采集端文件名里目前也没带这个信息），改成指向 dogs.id 的外键，
配合以后文件名带上 dog 编号时自动建档/关联（见 sample_import_service.py）。

为了不假设"现在肯定没有数据"，迁移时把 samples.dog_id 里已有的字符串值当作
dog_code 迁进 dogs 表，再把 samples.dog_id 换成指向对应 dogs.id 的整数外键，
没有 dog_id 的样本继续留空。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '50ae139f0fd6'
down_revision = 'ddb287164f5a'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'dogs',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('dog_code', sa.String(length=64), nullable=False),
        sa.Column('name', sa.String(length=100), nullable=True),
        sa.Column('breed', sa.String(length=100), nullable=True),
        sa.Column('remark', sa.String(length=500), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('dog_code'),
    )

    conn = op.get_bind()

    # 把 samples.dog_id 里已有的字符串值（如果有）迁进 dogs 表，一个值建一条档案
    existing_codes = [
        row[0]
        for row in conn.execute(
            sa.text("SELECT DISTINCT dog_id FROM samples WHERE dog_id IS NOT NULL AND dog_id <> ''")
        )
    ]
    for code in existing_codes:
        conn.execute(sa.text("INSERT INTO dogs (dog_code) VALUES (:code)"), {"code": code})

    # samples.dog_id 换成整数外键列：先加临时列、按 dog_code 回填、删旧列、改名
    op.add_column('samples', sa.Column('dog_id_new', sa.BigInteger(), nullable=True))
    if existing_codes:
        conn.execute(
            sa.text(
                "UPDATE samples s JOIN dogs d ON d.dog_code = s.dog_id "
                "SET s.dog_id_new = d.id WHERE s.dog_id IS NOT NULL AND s.dog_id <> ''"
            )
        )
    op.drop_column('samples', 'dog_id')
    op.alter_column('samples', 'dog_id_new', new_column_name='dog_id')
    op.create_foreign_key('fk_samples_dog_id_dogs', 'samples', 'dogs', ['dog_id'], ['id'])


def downgrade() -> None:
    op.drop_constraint('fk_samples_dog_id_dogs', 'samples', type_='foreignkey')
    op.add_column('samples', sa.Column('dog_id_str', sa.String(length=64), nullable=True))
    conn = op.get_bind()
    conn.execute(
        sa.text(
            "UPDATE samples s JOIN dogs d ON d.id = s.dog_id "
            "SET s.dog_id_str = d.dog_code WHERE s.dog_id IS NOT NULL"
        )
    )
    op.drop_column('samples', 'dog_id')
    op.alter_column('samples', 'dog_id_str', new_column_name='dog_id')
    op.drop_table('dogs')
