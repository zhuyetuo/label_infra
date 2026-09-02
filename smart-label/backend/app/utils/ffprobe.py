"""ffprobe 探测视频元信息，供样本导入时填充 duration/fps/resolution。失败不抛异常，返回 None。"""

import json
import subprocess


def probe_video(path: str) -> dict | None:
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=width,height,r_frame_rate",
                "-show_entries", "format=duration",
                "-of", "json", path,
            ],
            capture_output=True, text=True, timeout=30, check=True,
        )
        data = json.loads(result.stdout)
        stream = (data.get("streams") or [{}])[0]
        fmt = data.get("format") or {}
        fps = None
        if stream.get("r_frame_rate"):
            num, _, den = stream["r_frame_rate"].partition("/")
            if den and int(den) != 0:
                fps = round(int(num) / int(den), 2)
        return {
            "width": stream.get("width"),
            "height": stream.get("height"),
            "fps": fps,
            "duration_sec": int(float(fmt["duration"])) if fmt.get("duration") else None,
        }
    except (subprocess.SubprocessError, json.JSONDecodeError, KeyError, IndexError, ValueError):
        return None


def count_csv_rows(path: str) -> int | None:
    try:
        with open(path, "rb") as f:
            count = sum(1 for _ in f) - 1  # 减去表头
        return max(count, 0)
    except OSError:
        return None
