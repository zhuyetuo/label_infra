# Windows 本地运行指南

在没有服务器的情况下，直接在 Windows 本地运行 Label Studio + 上传服务 + 转码服务。

---

## 依赖安装

### 1. Label Studio
```bash
pip install label-studio
label-studio start   # 启动，浏览器打开 http://localhost:8080
```

### 2. Python 依赖
```bash
pip install flask requests
```

### 3. ffmpeg（视频转码用）
1. 下载：https://ffmpeg.org/download.html → Windows builds（推荐 gyan.dev）
2. 解压，将 `bin` 目录添加到系统 PATH
3. 验证：`ffmpeg -version`

---

## 启动步骤

### 第一步：获取 Token（只需做一次）

1. 打开 `http://localhost:8080`，注册登录
2. 右上角头像 → **Account & Settings** → **Personal Access Token** → **Create New Token** → 复制

```bash
# 在 Git Bash 中运行
bash label_studio/set_token.sh "粘贴你的token"
```

### 第二步：启动所有服务

```bash
# 在 Git Bash 中运行（同时启动媒体服务 + 上传服务 + 转码服务）
bash win/start.sh
```

启动后：
- Label Studio：`http://localhost:8080`
- 媒体文件服务：`http://localhost:8182`
- 上传服务：`http://localhost:8183`

---

## 目录说明

Windows 版 Label Studio 的数据存放在：
```
C:\Users\<用户名>\AppData\Local\label-studio\label-studio\media\
├── upload\      # Label Studio 上传的原始文件
└── transcoded\  # 转码后的视频（自动生成）
```

`media_server.py` 会自动找到这个目录并作为静态文件服务的根目录。

---

## 单独启动某个服务

```bash
# 只启动媒体文件服务
python win/media_server.py

# 指定自定义目录
python win/media_server.py --dir "C:/你的媒体目录" --port 8182

# 只启动上传服务
export LS_REFRESH_TOKEN="你的token"
export LS_URL="http://localhost:8080"
export NGINX_MEDIA_URL="http://localhost:8182"
python label_studio/upload_server.py

# 只启动转码服务
export LS_REFRESH_TOKEN="你的token"
export LS_URL="http://localhost:8080"
export NGINX_BASE_URL="http://localhost:8182/transcoded"
python label_studio/auto_transcode.py
```

---

## 验证 Token 是否有效

```bash
source .env
ACCESS=$(curl -s -X POST http://localhost:8080/api/token/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refresh\": \"$LS_REFRESH_TOKEN\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['access'])")
curl -s -H "Authorization: Bearer $ACCESS" http://localhost:8080/api/projects/?page_size=1
```

返回项目列表则正常，返回 `401` 则重新获取 token 后再跑 `set_token.sh`。
