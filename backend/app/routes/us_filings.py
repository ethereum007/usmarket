from fastapi import APIRouter, Depends, HTTPException, Query

from app.services.us_filings import FilingUnavailable, gateway
from app.us_auth import require_us_user

router = APIRouter(prefix="/api/us/filings", tags=["US filing evidence"])


@router.get("")
async def filings(symbol: str = Query(..., pattern=r"^[A-Z][A-Z0-9.\-]{0,14}$"), user: dict = Depends(require_us_user)):
    try:
        return {"success": True, "evidence": await gateway.load(symbol)}
    except FilingUnavailable as exc:
        raise HTTPException(503, str(exc))
