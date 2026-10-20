"""Historical breadth from immutable completed-session research packages."""
from fastapi import APIRouter, Depends, Query
from app.dependencies import get_current_user
from app.services import swing_repository as repo

router = APIRouter(prefix="/api/analysis", tags=["analysis"])

@router.get("/breadth-thrust")
def breadth_thrust(
    universe: str = Query("nifty500", pattern="^(nifty50|nifty100|nifty200|nifty500|smallcap|microcap)$"),
    user: dict = Depends(get_current_user),
) -> dict:
    final = repo.latest_package(universe)
    package = final or repo.latest_package(universe, final_only=False)
    return {"success": True, "package": package, "has_final": final is not None,
            "isEstimatedEmaBreadth": False,
            "methodology": "Actual completed stock bars; eligible denominators per lookback. No regime score is inferred from missing data."}
