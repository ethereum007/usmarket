from dataclasses import replace
from unittest.mock import patch
import json
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.config import settings
from app.us_auth import require_us_user
from app.routes import us_research as api
from app.services.us_research import research_package
from datetime import datetime, timezone

@pytest.fixture
def client(tmp_path):
    app=FastAPI()
    app.include_router(api.router)
    app.dependency_overrides[require_us_user]=lambda:{'id':'owner'}
    with patch.object(api,'settings',replace(settings,DATA_DIR=tmp_path)):
        yield TestClient(app), tmp_path


def test_saved_package_path_is_bounded_and_us_only(client):
    c, root=client
    assert c.get('/api/us/research/packages/not-a-hash').status_code == 422
    key='a'*64
    folder=root/'us-research';folder.mkdir()
    (folder/(key+'.json')).write_text(json.dumps({'id':key,'market':'NSE'}))
    assert c.get('/api/us/research/packages/'+key).status_code == 409
    assert c.get('/api/us/research/packages').json()['packages'] == []


def test_catalog_and_real_package_contract(client):
    c,root=client
    row={'t':'2026-07-01T04:00:00Z','o':10,'h':12,'l':9,'c':11,'v':100}
    p=research_package(['AAPL'],{'SPY':[row],'AAPL':[row]},[{'date':'2026-07-01','close':'16:00'}],datetime(2026,7,2,tzinfo=timezone.utc))
    folder=root/'us-research';folder.mkdir()
    (folder/(p['id']+'.json')).write_text(json.dumps(p))
    listing=c.get('/api/us/research/packages').json()
    assert listing['packages'][0]['id']==p['id']
    saved=c.get('/api/us/research/packages/'+p['id']).json()['package']
    assert saved['features']['AAPL']['close']==11
    assert saved['source_bars']['AAPL'][0]['volume']==100
    assert saved['session_calendar']['version']=='us-provider-sessions-v1'
    assert saved['session_calendar']['sessions'][0]['date']=='2026-07-01'
    assert saved['history_gaps']=={}


def test_refresh_rejects_invalid_universe_and_foreign_jobs(client):
    c,_=client
    assert c.post('/api/us/research/refresh',json={'symbols':'../bad'}).status_code==422
    assert c.post('/api/us/research/refresh',json={'symbols':'SPY'}).status_code==422
    api._jobs['foreign']={'id':'foreign','owner':'other','state':'completed'}
    assert c.get('/api/us/research/jobs/foreign').status_code==404
    del api._jobs['foreign']


def test_refresh_returns_exact_package_and_preserves_error_boundary(client):
    from unittest.mock import AsyncMock
    c,_=client
    with patch.object(api,'run',AsyncMock(return_value={'id':'b'*64})):
        response=c.post('/api/us/research/refresh',json={'symbols':'AAPL'})
    assert response.status_code==200
    job=c.get('/api/us/research/jobs/'+response.json()['job']['id']).json()['job']
    assert job['package_id']=='b'*64
    assert job['state']=='completed'
    assert 'owner' not in job


def test_production_routes_require_auth():
    from fastapi import HTTPException
    app=FastAPI();app.include_router(api.router)
    def reject(): raise HTTPException(401,'Unauthenticated')
    app.dependency_overrides[require_us_user]=reject
    c=TestClient(app)
    assert c.get('/api/us/research/packages').status_code==401
    assert c.post('/api/us/research/refresh',json={'symbols':'AAPL'}).status_code==401


def test_live_quote_request_limits_and_premium_boundary(client):
    c,_=client
    assert c.get('/api/us/research/live?symbols=../bad').status_code==422
    assert c.get('/api/us/research/live?symbols=&feed=iex').status_code==422
    assert c.get('/api/us/research/live?symbols=AAPL&feed=unknown').status_code==422
