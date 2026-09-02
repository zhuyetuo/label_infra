from fastapi import APIRouter

from app.api.v1 import auth, clips, dashboard, imu, labels, media, reviews, samples, tasks, users

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(auth.router)
api_router.include_router(users.router)
api_router.include_router(labels.router)
api_router.include_router(samples.router)
api_router.include_router(samples.scoped_router)
api_router.include_router(tasks.router)
api_router.include_router(reviews.router)
api_router.include_router(media.router)
api_router.include_router(imu.router)
api_router.include_router(clips.router)
api_router.include_router(dashboard.router)
