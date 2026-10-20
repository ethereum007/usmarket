from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import httpx
import pytest
from fastapi import FastAPI, Depends
from fastapi.testclient import TestClient
from app.us_auth import require_us_user
from app import us_auth
from app.us_main import app as hosted_app


def auth_app():
    app=FastAPI()
    @app.get('/private')
    async def private(user=Depends(require_us_user)):
        return {'id':user['id']}
    return app


@pytest.mark.parametrize('headers',[
    {}, {'Host':'localhost'}, {'Origin':'http://localhost:3108'},
    {'Host':'public.example','X-Forwarded-Host':'localhost'},
    {'X-Admin-Secret':'not-an-auth-token'},
    {'Authorization':'Basic anything'}, {'Authorization':'Bearer'},
    {'Authorization':'Bearer first second'},
])
def test_no_header_or_spoofed_local_request_can_grant_access(headers):
    with patch.object(us_auth,'verify_us_token',AsyncMock()) as verifier:
        response=TestClient(auth_app()).get('/private',headers=headers)
    assert response.status_code==401
    assert response.headers['www-authenticate']=='Bearer'
    verifier.assert_not_called()


def provider_client(response=None,error=None):
    class Factory:
        def __init__(self,*args,**kwargs):pass
        async def __aenter__(self):return self
        async def __aexit__(self,*args):return False
        async def get(self,url,headers):
            assert url=='https://us-auth.example/auth/v1/user'
            assert headers['Authorization']=='Bearer test-session'
            if error:raise error
            return response
    return Factory


@pytest.mark.parametrize('status,body,expected',[
    (200,{'id':'owner-a','email':'owner@example.com','email_confirmed_at':'2026-01-01T00:00:00Z'},200),
    (200,{'id':'owner-a','is_anonymous':True},401),
    (200,{'id':'owner-a','email':'owner@example.com'},403),
    (200,{'id':'owner-a','email':'owner@example.com','email_confirmed_at':None},403),
    (200,{'id':'owner-a','email':'owner@example.com','email_confirmed_at':'bad'},503),
    (200,{'id':'owner-a','email':'owner@example.com','email_confirmed_at':'2026-01-01T00:00:00'},503),
    (200,{'id':'owner-a','email_confirmed_at':'2026-01-01T00:00:00Z'},403),
    (200,{},503), (200,{'id':123},503), (200,[],503),
    (401,{'message':'expired'},401), (403,{},401),
    (429,{},503), (500,{},503), (302,{},503),
])
def test_provider_identity_and_failure_mapping(status,body,expected):
    config=SimpleNamespace(SUPABASE_URL='https://us-auth.example',SUPABASE_ANON_KEY='test-public-key')
    with patch.object(us_auth,'settings',config), patch.object(us_auth.httpx,'AsyncClient',provider_client(httpx.Response(status,json=body))):
        response=TestClient(auth_app()).get('/private',headers={'Authorization':'Bearer test-session'})
    assert response.status_code==expected
    if expected==200:assert response.json()=={'id':'owner-a'}
    assert 'test-session' not in response.text


def test_provider_timeout_fails_closed():
    config=SimpleNamespace(SUPABASE_URL='https://us-auth.example',SUPABASE_ANON_KEY='test-public-key')
    with patch.object(us_auth,'settings',config),patch.object(us_auth.httpx,'AsyncClient',provider_client(error=httpx.ReadTimeout('provider timeout'))):
        assert TestClient(auth_app()).get('/private',headers={'Authorization':'Bearer test-session'}).status_code==503


def test_missing_configuration_never_grants_a_dev_user():
    config=SimpleNamespace(SUPABASE_URL='',SUPABASE_ANON_KEY='')
    with patch.object(us_auth,'settings',config):
        response=TestClient(auth_app()).get('/private',headers={'Host':'localhost','Authorization':'Bearer test-session'})
    assert response.status_code==503


@pytest.mark.parametrize('path',['/api/us/research/packages','/api/us/research/live','/api/us/research/jobs/unknown'])
def test_real_hosted_app_rejects_localhost_without_token(path):
    with TestClient(hosted_app) as client:
        assert client.get(path,headers={'Host':'localhost','Origin':'http://localhost:3108'}).status_code==401


def test_hosted_refresh_requires_token_and_health_remains_public():
    with TestClient(hosted_app) as client:
        assert client.post('/api/us/research/refresh',json={'symbols':'AAPL'},headers={'Host':'localhost'}).status_code==401
        assert client.get('/api/health').status_code==200
