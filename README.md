# label_infra

数据标注基础设施，包含 Label Studio 部署和视频自动转码服务。

---

## 目录结构

```
label_infra/
├── label_studio/
│   ├── setup.sh            # 一键部署脚本（首次或重建）
│   ├── restart.sh          # 重启后台服务（不重建容器）
│   ├── set_token.sh        # 保存 Token 到 .env
│   ├── auto_transcode.py   # 视频自动转码服务
│   ├── upload_server.py    # MP4+CSV 上传服务（端口 8183）
│   ├── import_tasks.py     # 批量导入工具
│   ├── extract_frames.py   # 视频抽帧工具
│   ├── convert_imu.py      # IMU TXT→CSV 转换工具
│   └── ls_auth.py          # 认证公共模块
├── data/                   # 运行时数据（gitignore，不提交）
│   ├── label_studio/       # Label Studio 数据库、项目数据
│   ├── media/              # 媒体文件
│   │   ├── transcoded/     # 转码后的视频
│   │   └── frames/         # 抽帧图片
│   ├── imu/                # IMU 原始 TXT 文件
│   └── nginx.conf
└── logs/                   # 日志（gitignore，不提交）
```

---

## 快速开始

### 第一步：部署（首次或服务器重装）

```bash
bash label_studio/setup.sh
```

部署完成后：
- Label Studio：`http://<服务器IP>:8181`（首次需注册账号，第一个账号为管理员）
- 媒体文件服务：`http://<服务器IP>:8182`
- 上传服务：`http://<服务器IP>:8183`

---

### 第二步：获取 Token（只需做一次）

1. 登录 Label Studio
2. 右上角头像 → **Account & Settings** → 左侧 **Personal Access Token**
3. 点击 **Create New Token**，复制生成的 token

```bash
bash label_studio/set_token.sh "粘贴你的token"
```

Token 保存在 `~/label_infra/.env`，之后所有脚本自动读取，无需再次设置。

---

### 第三步：启动后台服务

```bash
bash label_studio/restart.sh
```

查看日志：
```bash
tail -f ~/label_infra/logs/transcode.log   # 转码服务
tail -f ~/label_infra/logs/upload.log      # 上传服务
```

---

### 验证 Token 是否有效

```bash
source ~/label_infra/.env
ACCESS=$(curl -s -X POST http://192.168.2.140:8181/api/token/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refresh\": \"$LS_REFRESH_TOKEN\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['access'])")
curl -s -H "Authorization: Bearer $ACCESS" http://192.168.2.140:8181/api/projects/?page_size=1 | python3 -m json.tool | head -5
```

返回项目列表则正常；返回 `401` 则 token 失效，重新从 Label Studio 获取后再次运行 `set_token.sh`。

> **Token 何时会失效**：重建容器（`setup.sh`）会重置 JWT 密钥，导致所有旧 token 失效，需重新获取。

---

### 重启服务

```bash
# 只重启后台 Python 服务（不动 Docker 容器）
bash label_studio/restart.sh

# 重建所有容器（数据不丢失）
bash label_studio/setup.sh

# 只重启容器（不重建）
docker restart label_studio label_studio_nginx
```

---

### 停止服务

```bash
pkill -f "auto_transcode.py" 2>/dev/null || true
pkill -f "upload_server.py"  2>/dev/null || true
docker stop label_studio label_studio_nginx
```

---

## 使用说明

### 上传视频 + IMU 数据

打开上传服务：`http://<服务器IP>:8183`

1. 选择目标项目（新建项目后点 **↻ 刷新列表**）
2. 拖拽同名的 MP4 + CSV 文件（如 `26060315.mp4` + `26060315.csv`），支持多对
3. 点击"上传并导入"，后台自动转码 + 配对 + 创建任务

### IMU TXT 转 CSV

