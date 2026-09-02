# smart-label

自建多模态标注平台（React + FastAPI + MySQL），替代 Label Studio。架构设计见 [`docs/architecture-proposal.md`](docs/architecture-proposal.md)。

## 当前进度

- [x] 架构设计（数据库/权限/文件流/IMU降采样/同步引擎评审），全部18项开放问题已收口
- [x] 后端骨架：数据库模型、JWT认证、用户管理、标签管理、Range流式媒体代理
- [x] 首个管理员：Web端 `/auth/bootstrap-admin`（仅数据库无用户时可调用一次）
- [x] 任务认领/心跳/草稿/提交 API + 超时自动回收定时任务（`app/workers/scheduler.py`）
- [x] 审核认领/通过/驳回 API（驳回后草稿自动拷贝到新一轮，不用重标）
- [x] 样本导入：扫描 NAS `data_raw/` 按会话分组3路视频+CSV（`POST /samples/import-scan`）+ 手动建任务（`POST /tasks`）
- [x] 测试用前端（React + TS + Vite + Ant Design）：登录/首个管理员引导、标签管理、样本导入、
      任务列表/新建/认领/草稿编辑/提交、审核队列/认领/通过驳回、账号管理。已在沙箱内用 Playwright
      跑通完整闭环截图验证。**这不是最终的视频+IMU标注界面**，只是让核心业务流程能点着测，
      不用再手写curl/Swagger
- [ ] IMU LTTB 降采样服务（`app/api/v1/imu.py`，TODO）
- [ ] Clip 切片异步队列 + SSE 通知（`app/api/v1/clips.py`，TODO）
- [ ] 统计看板（`app/api/v1/dashboard.py`，TODO）
- [ ] 正式标注界面：3路视频+IMU曲线双向同步引擎（架构文档已评审出方案，待实现）

## 启动方式（二选一）

### 方式一：Docker Compose（推荐）

```bash
cd deploy
cp .env.example .env   # 改数据库密码/JWT密钥/NAS路径
bash up.sh             # 等价于 docker compose up -d --build，跑完会打印访问地址
```

建表和后续的表结构升级都由 `migrate` 容器自动完成（`alembic upgrade head`），
`api` 和 `scheduler` 会等它跑成功再启动，所以**不需要手动执行迁移**，
每次 `git pull` 之后直接 `bash up.sh` 就行。

容器：`mysql`（数据库）、`migrate`（一次性，跑数据库迁移，跑完就退出）、`api`（FastAPI，映射宿主机 8283）、`scheduler`（超时回收定时任务，单实例，不要 `docker compose up --scale scheduler=2`）、`frontend`（映射宿主机 8284）。

访问 `http://<服务器IP>:8284` 打开测试用前端页面，首次会引导创建管理员账号。API 文档在 `http://<服务器IP>:8283/docs`。

如果页面上冒出 `服务器内部错误: ProgrammingError / OperationalError`，基本都是表结构比代码旧
（少了新加的表或字段）。先看迁移容器日志，再手动补跑一次：
```bash
docker compose logs migrate
docker compose exec api alembic current   # 看当前版本
docker compose run --rm migrate           # 手动补跑迁移
```

如果数据库版本记录跟迁移脚本对不上（比如之前手动生成过迁移文件但没提交），跑：
```bash
docker compose exec api alembic stamp --purge head
```

停止：`docker compose down`（数据保留在 `mysql_data` volume 里，不会丢）。

### 方式二：本地直接跑（开发调试用）

```bash
cd backend
cp .env.example .env   # 改数据库密码/JWT密钥，需要本地已有MySQL

python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

alembic upgrade head   # 迁移脚本已提交进仓库，直接建表

python -m scripts.create_admin   # 或用 /auth/bootstrap-admin 接口

uvicorn app.main:app --reload --port 8283

# 另开一个终端，跑超时回收定时任务（必须单实例，不要和uvicorn多worker混用）
python -m app.workers.scheduler
```

### 前端单独跑（不用docker，开发调试用）

```bash
cd frontend
npm install
npm run dev   # 默认代理 /api 到 http://localhost:8283，见 vite.config.ts
```

访问 `http://localhost:8284`。
