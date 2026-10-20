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


def catalog_package(key='a', computed='2026-07-02T00:30:00+00:00', session='2026-07-01'):
    return {'id':key*64, 'universe':'us-test', 'market':'US', 'currency':'USD', 'state':'final',
            'session':session, 'computed_at':computed, 'symbols':['AAPL'], 'benchmark':'SPY', 'feed':'sip'}


def write_catalog_package(root, package):
    folder=root/'us-research'; folder.mkdir(exist_ok=True)
    (folder/(package['id']+'.json')).write_text(json.dumps(package), encoding='utf-8')


def test_catalog_sorts_by_session_then_actual_instant_not_offset_text(client):
    c,root=client
    newer=catalog_package('a')
    offset_older=catalog_package('b', '2026-07-02T05:30:00+05:30')
    previous_session=catalog_package('c', '2026-07-03T01:00:00+00:00', '2026-06-30')
    for row in (offset_older, previous_session, newer):write_catalog_package(root,row)
    result=c.get('/api/us/research/packages').json()
    assert [row['id'] for row in result['packages']]==[newer['id'],offset_older['id'],previous_session['id']]
    assert result['unavailable_packages']==0


@pytest.mark.parametrize('content', ['{bad-json', '[]', 'null', '{"private":"not-package"}'])
def test_malformed_files_are_explicitly_omitted_without_breaking_valid_research(client,content):
    c,root=client
    valid=catalog_package()
    write_catalog_package(root,valid)
    (root/'us-research'/('b'*64+'.json')).write_text(content,encoding='utf-8')
    direct=c.get('/api/us/research/packages/'+'b'*64)
    assert direct.status_code==409 and 'private' not in direct.text
    result=c.get('/api/us/research/packages').json()
    assert len(result['packages'])==1 and result['unavailable_packages']==1


@pytest.mark.parametrize('change', [{'computed_at':'not-time'}, {'computed_at':'2026-07-02T00:00:00'},
    {'session':None}, {'universe':'../bad'}, {'symbols':None}, {'symbols':[{}]},
    {'symbols':['AAPL','AAPL']}, {'benchmark':'NIFTY'}, {'feed':None}, {'currency':'INR'}, {'state':'live'}])
def test_invalid_catalog_metadata_never_reaches_frontend(client,change):
    c,root=client
    row={**catalog_package(),**change}
    write_catalog_package(root,row)
    assert c.get('/api/us/research/packages/'+row['id']).status_code==409
    result=c.get('/api/us/research/packages').json()
    assert result['packages']==[] and result['unavailable_packages']==1


def test_storage_errors_are_sanitized(client):
    from pathlib import Path
    c,_=client
    with patch.object(Path,'read_text',side_effect=PermissionError('private disk path')):
        result=c.get('/api/us/research/packages/'+'a'*64)
    assert result.status_code==503 and 'private disk path' not in result.text


def test_pointer_files_are_not_counted_as_invalid_packages(client):
    c,root=client
    write_catalog_package(root,catalog_package())
    (root/'us-research'/'us-test-latest-final.json').write_text('{}')
    assert c.get('/api/us/research/packages').json()['unavailable_packages']==0


@pytest.mark.parametrize('failure', [ValueError, RuntimeError, OSError])
def test_refresh_failure_never_discloses_exception_and_releases_worker(client, failure):
    from unittest.mock import AsyncMock
    c,_=client
    secret='credential=private-provider-value /private/runtime/path'
    with patch.object(api,'run',AsyncMock(side_effect=failure(secret))):
        response=c.post('/api/us/research/refresh',json={'symbols':'AAPL'})
    result=c.get('/api/us/research/jobs/'+response.json()['job']['id'])
    job=result.json()['job']
    assert job['state']=='failed'
    assert job['error']=='Research refresh failed; saved research remains available'
    assert secret not in result.text and 'owner' not in job
    with patch.object(api,'run',AsyncMock(return_value={'id':'c'*64})):
        retry=c.post('/api/us/research/refresh',json={'symbols':'AAPL'})
    assert retry.status_code==200
    assert c.get('/api/us/research/jobs/'+retry.json()['job']['id']).json()['job']['state']=='completed'
