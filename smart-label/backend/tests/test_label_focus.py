"""「当前重点补什么」：默认抓挠；一次只能选一类；不认识的不让切；文件坏了 / 存的是下线了的选项都退回默认"""
import json

import pytest

from app.core.config import settings
from app.services import label_focus


@pytest.fixture
def nas(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "nas_root", str(tmp_path))
    return tmp_path


def test_default_is_scratch(nas):
    f = label_focus.get()
    assert f["key"] == "scratch" and f["labels"] == ["抓挠"] and f["by"] is None


def test_each_option_is_one_class(nas):
    """负例不能合成一组：每个选项只对应一类（新旧名字算同一类）"""
    names = [o["name"] for o in label_focus.options()]
    assert names == ["抓挠", "舔", "啃", "蹭", "进食", "饮水", "嗅闻", "甩身体"]
    for o in label_focus.options():
        assert all(lab.startswith(o["name"][0]) for lab in o["labels"]), o


def test_negatives_carry_flag(nas):
    """除了抓挠都是负例，显示名带「负例·」"""
    by = {o["key"]: o for o in label_focus.options()}
    assert by["scratch"]["neg"] is False and by["scratch"]["title"] == "抓挠"
    assert all(o["neg"] and o["title"] == f"负例·{o['name']}" for k, o in by.items() if k != "scratch")
    assert label_focus.get()["title"] == "抓挠"


def test_switch_and_back(nas):
    f = label_focus.set_focus("lick", "admin")
    assert f["name"] == "舔" and f["labels"] == ["舔", "舔身体"] and f["by"] == "admin"
    assert f["neg"] is True and f["title"] == "负例·舔"
    assert label_focus.get()["key"] == "lick"          # 存下来了，另一个后端实例读到的也是它
    assert label_focus.set_focus("scratch", "admin")["labels"] == ["抓挠"]


def test_unknown_key_rejected(nas):
    with pytest.raises(ValueError):
        label_focus.set_focus("neg", "admin")           # 以前那个「负例」整组已经下线
    assert label_focus.get()["key"] == "scratch"


def test_stale_or_broken_file_falls_back(nas):
    p = nas / ".smart_label" / "label_focus.json"
    p.parent.mkdir()
    p.write_text(json.dumps({"key": "neg"}), encoding="utf-8")
    assert label_focus.get()["key"] == "scratch"
    p.write_text("{坏的", encoding="utf-8")
    assert label_focus.get()["key"] == "scratch"