```bash
# 将 TXT 文件放到 data/imu/ 目录，批量转换
python3 label_studio/convert_imu.py data/imu/

# 单个文件
python3 label_studio/convert_imu.py data/imu/2026061711.TXT

# 手动指定日期（文件名无日期前缀时）
python3 label_studio/convert_imu.py data/imu/ --date 2026-06-17
```

### 视频抽帧（用于图片目标检测）

```bash
# 每秒1帧，抽完后自动导入项目
python3 label_studio/extract_frames.py \
    --video data/media/video.mp4 \
    --project <项目ID> --fps 1

# 先预览帧数
python3 label_studio/extract_frames.py \
    --video data/media/video.mp4 --fps 1 --dry-run
```

### 视频自动转码

直接在 Label Studio 项目里上传 MP4，`auto_transcode.py` 每 10 秒轮询一次，自动：
1. 检测到未转码的视频
2. GPU（h264_nvenc）转码，无 GPU 自动降级 CPU
3. 更新任务 URL 为 nginx 地址

---

### Labeling Interface 模板

标签列表（所有模板通用）：
`活动` `睡觉` `抓挠` `甩身体` `跳跃` `舔身体` `啃身体` `奔跑`

---

#### A. 三视频一行 + 双 IMU（3 cam / 2 dog）

任务数据字段：`$video1` `$video2` `$video3` `$csv1` `$csv2`

```xml
<View>
  <View style="display:flex; gap:4px; background:#000;">
    <View style="flex:1; min-width:0; background:#000;">
      <Header value="视角 1"/>
      <Video name="video1" value="$video1" frameRate="25" sync="sync_group"/>
    </View>
    <View style="flex:1; min-width:0; background:#000;">
      <Header value="视角 2"/>
      <Video name="video2" value="$video2" frameRate="25" sync="sync_group"/>
    </View>
    <View style="flex:1; min-width:0; background:#000;">
      <Header value="视角 3"/>
      <Video name="video3" value="$video3" frameRate="25" sync="sync_group"/>
    </View>
  </View>

  <View style="display:flex; gap:8px; margin-top:12px;">
    <View style="flex:1; min-width:0;">
      <Header value="狗 1 IMU"/>
      <TimeSeriesLabels name="label1" toName="ts1">
        <Label value="活动" background="#4CAF50"/>
        <Label value="睡觉" background="#2196F3"/>
        <Label value="抓挠" background="#F44336"/>
        <Label value="甩身体" background="#FF9800"/>
        <Label value="跳跃" background="#9C27B0"/>
        <Label value="舔身体" background="#00BCD4"/>
        <Label value="啃身体" background="#795548"/>
        <Label value="奔跑" background="#FF5722"/>
        <Label value="行走" background="#607D8B"/>
        <Label value="进食" background="#8BC34A"/>
        <Label value="饮水" background="#03A9F4"/>
        <Label value="蹭擦身体" background="#E91E63"/>
        <Label value="嗅闻" background="#FFC107"/>
        <Label value="戴摘项圈" background="#9E9E9E"/>
        <Label value="伸懒腰" background="#FFEB3B"/>
        <Label value="未佩戴" background="#546E7A"/>
        <Label value="项圈松动" background="#FF7043"/>
      </TimeSeriesLabels>
      <TimeSeries name="ts1" value="$csv1" valueType="url"
                  sync="sync_group"
                  timeColumn="timestamp"
                  timeFormat="%Y-%m-%d %H:%M:%S.%f"
                  timeDisplayFormat="%H:%M:%S"
                  sep=",">
        <Channel column="acc_x"  strokeColor="#e74c3c" legend="Acc X"  height="50"/>
        <Channel column="acc_y"  strokeColor="#2ecc71" legend="Acc Y"  height="50"/>
        <Channel column="acc_z"  strokeColor="#3498db" legend="Acc Z"  height="50"/>
        <Channel column="gyro_x" strokeColor="#e67e22" legend="Gyro X" height="50"/>
        <Channel column="gyro_y" strokeColor="#1abc9c" legend="Gyro Y" height="50"/>
        <Channel column="gyro_z" strokeColor="#9b59b6" legend="Gyro Z" height="50"/>
      </TimeSeries>
    </View>
    <View style="flex:1; min-width:0;">
      <Header value="狗 2 IMU"/>
      <TimeSeriesLabels name="label2" toName="ts2">
        <Label value="活动" background="#4CAF50"/>
        <Label value="睡觉" background="#2196F3"/>
        <Label value="抓挠" background="#F44336"/>
        <Label value="甩身体" background="#FF9800"/>
        <Label value="跳跃" background="#9C27B0"/>
        <Label value="舔身体" background="#00BCD4"/>
        <Label value="啃身体" background="#795548"/>
        <Label value="奔跑" background="#FF5722"/>
        <Label value="行走" background="#607D8B"/>
        <Label value="进食" background="#8BC34A"/>
        <Label value="饮水" background="#03A9F4"/>
        <Label value="蹭擦身体" background="#E91E63"/>
        <Label value="嗅闻" background="#FFC107"/>
        <Label value="戴摘项圈" background="#9E9E9E"/>
        <Label value="伸懒腰" background="#FFEB3B"/>
        <Label value="未佩戴" background="#546E7A"/>
        <Label value="项圈松动" background="#FF7043"/>
      </TimeSeriesLabels>
      <TimeSeries name="ts2" value="$csv2" valueType="url"
                  sync="sync_group"
                  timeColumn="timestamp"
                  timeFormat="%Y-%m-%d %H:%M:%S.%f"
                  timeDisplayFormat="%H:%M:%S"
                  sep=",">
        <Channel column="acc_x"  strokeColor="#e74c3c" legend="Acc X"  height="50"/>
        <Channel column="acc_y"  strokeColor="#2ecc71" legend="Acc Y"  height="50"/>
        <Channel column="acc_z"  strokeColor="#3498db" legend="Acc Z"  height="50"/>
        <Channel column="gyro_x" strokeColor="#e67e22" legend="Gyro X" height="50"/>
        <Channel column="gyro_y" strokeColor="#1abc9c" legend="Gyro Y" height="50"/>
        <Channel column="gyro_z" strokeColor="#9b59b6" legend="Gyro Z" height="50"/>
      </TimeSeries>
    </View>
  </View>
</View>
```

