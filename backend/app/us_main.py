"""US-only hosted API entry point. No Indian broker connections or schedulers.

Run: uvicorn app.us_main:app --host 127.0.0.1 --port 9018
The explicit loopback development harness is tests/serve_us_preview.py.
"""
from fastapi import FastAPI
from app.routes.us_research import router
from app.routes.us_plans import router as plans_router
from app.routes.us_filings import router as filings_router

app = FastAPI(title='US Market Research API', version='0.1.0')
app.include_router(router)
app.include_router(plans_router)
app.include_router(filings_router)

@app.get('/api/health')
def health():
    return {'status':'ok','product':'usmarket','market':'US','research_only':True}
