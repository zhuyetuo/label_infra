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

## 启动方式（二选一）

### 方式一：Docker Compose（推荐）

```bash
cd deploy
cp .env.example .env   # 改数据库密码/JWT密钥/NAS路径
docker compose up -d --build

# 首次启动，进容器建表（本地生成迁移脚本后提交进仓库，不要每台机器各自生成一份）
docker compose exec api alembic revision --autogenerate -m "init"
docker compose exec api alembic upgrade head
```

三个容器：`mysql`（数据库）、`api`（FastAPI，映射到宿主机 8283）、`scheduler`（超时回收定时任务，单实例，不要 `docker compose up --scale scheduler=2`）。

访问 `http://<服务器IP>:8283/docs` 查看 API 文档。首次用 `/api/v1/auth/bootstrap-admin` 创建管理员账号（仅数据库无用户时可调用一次）。

停止：`docker compose down`（数据保留在 `mysql_data` volume 里，不会丢）。

### 方式二：本地直接跑（开发调试用）

```bash
cd backend
cp .env.example .env   # 改数据库密码/JWT密钥，需要本地已有MySQL

python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

alembic revision --autogenerate -m "init"   # 首次生成迁移脚本
alembic upgrade head

python -m scripts.create_admin   # 或用 /auth/bootstrap-admin 接口

uvicorn app.main:app --reload --port 8283

# 另开一个终端，跑超时回收定时任务（必须单实例，不要和uvicorn多worker混用）
python -m app.workers.scheduler
```
