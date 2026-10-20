"""Durable status observations; this is not a distributed worker lease."""
import os
import httpx
from fastapi import HTTPException
from app.config import settings
from app.services.us_readiness import https_origin


def enabled():
    mode = os.environ.get('US_JOB_STORE', 'local')
    if mode not in {'local','supabase'}:
        raise HTTPException(503, 'US job storage is not configured')
    if mode == 'supabase' and os.environ.get('US_RESEARCH_STORE') != 'supabase':
        raise HTTPException(503, 'Remote jobs require remote research storage')
    return mode == 'supabase'


def execute(action, token, job_id=None, payload=None):
    if not token or not https_origin(settings.SUPABASE_URL) or not settings.SUPABASE_ANON_KEY:
        raise HTTPException(503, 'US remote job storage is not configured')
    body = {'action':action}
    if job_id is not None:
        body['job_id'] = job_id
    if payload is not None:
        body['job_payload'] = {k:v for k,v in payload.items() if k in {'id','state','package_id'}}
    try:
        with httpx.Client(timeout=10, follow_redirects=False) as client:
            response = client.post(settings.SUPABASE_URL.rstrip('/')+'/rest/v1/rpc/us_job_store',
                headers={'Authorization':'Bearer '+token,'apikey':settings.SUPABASE_ANON_KEY},json=body)
        if response.status_code == 409:
            raise HTTPException(409, 'Refresh status changed; check saved research before retrying')
        response.raise_for_status()
        result = response.json()
        if action == 'list':
            valid = isinstance(result,list) and len(result)<=20 and all(isinstance(row,dict) for row in result)
        else:
            valid = isinstance(result,dict) or (action=='get' and result is None)
        if not valid:
            raise ValueError()
        return result
    except (httpx.HTTPError, ValueError, TypeError):
        raise HTTPException(503, 'Refresh status storage is temporarily unavailable') from None
