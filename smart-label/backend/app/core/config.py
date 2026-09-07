from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- 数据库 ---
    mysql_dsn: str = "mysql+asyncmy://smart_label:smart_label@127.0.0.1:3306/smart_label"
    # 连接池：SQLAlchemy 默认 5+10 太小——批量预标注、批量导出这些后台任务本身要占
    # 连接，用的人多几个就会把池子耗光，然后所有请求（包括登录）一起 503。
    # MySQL 默认 max_connections=151，这里 20+30 留足余量
    db_pool_size: int = 20
    db_max_overflow: int = 30
    db_pool_timeout_sec: int = 10

    # --- NAS ---
    # 所有原始/标注/切片文件的根目录，数据库里只存相对这个根目录的相对路径
    nas_root: str = "/home/toky/ai_data"
    # nas_root 下的子目录名：原始数据只读；AI 预标注 JSON 单独放一棵树，不跟原始数据混
    data_raw_dir: str = "data_raw"
    ai_label_dir: str = "data_labeled_ai"

    # --- 算法任务素材库（另一个 NAS 共享，只读）---
    # 牙齿/口腔照片在 material_root/oral_dir/{YYYY-MM-DD-ok}/{狗名}/*.jpg，docker-compose
    # 把它跟 nas_root 一样按同路径挂进容器；imu_train/label_service 的 MATERIAL_ROOT 指同一目录
    material_root: str = "/home/toky/alg_material"
    oral_dir: str = "口腔验证"
    # 皮肤瘙痒问诊照片，目录结构跟口腔一样（{日期-ok}/{狗}/*.jpg）
    skin_photo_dir: str = "颈圈算法验证/皮肤瘙痒/视频问诊"

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

    # --- 日志 ---
    # 日志文件目录（容器里 /app/logs，docker-compose 挂到仓库根目录 logs/smart-label/），见 core/logging_setup.py
    log_dir: str = "logs"

    # --- 服务端口 ---
    backend_port: int = 8283
    frontend_port: int = 8284

    # --- algo_service（独立部署，通过HTTP调用，不合并进本仓库）---
    # docker-compose 里跟连 MySQL 用服务名当 hostname 是一回事；algo_service
    # 和这个后端共享同一份 nas_root，接口里只传相对路径，不传文件内容
    algo_service_url: str = "http://192.168.2.140:8383"
    algo_service_timeout_sec: int = 30
    # /infer 是同步推理，AI 服务那边还加了锁排队，一次几十秒很正常，单独放宽。
    # 前端 axios 给这个请求 180s、nginx proxy_read_timeout 300s，这里要比前端略短，
    # 这样超时是后端报出清楚的 502 而不是前端先断掉。
    algo_infer_timeout_sec: int = 170
    # 项目批量预标注走 /infer_batch：每次发多少个样本、等多久。AI 服务按文件多进程
    # 并行（22 个 worker 左右），一块 40 个 ≈ 两轮，单文件十几秒，正常一分钟内回；
    # 超时给足余量，机器被别的东西占满时也别误判失败
    algo_infer_batch_size: int = 40
    # 推理模式：stable=稳定版（AI 服务做状态平滑+事件合并过滤，片段少而可信），
    # raw=调试版（模型逐窗口原始输出，活动/睡觉会来回闪）。前端每次可以单独选
    algo_infer_mode: str = "stable"
    algo_infer_batch_timeout_sec: int = 1800

    # --- CORS ---
    cors_allow_origins: list[str] = ["http://localhost:8284"]


settings = Settings()
