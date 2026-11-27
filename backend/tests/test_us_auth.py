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
    {'Authorization':'Bearer first,second'},
    [('Authorization', 'Bearer first'), ('authorization', 'Bearer second')],
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
        def build_request(self,method,url,headers):
            return httpx.Request(method,url,headers=headers)
        async def send(self,request,stream):
            assert stream is True
            url=str(request.url);headers=request.headers
            assert url=='https://apidhmrlawbjvisnadht.supabase.co/auth/v1/user'
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
    config=SimpleNamespace(SUPABASE_URL='https://apidhmrlawbjvisnadht.supabase.co',SUPABASE_ANON_KEY='test-public-key')
    with patch.dict(us_auth.os.environ,{'US_INVITED_USER_IDS':'11111111-1111-4111-8111-111111111111'}), patch.object(us_auth,'settings',config), patch.object(us_auth.httpx,'AsyncClient',provider_client(httpx.Response(status,json=body))):
        response=TestClient(auth_app()).get('/private',headers={'Authorization':'Bearer test-session'})
    assert response.status_code==expected
    if expected==200:assert response.json()=={'id':'11111111-1111-4111-8111-111111111111'}
    assert 'test-session' not in response.text


def test_provider_timeout_fails_closed():
    config=SimpleNamespace(SUPABASE_URL='https://apidhmrlawbjvisnadht.supabase.co',SUPABASE_ANON_KEY='test-public-key')
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
    config=SimpleNamespace(SUPABASE_URL='https://apidhmrlawbjvisnadht.supabase.co',SUPABASE_ANON_KEY='test-public-key')
    with patch.dict(us_auth.os.environ,{'US_INVITED_USER_IDS':members}),patch.object(us_auth,'settings',config),patch.object(us_auth.httpx,'AsyncClient',provider_client(httpx.Response(200,json=body))):
        response=TestClient(auth_app()).get('/private',headers={'Authorization':'Bearer test-session',
            'X-Invited-User':identity,'X-Admin-Secret':'forged','Origin':'http://localhost:3108'})
    assert response.status_code==expected
    if expected!=200:assert identity not in response.text and 'owner@example.com' not in response.text


def test_invitation_revocation_applies_to_next_request_without_token_reissue():
    identity='11111111-1111-4111-8111-111111111111'
    body={'id':identity,'email':'owner@example.com','email_confirmed_at':'2026-01-01T00:00:00Z'}
    config=SimpleNamespace(SUPABASE_URL='https://apidhmrlawbjvisnadht.supabase.co',SUPABASE_ANON_KEY='test-public-key')
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
    None, 123, '', 'http://apidhmrlawbjvisnadht.supabase.co', 'https://',
    'https://user:secret@apidhmrlawbjvisnadht.supabase.co', 'https://apidhmrlawbjvisnadht.supabase.co/custom',
    'https://apidhmrlawbjvisnadht.supabase.co?key=secret', 'https://apidhmrlawbjvisnadht.supabase.co#fragment',
    'https://apidhmrlawbjvisnadht.supabase.co:invalid', 'https://apidhmrlawbjvisnadht.supabase.co:65536',
    ' https://apidhmrlawbjvisnadht.supabase.co', 'https://apidhmrlawbjvisnadht.supabase.co\n',
    'https://us-auth.exa\tmple', 'https://apidhmrlawbjvisnadht.supabase.co\\other',
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
    config = SimpleNamespace(SUPABASE_URL='https://apidhmrlawbjvisnadht.supabase.co/', SUPABASE_ANON_KEY='test-public-key')
    with patch.dict(us_auth.os.environ, {'US_INVITED_USER_IDS':identity}), patch.object(us_auth, 'settings', config), patch.object(us_auth.httpx, 'AsyncClient', provider_client(httpx.Response(200, json=body))):
        assert TestClient(auth_app()).get('/private', headers={'Authorization':'Bearer test-session'}).status_code == 200


@pytest.mark.parametrize('origin',[
    'https://etwmtakotrqlwwzttekc.supabase.co',
    'https://other-project.supabase.co',
    'https://apidhmrlawbjvisnadht.supabase.co.attacker.example',
    'https://apidhmrlawbjvisnadht.supabase.co:444',
])
def test_wrong_project_never_receives_auth_or_storage_bearers(origin):
    from fastapi import HTTPException
    from app.services import us_remote_plans,us_remote_research,us_remote_jobs,swing_repository
    config=SimpleNamespace(SUPABASE_URL=origin,SUPABASE_ANON_KEY='synthetic-public-key')
    with patch.object(us_auth,'settings',config),patch.object(us_auth.httpx,'AsyncClient') as auth_client:
        response=TestClient(auth_app()).get('/private',headers={'Authorization':'Bearer synthetic-private-token'})
    assert response.status_code==503
    auth_client.assert_not_called()
    operations=[(us_remote_plans,lambda:us_remote_plans.execute(swing_repository.list_plans,('owner',),'synthetic-private-token')),
                (us_remote_research,lambda:us_remote_research.execute('list','synthetic-private-token')),
                (us_remote_jobs,lambda:us_remote_jobs.execute('list','synthetic-private-token'))]
    for module,call in operations:
        with patch.object(module,'settings',config),patch.object(module.httpx,'Client') as storage_client:
            with pytest.raises(us_auth.HTTPException) as error:call()
        assert error.value.status_code==503
        assert origin not in error.value.detail and 'synthetic-private-token' not in error.value.detail
        storage_client.assert_not_called()


