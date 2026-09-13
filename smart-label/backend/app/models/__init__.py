"""导入全部模型，供 alembic autogenerate 和 Base.metadata.create_all 发现表结构。"""

from app.models.ai_candidate import AiCandidate
from app.models.annotation import AnnotationLabelItem, AnnotationRecord
from app.models.audit_log import AuditLog
from app.models.background_job import BackgroundJob
from app.models.clip import ClipJob
from app.models.dog import Dog
from app.models.dog_measurement import DogMeasurement
from app.models.inference_run import SampleInferenceRun
from app.models.label import LabelDefinition
from app.models.label_template import LabelTemplate, LabelTemplateItem
from app.models.media_file import MediaFile
from app.models.model_version import ModelVersion
from app.models.project import Project
from app.models.review import ReviewRecord
from app.models.sample import Sample
from app.models.skin import SkinRecord, SkinWeeklyRow
from app.models.skin_daily import SkinDailyStat
from app.models.task import Task
from app.models.tooth_photo import ToothPhotoResult
from app.models.user import User
from app.models.vision_annotation import VisionAnnotation, VisionAsset

__all__ = [
    "AiCandidate",
    "DogMeasurement",
    "SampleInferenceRun",
    "SkinDailyStat",
    "User",
    "Project",
    "Dog",
    "Sample",
    "Task",
    "LabelDefinition",
    "LabelTemplate",
    "LabelTemplateItem",
    "MediaFile",
    "AnnotationRecord",
    "AnnotationLabelItem",
    "ReviewRecord",
    "ClipJob",
    "BackgroundJob",
    "AuditLog",
    "ModelVersion",
    "ToothPhotoResult",
    "SkinRecord",
    "SkinWeeklyRow",
    "VisionAsset",
    "VisionAnnotation",
]