---

#### B. 两视频一行 + 双 IMU（2 cam / 2 dog）

任务数据字段：`$video1` `$video2` `$csv1` `$csv2`

```xml
<View>
  <View style="display:flex; gap:4px; background:#000;">
    <View style="flex:1; min-width:0; background:#000;">
      <Header value="视角 1"/>
      <Video name="video1" value="$video1" frameRate="25" sync="sync_group"/>
    </View>
    <View style="flex:1; min-width:0; background:#000;">
      <Header value="视角 2"/>
      <Video name="video2" value="$video2" frameRate="25" sync="sync_group"/>
    </View>
  </View>

  <View style="display:flex; gap:8px; margin-top:12px;">
    <View style="flex:1; min-width:0;">
      <Header value="狗 1 IMU"/>
      <TimeSeriesLabels name="label1" toName="ts1">
        <Label value="活动" background="#4CAF50"/>
        <Label value="睡觉" background="#2196F3"/>
        <Label value="抓挠" background="#F44336"/>
        <Label value="甩身体" background="#FF9800"/>
        <Label value="跳跃" background="#9C27B0"/>
        <Label value="舔身体" background="#00BCD4"/>
        <Label value="啃身体" background="#795548"/>
        <Label value="奔跑" background="#FF5722"/>
        <Label value="行走" background="#607D8B"/>
        <Label value="进食" background="#8BC34A"/>
        <Label value="饮水" background="#03A9F4"/>
        <Label value="蹭擦身体" background="#E91E63"/>
        <Label value="嗅闻" background="#FFC107"/>
        <Label value="戴摘项圈" background="#9E9E9E"/>
        <Label value="伸懒腰" background="#FFEB3B"/>
        <Label value="未佩戴" background="#546E7A"/>
        <Label value="项圈松动" background="#FF7043"/>
      </TimeSeriesLabels>
      <TimeSeries name="ts1" value="$csv1" valueType="url"
                  sync="sync_group"
                  timeColumn="timestamp"
                  timeFormat="%Y-%m-%d %H:%M:%S.%f"
                  timeDisplayFormat="%H:%M:%S"
                  sep=",">
        <Channel column="acc_x"  strokeColor="#e74c3c" legend="Acc X"  height="50"/>
        <Channel column="acc_y"  strokeColor="#2ecc71" legend="Acc Y"  height="50"/>
        <Channel column="acc_z"  strokeColor="#3498db" legend="Acc Z"  height="50"/>
        <Channel column="gyro_x" strokeColor="#e67e22" legend="Gyro X" height="50"/>
        <Channel column="gyro_y" strokeColor="#1abc9c" legend="Gyro Y" height="50"/>
        <Channel column="gyro_z" strokeColor="#9b59b6" legend="Gyro Z" height="50"/>
      </TimeSeries>
    </View>
    <View style="flex:1; min-width:0;">
      <Header value="狗 2 IMU"/>
      <TimeSeriesLabels name="label2" toName="ts2">
        <Label value="活动" background="#4CAF50"/>
        <Label value="睡觉" background="#2196F3"/>
        <Label value="抓挠" background="#F44336"/>
        <Label value="甩身体" background="#FF9800"/>
        <Label value="跳跃" background="#9C27B0"/>
        <Label value="舔身体" background="#00BCD4"/>
        <Label value="啃身体" background="#795548"/>
        <Label value="奔跑" background="#FF5722"/>
        <Label value="行走" background="#607D8B"/>
        <Label value="进食" background="#8BC34A"/>
        <Label value="饮水" background="#03A9F4"/>
        <Label value="蹭擦身体" background="#E91E63"/>
        <Label value="嗅闻" background="#FFC107"/>
        <Label value="戴摘项圈" background="#9E9E9E"/>
        <Label value="伸懒腰" background="#FFEB3B"/>
        <Label value="未佩戴" background="#546E7A"/>
        <Label value="项圈松动" background="#FF7043"/>
      </TimeSeriesLabels>
      <TimeSeries name="ts2" value="$csv2" valueType="url"
                  sync="sync_group"
                  timeColumn="timestamp"
                  timeFormat="%Y-%m-%d %H:%M:%S.%f"
                  timeDisplayFormat="%H:%M:%S"
                  sep=",">
        <Channel column="acc_x"  strokeColor="#e74c3c" legend="Acc X"  height="50"/>
        <Channel column="acc_y"  strokeColor="#2ecc71" legend="Acc Y"  height="50"/>
        <Channel column="acc_z"  strokeColor="#3498db" legend="Acc Z"  height="50"/>
        <Channel column="gyro_x" strokeColor="#e67e22" legend="Gyro X" height="50"/>
        <Channel column="gyro_y" strokeColor="#1abc9c" legend="Gyro Y" height="50"/>
        <Channel column="gyro_z" strokeColor="#9b59b6" legend="Gyro Z" height="50"/>
      </TimeSeries>
    </View>
  </View>
</View>
```