@pytest.mark.parametrize('stage',['enter','request'])
def test_total_auth_deadline_cancels_stalled_provider_and_allows_later_verification(stage):
    import asyncio
    from fastapi import HTTPException
    config=SimpleNamespace(SUPABASE_URL='https://apidhmrlawbjvisnadht.supabase.co',SUPABASE_ANON_KEY='test-public-key')
    cancelled=[]
    class Stalled:
        def __init__(self,*args,**kwargs):pass
        async def wait(self):
            try:await asyncio.Event().wait()
            finally:cancelled.append(stage)
        async def __aenter__(self):
            if stage=='enter':await self.wait()
            return self
        async def __aexit__(self,*args):return False
        def build_request(self,*args,**kwargs):return None
        async def send(self,*args,**kwargs):await self.wait()
    async def exercise():
        with patch.object(us_auth,'settings',config),patch.object(us_auth,'AUTH_DEADLINE_SECONDS',0.01),patch.object(us_auth.httpx,'AsyncClient',Stalled):
            with pytest.raises(HTTPException) as failure:
                await asyncio.wait_for(us_auth.verify_us_token('synthetic-secret'),1)
        assert failure.value.status_code==503
        assert failure.value.detail=='US authentication is temporarily unavailable'
        assert cancelled==[stage]
        identity='11111111-1111-4111-8111-111111111111'
        body={'id':identity,'email':'owner@example.com','email_confirmed_at':'2026-01-01T00:00:00Z'}
        with patch.object(us_auth,'settings',config),patch.dict(us_auth.os.environ,{'US_INVITED_USER_IDS':identity}),patch.object(us_auth.httpx,'AsyncClient',provider_client(httpx.Response(200,json=body))):
            assert (await us_auth.verify_us_token('test-session'))['id']==identity
    asyncio.run(exercise())


def test_caller_cancellation_is_not_converted_to_auth_outage():
    import asyncio
    config=SimpleNamespace(SUPABASE_URL='https://apidhmrlawbjvisnadht.supabase.co',SUPABASE_ANON_KEY='test-public-key')
    async def exercise():
        started=asyncio.Event();cancelled=asyncio.Event()
        class Stalled:
            def __init__(self,*args,**kwargs):pass
            async def __aenter__(self):return self
            async def __aexit__(self,*args):return False
            def build_request(self,*args,**kwargs):return None
            async def send(self,*args,**kwargs):
                started.set()
                try:await asyncio.Event().wait()
                finally:cancelled.set()
        with patch.object(us_auth,'settings',config),patch.object(us_auth.httpx,'AsyncClient',Stalled):
            task=asyncio.create_task(us_auth.verify_us_token('synthetic-secret'))
            await asyncio.wait_for(started.wait(),1);task.cancel()
            with pytest.raises(asyncio.CancelledError):await task
            assert cancelled.is_set()
    asyncio.run(exercise())


@pytest.mark.parametrize('anonymous', [False, True, 'false', None, 0])
def test_invited_identity_requires_boolean_anonymity_when_present(anonymous):
    identity = '11111111-1111-4111-8111-111111111111'
    body = {'id': identity, 'email': 'owner@example.com',
            'email_confirmed_at': '2026-01-01T00:00:00Z', 'is_anonymous': anonymous}
    config = SimpleNamespace(SUPABASE_URL='https://apidhmrlawbjvisnadht.supabase.co',
                             SUPABASE_ANON_KEY='test-public-key')
    with patch.dict(us_auth.os.environ, {'US_INVITED_USER_IDS': identity}), \
         patch.object(us_auth, 'settings', config), \
         patch.object(us_auth.httpx, 'AsyncClient', provider_client(httpx.Response(200, json=body))):
        response = TestClient(auth_app()).get('/private', headers={'Authorization': 'Bearer test-session'})
    assert response.status_code == (200 if anonymous is False else 401 if anonymous is True else 503)



