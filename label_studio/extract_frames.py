"""
extract_frames.py
=================
从视频中按固定帧率抽帧，保存为 JPG，并批量导入到 Label Studio 图片项目。

用法：
  python3 label_studio/extract_frames.py --video 视频.mp4 --project <项目ID>

  可选参数：
    --video      输入视频文件路径（支持 MP4、MOV、AVI 等）
    --project    Label Studio 项目 ID
    --fps        抽帧帧率，默认 1（每秒1帧）
    --output-dir 帧图片输出目录，默认 ~/label_infra/data/media/frames/
    --dry-run    只抽帧不导入
"""

import argparse
import os
import subprocess
import glob
import time
import requests

LS_URL         = os.getenv("LS_URL",           "http://192.168.2.140:8181")
REFRESH_TOKEN  = os.getenv("LS_REFRESH_TOKEN", "")
NGINX_BASE_URL = os.getenv("NGINX_MEDIA_URL",  "http://192.168.2.140:8182")
DEFAULT_OUTPUT = os.path.expanduser("~/label_infra/data/media/frames")

_token: dict = {"val": None, "ts": 0}


def get_token() -> str:
    if _token["val"] and (time.time() - _token["ts"]) < 86400:
        return _token["val"]
    r = requests.post(f"{LS_URL}/api/token/refresh",
                      json={"refresh": REFRESH_TOKEN}, timeout=10)
    r.raise_for_status()
    _token["val"] = r.json()["access"]
    _token["ts"] = time.time()
    return _token["val"]


def headers() -> dict:
    return {"Authorization": f"Bearer {get_token()}", "Content-Type": "application/json"}


def extract_frames(video_path: str, output_dir: str, fps: float) -> list[str]:
    """用 ffmpeg 抽帧，返回生成的图片路径列表"""
    os.makedirs(output_dir, exist_ok=True)

    video_name = os.path.splitext(os.path.basename(video_path))[0]
    pattern = os.path.join(output_dir, f"{video_name}_%06d.jpg")

    # 已有帧则跳过抽帧
    existing = sorted(glob.glob(os.path.join(output_dir, f"{video_name}_*.jpg")))
    if existing:
        print(f"ℹ️  已有 {len(existing)} 帧，跳过抽帧", flush=True)
        return existing

    cmd = [
        "ffmpeg", "-i", video_path,
        "-vf", f"fps={fps}",
        "-q:v", "2",
        "-y", pattern
    ]

    print(f"抽帧中：{os.path.basename(video_path)}  帧率={fps}fps", flush=True)
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        print(f"❌ 抽帧失败：{result.stderr.decode()[-300:]}", flush=True)
        return []

    frames = sorted(glob.glob(os.path.join(output_dir, f"{video_name}_*.jpg")))
    print(f"✅ 抽帧完成：共 {len(frames)} 帧 → {output_dir}", flush=True)
    return frames


def import_tasks(project_id: int, frames: list[str], output_dir: str) -> None:
    # 将本地路径转换为 nginx URL
    # output_dir 应在 ~/label_infra/data/media/ 下，nginx 从 media/ 根目录服务
    media_root = os.path.expanduser("~/label_infra/data/media")
    tasks = []
    for f in frames:
        rel = os.path.relpath(f, media_root)
        url = f"{NGINX_BASE_URL}/{rel}"
        tasks.append({"data": {"image": url}})

    print(f"导入 {len(tasks)} 个任务到项目 {project_id}...", flush=True)
    r = requests.post(
        f"{LS_URL}/api/projects/{project_id}/import",
        json=tasks, headers=headers(), timeout=120,
    )
    r.raise_for_status()
    count = r.json().get("task_count", len(tasks))
    print(f"✅ 导入完成：{count} 个任务", flush=True)


def main():
    parser = argparse.ArgumentParser(description="视频抽帧并导入 Label Studio")
    parser.add_argument("--video",      required=True,           help="输入视频路径")
    parser.add_argument("--project",    type=int,                help="Label Studio 项目 ID")
    parser.add_argument("--fps",        type=float, default=1.0, help="抽帧帧率（默认 1fps）")
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT,  help="帧图片输出目录")
    parser.add_argument("--dry-run",    action="store_true",     help="只抽帧不导入")
    args = parser.parse_args()

    if not os.path.exists(args.video):
        print(f"❌ 视频文件不存在：{args.video}")
        return

    frames = extract_frames(args.video, args.output_dir, args.fps)
    if not frames:
        return

    if args.dry_run:
        print(f"\n（dry-run 模式，未导入）")
        for f in frames[:5]:
            print(f"  {f}")
        if len(frames) > 5:
            print(f"  ... 共 {len(frames)} 帧")
        return

    if not args.project:
        print("❌ 请指定 --project <项目ID>")
        return

    if not REFRESH_TOKEN:
        print("❌ 请设置 LS_REFRESH_TOKEN 环境变量")
        return

    import_tasks(args.project, frames, args.output_dir)


if __name__ == "__main__":
    main()
