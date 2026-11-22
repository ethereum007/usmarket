import asyncio
from fastapi.testclient import TestClient

from app.services import us_request_limits as limits
from app.us_main import app


async def invoke(messages, headers=(), stalled=False):
    sent, reached, reads = [], [], []
    async def receive():
        reads.append(True)
        if stalled:
            await asyncio.Event().wait()
        return messages.pop(0)
    async def send(message):
        sent.append(message)
    async def downstream(scope, receive, send):
        reached.append(await receive())
    await limits.USRequestBodyLimit(downstream)(
        {'type':'http', 'method':'POST', 'path':'/api/us/plans', 'headers':headers}, receive, send)
    return sent, reached, reads


def test_declared_oversize_rejected_without_read_or_downstream():
    sent, reached, reads = asyncio.run(invoke([], [(b'content-length', b'99999999999999999999')]))
    assert sent[0]['status'] == 413 and reached == [] and reads == []
    assert b'private, no-store' in dict(sent[0]['headers']).values()


def test_stream_limit_stops_before_reading_remaining_body(monkeypatch):
    monkeypatch.setattr(limits, 'MAX_BODY_BYTES', 5)
    messages = [{'type':'http.request','body':b'123','more_body':True},
                {'type':'http.request','body':b'456','more_body':True},
                {'type':'http.request','body':b'PRIVATE_BODY','more_body':False}]
    sent, reached, reads = asyncio.run(invoke(messages, [(b'content-length', b'1')]))
    assert sent[0]['status'] == 413 and reached == [] and len(reads) == 2
    assert len(messages) == 1 and b'PRIVATE_BODY' not in sent[-1]['body']


def test_exact_limit_replays_original_bytes_once(monkeypatch):
    monkeypatch.setattr(limits, 'MAX_BODY_BYTES', 5)
    sent, reached, _ = asyncio.run(invoke([{'type':'http.request','body':b'12','more_body':True},
                                          {'type':'http.request','body':b'345','more_body':False}]))
    assert sent == [] and reached == [{'type':'http.request','body':b'12345','more_body':False}]


def test_receive_deadline_does_not_reach_application(monkeypatch):
    monkeypatch.setattr(limits, 'BODY_DEADLINE_SECONDS', 0.01)
    sent, reached, _ = asyncio.run(invoke([], stalled=True))
    assert sent[0]['status'] == 408 and reached == []


def test_disconnected_upload_does_not_reach_application():
    sent, reached, _ = asyncio.run(invoke([{'type':'http.disconnect'}]))
    assert sent == [] and reached == []


def test_hosted_entrypoint_limits_body_and_preserves_auth():
    client = TestClient(app)
    assert client.post('/api/us/plans/sizing-preview', content=b'x' * (limits.MAX_BODY_BYTES + 1)).status_code == 413
    assert client.post('/api/us/plans/sizing-preview', json={'trigger':100,'stop':95,'capital':10000,'risk_pct':1,'allocation_cap_pct':20,'direction':'BULL'}).status_code == 401
    assert client.get('/api/health').status_code == 200
