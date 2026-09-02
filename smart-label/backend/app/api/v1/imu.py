"""
IMU 六轴曲线 LTTB 降采样。TODO：
- GET /imu/{sample_id}/meta   返回总时长/采样率/行数，供前端初始化uPlot坐标轴
- GET /imu/{sample_id}/series?start_ms=&end_ms=&max_points=
      在 Parquet 缓存上做窗口切片 + 跨通道联合选点 LTTB，返回列式定长数值数组
      （不是"数组套对象"，减少前端 JSON.parse 后二次转换开销）
"""

from fastapi import APIRouter, Depends

from app.core.deps import get_current_user
from app.schemas.envelope import ok

router = APIRouter(prefix="/imu", tags=["imu"], dependencies=[Depends(get_current_user)])


@router.get("/{sample_id}/meta")
async def get_imu_meta(sample_id: int):
    return ok(None, msg="TODO: IMU元信息")
