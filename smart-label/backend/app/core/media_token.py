"""
<video>/<img> 等标签无法自定义请求头，只能把一个专用短期 token 拼在 URL query 里。
这个 token 权限比 access token 小很多：只绑定单个 file_id，不能做任何写操作，
纯本地验签（HMAC，不查库），4小时过期。用户权限校验在签发时（/media/{id}/token）
已经做过一次（当前实现见 api/v1/media.py 的 TODO），token 本身不再重复携带 user_id。
"""

import hashlib
import hmac
import time

from app.core.config import settings


def issue_media_token(file_id: int) -> str:
    expires_at = int(time.time()) + settings.media_token_ttl_hours * 3600
    payload = f"{file_id}.{expires_at}"
    sig = hmac.new(settings.jwt_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{expires_at}.{sig}"


def verify_media_token(file_id: int, token: str) -> bool:
    try:
        expires_at_str, sig = token.split(".", 1)
        expires_at = int(expires_at_str)
    except (ValueError, AttributeError):
        return False
    if expires_at < int(time.time()):
        return False
    payload = f"{file_id}.{expires_at}"
    expected = hmac.new(settings.jwt_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]
    return hmac.compare_digest(expected, sig)