---

#### C. 三视频一行 + 单 IMU（3 cam / 1 dog）

任务数据字段：`$video1` `$video2` `$video3` `$csv1`

```xml
<View>
  <View style="display:flex; gap:4px; background:#000;">
    <View style="flex:1; min-width:0; background:#000;">
      <Header value="视角 1"/>
      <Video name="video1" value="$video1" frameRate="25" sync="sync_group"/>
    </View>
    <View style="flex:1; min-width:0; background:#000;">
      <Header value="视角 2"/>
      <Video name="video2" value="$video2" frameRate="25" sync="sync_group"/>
    </View>
    <View style="flex:1; min-width:0; background:#000;">
      <Header value="视角 3"/>
      <Video name="video3" value="$video3" frameRate="25" sync="sync_group"/>
    </View>
  </View>

  <TimeSeriesLabels name="label" toName="ts">
    <Label value="活动" background="#4CAF50"/>
    <Label value="睡觉" background="#2196F3"/>
    <Label value="抓挠" background="#F44336"/>
    <Label value="甩身体" background="#FF9800"/>
    <Label value="跳跃" background="#9C27B0"/>
    <Label value="舔身体" background="#00BCD4"/>
    <Label value="啃身体" background="#795548"/>
    <Label value="奔跑" background="#FF5722"/>
    <Label value="行走" background="#607D8B"/>
    <Label value="进食" background="#8BC34A"/>
    <Label value="饮水" background="#03A9F4"/>
    <Label value="蹭擦身体" background="#E91E63"/>
    <Label value="嗅闻" background="#FFC107"/>
    <Label value="戴摘项圈" background="#9E9E9E"/>
    <Label value="伸懒腰" background="#FFEB3B"/>
    <Label value="未佩戴" background="#546E7A"/>
    <Label value="项圈松动" background="#FF7043"/>
  </TimeSeriesLabels>
  <TimeSeries name="ts" value="$csv1" valueType="url"
              sync="sync_group"
              timeColumn="timestamp"
              timeFormat="%Y-%m-%d %H:%M:%S.%f"
              timeDisplayFormat="%H:%M:%S"
              sep=",">
    <Channel column="acc_x"  strokeColor="#e74c3c" legend="Acc X"  height="50"/>
    <Channel column="acc_y"  strokeColor="#2ecc71" legend="Acc Y"  height="50"/>
    <Channel column="acc_z"  strokeColor="#3498db" legend="Acc Z"  height="50"/>
    <Channel column="gyro_x" strokeColor="#e67e22" legend="Gyro X" height="50"/>
    <Channel column="gyro_y" strokeColor="#1abc9c" legend="Gyro Y" height="50"/>
    <Channel column="gyro_z" strokeColor="#9b59b6" legend="Gyro Z" height="50"/>
  </TimeSeries>
</View>
```

