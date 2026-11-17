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

# key → 显示名 + 统计哪几个类别（各自含子类，见 label_review_progress）。
# **一次只盯一类**：负例不能合成一组——合在一起看，大家不知道该先补哪个，数字也看不出哪类还缺。
# labels 里放同一类的新旧名字（舔 / 舔身体…都是平台上实际有的标签），统计时一起算
_NEG = "容易被判成抓挠的动作，补了用来压抓挠误报"
PRESETS: dict[str, dict] = {
    "scratch": {"key": "scratch", "name": "抓挠", "labels": ["抓挠"],
                "hint": "抓挠（含各部位细类）。优先补 2 秒以内的短抓挠、样本少的部位（肩胸、耳/耳后）、新狗"},
    "lick": {"key": "lick", "name": "舔", "labels": ["舔", "舔身体"],
             "hint": f"舔自己（舔爪 / 后腿 / 身体，含各部位细类）：{_NEG}，跟挠头颈最像，现在几乎没有数据"},
    "chew": {"key": "chew", "name": "啃", "labels": ["啃", "啃身体"],
             "hint": f"啃自己（啃后腿 / 会阴 / 尾巴，含各部位细类）：{_NEG}，头部快速小幅抖动，频率接近抓挠"},
    "rub": {"key": "rub", "name": "蹭", "labels": ["蹭", "蹭擦身体"],
            "hint": f"蹭（地 / 墙 / 家具）、打滚，含各部位细类：{_NEG}，身体来回摩擦，节律跟挠身体像"},
    "eat": {"key": "eat", "name": "进食", "labels": ["进食"],
            "hint": f"进食（含啃骨头 / 玩具）：{_NEG}。公开数据能补一部分，自家项圈的样本仍然要有"},
    "drink": {"key": "drink", "name": "饮水", "labels": ["饮水"],
              "hint": f"饮水 / 舔碗：{_NEG}。公开数据能补一部分，自家项圈的样本仍然要有"},
    "sniff": {"key": "sniff", "name": "嗅闻", "labels": ["嗅闻"],
              "hint": f"嗅闻（低头小步走）：{_NEG}。公开数据已经有不少"},
    "shake": {"key": "shake", "name": "甩身体", "labels": ["甩身体"],
              "hint": "甩身体（全身抖）：大幅、节律快，也容易被判成抓挠"},
}
DEFAULT = "scratch"


def _path() -> str:
    return os.path.join(settings.nas_root, ".smart_label", "label_focus.json")


def _with_flag(v: dict) -> dict:
    """除了抓挠都是负例：带个标志，界面上显示成「负例·舔」，一眼知道现在补的是负例、是哪一类"""
    neg = v["key"] != "scratch"
    return {**v, "neg": neg, "title": f"负例·{v['name']}" if neg else v["name"]}


def options() -> list[dict]:
    return [_with_flag(v) for v in PRESETS.values()]


def get() -> dict:
    key, by, at = DEFAULT, None, None
    try:
        with open(_path(), encoding="utf-8") as f:
            d = json.load(f) or {}
        if d.get("key") in PRESETS:
            key, by, at = d["key"], d.get("by"), d.get("at")
    except (OSError, ValueError):
        pass
    return {**_with_flag(PRESETS[key]), "by": by, "at": at, "options": options()}


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
