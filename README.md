# label_infra

数据标注基础设施，包含 Label Studio 部署和视频自动转码服务。

---

## 目录结构

```
label_infra/
├── label_studio/
│   ├── setup.sh            # 一键部署脚本
│   └── auto_transcode.py   # 视频自动转码后台服务
├── data/                   # 运行时数据（gitignore，不提交）
│   ├── label_studio/       # Label Studio 数据库、项目数据
│   ├── media/              # 媒体文件
│   │   └── transcoded/     # 转码后的视频
│   └── nginx.conf
└── logs/                   # 日志（gitignore，不提交）
    └── transcode.log
```

---

## 快速开始

### 1. 部署所有服务

```bash
# 先设置 token（可选，部署完再设也行）
export LS_REFRESH_TOKEN="你的JWT refresh token"
export SERVER_IP="192.168.2.140"   # 服务器 IP，不填自动检测

bash label_studio/setup.sh
```

部署完成后：
- Label Studio：`http://<服务器IP>:8181`
- 媒体文件服务：`http://<服务器IP>:8182`

首次访问 Label Studio 需要注册账号，第一个注册的账号自动成为管理员。

---

### 2. 获取 Refresh Token

1. 登录 Label Studio
2. 右上角头像 → **Account & Settings**
3. 左侧 **Personal Access Token** → 复制 token

---

### 3. 单独启动自动转码服务

如果 `setup.sh` 时没有设置 token，部署完后单独启动：

```bash
export LS_REFRESH_TOKEN="你的JWT refresh token"
export LS_URL="http://192.168.2.140:8181"
export NGINX_BASE_URL="http://192.168.2.140:8182/transcoded"

nohup python3 label_studio/auto_transcode.py >> ~/transcode.log 2>&1 &
echo "转码服务已启动，PID: $!"
```

查看实时日志：
```bash
tail -f ~/transcode.log
```

---

### 4. 停止服务

```bash
# 停止所有后台服务
pkill -f "auto_transcode.py" 2>/dev/null || true
pkill -f "upload_server.py"  2>/dev/null || true

# 停止容器
docker stop label_studio label_studio_nginx
```

重新启动容器：
```bash
docker start label_studio label_studio_nginx
```

---

### 5. 使用说明

#### 上传视频 + IMU 数据（推荐方式）

打开上传服务页面：`http://<服务器IP>:8183`

1. 选择目标 Label Studio 项目
2. 拖拽同名的 MP4 + CSV 文件（如 `26060315.mp4` + `26060315.csv`），支持多对同时上传
3. 点击"上传并导入"，后台自动转码 + 配对 + 创建任务

#### 视频自动转码
直接在 Label Studio 项目里上传 MP4 视频，`auto_transcode.py` 也会自动：
1. 检测到上传的视频（每 10 秒轮询一次）
2. 用 GPU（h264_nvenc）转码为浏览器兼容的 H.264 格式，无 GPU 时自动降级到 CPU
3. 将任务的视频 URL 更新为 nginx 托管的转码文件

#### 标注 IMU 时序数据
将 CSV 文件放到 `~/ls-data/media/` 目录，在 Label Studio 任务中用 nginx URL 引用：
```
http://<服务器IP>:8182/文件名.csv
```

Labeling Interface XML 模板（视频 + IMU 同步）：
```xml
<View>
  <Video name="video" value="$video" frameRate="25" sync="sync_group"/>

  <TimeSeriesLabels name="label" toName="ts">
    <Label value="活动" background="#4CAF50"/>
    <Label value="睡觉" background="#2196F3"/>
    <Label value="抓挠" background="#F44336"/>
  </TimeSeriesLabels>

  <TimeSeries name="ts" value="$csv" valueType="url"
              sync="sync_group"
              timeColumn="timestamp"
              timeFormat="%Y-%m-%d %H:%M:%S.%f"
              timeDisplayFormat="%H:%M:%S"
              sep=",">
    <Channel column="acc_x"  strokeColor="#e74c3c" legend="Acc X"  height="60"/>
    <Channel column="acc_y"  strokeColor="#2ecc71" legend="Acc Y"  height="60"/>
    <Channel column="acc_z"  strokeColor="#3498db" legend="Acc Z"  height="60"/>
    <Channel column="gyro_x" strokeColor="#e67e22" legend="Gyro X" height="60"/>
    <Channel column="gyro_y" strokeColor="#1abc9c" legend="Gyro Y" height="60"/>
    <Channel column="gyro_z" strokeColor="#9b59b6" legend="Gyro Z" height="60"/>
  </TimeSeries>
</View>
```

---

### Labeling Interface 模板

#### 1. 视频 + IMU 同步标注

任务数据字段：`$video`（视频 URL）、`$csv`（IMU CSV URL）

```xml
<View>
  <Video name="video" value="$video" frameRate="25" sync="sync_group"/>

  <TimeSeriesLabels name="label" toName="ts">
    <Label value="活动" background="#4CAF50"/>
    <Label value="睡觉" background="#2196F3"/>
    <Label value="抓挠" background="#F44336"/>
  </TimeSeriesLabels>

  <TimeSeries name="ts" value="$csv" valueType="url"
              sync="sync_group"
              timeColumn="timestamp"
              timeFormat="%Y-%m-%d %H:%M:%S.%f"
              timeDisplayFormat="%H:%M:%S"
              sep=",">
    <Channel column="acc_x"  strokeColor="#e74c3c" legend="Acc X"  height="60"/>
    <Channel column="acc_y"  strokeColor="#2ecc71" legend="Acc Y"  height="60"/>
    <Channel column="acc_z"  strokeColor="#3498db" legend="Acc Z"  height="60"/>
    <Channel column="gyro_x" strokeColor="#e67e22" legend="Gyro X" height="60"/>
    <Channel column="gyro_y" strokeColor="#1abc9c" legend="Gyro Y" height="60"/>
    <Channel column="gyro_z" strokeColor="#9b59b6" legend="Gyro Z" height="60"/>
  </TimeSeries>
</View>
```