---

#### D. 两视频一行 + 单 IMU（2 cam / 1 dog）

任务数据字段：`$video1` `$video2` `$csv1`

```xml
<View>
  <View style="display:flex; gap:4px; background:#000;">
    <View style="flex:1; min-width:0; background:#000;">
      <Header value="视角 1"/>
      <Video name="video1" value="$video1" frameRate="25" sync="sync_group"/>
    </View>
    <View style="flex:1; min-width:0; background:#000;">
      <Header value="视角 2"/>
      <Video name="video2" value="$video2" frameRate="25" sync="sync_group"/>
    </View>
  </View>

  <TimeSeriesLabels name="label" toName="ts">
    <Label value="活动" background="#4CAF50"/>
    <Label value="睡觉" background="#2196F3"/>
    <Label value="抓挠" background="#F44336"/>
    <Label value="甩身体" background="#FF9800"/>
    <Label value="跳跃" background="#9C27B0"/>
    <Label value="舔身体" background="#00BCD4"/>
    <Label value="啃身体" background="#795548"/>
    <Label value="奔跑" background="#FF5722"/>
    <Label value="行走" background="#607D8B"/>
    <Label value="进食" background="#8BC34A"/>
    <Label value="饮水" background="#03A9F4"/>
    <Label value="蹭擦身体" background="#E91E63"/>
    <Label value="嗅闻" background="#FFC107"/>
    <Label value="戴摘项圈" background="#9E9E9E"/>
    <Label value="伸懒腰" background="#FFEB3B"/>
    <Label value="未佩戴" background="#546E7A"/>
    <Label value="项圈松动" background="#FF7043"/>
  </TimeSeriesLabels>
  <TimeSeries name="ts" value="$csv1" valueType="url"
              sync="sync_group"
              timeColumn="timestamp"
              timeFormat="%Y-%m-%d %H:%M:%S.%f"
              timeDisplayFormat="%H:%M:%S"
              sep=",">
    <Channel column="acc_x"  strokeColor="#e74c3c" legend="Acc X"  height="50"/>
    <Channel column="acc_y"  strokeColor="#2ecc71" legend="Acc Y"  height="50"/>
    <Channel column="acc_z"  strokeColor="#3498db" legend="Acc Z"  height="50"/>
    <Channel column="gyro_x" strokeColor="#e67e22" legend="Gyro X" height="50"/>
    <Channel column="gyro_y" strokeColor="#1abc9c" legend="Gyro Y" height="50"/>
    <Channel column="gyro_z" strokeColor="#9b59b6" legend="Gyro Z" height="50"/>
  </TimeSeries>
</View>
```

