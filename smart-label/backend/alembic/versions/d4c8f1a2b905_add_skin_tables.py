"""add skin_records / skin_weekly_rows

Revision ID: d4c8f1a2b905
Revises: b7d2e9a04c31
Create Date: 2026-09-07

「皮肤评估」页（React 重写 pm_skin_scoring 那个 Gradio）的两张表：问卷记录
（对应 records.csv）和周报表行（对应 weekly_report.csv，36 列存 JSON）。分值由
imu_train/label_service 按 PM 规则算，这里只存结果。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'd4c8f1a2b905'
down_revision = 'b7d2e9a04c31'
branch_labels = None
depends_on = None


def _has_table(conn, name: str) -> bool:
    return name in sa.inspect(conn).get_table_names()


def upgrade() -> None:
    conn = op.get_bind()
    if not _has_table(conn, 'skin_records'):
        op.create_table(
            'skin_records',
            sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column('dog_name', sa.String(length=100), nullable=False),
            sa.Column('dog_id', sa.BigInteger(), nullable=True),
            sa.Column('fill_date', sa.Date(), nullable=False),
            sa.Column('filler', sa.String(length=50), nullable=False),
            sa.Column('imu', sa.String(length=20), nullable=True),
            sa.Column('has_hair_loss', sa.String(length=2), nullable=True),
            sa.Column('color', sa.String(length=2), nullable=True),
            sa.Column('odor', sa.String(length=2), nullable=True),
            sa.Column('lesion', sa.String(length=2), nullable=True),
            sa.Column('hair_spot', sa.String(length=2), nullable=True),
            sa.Column('hair_diameter', sa.String(length=2), nullable=True),
            sa.Column('coat', sa.String(length=2), nullable=True),
            sa.Column('q_score', sa.Float(), nullable=True),
            sa.Column('c_value', sa.Float(), nullable=True),
            sa.Column('c_tier', sa.String(length=4), nullable=True),
            sa.Column('s_total', sa.Float(), nullable=True),
            sa.Column('s_tier', sa.String(length=4), nullable=True),
            sa.Column('c_inputs', sa.Text(), nullable=True),
            sa.Column('created_by', sa.BigInteger(), nullable=False),
            sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('dog_name', 'fill_date', 'filler', name='uq_skin_record_dog_date_filler'),
            sa.ForeignKeyConstraint(['dog_id'], ['dogs.id']),
            sa.ForeignKeyConstraint(['created_by'], ['users.id']),
        )
    if not _has_table(conn, 'skin_weekly_rows'):
        op.create_table(
            'skin_weekly_rows',
            sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column('imu', sa.String(length=20), nullable=False),
            sa.Column('dog_name', sa.String(length=100), nullable=True),
            sa.Column('report_date', sa.String(length=20), nullable=False),
            sa.Column('data', sa.Text(), nullable=False),
            sa.Column('created_by', sa.BigInteger(), nullable=False),
            sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('imu', 'report_date', name='uq_skin_weekly_imu_date'),
            sa.ForeignKeyConstraint(['created_by'], ['users.id']),
        )


def downgrade() -> None:
    op.drop_table('skin_weekly_rows')
    op.drop_table('skin_records')
