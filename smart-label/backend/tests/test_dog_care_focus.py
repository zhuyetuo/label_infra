"""重点护理：标上之后皮肤跟踪的每一行都带着（前端「只看重点护理」靠它）"""

import pytest
from fastapi import HTTPException

from app.api.v1 import dogs as dogs_api
from app.models.dog import Dog
from app.models.user import User, UserRole
from app.services.dog_name_service import dog_meta, dog_profiles


def test_标重点护理_跟踪行带上(db, run):
    d = Dog(dog_code="bolangwang-001", name="奥迪", breed="东德牧羊犬", site="佛山博朗旺狗场")
    db.add(d)
    run(db.commit())
    m = dog_meta(run(dog_profiles(db)), None, "IMU9", "奥迪")
    assert m["care_focus"] is False and m["dog_id"] == d.id
    run(dogs_api.set_care_focus(d.id, dogs_api.CareFocusIn(on=True), db=db))
    m = dog_meta(run(dog_profiles(db)), None, "IMU9", "奥迪")
    assert m["care_focus"] is True
    with pytest.raises(HTTPException):
        run(dogs_api.set_care_focus(999999, dogs_api.CareFocusIn(on=True), db=db))
