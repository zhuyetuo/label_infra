"""
convert_imu.py
==============
将 IMU TXT 文件批量转换为 Label Studio 兼容的 CSV 格式。

TXT 格式：
  HH:MM:SS.MS,AX,AY,AZ,GX,GY,GZ
  21:25:10.000,-4.441163,...

CSV 输出格式：
  timestamp,acc_x,acc_y,acc_z,gyro_x,gyro_y,gyro_z
  2026-06-17 21:25:10.000000,-4.441163,...

日期从文件名推断（前8位 YYYYMMDD），或通过 --date 指定。

用法：
  # 转换单个文件
  python3 label_studio/convert_imu.py data/imu/2026061711.TXT

  # 转换目录下所有 TXT
  python3 label_studio/convert_imu.py data/imu/

  # 指定日期
  python3 label_studio/convert_imu.py data/imu/ --date 2026-06-17
"""

import argparse
import csv
import os
import re


COL_MAP = {
    "AX": "acc_x", "AY": "acc_y", "AZ": "acc_z",
    "GX": "gyro_x", "GY": "gyro_y", "GZ": "gyro_z",
}


def parse_date(filename: str) -> str:
    """从文件名前8位提取日期，如 20260617 → 2026-06-17"""
    name = os.path.splitext(os.path.basename(filename))[0]
    m = re.match(r"(\d{4})(\d{2})(\d{2})", name)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return "1970-01-01"


def convert(txt_path: str, date: str = None) -> str:
    date = date or parse_date(txt_path)
    csv_path = os.path.splitext(txt_path)[0] + ".csv"

    with open(txt_path, encoding="utf-8") as fin, \
         open(csv_path, "w", newline="", encoding="utf-8") as fout:

        reader = csv.reader(fin)
        writer = csv.writer(fout)

        header = next(reader)
        writer.writerow(["timestamp"] + [COL_MAP.get(c.strip(), c.strip().lower()) for c in header[1:]])

        for row in reader:
            if not row or not row[0].strip():
                continue
            t = row[0].strip()
            hms, ms = t.rsplit(".", 1)
            ts = f"{date} {hms}.{ms.ljust(6, '0')}"
            writer.writerow([ts] + [v.strip() for v in row[1:]])

    return csv_path


def main():
    parser = argparse.ArgumentParser(description="IMU TXT → CSV 批量转换")
    parser.add_argument("path", help="TXT 文件路径或目录")
    parser.add_argument("--date", help="日期（YYYY-MM-DD），不填则从文件名推断")
    args = parser.parse_args()

    targets = []
    if os.path.isdir(args.path):
        for f in sorted(os.listdir(args.path)):
            if f.upper().endswith(".TXT"):
                targets.append(os.path.join(args.path, f))
    elif os.path.isfile(args.path):
        targets = [args.path]
    else:
        print(f"❌ 路径不存在: {args.path}")
        return

    if not targets:
        print("未找到 TXT 文件")
        return

    for txt in targets:
        csv_path = convert(txt, args.date)
        print(f"✅ {os.path.basename(txt)} → {os.path.basename(csv_path)}")


if __name__ == "__main__":
    main()
