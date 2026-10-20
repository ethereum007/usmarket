"""Customer-facing controls for shared market snapshot freshness."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.dependencies import require_premium
from app.services.market_snapshot_service import market_snapshot_service


router = APIRouter(prefix="/api/market-snapshots", tags=["market-snapshots"])


class IntradayRescanRequest(BaseModel):
    feed: Literal["intraday"] = "intraday"
    symbols: list[str] = Field(min_length=1, max_length=500)
    minTradedValueLakh: float = Field(default=0, ge=0)
    useCache: bool = True
    quoteProvider: str = Field(default="arrow_first", pattern="^(arrow_first|arrow|kite)$")


@router.post("/heartbeat")
async def heartbeat(user: dict = Depends(require_premium)) -> dict:
    await market_snapshot_service.mark_paid_activity(str(user.get("id") or ""))
    return {"success": True, "activeForSeconds": 90}


@router.post("/rescan")
async def rescan(body: IntradayRescanRequest, user: dict = Depends(require_premium)) -> dict:
    return await market_snapshot_service.request_manual_rescan(
        user_id=str(user.get("id") or ""),
        body=body.model_dump(),
    )


@router.get("/status")
async def status(user: dict = Depends(require_premium)) -> dict:
    del user
    return await market_snapshot_service.status()
