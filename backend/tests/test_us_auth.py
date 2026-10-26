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
    (200,{'id':'11111111-1111-4111-8111-111111111111','email':'owner@example.com','email_confirmed_at':'2026-01-01T00:00:00Z'},200),
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
    with patch.dict(us_auth.os.environ,{'US_INVITED_USER_IDS':'11111111-1111-4111-8111-111111111111'}), patch.object(us_auth,'settings',config), patch.object(us_auth.httpx,'AsyncClient',provider_client(httpx.Response(status,json=body))):
        response=TestClient(auth_app()).get('/private',headers={'Authorization':'Bearer test-session'})
    assert response.status_code==expected
    if expected==200:assert response.json()=={'id':'11111111-1111-4111-8111-111111111111'}
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


@pytest.mark.parametrize('members,expected',[
    ('',503),('not-a-uuid',503),
    ('22222222-2222-4222-8222-222222222222',403),
    ('11111111-1111-4111-8111-111111111111',200),
    (' 22222222-2222-4222-8222-222222222222, 11111111-1111-4111-8111-111111111111 ',200),
    ('11111111-1111-4111-8111-111111111111,invalid',503),
])
def test_private_mvp_invitation_is_enforced_after_provider_verification(members,expected):
    identity='11111111-1111-4111-8111-111111111111'
    body={'id':identity,'email':'owner@example.com','email_confirmed_at':'2026-01-01T00:00:00Z'}
    config=SimpleNamespace(SUPABASE_URL='https://us-auth.example',SUPABASE_ANON_KEY='test-public-key')
    with patch.dict(us_auth.os.environ,{'US_INVITED_USER_IDS':members}),patch.object(us_auth,'settings',config),patch.object(us_auth.httpx,'AsyncClient',provider_client(httpx.Response(200,json=body))):
        response=TestClient(auth_app()).get('/private',headers={'Authorization':'Bearer test-session',
            'X-Invited-User':identity,'X-Admin-Secret':'forged','Origin':'http://localhost:3108'})
    assert response.status_code==expected
    if expected!=200:assert identity not in response.text and 'owner@example.com' not in response.text


def test_invitation_revocation_applies_to_next_request_without_token_reissue():
    identity='11111111-1111-4111-8111-111111111111'
    body={'id':identity,'email':'owner@example.com','email_confirmed_at':'2026-01-01T00:00:00Z'}
    config=SimpleNamespace(SUPABASE_URL='https://us-auth.example',SUPABASE_ANON_KEY='test-public-key')
    client=TestClient(auth_app())
    with patch.object(us_auth,'settings',config),patch.object(us_auth.httpx,'AsyncClient',provider_client(httpx.Response(200,json=body))):
        with patch.dict(us_auth.os.environ,{'US_INVITED_USER_IDS':identity}):
            assert client.get('/private',headers={'Authorization':'Bearer test-session'}).status_code==200
        with patch.dict(us_auth.os.environ,{'US_INVITED_USER_IDS':'22222222-2222-4222-8222-222222222222'}):
            assert client.get('/private',headers={'Authorization':'Bearer test-session'}).status_code==403


def test_access_probe_uses_same_auth_boundary_and_discloses_no_identity():
    client=TestClient(hosted_app)
    assert client.get('/api/us/research/access',headers={'Host':'localhost','X-Invited-User':'forged'}).status_code==401
    with patch.object(us_auth,'verify_us_token',AsyncMock(return_value={'id':'private-owner','email':'private@example.com'})):
        result=client.get('/api/us/research/access',headers={'Authorization':'Bearer test-session'})
    assert result.status_code==200
    assert result.json()=={'success':True,'allowed':True,'market':'US','private_mvp':True}
    assert 'private-owner' not in result.text and 'private@example.com' not in result.text


@pytest.mark.parametrize('origin', [
    None, 123, '', 'http://us-auth.example', 'https://',
    'https://user:secret@us-auth.example', 'https://us-auth.example/custom',
    'https://us-auth.example?key=secret', 'https://us-auth.example#fragment',
    'https://us-auth.example:invalid', 'https://us-auth.example:65536',
    ' https://us-auth.example', 'https://us-auth.example\n',
    'https://us-auth.exa\tmple', 'https://us-auth.example\\other',
])
def test_invalid_auth_origin_rejected_before_sending_bearer(origin):
    config = SimpleNamespace(SUPABASE_URL=origin, SUPABASE_ANON_KEY='test-public-key')
    with patch.object(us_auth, 'settings', config), patch.object(us_auth.httpx, 'AsyncClient') as client:
        response = TestClient(auth_app()).get('/private', headers={'Authorization':'Bearer test-session'})
    assert response.status_code == 503
    assert response.json() == {'detail':'US authentication is not configured'}
    assert 'test-session' not in response.text and 'secret' not in response.text
    client.assert_not_called()


def test_auth_origin_single_trailing_slash_remains_supported():
    identity = '11111111-1111-4111-8111-111111111111'
    body = {'id':identity, 'email':'owner@example.com', 'email_confirmed_at':'2026-01-01T00:00:00Z'}
    config = SimpleNamespace(SUPABASE_URL='https://us-auth.example/', SUPABASE_ANON_KEY='test-public-key')
    with patch.dict(us_auth.os.environ, {'US_INVITED_USER_IDS':identity}), patch.object(us_auth, 'settings', config), patch.object(us_auth.httpx, 'AsyncClient', provider_client(httpx.Response(200, json=body))):
        assert TestClient(auth_app()).get('/private', headers={'Authorization':'Bearer test-session'}).status_code == 200
