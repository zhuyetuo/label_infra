"""
「要标的那只狗，到底在不在这段画面里」。

要解决的场景：标注员认领一份样本，打开、看波形、翻视频，十分钟之后才发现——
这段里那只狗压根不在画面里。IMU 还在身上（狗戴着跑到别的房间去了 / 被抱去
洗澡了 / 摄像头拍的是隔壁那间），但画面里没有它。

── 这里**不做**重识别模型 ──────────────────────────────────────────────

判"画面里这只白比熊是不是 bibi 而不是小白"，要重识别模型、要每只狗的注册图、
要处理换毛和光照——那是另一个项目。而且在这个场景里**大部分情况根本不需要**：

  狗场：一间一狗一摄像头。画面里那只狗就是这间的那只，没有别人。
        → 只要画面里"有狗"，身份就是确定的。
  影棚：一个大空间、四到八只狗同时在场、三路摄像头都可能拍到任意一只。
        → 光靠"有几只狗"根本判不出是哪只。

所以这里只用**确定性的信息**（狗档案的 IMU→狗、场地是不是一间一狗、画面里
几只狗），能判的给结论，判不了的**明说判不了**。

── 为什么"判不了"必须是一个明确的结论 ────────────────────────────────

如果判不了的时候返回"不在画面里"，影棚的每一份样本都会被标成"狗不在"——
人看两次发现是错的就再也不看这个提示了，这个功能等于没做。
如果判不了的时候返回"在画面里"，那它什么都没说，白占一列。

所以是三档：**在 / 不在 / 判不了**，而且"判不了"要带上为什么判不了。
"""

from app.services import vision_scan_service as vscan

#: 一间一狗一摄像头的场地。这些场地里"画面里有狗"就等于"那只狗在画面里"。
#: 按 sample_code 里的场地后缀认——采集端就是这么写进文件名和目录名的。
#:
#: 影棚**不在**这个名单里，而且不能加进来：一个大空间四到八只狗同时在场，
#: 三路摄像头都可能拍到任意一只，"有狗"跟"是哪只狗"完全是两回事。
ONE_DOG_PER_CAM_SITES = ("gouchang", "狗场")

PRESENT = "present"        # 那只狗在画面里
ABSENT = "absent"          # 那只狗不在画面里
UNKNOWN = "unknown"        # 判不了（要带上为什么）


def site_of(sample_code: str | None) -> str | None:
    """从样本编号里认场地。认不出来返回 None——**不猜**。

    猜错的方向是有偏的：猜成"一间一狗"会让影棚的样本拿到一个错的确定结论，
    而那个结论看起来跟对的一模一样。
    """
    code = (sample_code or "").lower()
    for site in ONE_DOG_PER_CAM_SITES:
        if site.lower() in code:
            return site
    return None


def is_one_dog_site(sample_code: str | None, day_dir: str | None = None) -> bool:
    """这份样本是不是来自"一间一狗一摄像头"的场地。

    样本编号里没有的话再看日期目录（`2026_9_13_gouchang`）——采集端是从
    DAY_SUFFIX 写进目录名的，编号里反而不一定带。
    """
    return site_of(sample_code) is not None or site_of(day_dir) is not None


def presence(
    sample_code: str | None,
    day_dir: str | None,
    scan_rows: list[dict],
    dog_name: str | None,
) -> dict:
    """那只狗在不在画面里。

    scan_rows：这份样本各路的扫描结果（vision_scan_service.row_to_dict 的形状）。
    dog_name：这份样本登记的是哪只狗（狗档案 IMU→狗 查出来的）；没登记就是 None。

    返回 {state, reason}。state 三档，reason 是给人看的一句话——
    尤其 unknown 一定要说清楚为什么，不然人只会看到一个没用的"判不了"。
    """
    if not dog_name:
        # 连"该是哪只狗"都不知道，无从判起。这不是画面的问题，是档案没登记
        return {"state": UNKNOWN, "reason": "这份样本还没登记是哪只狗（去狗档案把 IMU 号填上）"}

    v = vscan.sample_verdict(scan_rows)
    if v == "unscanned":
        return {"state": UNKNOWN, "reason": "还没扫过画面"}
    if v == "unknown":
        return {"state": UNKNOWN, "reason": "画面没扫成（有路失败或读不出），不是没狗"}

    one_dog = is_one_dog_site(sample_code, day_dir)

    if v == "no_dog":
        # 整段画面里一只狗都没有。**这一条跟场地无关**：不管几只狗共用一个
        # 空间，画面里没有狗，那只狗就一定不在画面里
        return {"state": ABSENT, "reason": f"整段画面里没有狗，{dog_name} 不在画面里"}

    if one_dog:
        # 一间一狗一摄像头：画面里的狗就是这间的那只
        if v == "mostly_empty":
            ratio = _worst_ratio(scan_rows)
            pct = f"{ratio * 100:.0f}%" if ratio is not None else "大部分"
            return {"state": PRESENT,
                    "reason": f"这是一间一狗的场地，画面里的就是 {dog_name}；但 {pct} 的时间它不在画面里"}
        return {"state": PRESENT, "reason": f"这是一间一狗的场地，画面里的就是 {dog_name}"}

    # 多狗同场（影棚）：有狗，但判不出是哪只。**必须说判不了**——
    # 说"在"是瞎猜，说"不在"会让人跳过真有素材的样本
    n = _max_dogs(scan_rows)
    extra = f"（画面里最多同时 {n} 只）" if n else ""
    return {"state": UNKNOWN,
            "reason": f"画面里有狗，但这个场地多只狗同场{extra}，判不出其中哪只是 {dog_name}"}


def _max_dogs(rows: list[dict]) -> int | None:
    vals = [r.get("max_dogs") for r in rows if r.get("max_dogs") is not None]
    return max(vals) if vals else None


def _worst_ratio(rows: list[dict]) -> float | None:
    """各路里"没狗比例"最小的那个——也就是狗出现得最多的那一路。

    取最小不是最大：多路拍同一个空间，只要有一路一直看得到狗，这份样本就
    不算"大部分时间没狗"。取最大的话，一路空镜就能把整份样本说成没素材。
    """
    vals = [r.get("no_dog_ratio") for r in rows
            if r.get("state") == "ok" and r.get("no_dog_ratio") is not None]
    return min(vals) if vals else None
