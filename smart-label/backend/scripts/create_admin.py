"""
一次性创建首个管理员账号，部署时手动运行一次，不经过 Web 界面（决策⑥）。

用法：
    cd smart-label/backend
    python -m scripts.create_admin
"""

import asyncio
import getpass
import sys

sys.path.insert(0, ".")

from sqlalchemy import select  # noqa: E402

from app.core.security import hash_password  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.models.user import User, UserRole  # noqa: E402


async def main() -> None:
    username = input("管理员用户名: ").strip()
    display_name = input("显示名: ").strip() or username
    password = getpass.getpass("密码: ")
    confirm = getpass.getpass("确认密码: ")
    if password != confirm:
        print("两次密码不一致，退出。")
        return
    if len(password) < 8:
        print("密码至少8位，退出。")
        return

    async with SessionLocal() as db:
        exists = await db.execute(select(User).where(User.username == username))
        if exists.scalar_one_or_none() is not None:
            print(f"用户名 {username} 已存在，退出。")
            return

        user = User(
            username=username,
            display_name=display_name,
            role=UserRole.admin,
            password_hash=hash_password(password),
            must_change_password=False,
        )
        db.add(user)
        await db.commit()
        print(f"✅ 管理员账号 {username} 创建成功。")


if __name__ == "__main__":
    asyncio.run(main())
