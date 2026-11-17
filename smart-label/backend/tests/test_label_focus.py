"""「当前重点补什么」：默认抓挠；切成负例后统计进食 / 饮水 / 嗅闻；不认识的不让切；文件坏了退回默认"""
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
    assert {o["key"] for o in f["options"]} == {"scratch", "neg"}


def test_switch_to_negatives_and_back(nas):
    f = label_focus.set_focus("neg", "admin")
    assert f["name"] == "负例" and f["labels"] == ["进食", "饮水", "嗅闻"] and f["by"] == "admin"
    assert label_focus.get()["key"] == "neg"          # 存下来了，另一个后端实例读到的也是它
    assert label_focus.set_focus("scratch", "admin")["labels"] == ["抓挠"]


def test_unknown_key_rejected(nas):
    with pytest.raises(ValueError):
        label_focus.set_focus("舔", "admin")
    assert label_focus.get()["key"] == "scratch"


def test_broken_file_falls_back(nas):
    p = nas / ".smart_label" / "label_focus.json"
    p.parent.mkdir()
    p.write_text("{坏的", encoding="utf-8")
    assert label_focus.get()["key"] == "scratch"
