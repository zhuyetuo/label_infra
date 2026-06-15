"""
auto_transcode.py
=================
轮询 Label Studio 所有项目，检测到 /data/upload/ 路径的视频后：
  1. 用 GPU (h264_nvenc) 转码为浏览器兼容的 H.264 MP4
  2. 将 Label Studio 任务的 video 字段更新为 nginx 可访问的 URL

依赖：
  pip install requests
  apt install ffmpeg  （需支持 h264_nvenc，即服务器有 NVIDIA GPU）

配置：
  编辑下方 CONFIG 区域，或通过环境变量覆盖：
    LS_URL              Label Studio 地址
    LS_REFRESH_TOKEN    从 Label Studio 用户设置页面获取的 JWT refresh token
    NGINX_BASE_URL      nginx 媒体服务的基础 URL
    OUTPUT_DIR          转码后文件存放目录
    UPLOAD_DIR          Label Studio 上传目录

用法：
  # 前台运行（调试）
  python3 auto_transcode.py

  # 后台运行
  nohup python3 auto_transcode.py >> transcode.log 2>&1 &
"""

import glob
import os
import subprocess
import time

import requests

# ── 配置项（可用环境变量覆盖）────────────────────────────────
LS_URL          = os.getenv("LS_URL",           "http://192.168.2.140:8181")
REFRESH_TOKEN   = os.getenv("LS_REFRESH_TOKEN", "")   # 必填
NGINX_BASE_URL  = os.getenv("NGINX_BASE_URL",   "http://192.168.2.140:8182/transcoded")
OUTPUT_DIR      = os.getenv("OUTPUT_DIR",       os.path.expanduser("~/ls-data/media/transcoded"))
UPLOAD_DIR      = os.getenv("UPLOAD_DIR",       os.path.expanduser("~/ls-data/media/upload"))
POLL_INTERVAL   = int(os.getenv("POLL_INTERVAL", "10"))   # 轮询间隔（秒）

# GPU 转码参数；若无 GPU 自动降级到 CPU
FFMPEG_GPU_ARGS = ["-hwaccel", "cuda", "-c:v", "h264_nvenc", "-preset", "fast", "-cq", "23"]
FFMPEG_CPU_ARGS = ["-c:v", "libx264", "-preset", "fast", "-crf", "23"]
# ─────────────────────────────────────────────────────────────

os.makedirs(OUTPUT_DIR, exist_ok=True)

_access_token: dict = {"val": None, "ts": 0}


def _refresh_access_token() -> str:
    r = requests.post(
        f"{LS_URL}/api/token/refresh",
        json={"refresh": REFRESH_TOKEN},
        timeout=10,
    )
    r.raise_for_status()
    token = r.json()["access"]
    _access_token["val"] = token
    _access_token["ts"] = time.time()
    return token


def get_token() -> str:
    if _access_token["val"] and (time.time() - _access_token["ts"]) < 86400:
        return _access_token["val"]
    return _refresh_access_token()


def headers() -> dict:
    return {"Authorization": f"Bearer {get_token()}", "Content-Type": "application/json"}


def _detect_gpu() -> bool:
    result = subprocess.run(
        ["ffmpeg", "-encoders"],
        capture_output=True, text=True
    )
    return "h264_nvenc" in result.stdout


def transcode(src: str, dst: str) -> bool:
    use_gpu = _detect_gpu()
    encode_args = FFMPEG_GPU_ARGS if use_gpu else FFMPEG_CPU_ARGS
    mode = "GPU" if use_gpu else "CPU"

    print(f"  🎬 转码 [{mode}]: {os.path.basename(src)}", flush=True)
    if use_gpu:
        cmd = ["ffmpeg", "-hwaccel", "cuda", "-i", src,
               "-c:v", "h264_nvenc", "-preset", "fast", "-cq", "23",
               "-c:a", "aac", "-movflags", "+faststart", "-y", dst]
    else:
        cmd = ["ffmpeg", "-i", src,
               "-c:v", "libx264", "-preset", "fast", "-crf", "23",
               "-c:a", "aac", "-movflags", "+faststart", "-y", dst]

    result = subprocess.run(cmd, capture_output=True)
    if result.returncode == 0:
        print(f"  ✅ 转码完成: {os.path.basename(dst)}", flush=True)
        return True
    else:
        print(f"  ❌ 转码失败: {result.stderr.decode()[-300:]}", flush=True)
        return False


