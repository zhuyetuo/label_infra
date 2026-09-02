import os

from app.core.config import settings


class PathTraversalError(Exception):
    pass


def resolve_nas_path(relative_path: str) -> str:
    """
    数据库里的相对路径 -> NAS 上的真实绝对路径，带路径穿越二次校验。
    relative_path 本身应该只由后端自己写入（导入脚本/AI落盘），不接受前端直接传入拼接。
    """
    nas_root = os.path.realpath(settings.nas_root)
    candidate = os.path.realpath(os.path.join(nas_root, relative_path))
    if not (candidate == nas_root or candidate.startswith(nas_root + os.sep)):
        raise PathTraversalError(f"路径越界: {relative_path}")
    return candidate
