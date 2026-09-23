"""训练出来的模型跟默认模型同名 ml_rf.pkl：结果的 mode 必须带完整版本串，不然记录撞车。"""
from app.services import algo_client


def test_stamp_spec_replaces_post_mode():
    rows = [{"ok": True, "result": {"mode": "viterbi", "model_path": "/x/ml_rf.pkl"}},
            {"ok": False, "error": "x"}]
    out = algo_client.stamp_spec(rows, "srv:train6")
    assert out[0]["result"]["mode"] == "srv:train6"
    assert out[1] == {"ok": False, "error": "x"}


def test_model_version_out_has_listed():
    from app.schemas.model_version import ModelVersionOut
    assert "listed" in ModelVersionOut.model_fields