#### 2. 纯视频片段标注

任务数据字段：`$video`（视频 URL）

```xml
<View>
  <Video name="video" value="$video" frameRate="25"/>

  <TimeSeriesLabels name="label" toName="video">
    <Label value="活动" background="#4CAF50"/>
    <Label value="睡觉" background="#2196F3"/>
    <Label value="抓挠" background="#F44336"/>
  </TimeSeriesLabels>
</View>
```

#### 3. 纯 IMU 时序标注

任务数据字段：`$csv`（IMU CSV URL）

```xml
<View>
  <TimeSeriesLabels name="label" toName="ts">
    <Label value="活动" background="#4CAF50"/>
    <Label value="睡觉" background="#2196F3"/>
    <Label value="抓挠" background="#F44336"/>
  </TimeSeriesLabels>

  <TimeSeries name="ts" value="$csv" valueType="url"
              timeColumn="timestamp"
              timeFormat="%Y-%m-%d %H:%M:%S.%f"
              timeDisplayFormat="%H:%M:%S"
              sep=",">
    <Channel column="acc_x"  strokeColor="#e74c3c" legend="Acc X"  height="60"/>
    <Channel column="acc_y"  strokeColor="#2ecc71" legend="Acc Y"  height="60"/>
    <Channel column="acc_z"  strokeColor="#3498db" legend="Acc Z"  height="60"/>
    <Channel column="gyro_x" strokeColor="#e67e22" legend="Gyro X" height="60"/>
    <Channel column="gyro_y" strokeColor="#1abc9c" legend="Gyro Y" height="60"/>
    <Channel column="gyro_z" strokeColor="#9b59b6" legend="Gyro Z" height="60"/>
  </TimeSeries>
</View>
```

#### 4. 图片目标检测（从零标注）

任务数据字段：`$image`（图片 URL）

```xml
<View>
  <Image name="image" value="$image"/>

  <RectangleLabels name="label" toName="image">
    <Label value="狗" background="#FF6B6B"/>
    <Label value="猫" background="#4ECDC4"/>
    <Label value="人" background="#45B7D1"/>
  </RectangleLabels>
</View>
```

批量导入图片任务（`import_tasks.py` 同目录下运行）：
```bash
# 将图片放到 ~/label_infra/data/media/，CSV 中每行一个图片 URL
python3 label_studio/import_tasks.py --project <项目ID> --media-dir ~/label_infra/data/media/
```

或直接用 JSON 批量导入：
```json
[
  {"data": {"image": "http://<服务器IP>:8182/dog001.jpg"}},
  {"data": {"image": "http://<服务器IP>:8182/dog002.jpg"}}
]
```

#### 5. 图片目标检测（已有预标注，导入后校验）

任务数据字段：`$image`（图片 URL），预标注通过 `predictions` 字段传入：

```xml
<View>
  <Image name="image" value="$image"/>

  <RectangleLabels name="label" toName="image">
    <Label value="狗" background="#FF6B6B"/>
    <Label value="猫" background="#4ECDC4"/>
    <Label value="人" background="#45B7D1"/>
  </RectangleLabels>
</View>
```

带预标注的导入 JSON 格式：
```json
[
  {
    "data": {"image": "http://<服务器IP>:8182/dog001.jpg"},
    "predictions": [{
      "model_version": "v1",
      "result": [
        {
          "type": "rectanglelabels",
          "from_name": "label",
          "to_name": "image",
          "original_width": 1920,
          "original_height": 1080,
          "value": {
            "x": 10.5, "y": 20.3,
            "width": 30.0, "height": 40.0,
            "rotation": 0,
            "rectanglelabels": ["狗"]
          }
        }
      ]
    }]
  }
]
```

> `x`、`y`、`width`、`height` 均为百分比（相对图片宽高），范围 0–100。

#### 媒体文件目录
```
label_infra/data/
├── media/
│   ├── transcoded/   # 转码后的视频（auto_transcode.py 自动写入）
│   └── upload/       # Label Studio 上传目录（自动管理）
├── label_studio/     # Label Studio 数据库和项目数据
└── nginx.conf
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LS_REFRESH_TOKEN` | 无（必填） | Label Studio JWT refresh token |
| `LS_URL` | `http://192.168.2.140:8181` | Label Studio 地址 |
| `NGINX_BASE_URL` | `http://192.168.2.140:8182/transcoded` | 转码文件访问基础 URL |
| `OUTPUT_DIR` | `~/ls-data/media/transcoded` | 转码输出目录 |
| `UPLOAD_DIR` | `~/ls-data/media/upload` | Label Studio 上传目录 |
| `POLL_INTERVAL` | `10` | 轮询间隔（秒） |
| `SERVER_IP` | 自动检测 | 服务器 IP（setup.sh 使用） |

---

## 依赖

- Docker
- Python 3.10+
- `pip install requests`
- ffmpeg（`apt install ffmpeg`）
- NVIDIA GPU + 驱动（可选，无 GPU 自动降级到 CPU 转码）