---

#### E. 单视频 + 单 IMU（1 cam / 1 dog）

任务数据字段：`$video` `$csv`

```xml
<View>
  <Video name="video" value="$video" frameRate="25" sync="sync_group"/>

  <TimeSeriesLabels name="label" toName="ts">
    <Label value="活动" background="#4CAF50"/>
    <Label value="睡觉" background="#2196F3"/>
    <Label value="抓挠" background="#F44336"/>
    <Label value="甩身体" background="#FF9800"/>
    <Label value="跳跃" background="#9C27B0"/>
    <Label value="舔身体" background="#00BCD4"/>
    <Label value="啃身体" background="#795548"/>
    <Label value="奔跑" background="#FF5722"/>
    <Label value="行走" background="#607D8B"/>
    <Label value="进食" background="#8BC34A"/>
    <Label value="饮水" background="#03A9F4"/>
    <Label value="蹭擦身体" background="#E91E63"/>
    <Label value="嗅闻" background="#FFC107"/>
    <Label value="戴摘项圈" background="#9E9E9E"/>
    <Label value="伸懒腰" background="#FFEB3B"/>
    <Label value="未佩戴" background="#546E7A"/>
    <Label value="项圈松动" background="#FF7043"/>
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

#### F. 纯视频片段标注

任务数据字段：`$video`

```xml
<View>
  <Video name="video" value="$video" frameRate="25"/>

  <TimeSeriesLabels name="label" toName="video">
    <Label value="活动" background="#4CAF50"/>
    <Label value="睡觉" background="#2196F3"/>
    <Label value="抓挠" background="#F44336"/>
    <Label value="甩身体" background="#FF9800"/>
    <Label value="跳跃" background="#9C27B0"/>
    <Label value="舔身体" background="#00BCD4"/>
    <Label value="啃身体" background="#795548"/>
    <Label value="奔跑" background="#FF5722"/>
    <Label value="行走" background="#607D8B"/>
    <Label value="进食" background="#8BC34A"/>
    <Label value="饮水" background="#03A9F4"/>
    <Label value="蹭擦身体" background="#E91E63"/>
    <Label value="嗅闻" background="#FFC107"/>
    <Label value="戴摘项圈" background="#9E9E9E"/>
    <Label value="伸懒腰" background="#FFEB3B"/>
    <Label value="未佩戴" background="#546E7A"/>
    <Label value="项圈松动" background="#FF7043"/>
  </TimeSeriesLabels>
</View>
```

---

#### G. 图片目标检测

任务数据字段：`$image`

> 图片项目只接受 JPG/PNG，视频需先用 `extract_frames.py` 抽帧。

```xml
<View>
  <Image name="image" value="$image"/>

  <RectangleLabels name="label" toName="image">
    <Label value="活动" background="#4CAF50"/>
    <Label value="睡觉" background="#2196F3"/>
    <Label value="抓挠" background="#F44336"/>
    <Label value="甩身体" background="#FF9800"/>
    <Label value="跳跃" background="#9C27B0"/>
    <Label value="舔身体" background="#00BCD4"/>
    <Label value="啃身体" background="#795548"/>
    <Label value="奔跑" background="#FF5722"/>
  </RectangleLabels>
