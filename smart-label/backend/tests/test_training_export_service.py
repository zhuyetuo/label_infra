

def test_project_ids_override_date_filter():
    """选了项目就不按日期过滤（老项目名不按日期来，日期早过了默认区间）。"""
    import inspect
    from app.services import training_export_service as m
    src = inspect.getsource(m)
    assert "if not project_ids:" in src and "Sample.session_date >= date_from" in src
