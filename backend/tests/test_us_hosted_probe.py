import asyncio
import json
import httpx
import pytest
from app.services import us_hosted_probe as probe


@pytest.mark.parametrize('change',[None,'status','cache','vary','challenge','redirect','transport'])
def test_hosted_probe_checks_boundary_without_sending_credentials_or_reading_bodies(change):
    requests=[];read=[]
    class PrivateBody(httpx.AsyncByteStream):
        async def __aiter__(self):
            read.append(True)
            yield b'private runtime payload'
    def gateway(request):
        requests.append(request)
        assert request.url.host=='usmarket.onrender.com'
        assert 'authorization' not in request.headers and 'apikey' not in request.headers
        status=200 if request.url.path=='/api/health' else 401
        headers={'cache-control':'private, no-store','vary':'Accept-Encoding, Authorization','www-authenticate':'Bearer'}
        if request.url.path=='/api/us/plans':
            if change=='transport':raise httpx.ConnectError('private transport detail')
            if change=='status':status=200
            if change=='cache':headers['cache-control']='public, max-age=60'
            if change=='vary':headers['vary']='Accept-Encoding'
            if change=='challenge':headers['www-authenticate']='Basic private'
            if change=='redirect':status=302;headers['location']='https://private.example'
        return httpx.Response(status,headers=headers,stream=PrivateBody())
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(gateway),follow_redirects=False) as client:
            return await probe.report(client)
    result=asyncio.run(run())
    assert result['passed'] is (change is None)
    assert len(requests)==3 and read==[]
    assert 'private runtime' not in json.dumps(result) and 'private transport' not in json.dumps(result)
    assert 'private.example' not in json.dumps(result)



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
