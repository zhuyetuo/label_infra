"""
手写 HTTP Range / 206 Partial Content 分段流式响应。
这是 label-studio 排查里验证过 nginx 能正确处理（curl -H "Range:..." 返回206）的同一套语义，
迁到 FastAPI 自己实现，保证长视频拖动进度条不需要整段下载。
"""

import os
import re

import aiofiles
from fastapi import Request
from fastapi.responses import Response, StreamingResponse

CHUNK_SIZE = 1024 * 1024  # 1MB
# 视频 / 音频每次 Range 最多回这么多，剩下的让浏览器接着要。
#
# 为什么：<video> 第一次请求是 `bytes=0-`（从头到尾），以前照单全收、把几百 MB 的整个文件
# 顺着这一条连接一直往下推，推完之前这条连接一直占着。浏览器对同一个网站只开 6 条连接（HTTP/1.1），
# 三路视频就占掉三条，再加上拖进度条时新开的请求，后面「保存起止」、系统监控这些接口全在浏览器里
# 排队——人看着整个平台卡死，服务器日志里却一条慢请求都没有（2026-11-12）。
# 每次只回 4MB：一条请求几十毫秒就结束、连接马上空出来，浏览器缓冲不够了自己会接着要下一段。
MEDIA_RANGE_CAP = 4 * 1024 * 1024


def _parse_range(range_header: str, file_size: int) -> tuple[int, int] | None:
    match = re.match(r"bytes=(\d*)-(\d*)", range_header or "")
    if not match:
        return None
    start_str, end_str = match.groups()
    if start_str == "" and end_str == "":
        return None
    if start_str == "":
        # bytes=-500  最后500字节
        length = int(end_str)
        start = max(file_size - length, 0)
        end = file_size - 1
    else:
        start = int(start_str)
        end = int(end_str) if end_str else file_size - 1
    end = min(end, file_size - 1)
    if start > end or start < 0:
        return None
    return start, end


async def _iter_file_range(path: str, start: int, end: int):
    async with aiofiles.open(path, "rb") as f:
        await f.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            read_size = min(CHUNK_SIZE, remaining)
            chunk = await f.read(read_size)
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


async def stream_file(request: Request, path: str, content_type: str) -> Response:
    if not os.path.isfile(path):
        return Response(status_code=404, content="file not found")

    file_size = os.path.getsize(path)
    range_header = request.headers.get("range")

    if range_header:
        parsed = _parse_range(range_header, file_size)
        if parsed is None:
            return Response(
                status_code=416,
                headers={"Content-Range": f"bytes */{file_size}"},
            )
        start, end = parsed
        if content_type.startswith(("video/", "audio/")):
            # 规范允许回得比要的少（Content-Range 写清实际范围），播放器都认
            end = min(end, start + MEDIA_RANGE_CAP - 1)
        headers = {
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(end - start + 1),
            "Cache-Control": "private, max-age=3600",
        }
        return StreamingResponse(
            _iter_file_range(path, start, end),
            status_code=206,
            media_type=content_type,
            headers=headers,
        )

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(file_size),
        "Cache-Control": "private, max-age=3600",
    }
    return StreamingResponse(
        _iter_file_range(path, 0, file_size - 1),
        status_code=200,
        media_type=content_type,
        headers=headers,
    )
