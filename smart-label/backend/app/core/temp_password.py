"""系统发出去的临时密码（新建账号 / 重置密码），加密存一份给超级管理员回看。

为什么只存临时密码、不存本人的密码：
  · 本人自己设的密码，人们常常在别处也用同一个（邮箱、网银）。库或备份一旦泄露，
    明文（或者能解开的）密码会连带把那些账号一起交出去，所以本人的密码只存不可逆的哈希，谁都看不到；
  · 临时密码是系统随机生成的、别处不会用，又本来就是要转交出去的。存下来让超级管理员
    能再拿出来（比如当时忘了复制、对方说没收到），风险很小。
本人一改密码（第一次登录会被强制改），这份临时密码就清掉。

用 jwt_secret 派生的密钥加密，库里不是明文。
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
