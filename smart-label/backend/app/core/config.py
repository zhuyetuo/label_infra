from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- 数据库 ---
    mysql_dsn: str = "mysql+asyncmy://smart_label:smart_label@127.0.0.1:3306/smart_label"

    # --- NAS ---
    # 所有原始/标注/切片文件的根目录，数据库里只存相对这个根目录的相对路径
    nas_root: str = "/home/toky/ai_data"

    # --- JWT ---
    jwt_secret: str = "CHANGE_ME_IN_PRODUCTION"
    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = 30
    refresh_token_ttl_days: int = 14
    media_token_ttl_hours: int = 4

    # --- 任务超时回收 ---
    annotation_timeout_hours: int = 48
    review_timeout_hours: int = 24
    heartbeat_interval_minutes: int = 30

    # --- 同步引擎 ---
    video_sync_tolerance_ms: int = 100

    # --- 服务端口 ---
    backend_port: int = 8283
    frontend_port: int = 8284

    # --- algo_service（独立部署，通过HTTP调用，不合并进本仓库）---
    # docker-compose 里跟连 MySQL 用服务名当 hostname 是一回事；algo_service
    # 和这个后端共享同一份 nas_root，接口里只传相对路径，不传文件内容
    algo_service_url: str = "http://algo-service:8000"
    algo_service_timeout_sec: int = 30

    # --- CORS ---
    cors_allow_origins: list[str] = ["http://localhost:8284"]


settings = Settings()
