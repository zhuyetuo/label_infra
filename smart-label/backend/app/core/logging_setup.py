"""
日志同时写终端（docker compose logs 还能看）和文件。文件在 settings.log_dir 下，
容器里是 /app/logs，docker-compose 把它挂到仓库根目录 logs/smart-label/，宿主机
直接 tail 就行：
  api.log        后端业务日志：AI 预标注批次、训练任务、algo_service 调用、未捕获异常堆栈
  access.log     uvicorn 的 HTTP 访问日志（谁什么时候调了什么接口、状态码）
  scheduler.log  定时任务：超时回收、NAS 自动扫描
按天切、各留 14 天，文件名带日期后缀。
"""

import logging
import logging.handlers
import os

from app.core.config import settings

_FMT = "%(asctime)s %(levelname)s %(name)s: %(message)s"


def _file_handler(name: str) -> logging.Handler:
    os.makedirs(settings.log_dir, exist_ok=True)
    h = logging.handlers.TimedRotatingFileHandler(
        os.path.join(settings.log_dir, name), when="midnight", backupCount=14, encoding="utf-8"
    )
    h.setFormatter(logging.Formatter(_FMT))
    return h


def setup_logging(process: str) -> None:
    """process: "api" / "scheduler"，决定业务日志写哪个文件"""
    root = logging.getLogger()
    if getattr(root, "_smart_label_configured", False):
        return
    root.setLevel(logging.INFO)
    stream = logging.StreamHandler()
    stream.setFormatter(logging.Formatter(_FMT))
    root.addHandler(stream)
    root.addHandler(_file_handler(f"{process}.log"))
    if process == "api":
        # 访问日志单独一个文件，不跟业务日志混；uvicorn 自己往终端打，这里只追加文件
        logging.getLogger("uvicorn.access").addHandler(_file_handler("access.log"))
    # httpx 每发一个请求打一条 INFO（"HTTP Request: GET …/embed/status 200 OK"），项目页轮询
    # 索引进度、监控页探服务都会刷屏，真正要看的日志被淹掉。出错时调用方自己会记
    logging.getLogger("httpx").setLevel(logging.WARNING)
    root._smart_label_configured = True  # type: ignore[attr-defined]
