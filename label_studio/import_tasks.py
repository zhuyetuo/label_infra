"""
import_tasks.py
==============
扫描媒体目录，将同名的 MP4 + CSV 自动配对，批量导入到指定 Label Studio 项目。

文件命名规则：
  同名文件自动配对，例如：
    26060315.mp4  +  26060315.csv  →  一个任务
    26060603.mp4  +  26060603.csv  →  一个任务

用法：
  python3 label_studio/import_tasks.py --project <项目ID>

  可选参数：
    --project   目标项目 ID（在 Label Studio URL 里看：/projects/3/）
    --media-dir 媒体文件目录，默认 ~/label_infra/data/media/
    --dry-run   只打印配对结果，不实际导入
"""

import argparse
import os
import glob
import requests
import time

LS_URL         = os.getenv("LS_URL",          "http://192.168.2.140:8181")
LS_API_KEY     = os.getenv("LS_API_KEY",      "")
NGINX_BASE_URL = os.getenv("NGINX_BASE_URL",  "http://192.168.2.140:8182")
MEDIA_DIR      = os.getenv("MEDIA_DIR",       os.path.expanduser("~/label_infra/data/media"))


def headers() -> dict:
    return {"Authorization": f"Token {LS_API_KEY}", "Content-Type": "application/json"}


def find_pairs(media_dir: str) -> list[dict]:
    """扫描目录，返回同名 mp4+csv 配对列表"""
    transcoded_dir = os.path.join(media_dir, "transcoded")
    pairs = []

    # 查找所有 CSV 文件
    for csv_path in sorted(glob.glob(f"{media_dir}/*.csv")):
        name = os.path.splitext(os.path.basename(csv_path))[0]

        # 优先用转码后的视频，没有就用原始
        mp4_transcoded = os.path.join(transcoded_dir, f"{name}.mp4")
        mp4_original   = os.path.join(media_dir, f"{name}.mp4")

        if os.path.exists(mp4_transcoded):
            video_url = f"{NGINX_BASE_URL}/transcoded/{name}.mp4"
        elif os.path.exists(mp4_original):
            video_url = f"{NGINX_BASE_URL}/{name}.mp4"
        else:
            print(f"  ⚠️  {name}.csv 没有对应的 MP4，跳过")
            continue

        csv_url = f"{NGINX_BASE_URL}/{name}.csv"
        pairs.append({"name": name, "video": video_url, "csv": csv_url})

    return pairs


def import_tasks(project_id: int, pairs: list[dict]) -> None:
    tasks = [{"data": {"video": p["video"], "csv": p["csv"]}} for p in pairs]
    r = requests.post(
        f"{LS_URL}/api/projects/{project_id}/import",
        json=tasks,
        headers=headers(),
        timeout=60,
    )
    r.raise_for_status()
    result = r.json()
    print(f"✅ 导入完成：{result.get('task_count', len(tasks))} 个任务")


def main():
    parser = argparse.ArgumentParser(description="批量导入视频+IMU配对任务到 Label Studio")
    parser.add_argument("--project", type=int, required=True, help="Label Studio 项目 ID")
    parser.add_argument("--media-dir", default=MEDIA_DIR, help="媒体文件目录")
    parser.add_argument("--dry-run", action="store_true", help="只打印配对结果，不导入")
    args = parser.parse_args()

    if not LS_API_KEY:
        raise RuntimeError("请设置 LS_API_KEY 环境变量")

    print(f"扫描目录：{args.media_dir}")
    pairs = find_pairs(args.media_dir)

    if not pairs:
        print("未找到任何配对文件")
        return

    print(f"\n找到 {len(pairs)} 对文件：")
    for p in pairs:
        print(f"  {p['name']}")
        print(f"    视频: {p['video']}")
        print(f"    CSV : {p['csv']}")

    if args.dry_run:
        print("\n（dry-run 模式，未导入）")
        return

    print(f"\n导入到项目 {args.project}...")
    import_tasks(args.project, pairs)


if __name__ == "__main__":
    main()
