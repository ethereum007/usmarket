"""Strict identity boundary for the standalone US product.

No inherited premium pricing, broker connection, Host/Origin trust or automatic
local user. The explicit loopback preview harness owns its test override.
"""
from __future__ import annotations

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
    return {'id':user['id'],'email':user.get('email'),'auth_source':'supabase'}


async def require_us_user(request: Request) -> dict:
    authorization = request.headers.get('Authorization','')
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != 'bearer' or len(parts[1]) > 8192:
        raise unauthorized()
    return await verify_us_token(parts[1])
