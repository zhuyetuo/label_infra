import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from app.api.v1.router import api_router
from app.core.config import settings
from app.core.logging_setup import setup_logging

setup_logging("api")
logger = logging.getLogger("smart-label")


async def _seed_builtin_templates():
    """内置的「抓/舔/啃/蹭」标签模板：没有就建，有了不碰。

    库还没起来 / 还没建管理员时不能让 API 起不来——记一条日志，下次重启再试。
    """
    from app.db.session import SessionLocal
    from app.services import label_tree
    from app.services.grooming_labels import TEMPLATE_NAME, ensure_grooming_template

    try:
        async with SessionLocal() as db:
            result = await ensure_grooming_template(db)
            # 老项目按模板套过的标签还没挂父子关系：按模板条目的 parent_code 补上
            linked = await label_tree.link_from_templates(db)
            if linked:
                await db.commit()
                logger.info("按模板给 %d 条项目标签补上了上级", linked)
        if result == "created":
            logger.info("内置标签模板「%s」已建好", TEMPLATE_NAME)
        elif result == "updated":
            logger.info("内置标签模板「%s」补上了新加的组 / 换了新配色", TEMPLATE_NAME)
        elif result == "no_admin":
            logger.warning("还没有管理员账号，内置标签模板「%s」这次没建，下次启动再试", TEMPLATE_NAME)
    except Exception:  # noqa: BLE001
        logger.exception("建内置标签模板「%s」失败，跳过", TEMPLATE_NAME)


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    await _seed_builtin_templates()
    yield


app = FastAPI(title="smart-label", version="0.1.0", lifespan=_lifespan)

app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    # 统一成 {code, msg, data} 响应体，与前端 request.ts 约定一致
    return JSONResponse(status_code=exc.status_code, content={"code": exc.status_code, "msg": exc.detail, "data": None})


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    # 兜底：任何没被显式捕获的异常都记录完整堆栈到日志（logs/smart-label/api.log 或 docker compose logs api），
    # 响应体只给出类名，不把内部细节暴露给前端
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"code": 500, "msg": f"服务器内部错误: {type(exc).__name__}", "data": None},
    )


@app.get("/health")
async def health():
    return {"status": "ok"}


app.include_router(api_router)
