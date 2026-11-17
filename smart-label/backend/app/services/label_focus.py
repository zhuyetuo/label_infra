"""「当前重点补什么」：全平台一个设置，侧栏角标、项目行上的「xx 未通过 / 未审 / 全部通过」都按它统计。

以前写死成「抓挠」。抓挠补得差不多了，现在要重点补负例（进食 / 饮水 / 嗅闻——容易被判成抓挠的动作），
得让所有人一眼知道现在重点是什么、还差多少。管理员在项目页顶部切换。

存成 NAS 上的一个小 JSON（nas_root/.smart_label/label_focus.json）：两个后端实例（api / api_b）
挂的是同一个 nas_root，切了马上两边一致；不用为一个开关加表、跑迁移。读不到 / 坏了就当默认（抓挠）。
"""
from __future__ import annotations

import json
import os
from datetime import datetime

from app.core.config import settings

# key → 显示名 + 统计哪几个类别（各自含子类，见 label_review_progress）
PRESETS: dict[str, dict] = {
    "scratch": {"key": "scratch", "name": "抓挠", "labels": ["抓挠"],
                "hint": "抓挠（含各部位细类）"},
    "neg": {"key": "neg", "name": "负例", "labels": ["进食", "饮水", "嗅闻"],
            "hint": "负例：进食 / 饮水 / 嗅闻——容易被判成抓挠的动作，补了用来压抓挠误报（配「只补负例候选」）"},
}
DEFAULT = "scratch"


def _path() -> str:
    return os.path.join(settings.nas_root, ".smart_label", "label_focus.json")


def options() -> list[dict]:
    return [dict(v) for v in PRESETS.values()]


def get() -> dict:
    key, by, at = DEFAULT, None, None
    try:
        with open(_path(), encoding="utf-8") as f:
            d = json.load(f) or {}
        if d.get("key") in PRESETS:
            key, by, at = d["key"], d.get("by"), d.get("at")
    except (OSError, ValueError):
        pass
    return {**PRESETS[key], "by": by, "at": at, "options": options()}


def set_focus(key: str, by: str | None) -> dict:
    if key not in PRESETS:
        raise ValueError(f"不认识的重点：{key}（可选 {', '.join(PRESETS)}）")
    p = _path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"key": key, "by": by, "at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}, f, ensure_ascii=False)
    os.replace(tmp, p)
    return get()
