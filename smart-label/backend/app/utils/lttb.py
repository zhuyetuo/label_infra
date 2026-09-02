"""
LTTB (Largest-Triangle-Three-Buckets) 降采样。
六轴共享同一组被选中的采样点（在主通道上跑一次LTTB选点，其余通道按同样的下标采样），
保证 uPlot 多 series 共享同一个 x 轴、点击曲线跳转视频的时间精度也一致。
"""

import numpy as np


def lttb_select_indices(x: np.ndarray, y: np.ndarray, n_out: int) -> np.ndarray:
    """返回被选中的下标数组（长度 n_out，含首尾两点）。"""
    n = len(x)
    if n_out >= n or n_out <= 2:
        return np.arange(n)

    selected = np.empty(n_out, dtype=np.int64)
    selected[0] = 0
    selected[-1] = n - 1

    bucket_size = (n - 2) / (n_out - 2)
    a = 0  # 上一个被选中的点

    for i in range(n_out - 2):
        bucket_start = int(np.floor(i * bucket_size)) + 1
        bucket_end = int(np.floor((i + 1) * bucket_size)) + 1
        bucket_end = min(bucket_end, n - 1)

        next_start = int(np.floor((i + 1) * bucket_size)) + 1
        next_end = int(np.floor((i + 2) * bucket_size)) + 1
        next_end = min(next_end, n)
        if next_start >= next_end:
            avg_x, avg_y = x[a], y[a]
        else:
            avg_x = x[next_start:next_end].mean()
            avg_y = y[next_start:next_end].mean()

        seg = np.arange(bucket_start, max(bucket_end, bucket_start + 1))
        seg = seg[seg < n - 1]
        if len(seg) == 0:
            selected[i + 1] = a
            continue

        area = np.abs(
            (x[a] - avg_x) * (y[seg] - y[a]) - (x[a] - x[seg]) * (avg_y - y[a])
        )
        chosen = seg[np.argmax(area)]
        selected[i + 1] = chosen
        a = chosen

    return np.unique(selected)
