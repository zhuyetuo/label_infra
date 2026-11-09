"""每个账号现在的密码，加密存一份给超级管理员看（内部平台，牵头人要求能看到所有人的密码）。

新建、重置、本人改密码、初始化管理员，都会更新这一份；登录校验仍然只用 password_hash。
用 jwt_secret 派生的密钥加密，库里不是明文；但拿到库 + jwt_secret 就能解开，
所以 .env 里的 JWT_SECRET 和数据库备份要一起保管好。换了 jwt_secret 以后旧的解不开，
显示成看不到，重置一次就有了。
"""
from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings


def _f() -> Fernet:
    key = hashlib.sha256(("temp-password:" + settings.jwt_secret).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def seal(pw: str) -> str:
    return _f().encrypt(pw.encode()).decode()


def unseal(token: str | None) -> str | None:
    if not token:
        return None
    try:
        return _f().decrypt(token.encode()).decode()
    except InvalidToken:  # 换过 jwt_secret：解不开就当没有
        return None
