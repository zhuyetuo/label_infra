"""ffprobe 探测视频元信息，供样本导入时填充 duration/fps/resolution。失败不抛异常，返回 None。"""

import csv
import json
import subprocess
from datetime import datetime


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


def measure_csv_hz(path: str, probe_rows: int = 400) -> float | None:
    """
    量一下这份 CSV 的采样率（Hz）。

    为什么要量：整套流程原来假设所有样本都是同一个采样率（label_service 的
    DEVICE_HZ，默认 50）。但 8-11 之前的数据是采集端就已经从 100Hz 降到 16Hz
    存下来的，8-11 起才是 50Hz 原始流——两种混在一起，按 50Hz 去跑 16Hz 的文件，
    重采样和特征窗口全是错的，模型输出没有意义。所以导入时就记下来，后面
    该按哪个频率处理、哪些不该混着训练，才有依据。

    取前几百行相邻时间戳差值的中位数：用中位数而不是首尾平均，是因为中间掉数据
    的那种缝会把平均值拉偏，中位数不受影响。

    第一列有两种写法，都得认：
    - 降过采样的那批是可读的日期时间串（`2026-08-11 00:00:02.781`）；
    - 采集端直接写的 raw 是 `pc_ms`，epoch 毫秒的浮点数（`1786424400488.073`）。
      只按日期串解析的话 raw 全部量不出来，采样率就留空、推理退回全局默认值——
      正好是这个字段要避免的事。
    """
    fmts = ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S.%f")

    def _parse(v: str) -> float | None:
        """统一返回"秒"，不管原来是日期串还是 epoch 数字。"""
        v = v.strip()
        for f in fmts:
            try:
                return datetime.strptime(v, f).timestamp()
            except ValueError:
                continue
        try:
            n = float(v)
        except ValueError:
            return None
        # 纯数字得判断单位。用绝对量级判断最稳：当前的 epoch 秒是 1.8e9 这个量级，
        # 毫秒 1.8e12，微秒 1.8e15，三者差着一千倍，不会认错。相邻差值判断不了——
        # 50Hz 的毫秒间隔是 20，16Hz 的秒间隔是 0.06，两个都说得通。
        a = abs(n)
        if a >= 1e14:
            return n / 1e6
        if a >= 1e11:
            return n / 1e3
        return n

    try:
        with open(path, encoding="utf-8-sig", newline="") as f:
            reader = csv.reader(f)
            try:
                next(reader)  # 表头
            except StopIteration:
                return None
            ts: list[float] = []
            for row in reader:
                if not row or not row[0]:
                    continue
                t = _parse(row[0])
                if t is not None:
                    ts.append(t)
                if len(ts) >= probe_rows:
                    break
    except OSError:
        return None
    if len(ts) < 10:
        return None
    # 采样率 = 这段时间里有多少行，不是"相邻间隔的倒数"。
    #
    # raw 那批的 pc_ms 是 PC 收到数据的时刻，一次串口读里可能带回好几帧，于是
    # 同一毫秒落进两三行，相邻差值长这样：0, 40, 0, 40...。原来为了躲时钟回拨
    # 只留 > 0 的差值，把 0 全扔掉，中位数就成了 40ms —— 50Hz 的文件量出 25Hz，
    # 三帧一组的量出 33Hz，正好是真值的 1/2、2/3。
    #
    # 所以 0 差值必须算进去。但也不能直接拿首尾平均：中间掉一段数据的缝会把
    # 结果拉低。要剔掉数据缝，就得先有个"正常间隔"当标尺。
    #
    # ⚠ 这个标尺不能用"非零差值的中位数"。狗场 6 个设备挂一个蓝牙适配器，一次
    # 串口读经常带回一整批帧，写进 CSV 就是「几行挤在同一瞬间，然后隔一个整包的
    # 时间」——非零差值里占多数的是包内那种零点几毫秒，中位数就是零点几毫秒，
    # 乘十也还是几毫秒，于是真正的包间隔（20ms）全被当成"数据缝"剔掉，只剩包内
    # 那点时间当分母。50Hz 的文件量出三四千 Hz，就是这么来的。
    #
    # 改用全部差值的平均值当标尺：一批帧挤在一起不会把平均值拉动多少（总时长
    # 摆在那儿），而真正掉一段数据的缝一定远大于平均值。剔掉缝之后平均值会更
    # 准，所以再迭代两轮收敛。
    deltas = [d for d in (ts[i + 1] - ts[i] for i in range(len(ts) - 1)) if d >= 0]
    if not deltas or sum(deltas) <= 0:
        return None
    kept = deltas
    for _ in range(3):
        gap_limit = (sum(kept) / len(kept)) * 10
        shrunk = [d for d in kept if d <= gap_limit]
        if not shrunk or sum(shrunk) <= 0 or len(shrunk) == len(kept):
            break
        kept = shrunk
    span = sum(kept)
    if span <= 0:
        return None
    return round(len(kept) / span, 1)


def count_csv_rows(path: str) -> int | None:
    try:
        with open(path, "rb") as f:
            count = sum(1 for _ in f) - 1  # 减去表头
        return max(count, 0)
    except OSError:
        return None
