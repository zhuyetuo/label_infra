from fastapi import APIRouter

from app.api.v1 import (
    auth,
    clips,
    dashboard,
    dogs,
    imu,
    label_templates,
    labels,
    media,
    model_versions,
    projects,
    reviews,
    samples,
    tasks,
    tooth,
    users,
)

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(auth.router)
api_router.include_router(users.router)
api_router.include_router(projects.router)
api_router.include_router(labels.router)
api_router.include_router(label_templates.router)
api_router.include_router(samples.router)
api_router.include_router(samples.scoped_router)
api_router.include_router(tasks.router)
api_router.include_router(reviews.router)
api_router.include_router(media.router)
api_router.include_router(imu.router)
api_router.include_router(clips.router)
api_router.include_router(dashboard.router)
api_router.include_router(dogs.router)
api_router.include_router(model_versions.router)
api_router.include_router(model_versions.callback_router)
api_router.include_router(tooth.router)
api_router.include_router(tooth.stream_router)
