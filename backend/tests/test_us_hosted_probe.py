import asyncio
import json
import httpx
import pytest
from app.services import us_hosted_probe as probe


@pytest.mark.parametrize('change',[None,'health_cache','access_open','status','cache','vary','challenge','redirect','transport'])
def test_hosted_probe_checks_boundary_without_sending_credentials_or_reading_bodies(change):
    requests=[];read=[]
    class PrivateBody(httpx.AsyncByteStream):
        async def __aiter__(self):
            read.append(True)
            yield b'private runtime payload'
    def gateway(request):
        requests.append(request)
        assert request.url.host=='usmarket.onrender.com'
        assert not {'authorization', 'apikey', 'cookie'}.intersection(request.headers)
        status=200 if request.url.path=='/api/health' else 401
        headers={'cache-control':'private, no-store','vary':'Accept-Encoding, Authorization','www-authenticate':'Bearer'}
        if request.url.path=='/api/health':
            if change == 'health_cache':
                headers.pop('cache-control')
            headers['set-cookie'] = 'session=synthetic; Path=/; Secure'
        if request.url.path == '/api/us/research/access' and change == 'access_open':
            status = 200
        if request.url.path=='/api/us/plans':
            if change=='transport':raise httpx.ConnectError('private transport detail')
            if change=='status':status=200
            if change=='cache':headers['cache-control']='public, max-age=60'
            if change=='vary':headers['vary']='Accept-Encoding'
            if change=='challenge':headers['www-authenticate']='Basic private'
            if change=='redirect':status=302;headers['location']='https://private.example'
        return httpx.Response(status,headers=headers,stream=PrivateBody())
    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(gateway), follow_redirects=True,
            auth=('synthetic', 'synthetic'), headers={'apikey': 'synthetic'},
        ) as client:
            return await probe.report(client)
    result=asyncio.run(run())
    assert result['passed'] is (change is None)
    assert [request.url.path for request in requests] == [
        '/api/health', '/api/us/research/access', '/api/us/plans', '/api/us/research/packages',
        '/api/us/plans/export', '/api/us/research/jobs', '/api/us/research/live',
    ]
    assert read == []
    assert 'private runtime' not in json.dumps(result) and 'private transport' not in json.dumps(result)
    assert 'private.example' not in json.dumps(result)


@pytest.mark.parametrize('path', ['/api/us/plans/export', '/api/us/research/jobs', '/api/us/research/live'])
@pytest.mark.parametrize('failure', ['open', 'cache', 'vary', 'challenge'])
def test_sensitive_read_boundaries_fail_independently(path, failure):
    def gateway(request):
        headers = {'cache-control': 'private, no-store', 'vary': 'Authorization', 'www-authenticate': 'Bearer'}
        status = 200 if request.url.path == '/api/health' else 401
        if request.url.path == path:
            if failure == 'open': status = 200
            if failure == 'cache': headers['cache-control'] = 'public'
            if failure == 'vary': headers['vary'] = 'Accept-Encoding'
            if failure == 'challenge': headers['www-authenticate'] = 'Basic'
        return httpx.Response(status, headers=headers)
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(gateway)) as client:
            return await probe.report(client)
    result = asyncio.run(run())
    assert result['passed'] is False
    assert [row['path'] for row in result['checks'] if not row['passed']] == [path]



def test_probe_deadline_cancels_stalled_header_requests(monkeypatch):
    cancelled=[]
    async def gateway(request):
        try:await asyncio.Event().wait()
        finally:cancelled.append(request.url.path)
    monkeypatch.setattr(probe,'REQUEST_DEADLINE_SECONDS',0.01)
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(gateway)) as client:
            return await asyncio.wait_for(probe.report(client),1)
    result=asyncio.run(run())
    assert not result['passed']
    assert cancelled==list(probe.PATHS)
    assert all(row['result']=='transport_unavailable' for row in result['checks'])
    assert all(row['failure_kind']=='total_deadline' for row in result['checks'])



@pytest.mark.parametrize(('error_type', 'kind'), [
    (httpx.ConnectTimeout, 'network_timeout'),
    (httpx.ReadTimeout, 'network_timeout'),
    (httpx.ConnectError, 'transport_error'),
])
def test_probe_classifies_transport_failure_without_exception_details(error_type, kind):
    def gateway(request):
        raise error_type('synthetic private detail https://private.example secret')
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(gateway)) as client:
            return await probe.report(client)
    result = asyncio.run(run())
    assert not result['passed']
    assert all(row['failure_kind'] == kind for row in result['checks'])
    assert all(row['result'] == 'transport_unavailable' for row in result['checks'])
    assert 'synthetic private' not in json.dumps(result)
    assert 'private.example' not in json.dumps(result)
    assert 'secret' not in json.dumps(result)