@pytest.mark.parametrize("token", [b"synthetic-\xff", b"synthetic-\x7f", b"synthetic-\x00"])
def test_malformed_bearer_characters_never_reach_identity_verifier(token):
    import asyncio
    from starlette.requests import Request
    request = Request({"type": "http", "headers": [(b"authorization", b"Bearer " + token)]})
    with patch.object(us_auth, "verify_us_token", AsyncMock()) as verifier:
        with pytest.raises(us_auth.HTTPException) as error:
            asyncio.run(us_auth.require_us_user(request))
        assert error.value.status_code == 401
        assert error.value.headers["WWW-Authenticate"] == "Bearer"
        verifier.assert_not_awaited()


@pytest.mark.parametrize('compressed', [False, True])
def test_oversized_auth_stream_is_closed_early_and_next_identity_can_verify(compressed):
    import asyncio
    import gzip
    import json
    identity = '11111111-1111-4111-8111-111111111111'
    valid = json.dumps({'id': identity, 'email': 'owner@example.com',
                        'email_confirmed_at': '2026-01-01T00:00:00Z'}).encode()
    limit = 65536
    payload = valid + b' ' * (limit * 4)
    wire = gzip.compress(payload) if compressed else payload
    class Body(httpx.AsyncByteStream):
        closed = False
        consumed = 0
        async def __aiter__(self):
            for offset in range(0, len(wire), 1024):
                self.consumed += 1
                yield wire[offset:offset + 1024]
        async def aclose(self):self.closed = True
    body = Body()
    attempts = []
    def handler(request):
        attempts.append(request)
        if len(attempts) > 1:return httpx.Response(200, content=valid)
        headers = {'Content-Encoding': 'gzip'} if compressed else {}
        return httpx.Response(200, headers=headers, stream=body)
    client_factory = httpx.AsyncClient
    def factory(**kwargs):
        return client_factory(transport=httpx.MockTransport(handler), **kwargs)
    config = SimpleNamespace(SUPABASE_URL='https://apidhmrlawbjvisnadht.supabase.co',
                             SUPABASE_ANON_KEY='test-public-key')
    async def exercise():
        with patch.object(us_auth, 'settings', config), \
             patch.dict(us_auth.os.environ, {'US_INVITED_USER_IDS': identity}), \
             patch.object(us_auth, 'MAX_AUTH_RESPONSE_BYTES', limit), \
             patch.object(us_auth.httpx, 'AsyncClient', factory):
            with pytest.raises(us_auth.HTTPException) as failure:
                await us_auth.verify_us_token('test-session')
            assert failure.value.status_code == 503
            assert failure.value.detail == 'US authentication returned an invalid response'
            assert body.closed
            if not compressed:assert body.consumed < len(wire) // 1024
            assert (await us_auth.verify_us_token('test-session'))['id'] == identity
    asyncio.run(exercise())


def test_auth_response_at_decoded_limit_is_accepted():
    import asyncio
    import json
    identity = '11111111-1111-4111-8111-111111111111'
    payload = json.dumps({'id': identity, 'email': 'owner@example.com',
                          'email_confirmed_at': '2026-01-01T00:00:00Z'}).encode()
    config = SimpleNamespace(SUPABASE_URL='https://apidhmrlawbjvisnadht.supabase.co',
                             SUPABASE_ANON_KEY='test-public-key')
    with patch.object(us_auth, 'settings', config), \
         patch.dict(us_auth.os.environ, {'US_INVITED_USER_IDS': identity}), \
         patch.object(us_auth, 'MAX_AUTH_RESPONSE_BYTES', len(payload)), \
         patch.object(us_auth.httpx, 'AsyncClient', provider_client(httpx.Response(200, content=payload))):
        assert asyncio.run(us_auth.verify_us_token('test-session'))['id'] == identity


def test_auth_deadline_also_bounds_stream_body_and_closes_response():
    import asyncio
    class Body(httpx.AsyncByteStream):
        closed = False
        async def __aiter__(self):
            yield b'{'
            await asyncio.Event().wait()
        async def aclose(self):self.closed = True
    body = Body()
    client_factory = httpx.AsyncClient
    def factory(**kwargs):
        return client_factory(transport=httpx.MockTransport(
            lambda request: httpx.Response(200, stream=body)), **kwargs)
    config = SimpleNamespace(SUPABASE_URL='https://apidhmrlawbjvisnadht.supabase.co',
                             SUPABASE_ANON_KEY='test-public-key')
    async def exercise():
        with patch.object(us_auth, 'settings', config), \
             patch.object(us_auth, 'AUTH_DEADLINE_SECONDS', 0.01), \
             patch.object(us_auth.httpx, 'AsyncClient', factory):
            with pytest.raises(us_auth.HTTPException) as failure:
                await asyncio.wait_for(us_auth.verify_us_token('test-session'), 1)
            assert failure.value.status_code == 503
            assert failure.value.detail == 'US authentication is temporarily unavailable'
            assert body.closed
    asyncio.run(exercise())
