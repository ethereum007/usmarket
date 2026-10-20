"""US-only hosted API entry point. No Indian broker connections or schedulers.

Run: uvicorn app.us_main:app --host 127.0.0.1 --port 9018
The explicit loopback development harness is tests/serve_us_preview.py.
"""
from fastapi import FastAPI
from app.routes.us_research import router

app = FastAPI(title='US Market Research API', version='0.1.0')
app.include_router(router)

@app.get('/api/health')
def health():
    return {'status':'ok','product':'usmarket','market':'US','research_only':True}