</View>
```

**从视频抽帧并导入：**
```bash
export LS_REFRESH_TOKEN="你的token"

python3 label_studio/extract_frames.py \
    --video ~/label_infra/data/media/video.mp4 \
    --project <项目ID> --fps 1
```

---

#### I. 图片二分类目标检测（正常 / 异常）

任务数据字段：`$image`

> 图片项目只接受 JPG/PNG，视频需先用 `extract_frames.py` 抽帧。

```xml
<View>
  <Image name="image" value="$image"/>

  <RectangleLabels name="label" toName="image">
    <Label value="正常" background="#4CAF50"/>
    <Label value="异常" background="#F44336"/>
  </RectangleLabels>
</View>
```

---

#### H. 纯 IMU 标注（仅 CSV）

任务数据字段：`$csv`

```xml
<View>
  <TimeSeriesLabels name="label" toName="ts">
    <Label value="活动" background="#4CAF50"/>
    <Label value="睡觉" background="#2196F3"/>
    <Label value="抓挠" background="#F44336"/>
    <Label value="甩身体" background="#FF9800"/>
    <Label value="跳跃" background="#9C27B0"/>
    <Label value="舔身体" background="#00BCD4"/>
    <Label value="啃身体" background="#795548"/>
    <Label value="奔跑" background="#FF5722"/>
    <Label value="行走" background="#607D8B"/>
    <Label value="进食" background="#8BC34A"/>
    <Label value="饮水" background="#03A9F4"/>
    <Label value="蹭擦身体" background="#E91E63"/>
    <Label value="嗅闻" background="#FFC107"/>
    <Label value="戴摘项圈" background="#9E9E9E"/>
    <Label value="伸懒腰" background="#FFEB3B"/>
    <Label value="未佩戴" background="#546E7A"/>
    <Label value="项圈松动" background="#FF7043"/>
  </TimeSeriesLabels>
  <TimeSeries name="ts" value="$csv" valueType="url"
              timeColumn="timestamp"
              timeFormat="%Y-%m-%d %H:%M:%S.%f"
              timeDisplayFormat="%H:%M:%S"
              sep=",">
    <Channel column="acc_x"  strokeColor="#e74c3c" legend="Acc X"  height="50"/>
    <Channel column="acc_y"  strokeColor="#2ecc71" legend="Acc Y"  height="50"/>
    <Channel column="acc_z"  strokeColor="#3498db" legend="Acc Z"  height="50"/>
    <Channel column="gyro_x" strokeColor="#e67e22" legend="Gyro X" height="50"/>
    <Channel column="gyro_y" strokeColor="#1abc9c" legend="Gyro Y" height="50"/>
    <Channel column="gyro_z" strokeColor="#9b59b6" legend="Gyro Z" height="50"/>
  </TimeSeries>
</View>
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LS_API_KEY` | 无（必填） | Label Studio 静态 API Key，不随容器重建失效。获取：右上角头像 → Account & Settings → Access Token |
| `LS_URL` | `http://192.168.2.140:8181` | Label Studio 地址 |
| `NGINX_BASE_URL` | `http://192.168.2.140:8182/transcoded` | 转码文件访问基础 URL |
| `NGINX_MEDIA_URL` | `http://192.168.2.140:8182` | nginx 根地址（upload_server 使用） |
| `OUTPUT_DIR` | `~/label_infra/data/media/transcoded` | 转码输出目录 |
| `UPLOAD_DIR` | `~/label_infra/data/label_studio/media/upload` | Label Studio 上传目录 |
| `POLL_INTERVAL` | `10` | 轮询间隔（秒） |
| `SERVER_IP` | 自动检测 | 服务器 IP（setup.sh 使用） |

---

## 依赖

- Docker
- Python 3.10+
- `pip install requests`
- ffmpeg（`apt install ffmpeg`）
- NVIDIA GPU + 驱动（可选，无 GPU 自动降级到 CPU 转码）
