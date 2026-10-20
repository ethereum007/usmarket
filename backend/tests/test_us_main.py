from fastapi.testclient import TestClient
from app.us_main import app

def test_us_entrypoint_mounts_only_us_routes_and_health():
    paths=set(app.openapi()['paths'])
    assert '/api/us/research/packages' in paths
    assert '/api/health' in paths
    assert '/api/scanner/research/package' not in paths
    assert not any(path.startswith('/api/options') for path in paths)
    with TestClient(app) as client:
        assert client.get('/api/health').json()['market']=='US'
        assert client.get('/api/options').status_code==404
