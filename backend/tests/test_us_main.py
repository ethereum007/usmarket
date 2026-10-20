from fastapi.testclient import TestClient
from app.us_main import app

def test_us_entrypoint_mounts_only_us_routes_and_health():
    paths=set(app.openapi()['paths'])
    assert '/api/us/research/packages' in paths
    assert '/api/us/plans' in paths
    assert '/api/us/plans/{plan_id}' in paths
    assert '/api/health' in paths
    assert '/api/scanner/research/package' not in paths
    assert not any(path.startswith('/api/options') for path in paths)
    with TestClient(app) as client:
        assert client.get('/api/health').json()['market']=='US'
        assert client.get('/api/options').status_code==404



def test_private_cache_policy_covers_success_denial_and_missing_routes():
    from app.us_auth import require_us_user
    app.dependency_overrides[require_us_user] = lambda: {'id': 'owner-a'}
    try:
        client = TestClient(app)
        success = client.get('/api/us/research/access')
        assert success.status_code == 200
    finally:
        app.dependency_overrides.pop(require_us_user, None)
    denied = client.get('/api/us/research/access')
    missing = client.get('/api/us/no-such-route')
    method = client.post('/api/us/research/access')
    assert [denied.status_code, missing.status_code, method.status_code] == [401, 404, 405]
    for response in [success, denied, missing, method]:
        assert response.headers['cache-control'] == 'private, no-store'
        assert response.headers['pragma'] == 'no-cache'
        assert response.headers['expires'] == '0'
        assert 'authorization' in response.headers['vary'].lower()
        assert 'owner-a' not in response.text
    assert 'cache-control' not in client.get('/api/health').headers


def test_private_cache_policy_preserves_existing_vary_and_replaces_public_cache():
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse
    from app.us_main import private_us_cache_policy
    isolated = FastAPI()
    isolated.middleware('http')(private_us_cache_policy)

    @isolated.get('/api/us/test')
    def fixture():
        return JSONResponse({'ok': True}, headers={
            'Vary': 'Accept-Encoding', 'Cache-Control': 'public, max-age=3600'})

    response = TestClient(isolated).get('/api/us/test')
    assert response.headers['vary'] == 'Accept-Encoding, Authorization'
    assert response.headers['cache-control'] == 'private, no-store'
