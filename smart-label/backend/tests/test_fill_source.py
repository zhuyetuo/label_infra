"""「补标」来源：普通来源（确认写进标注），重跑预标注不会把它冲掉，能按来源单独看、单独删。"""
from app.api.v1 import projects
from app.models.ai_candidate import FILL_REASONS, SPECIAL_REASONS
from app.services.ai_prelabel_service import PRELABEL_REASONS


def test_不是专项_确认会写进标注():
    assert not set(FILL_REASONS) & set(SPECIAL_REASONS)


def test_重跑预标注不会把补标冲掉():
    assert not set(FILL_REASONS) & set(PRELABEL_REASONS)


def test_能按来源单独看和删():
    assert projects._CAND_SOURCES["unl_fill"][0] == "unl_fill"
