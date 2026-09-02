from pydantic import BaseModel

from app.models.review import ReviewDecision


class ReviewDecisionRequest(BaseModel):
    decision: ReviewDecision
    comment: str | None = None
