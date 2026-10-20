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
    api.persist_job({'id':'foreign','owner':'other','state':'completed'})
    assert c.get('/api/us/research/jobs/foreign').status_code==404


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


def test_job_result_survives_fresh_application_and_is_owner_isolated(client):
    from unittest.mock import AsyncMock
    c,_=client
    with patch.object(api,'run',AsyncMock(return_value={'id':'d'*64})):
        response=c.post('/api/us/research/refresh',json={'symbols':'AAPL'})
    url='/api/us/research/jobs/'+response.json()['job']['id']
    app=FastAPI();app.include_router(api.router)
    app.dependency_overrides[require_us_user]=lambda:{'id':'owner'}
    fresh=TestClient(app)
    assert fresh.get(url).json()['job']['package_id']=='d'*64
    assert fresh.get(url).json()['job']['updated_at'].endswith('+00:00')
    app.dependency_overrides[require_us_user]=lambda:{'id':'other'}
    assert fresh.get(url).status_code==404


def test_status_write_failure_blocks_provider_and_releases_lock(client):
    from unittest.mock import AsyncMock
    c,_=client
    provider=AsyncMock(return_value={'id':'e'*64})
    with patch.object(api,'persist_job',side_effect=OSError('private path')), patch.object(api,'run',provider):
        result=c.post('/api/us/research/refresh',json={'symbols':'AAPL'})
    assert result.status_code==503 and 'private path' not in result.text
    provider.assert_not_called()
    assert not api._lock.locked()


def test_running_write_failure_prevents_provider(client):
    from unittest.mock import AsyncMock
    c,_=client
    original=api.persist_job
    def fail_running(data):
        if data['state']=='running':raise OSError('private')
        original(data)
    with patch.object(api,'persist_job',side_effect=fail_running), patch.object(api,'run',AsyncMock()) as provider:
        result=c.post('/api/us/research/refresh',json={'symbols':'AAPL'})
    job=c.get('/api/us/research/jobs/'+result.json()['job']['id']).json()['job']
    assert job['state']=='queued'  # Only the durable observation is asserted.
    provider.assert_not_called()
    assert not api._lock.locked()


def test_completion_write_failure_does_not_invent_failed_publication(client):
    from unittest.mock import AsyncMock
    c,_=client
    original=api.persist_job
    def fail_completed(data):
        if data['state']=='completed':raise OSError('private')
        original(data)
    with patch.object(api,'persist_job',side_effect=fail_completed), patch.object(api,'run',AsyncMock(return_value={'id':'e'*64})):
        result=c.post('/api/us/research/refresh',json={'symbols':'AAPL'})
    job=c.get('/api/us/research/jobs/'+result.json()['job']['id']).json()['job']
    assert job['state']=='running' and 'package_id' not in job
    assert not api._lock.locked()


def test_old_running_job_remains_last_known_not_claimed_dead(client):
    c,_=client
    api.repository.save_job({'id':'old','owner':'owner','state':'running'},
        database_path=api.job_database(),updated_at='2020-01-01T00:00:00+00:00')
    assert c.get('/api/us/research/jobs/old').json()['job']['state']=='running'
    with patch.object(api.repository,'get_job',side_effect=OSError('private path')):
        result=c.get('/api/us/research/jobs/old')
    assert result.status_code==503 and 'private path' not in result.text


def test_job_can_be_read_in_separate_python_process(client):
    import subprocess,sys
    c,_=client
    api.persist_job({'id':'persisted','owner':'owner','state':'completed','package_id':'f'*64})
    script="from pathlib import Path; import sys,json; from app.services.swing_repository import get_job; print(json.dumps(get_job('persisted','owner',database_path=Path(sys.argv[1]),stale_after=None)))"
    result=subprocess.run([sys.executable,'-c',script,str(api.job_database())],capture_output=True,text=True,check=True)
    assert json.loads(result.stdout)['package_id']=='f'*64


def test_recent_jobs_only_returns_owner_latest_twenty_in_order(client):
    c,_=client
    for index in range(25):
        api.repository.save_job({'id':f'job-{index:02}','owner':'owner','state':'completed','internal':'hidden'},
            database_path=api.job_database(),updated_at=f'2026-10-20T10:{index:02}:00+00:00')
    api.persist_job({'id':'foreign','owner':'other','state':'running'})
    result=c.get('/api/us/research/jobs')
    assert result.status_code==200
    rows=result.json()['jobs']
    assert len(rows)==20 and rows[0]['id']=='job-24' and rows[-1]['id']=='job-05'
    assert 'owner' not in result.text and 'hidden' not in result.text and 'foreign' not in result.text


def test_recent_jobs_empty_and_storage_error_are_distinct(client):
    c,_=client
    assert c.get('/api/us/research/jobs').json()['jobs']==[]
    with patch.object(api.repository,'list_jobs',side_effect=OSError('private path')):
        result=c.get('/api/us/research/jobs')
    assert result.status_code==503 and 'private path' not in result.text


def test_recent_job_history_requires_auth():
    from fastapi import HTTPException
    app=FastAPI();app.include_router(api.router)
    def reject():raise HTTPException(401,'Unauthenticated')
    app.dependency_overrides[require_us_user]=reject
    assert TestClient(app).get('/api/us/research/jobs').status_code==401
