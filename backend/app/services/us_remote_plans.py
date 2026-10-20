"""User-token Supabase plan transport. No service-role key or local fallback."""
import httpx
from fastapi import HTTPException
from app.config import settings
from app.services.us_readiness import https_origin


def execute(operation, args, token):
    if not token or not https_origin(settings.SUPABASE_URL) or not settings.SUPABASE_ANON_KEY:
        raise HTTPException(503, 'US remote plan storage is not configured')
    names = {'list_plans':'list', 'get_plan':'get', 'save_plan':'save', 'export_plan_revisions':'export'}
    action = names.get(operation.__name__)
    if action is None:
        raise HTTPException(503, 'US remote plan operation is unavailable')
    body = {'action':action}
    # Owner comes exclusively from the verified JWT in auth.uid(), never args[0].
    if action in {'get', 'save'}:
        body['plan_id'] = args[1]
    if action == 'get':
        body['wanted_revision'] = args[2]
    if action == 'save':
        body.update(expected_revision=args[2], plan_payload=args[3])
    try:
        with httpx.Client(timeout=10, follow_redirects=False) as client:
            response = client.post(settings.SUPABASE_URL.rstrip('/') + '/rest/v1/rpc/us_plan_store',
                headers={'Authorization':'Bearer ' + token, 'apikey':settings.SUPABASE_ANON_KEY}, json=body)
        if response.status_code == 409 or (response.status_code == 400 and response.json().get('code') == '40001'):
            raise HTTPException(409, 'Plan unavailable or changed; reload before saving')
        response.raise_for_status()
        result = response.json()
        valid = (isinstance(result, list) and all(isinstance(row, dict) for row in result)) if action in {'list','export'} else (isinstance(result, dict) or (action == 'get' and result is None))
        if not valid:
            raise ValueError('Invalid storage response')
        return result
    except (httpx.HTTPError, ValueError, TypeError, AttributeError):
        raise HTTPException(503, 'US remote plan storage is unavailable; no save was confirmed') from None
