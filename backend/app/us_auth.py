"""Strict identity boundary for the standalone US product.

No inherited premium pricing, broker connection, Host/Origin trust or automatic
local user. The explicit loopback preview harness owns its test override.
"""
from __future__ import annotations

from datetime import datetime
import os
from uuid import UUID

import httpx
from fastapi import HTTPException, Request
from app.config import settings


def unauthorized():
    return HTTPException(401, 'Sign in to the US workspace', headers={'WWW-Authenticate':'Bearer'})


async def verify_us_token(token: str) -> dict:
    origin = settings.SUPABASE_URL.rstrip('/')
    public_key = settings.SUPABASE_ANON_KEY
    if not origin.startswith('https://') or not public_key:
        raise HTTPException(503, 'US authentication is not configured')
    try:
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=False) as client:
            response = await client.get(origin + '/auth/v1/user', headers={
                'Authorization':'Bearer ' + token,
                'apikey':public_key,
            })
    except httpx.HTTPError:
        raise HTTPException(503, 'US authentication is temporarily unavailable') from None
    if response.status_code in {401,403}:
        raise unauthorized()
    if response.status_code != 200:
        raise HTTPException(503, 'US authentication is temporarily unavailable')
    try:
        user = response.json()
    except ValueError:
        raise HTTPException(503, 'US authentication returned an invalid response') from None
    if not isinstance(user,dict) or not isinstance(user.get('id'),str) or not user['id'].strip():
        raise HTTPException(503, 'US authentication returned an invalid identity')
    if user.get('is_anonymous') is True:
        raise unauthorized()
    if not isinstance(user.get('email'), str) or '@' not in user['email'] or not user.get('email_confirmed_at'):
        raise HTTPException(403, 'Confirm your US account email before accessing research')
    try:
        confirmed = datetime.fromisoformat(user['email_confirmed_at'].replace('Z', '+00:00'))
        if confirmed.utcoffset() is None:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(503, 'US authentication returned invalid confirmation evidence') from None
    # Private MVP access follows stable provider user IDs, not request headers,
    # email aliases or frontend signup settings. Missing configuration denies all.
    try:
        raw = os.getenv('US_INVITED_USER_IDS', '')
        members = [value.strip() for value in raw.split(',') if value.strip()]
        if not 1 <= len(members) <= 500 or len(raw) > 20000:
            raise ValueError()
        invited = {str(UUID(value)) for value in members}
        identity = str(UUID(user['id']))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(503, 'Private US access is not configured') from None
    if identity not in invited:
        raise HTTPException(403, 'This account is not invited to the private US MVP')
    return {'id':identity,'email':user['email'],'auth_source':'supabase'}


async def require_us_user(request: Request) -> dict:
    authorization = request.headers.get('Authorization','')
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != 'bearer' or len(parts[1]) > 8192:
        raise unauthorized()
    return await verify_us_token(parts[1])
