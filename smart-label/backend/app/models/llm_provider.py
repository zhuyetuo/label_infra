from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class LlmProvider(Base):
    """
    大模型 API 的配置：一家一行（anthropic / openai / doubao / gemini）。

    key 存在这里而不是服务器环境变量：换 key、加一家、试一个新模型都是业务上
    随时会发生的事，不该每次都要人 ssh 上去改 .env 再重启。视觉服务那边不存 key，
    每次「画面找片段」平台把这一行带过去（局域网内）。

    key **只写不读**：接口只返回"配没配"和末四位，没有任何路径能把整串拿回来。
    models 是 JSON 列表 [{name, price_in, price_out}]，价格是 $/百万 token，
    只用来估花费（数量级），账以各家后台为准。
    """

    __tablename__ = "llm_providers"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    provider: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(50), nullable=False)
    api_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    base_url: Mapped[str | None] = mapped_column(String(300), nullable=True)
    models: Mapped[str] = mapped_column(Text, nullable=False, default="[]", comment="JSON [{name, price_in, price_out}]")
    default_model: Mapped[str | None] = mapped_column(String(100), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    updated_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
