"""US-only hosted API entry point. No Indian broker connections or schedulers.

Run: uvicorn app.us_main:app --host 127.0.0.1 --port 9018
The explicit loopback development harness is tests/serve_us_preview.py.
"""
import os
import re

from fastapi import FastAPI, Response
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from app.routes.us_research import router
from app.routes.us_plans import router as plans_router
from app.routes.us_filings import router as filings_router
from app.services.us_request_limits import USRequestBodyLimit

app = FastAPI(title='US Market Research API', version='0.1.0')
app.add_middleware(USRequestBodyLimit)


@app.exception_handler(RequestValidationError)
async def invalid_request(request, exc):
    if request.url.path == '/api/us' or request.url.path.startswith('/api/us/'):
        # Default validation details can contain submitted values and parser context.
        return JSONResponse({'detail': 'Check the request fields and source evidence before retrying.'}, status_code=422)
    return await request_validation_exception_handler(request, exc)


@app.exception_handler(Exception)
async def unexpected_failure(request, exc):
    # ServerErrorMiddleware handles these outside the normal cache middleware.
    headers = {'Cache-Control': 'no-store'}
    if request.url.path == '/api/us' or request.url.path.startswith('/api/us/'):
        headers.update({'Cache-Control': 'private, no-store', 'Pragma': 'no-cache',
                        'Expires': '0', 'Vary': 'Authorization'})
    return JSONResponse({'detail': 'US service is temporarily unavailable'}, status_code=500, headers=headers)


@app.middleware('http')
async def private_us_cache_policy(request, call_next):
    response = await call_next(request)
    if request.url.path == '/api/us' or request.url.path.startswith('/api/us/'):
        response.headers['Cache-Control'] = 'private, no-store'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
        vary = [
            value.strip()
            for header in response.headers.getlist('Vary')
            for value in header.split(',')
            if value.strip()
        ]
        if not any(value.lower() in {'authorization', '*'} for value in vary):
            vary.append('Authorization')
        response.headers['Vary'] = ', '.join(vary)
    return response


app.include_router(router)
app.include_router(plans_router)
app.include_router(filings_router)

@app.get('/api/health')
def health(response: Response):
    response.headers["Cache-Control"] = "no-store"
    revision = os.getenv("RENDER_GIT_COMMIT", "")
    if re.fullmatch(r"[0-9a-f]{40}", revision):
        response.headers["X-US-Source-Revision"] = revision
    return {'status':'ok','product':'usmarket','market':'US','research_only':True}
