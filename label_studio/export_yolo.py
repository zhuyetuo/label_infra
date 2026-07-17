"""
export_yolo.py
==============
将 Label Studio 视频框追踪标注导出为 YOLO 逐帧格式。

用法：
  python3 label_studio/export_yolo.py \
      --json export.json \
      --video data/media/transcoded/xxx.mp4 \
      --output dataset/ \
      --class 抓挠

输出结构：
  dataset/
  ├── images/   # 每帧 JPG
  ├── labels/   # 每帧 YOLO txt（class cx cy w h）
  └── data.yaml # YOLO 训练配置
"""

import argparse
import json
import os
import subprocess
import sys


def interpolate_box(seq: list, frame_idx: int):
    """
    在关键帧序列中插值，返回指定帧的 (x, y, w, h) 或 None（disabled）。
    x/y/w/h 单位为百分比（0-100）。
    """
    # 找前后关键帧
    prev = None
    nxt = None
    for kf in seq:
        if kf["frame"] <= frame_idx:
            prev = kf
        elif nxt is None and kf["frame"] > frame_idx:
            nxt = kf

    if prev is None:
        return None
    if not prev.get("enabled", True):
        return None

    # 如果没有下一帧，用 prev
    if nxt is None:
        return prev["x"], prev["y"], prev["width"], prev["height"]

    # 线性插值
    t = (frame_idx - prev["frame"]) / (nxt["frame"] - prev["frame"])
    x = prev["x"] + t * (nxt["x"] - prev["x"])
    y = prev["y"] + t * (nxt["y"] - prev["y"])
    w = prev["width"]  + t * (nxt["width"]  - prev["width"])
    h = prev["height"] + t * (nxt["height"] - prev["height"])
    return x, y, w, h


def extract_frames(video_path: str, out_dir: str, fps: int = 5):
    """用 ffmpeg 抽帧。"""
    os.makedirs(out_dir, exist_ok=True)
    cmd = [
        "ffmpeg", "-i", video_path,
        "-vf", f"fps={fps}",
        "-q:v", "2",
        os.path.join(out_dir, "frame_%06d.jpg"),
        "-y"
    ]
    subprocess.run(cmd, check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--json",    required=True, help="Label Studio 导出的 JSON 文件")
    parser.add_argument("--video",   required=True, help="对应的视频文件路径")
    parser.add_argument("--output",  default="dataset", help="输出目录")
    parser.add_argument("--class",   dest="cls", default="抓挠", help="类别名称（默认：抓挠）")
    parser.add_argument("--fps",     type=int, default=5, help="抽帧帧率（默认5）")
    args = parser.parse_args()

    # 读取标注
    with open(args.json) as f:
        data = json.load(f)

    images_dir = os.path.join(args.output, "images")
    labels_dir = os.path.join(args.output, "labels")
    os.makedirs(images_dir, exist_ok=True)
    os.makedirs(labels_dir, exist_ok=True)

    # 抽帧
    print(f"📽  抽帧: {args.video} → {images_dir} ({args.fps}fps)")
    extract_frames(args.video, images_dir, fps=args.fps)

    # 获取视频总帧数和fps
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=nb_frames,r_frame_rate",
         "-of", "json", args.video],
        capture_output=True, text=True
    )
    probe_data = json.loads(probe.stdout)
    stream = probe_data["streams"][0]
    num, den = map(int, stream["r_frame_rate"].split("/"))
    video_fps = num / den
    print(f"   视频帧率: {video_fps:.2f}fps")

    # 收集所有标注的 videorectangle sequence
    sequences = []
    for task in data:
        for ann in task.get("annotations", []):
            for result in ann.get("result", []):
                if result.get("type") == "videorectangle":
                    sequences.append(result["value"]["sequence"])

    if not sequences:
        print("❌ 未找到 videorectangle 标注")
        sys.exit(1)

    print(f"   找到 {len(sequences)} 个追踪框")

    # 遍历抽出的帧，生成 YOLO 标注
    frame_files = sorted(f for f in os.listdir(images_dir) if f.endswith(".jpg"))
    labeled = 0

    for i, fname in enumerate(frame_files):
        # 抽帧编号从1开始，对应视频帧号 = i * (video_fps / args.fps)
        video_frame = int(round(i * video_fps / args.fps)) + 1

        label_path = os.path.join(labels_dir, fname.replace(".jpg", ".txt"))
        lines = []

        for seq in sequences:
            box = interpolate_box(seq, video_frame)
            if box is None:
                continue
            x, y, w, h = box
            # 转为 YOLO 格式：center_x center_y width height（0-1）
            cx = (x + w / 2) / 100
            cy = (y + h / 2) / 100
            nw = w / 100
            nh = h / 100
            lines.append(f"0 {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}")

        if lines:
            with open(label_path, "w") as f:
                f.write("\n".join(lines))
            labeled += 1
        else:
            # 没有框的帧：空 txt（负样本）
            open(label_path, "w").close()

    print(f"✅ 共 {len(frame_files)} 帧，{labeled} 帧有标注框")

    # 生成 data.yaml
    yaml_path = os.path.join(args.output, "data.yaml")
    abs_images = os.path.abspath(images_dir)
    with open(yaml_path, "w") as f:
        f.write(f"""path: {os.path.abspath(args.output)}
train: images
val: images

nc: 1
names: ['{args.cls}']
""")
    print(f"✅ 生成 {yaml_path}")
    print(f"\n训练命令：")
    print(f"  yolo detect train data={yaml_path} model=yolov8n.pt epochs=100 imgsz=640")


if __name__ == "__main__":
    main()
