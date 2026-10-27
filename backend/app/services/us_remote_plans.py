"""User-token Supabase plan transport. No service-role key or local fallback."""
import httpx
from uuid import UUID
from fastapi import HTTPException
from app.config import settings
from app.services.us_target import dedicated_supabase_origin
from app.services.us_json import same_value


def verified_plan(row, plan_id=None, revision=None, source=None):
    if not isinstance(row, dict) or not isinstance(row.get('id'), str):
        raise ValueError('Invalid plan identity')
    if str(UUID(row['id'])) != row['id']:
        raise ValueError('Noncanonical plan identity')
    if type(row.get('revision')) is not int or row['revision'] < 1:
        raise ValueError('Invalid plan revision')
    if plan_id is not None and row['id'] != plan_id:
        raise ValueError('Mismatched plan identity')
    if revision is not None and row['revision'] != revision:
        raise ValueError('Mismatched plan revision')
    if row.get('market') != 'US' or row.get('currency') != 'USD':
        raise ValueError('Invalid plan market')
    if source is not None:
        metadata = {'owner','_access_token','id','revision','updated_at'}
        actual = {key:value for key,value in row.items() if key not in metadata}
        expected = {key:value for key,value in source.items() if key not in metadata}
        if not same_value(actual, expected):
            raise ValueError('Mismatched saved plan content')
    return {key:value for key,value in row.items() if key not in {'owner','_access_token'}}


def verified_collection(rows, export=False):
    if not isinstance(rows, list) or len(rows) > 10000:
        raise ValueError('Invalid plan collection size')
    result = [verified_plan(row) for row in rows]
    observed = {}
    for row in result:
        observed.setdefault(row['id'], []).append(row['revision'])
    for revisions in observed.values():
        if export:
            # Immutable histories start at one and cannot delete/skip revisions.
            # Work is bounded by received rows, never by an untrusted revision number.
            if sorted(revisions) != list(range(1, len(revisions)+1)):
                raise ValueError('Invalid revision history continuity')
        elif len(revisions) != 1:
            raise ValueError('Duplicate latest plan identity')
    if export:
        result.sort(key=lambda row:(row['id'],row['revision']))
    return result


def execute(operation, args, token):
    if not token or not dedicated_supabase_origin(settings.SUPABASE_URL) or not settings.SUPABASE_ANON_KEY:
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
        if action in {'list','export'}:
            return verified_collection(result, export=action == 'export')
        if result is None:
            return None
        return verified_plan(result, args[1], args[2] if action == 'get' else args[2]+1,
                             args[3] if action == 'save' else None)
    except (httpx.HTTPError, ValueError, TypeError, AttributeError):
        raise HTTPException(503, 'US remote plan storage is unavailable; no save was confirmed') from None