def find_uploaded_file(fname: str) -> str | None:
    matches = glob.glob(f"{UPLOAD_DIR}/**/{fname}", recursive=True)
    return matches[0] if matches else None


def get_all_projects() -> list:
    r = requests.get(f"{LS_URL}/api/projects/?page_size=200", headers=headers(), timeout=10)
    return r.json().get("results", [])


def get_tasks(project_id: int) -> list:
    r = requests.get(
        f"{LS_URL}/api/tasks/?project={project_id}&page_size=500",
        headers=headers(), timeout=10,
    )
    r.raise_for_status()
    data = r.json()
    if isinstance(data, dict):
        # 兼容两种返回格式：{tasks:[...]} 或 {results:[...]}
        tasks = data.get("tasks") or data.get("results") or []
    elif isinstance(data, list):
        tasks = data
    else:
        tasks = []
    return tasks


def update_task_video(task_id: int, new_url: str) -> bool:
    r = requests.patch(
        f"{LS_URL}/api/tasks/{task_id}/",
        json={"data": {"video": new_url}},
        headers=headers(),
        timeout=10,
    )
    return r.status_code == 200


def main():
    if not REFRESH_TOKEN:
        raise RuntimeError(
            "请设置 LS_REFRESH_TOKEN 环境变量，或直接修改脚本中的 REFRESH_TOKEN 配置项。\n"
            "Token 获取方式：登录 Label Studio → 右上角头像 → Account & Settings → Personal Access Token"
        )

    processed: set[int] = set()
    print(f"🚀 auto_transcode 启动", flush=True)
    print(f"   Label Studio : {LS_URL}", flush=True)
    print(f"   转码输出目录  : {OUTPUT_DIR}", flush=True)
    print(f"   媒体服务地址  : {NGINX_BASE_URL}", flush=True)
    print(f"   轮询间隔      : {POLL_INTERVAL}s", flush=True)

    while True:
        try:
            projects = get_all_projects()
            for project in projects:
                pid = project["id"]
                tasks = get_tasks(pid)

                for task in tasks:
                    task_id = task["id"]
                    if task_id in processed:
                        continue

                    video_url: str = task.get("data", {}).get("video", "")

                    # 只处理还未转码的上传文件
                    if "/data/upload/" not in video_url:
                        continue

                    fname = video_url.split("/")[-1]
                    dst = os.path.join(OUTPUT_DIR, fname)
                    processed.add(task_id)

                    print(f"\n[项目 {pid}] 发现待处理任务 {task_id}: {fname}", flush=True)

                    # 查找本地文件
                    src = find_uploaded_file(fname)
                    if not src:
                        print(f"  ⚠️  找不到上传文件: {fname}", flush=True)
                        continue

                    # 等待文件写入完成
                    try:
                        s1 = os.path.getsize(src)
                        time.sleep(2)
                        s2 = os.path.getsize(src)
                        if s1 != s2:
                            processed.discard(task_id)  # 还在上传，下次再处理
                            continue
                    except OSError:
                        continue

                    # 转码（已存在则跳过）
                    if not os.path.exists(dst):
                        success = transcode(src, dst)
                    else:
                        print(f"  ℹ️  已有转码文件，跳过转码", flush=True)
                        success = True

                    if not success:
                        continue

                    # 更新 Label Studio 任务 URL
                    new_url = f"{NGINX_BASE_URL}/{fname}"
                    if update_task_video(task_id, new_url):
                        print(f"  ✅ 任务更新成功 → {new_url}", flush=True)
                    else:
                        print(f"  ❌ 任务更新失败", flush=True)

        except Exception as exc:
            print(f"⚠️  轮询错误: {exc}", flush=True)

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
