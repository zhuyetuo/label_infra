"""导入全部模型，供 alembic autogenerate 和 Base.metadata.create_all 发现表结构。"""

from app.models.annotation import AnnotationLabelItem, AnnotationRecord
from app.models.audit_log import AuditLog
from app.models.background_job import BackgroundJob
from app.models.clip import ClipJob
from app.models.label import LabelDefinition
from app.models.media_file import MediaFile
from app.models.review import ReviewRecord
from app.models.sample import Sample
from app.models.task import Task
from app.models.user import User

__all__ = [
    "User",
    "Sample",
    "Task",
    "LabelDefinition",
    "MediaFile",
    "AnnotationRecord",
    "AnnotationLabelItem",
    "ReviewRecord",
    "ClipJob",
    "BackgroundJob",
    "AuditLog",
]
