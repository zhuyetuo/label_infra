# smart-label

自建多模态标注平台（React + FastAPI + MySQL），替代 Label Studio。架构设计见 [`docs/architecture-proposal.md`](docs/architecture-proposal.md)。

## 当前进度

- [x] 架构设计（数据库/权限/文件流/IMU降采样/同步引擎评审），全部18项开放问题已收口
- [x] 后端骨架：数据库模型、JWT认证、用户管理、标签管理、Range流式媒体代理
- [x] 首个管理员：Web端 `/auth/bootstrap-admin`（仅数据库无用户时可调用一次）
- [x] 任务认领/心跳/草稿/提交 API + 超时自动回收定时任务（`app/workers/scheduler.py`）
- [x] 审核认领/通过/驳回 API（驳回后草稿自动拷贝到新一轮，不用重标）
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
# 或者：起服务后调用 POST /api/v1/auth/bootstrap-admin（仅数据库无用户时可用一次）

uvicorn app.main:app --reload --port 8283

# 另开一个终端，跑超时回收定时任务（必须单实例，不要和uvicorn多worker混用）
python -m app.workers.scheduler
```

访问 `http://localhost:8283/docs` 查看 API 文档。
