"""
视觉标注（雏形）：在素材库 NAS 的口腔/皮肤照片上画框 + 打类别 + 填属性。

刻意跟现有的标注链路（samples / tasks / annotation_records / annotation_label_items）
完全隔离——那套是一维时间段的，几何标注塞不进去，而改它会动到认领、审核、导出、
鉴权一整层。雏形阶段先自成一套两张表，等形态定了再谈要不要并进主链路。

照片本身一个字节都不动，这里只存「相对相册目录的路径 + 归一化的框」。
"""

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class VisionAsset(Base):
    """
    一张照片在这轮标注里的状态。

    为什么要有这张表：没有它就区分不了「这张还没标」和「这张看过了、确实没有目标」。
    导出训练集时这两者天差地别——前者漏标当负样本会教坏模型，后者是货真价实的
    背景图。而且这个错误查不出来，等发现时数据集已经脏了。
    """

    __tablename__ = "vision_assets"
    __table_args__ = (
        UniqueConstraint("album", "rel_path", name="uq_vision_assets_album_path"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    album: Mapped[str] = mapped_column(String(20), nullable=False, comment="oral=口腔 / skin=皮肤，跟 material 相册同名")
    rel_path: Mapped[str] = mapped_column(String(500), nullable=False, comment="相对该相册根目录的路径")

    state: Mapped[str] = mapped_column(String(20), nullable=False, default="todo", comment="todo 未标 / done 标完 / skipped 跳过")
    skip_reason: Mapped[str | None] = mapped_column(String(200), nullable=True)
    attrs: Mapped[str] = mapped_column(Text, nullable=False, default="{}", comment="图级属性 JSON：口腔的 view_code、皮肤的 body_site 等")

    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)

    updated_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class VisionAnnotation(Base):
    """
    照片上的一个框。

    bbox 存归一化坐标（0-1 的 x/y/w/h），这样原图缩放、换显示尺寸都不用重算；
    导出 YOLO 时也正好是它要的格式。attrs 里装牙位/分级/严重度这类随类别而变的字段，
    不为每个业务字段单独开列——雏形阶段类别体系还会动，开成列每改一次就要一次迁移。
    """

    __tablename__ = "vision_annotations"
    __table_args__ = (
        Index("ix_vision_annotations_album_path", "album", "rel_path"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    album: Mapped[str] = mapped_column(String(20), nullable=False)
    rel_path: Mapped[str] = mapped_column(String(500), nullable=False)

    label_code: Mapped[str] = mapped_column(String(40), nullable=False, comment="类别代码，见 vision_service.LABELS")
    bbox: Mapped[str] = mapped_column(Text, nullable=False, comment="JSON [x, y, w, h]，归一化到 0-1，左上角原点")
    attrs: Mapped[str] = mapped_column(Text, nullable=False, default="{}", comment="属性 JSON：牙齿 {tooth_code, ci, gi, visibility}，皮肤 {severity, area_band}")

    source: Mapped[str] = mapped_column(String(20), nullable=False, default="human", comment="human 人画的 / ai 模型预标的（雏形阶段只有 human）")

    created_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
