from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.models.model_version import ModelTrainStatus


class ExtraDatasetIn(BaseModel):
    """一起训练的另一份数据集。

    带 export_json 是关键：AI 服务那边只整理过主数据集，额外批次原本得事先
    自己躺在 data/raw_custom/ 下，界面上选不了。带上路径它就跟主数据集走
    同一条整理流程。
    """
    date: str
    export_json: str
    source_hz: int | None = None
    # 新版流程：这份数据集里不进训练的类别（归并后的名字）
    exclude_classes: list[str] = []


class DatasetSpecIn(BaseModel):
    date: str
    extra_date: list[str] = []
    # 一起训练的其它数据集。**单独一份常常训不了**：按片段取的数据集只收
    # 人确认过的片段，而没人会去确认「活动」「睡觉」，于是整份只有正样本，
    # 分类器没有可对比的负类——得掺上带状态标签的那几批老数据
    extra_datasets: list[ExtraDatasetIn] = []
    # 类别归并 {原名: 新名}。细类太少就并进兄弟类别，不训的行为折进「活动」
    # 当负样本。AI 服务整理数据时改写，不动 NAS 上的导出——同一份数据集能
    # 喂给不同的归并方案反复试
    label_remap: dict[str, str] = {}
    # 用几轴：6=加速度+陀螺仪（默认），3=只用加速度。
    # **端侧只有加速度计时要用 3**——否则模型学的是板上根本没有的信号，
    # 服务端指标再好也代表不了端上的表现
    axes: int = 6
    # 输入通道：tilt=重力对齐+姿态角（老模型）；inv=方向无关（竖直/水平分量、模长、偏角、jerk），
    # 用户怎么戴都一样。rot_aug：训练集每窗另加几份随机 3D 旋转
    channel_mode: str = "tilt"
    rot_aug: int = 0
    # 短促动作（甩动这类一两秒的）：比训练窗口短的片段以事件为中心带上前后真实上下文补成完整窗口，
    # 不再被丢掉 / 被多数投票吞掉。填训练用的类别名（归并后的名字）
    short_labels: list[str] = []
    # 端侧尺寸：用 imu_train 的 configs/ml_edge.yaml（限深限棵数），模型才塞得进
    # 板子给模型留的约 128KB flash。默认那份是 200 棵不限深的森林，几十 MB
    edge_size: bool = False
    # 端侧尺寸里具体填的规格（体积曲线那页「按这个规格重训」会带过来）；不填用默认
    edge_trees: int | None = None
    edge_depth: int | None = None
    edge_filters: list[int] | None = None
    missing_strategy: str | None = None
    skip_syn: bool = False
    # 类别均衡：none（默认）/ min（多的类砍到跟最少的一样多）/ cap:N（每类最多 N 个训练窗口）。
    # 只砍训练集的窗口。先看训练集统计和回放，确认是"量少"不是"标错"再开
    balance: str | None = None
    # 用标注平台导出的数据集训练时带上：NAS 相对路径的 Label Studio 格式 JSON。
    # AI 服务会把它整理成 data/raw_custom/<date>/merged_tmp.json 再跑 train_custom.sh
    export_json: str | None = None
    source_hz: float | None = None
    # 可以是小数：31.25 / 15.625 是 QMI8658 的原生档位（它没有 16 / 25 / 50）
    hz: float | None = None
    clean: bool = False
    # 窗口 / 步长（秒）。不填按采样率自动挑（31.25 Hz → 2.048 / 1.024 s）。以前没列在这里，界面传了也被丢掉
    window_s: float | None = None
    stride_s: float | None = None
    # 窗口怎么打标签：majority（多数投票，默认）/ center（窗口中心那一刻）
    label_mode: str | None = None
    # 模型超参覆盖：n_estimators / max_depth / min_samples_leaf / max_features，不填用默认
    model_params: dict | None = None
    # 新版训练流程（imu_train src/ml/train_v2.py）：pipeline="v2"；细分训练的类别；输出校准系数
    pipeline: str | None = None
    fine_labels: list[str] | None = None
    class_scale: dict[str, float] | None = None


class TrainSubmitIn(BaseModel):
    dataset: DatasetSpecIn
    model_type: str = "rf"
    tag: str | None = None


class ModelVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    algo_job_id: int
    status: ModelTrainStatus
    model_type: str
    model_version: str | None
    model_path: str | None
    error: str | None
    dataset_spec: str
    metrics: str | None
    listed: bool = False
    created_at: datetime
    updated_at: datetime


class PrelabelItem(BaseModel):
    """一段 AI 预测出来的行为，时间已经换算成相对 IMU CSV 起点的毫秒数——
    跟标注工作台里 LabelItem 用的是同一个时间基准，前端拿到就能直接画色块。"""

    label_name: str
    start_time_ms: int
    end_time_ms: int
    confidence: float


class PrelabelResult(BaseModel):
    """
    imu_train/label_service 的 /infer 返回的是按类别分组的 segments
    （{类别: [{start_ts, end_ts, conf_max, ...}]}，start_ts 是绝对墙钟时间字符串），
    后端在 ai_prelabel 里摊平并换算成相对毫秒后给前端，前端不用管时间戳换算。
    """

    sample_id: int
    ai_label_path: str
    items: list[PrelabelItem]
    n_windows: int
    # 时间戳为空/换算出来时长非正的片段数，前端提示用
    skipped: int
