"""ai_candidates.decided_at 时区修正：片段审核写的是库本地时间，统一改回 UTC

人力管理页「最后一次」出现未来时间（今天 15:39 显示成 23:39，甚至跨到第二天），
是因为两处写 decided_at 的时区不一致：
- 工作台（api/v1/candidates.py）写 UTC，读的时候统一 +8，显示正确；
- 片段审核（api/v1/segment_review.py 剔除/去重候选）写的是库本地时间，再 +8 就晚了 8 小时。

写库那头已经在代码里改成 UTC。这里把历史上按本地时间写进去的记录减 8 小时。
判定依据（都核对过当天数据）：
- 11-07 / 11-13 / 11-16 这三天没有 confirmed 记录，说明只用过片段审核，全部是本地时间；
- 11-05 ~ 11-12 混合使用的日子里，同一秒出现多条的是「一键去重」批量剔除（本地时间），
  单独一条的是工作台里逐个排除（UTC），不动。

Revision ID: d4e9b2c7a1f5
Revises: b7d4c2a9e6f1
"""

from alembic import op

revision = "d4e9b2c7a1f5"
down_revision = "b7d4c2a9e6f1"
branch_labels = None
depends_on = None


_WHERE = """
    status <> 'confirmed'
    AND decided_at IS NOT NULL
    AND (
        decided_at >= '2026-11-13 00:00:00'
        OR (decided_at >= '2026-11-07 00:00:00' AND decided_at < '2026-11-08 00:00:00')
        OR decided_at IN (
            SELECT decided_at FROM (
                SELECT decided_at FROM ai_candidates
                WHERE decided_at >= '2026-11-05 00:00:00'
                  AND decided_at < '2026-11-13 00:00:00'
                  AND status <> 'confirmed'
                  AND decided_at IS NOT NULL
                GROUP BY decided_at
                HAVING COUNT(*) > 1
            ) AS batched
        )
    )
"""


def upgrade() -> None:
    op.execute(f"UPDATE ai_candidates SET decided_at = decided_at - INTERVAL 8 HOUR WHERE {_WHERE}")


def downgrade() -> None:
    # 已经按同一批条件挪到 UTC 的，加回 8 小时；之后新写入的都是 UTC，不在此列
    op.execute(f"UPDATE ai_candidates SET decided_at = decided_at + INTERVAL 8 HOUR WHERE {_WHERE}")
