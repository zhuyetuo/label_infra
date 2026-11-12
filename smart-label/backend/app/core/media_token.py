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


#: token 里带的身份（隐私遮罩用，见 services/privacy_mask.py）：
#:   ""  普通人：开了遮罩的项目只给遮罩版
#:   "s" 超级管理员：给原版
#:   "m" 超级管理员想看看遮罩效果：有遮罩版就给遮罩版
#: <video>/<img> 拿不到 user，只能在签发时把这个决定签进 token 里。
VARIANTS = ("", "s", "m")


def _sig(payload: str) -> str:
    return hmac.new(settings.jwt_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]


def issue_media_token(file_id: int, variant: str = "") -> str:
    if variant not in VARIANTS:
        raise ValueError(f"未知 token 类型：{variant}")
    expires_at = int(time.time()) + settings.media_token_ttl_hours * 3600
    if not variant:
        return f"{expires_at}.{_sig(f'{file_id}.{expires_at}')}"
    return f"{expires_at}.{variant}.{_sig(f'{file_id}.{expires_at}.{variant}')}"


def media_token_variant(file_id: int, token: str) -> str | None:
    """验签，返回 token 的身份（"" / "s" / "m"）；无效或过期返回 None。"""
    try:
        parts = token.split(".")
        if len(parts) == 2:
            exp_s, sig = parts
            variant = ""
        elif len(parts) == 3:
            exp_s, variant, sig = parts
            if variant not in VARIANTS or not variant:
                return None
        else:
            return None
        expires_at = int(exp_s)
    except (ValueError, AttributeError):
        return None
    if expires_at < int(time.time()):
        return None
    payload = f"{file_id}.{expires_at}" + (f".{variant}" if variant else "")
    return variant if hmac.compare_digest(_sig(payload), sig) else None


def verify_media_token(file_id: int, token: str) -> bool:
    return media_token_variant(file_id, token) is not None


def variant_for(user, want_mask: bool = False) -> str:
    """签发时按人定身份：超级管理员给 s（想看遮罩效果给 m），其他人给空。"""
    from app.models.user import UserRole

    if user is not None and user.role == UserRole.super_admin:
        return "m" if want_mask else "s"
    return ""
