"""Owner-scoped remote research; failures never fall back to ephemeral files."""
import os
import httpx
from fastapi import HTTPException
from app.config import settings
from app.services.us_readiness import https_origin
from app.services.us_publication import validate, content


def enabled():
    mode = os.environ.get('US_RESEARCH_STORE', 'local')
    if mode not in {'local', 'supabase'}:
        raise HTTPException(503, 'US research storage is not configured')
    return mode == 'supabase'


def execute(action, token, package_id=None, package_payload=None):
    if not token or not https_origin(settings.SUPABASE_URL) or not settings.SUPABASE_ANON_KEY:
        raise HTTPException(503, 'US remote research storage is not configured')
    body = {'action':action}
    if package_id is not None:
        body['package_id'] = package_id
    if package_payload is not None:
        validate(package_payload)
        body['package_payload'] = package_payload
    try:
        with httpx.Client(timeout=15, follow_redirects=False) as client:
            response = client.post(settings.SUPABASE_URL.rstrip('/') + '/rest/v1/rpc/us_research_store',
                headers={'Authorization':'Bearer ' + token, 'apikey':settings.SUPABASE_ANON_KEY}, json=body)
        if response.status_code == 409:
            raise HTTPException(409, 'Saved research conflicts with immutable evidence')
        response.raise_for_status()
        result = response.json()
        if action == 'list':
            if not isinstance(result, list) or len(result) > 120 or any(not isinstance(row, dict) for row in result):
                raise ValueError()
        elif result is not None and not isinstance(result, dict):
            raise ValueError()
        if action == 'publish':
            if not isinstance(result, dict) or result.get('id') != package_id:
                raise ValueError()
            validate(result)
            if content(result) != content(package_payload):
                raise ValueError('Publication acknowledgement does not match immutable content')
        return result
    except (httpx.HTTPError, ValueError, TypeError):
        raise HTTPException(503, 'US remote research storage is unavailable; publication was not confirmed') from None
