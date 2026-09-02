# smart-label

自建多模态标注平台（React + FastAPI + MySQL），替代 Label Studio。架构设计见 [`docs/architecture-proposal.md`](docs/architecture-proposal.md)。

## 当前进度

- [x] 架构设计（数据库/权限/文件流/IMU降采样/同步引擎评审），全部18项开放问题已收口
- [x] 后端骨架：数据库模型、JWT认证、用户管理、标签管理、Range流式媒体代理
- [ ] 任务认领/心跳/草稿/提交 API（`app/api/v1/tasks.py`，TODO）
- [ ] 审核流程 API（`app/api/v1/reviews.py`，TODO）
- [ ] IMU LTTB 降采样服务（`app/api/v1/imu.py`，TODO）
- [ ] Clip 切片异步队列 + SSE 通知（`app/api/v1/clips.py`，TODO）
- [ ] 统计看板（`app/api/v1/dashboard.py`，TODO）
- [ ] 前端（React + TS + uPlot + 同步引擎）

## 后端本地启动

```bash
cd backend
cp .env.example .env   # 改数据库密码/JWT密钥

python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

# 首次建表（正式环境用 alembic migration，这里先用于本地快速起步）
alembic upgrade head    # 需要先 alembic revision --autogenerate -m "init"

# 创建首个管理员账号
python -m scripts.create_admin

uvicorn app.main:app --reload --port 8283
```

访问 `http://localhost:8283/docs` 查看 API 文档。
