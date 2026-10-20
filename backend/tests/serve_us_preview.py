"""Local US preview using real saved research. No application lifespan or broker startup."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI
import uvicorn
from app.us_auth import require_us_user
from app.routes.us_research import router
from app.routes.us_plans import router as plans_router
from app.routes.us_filings import router as filings_router

if __name__ == '__main__':
    app = FastAPI()
    app.include_router(router)
    app.include_router(plans_router)
    app.include_router(filings_router)
    app.dependency_overrides[require_us_user] = lambda: {'id':'local-us-preview'}
    uvicorn.run(app, host='127.0.0.1', port=9018)
