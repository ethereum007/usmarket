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
    lock=api.acquire_refresh_lock(api.settings.DATA_DIR/'us-refresh-lock.sqlite3');lock.release()


def test_running_write_failure_prevents_provider(client):
    from unittest.mock import AsyncMock
    c,_=client
    original=api.persist_job
    def fail_running(data, access_token=None):
        if data['state']=='running':raise OSError('private')
        original(data)
    with patch.object(api,'persist_job',side_effect=fail_running), patch.object(api,'run',AsyncMock()) as provider:
        result=c.post('/api/us/research/refresh',json={'symbols':'AAPL'})
    job=c.get('/api/us/research/jobs/'+result.json()['job']['id']).json()['job']
    assert job['state']=='queued'  # Only the durable observation is asserted.
    provider.assert_not_called()
    lock=api.acquire_refresh_lock(api.settings.DATA_DIR/'us-refresh-lock.sqlite3');lock.release()


def test_completion_write_failure_does_not_invent_failed_publication(client):
    from unittest.mock import AsyncMock
    c,_=client
    original=api.persist_job
    def fail_completed(data, access_token=None):
        if data['state']=='completed':raise OSError('private')
        original(data)
    with patch.object(api,'persist_job',side_effect=fail_completed), patch.object(api,'run',AsyncMock(return_value={'id':'e'*64})):
        result=c.post('/api/us/research/refresh',json={'symbols':'AAPL'})
    job=c.get('/api/us/research/jobs/'+result.json()['job']['id']).json()['job']
    assert job['state']=='running' and 'package_id' not in job
    lock=api.acquire_refresh_lock(api.settings.DATA_DIR/'us-refresh-lock.sqlite3');lock.release()


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


def test_refresh_rejects_another_worker_before_creating_job(client):
    c,_=client
    lock=api.acquire_refresh_lock(api.settings.DATA_DIR/'us-refresh-lock.sqlite3')
    try:
        response=c.post('/api/us/research/refresh',json={'symbols':'AAPL'})
        assert response.status_code==409
        assert c.get('/api/us/research/jobs').json()['jobs']==[]
    finally:lock.release()


def test_lock_storage_failure_is_sanitized(client):
    c,_=client
    with patch.object(api,'acquire_refresh_lock',side_effect=OSError('private path')):
        result=c.post('/api/us/research/refresh',json={'symbols':'AAPL'})
    assert result.status_code==503 and 'private path' not in result.text


def test_lock_is_held_during_provider_work_and_status_write(client):
    from unittest.mock import AsyncMock
    c,_=client
    path=api.settings.DATA_DIR/'us-refresh-lock.sqlite3'
    async def provider(args):
        with pytest.raises(api.RefreshBusy):api.acquire_refresh_lock(path)
        return {'id':'f'*64}
    original=api.persist_job
    def persist(data, access_token=None):
        with pytest.raises(api.RefreshBusy):api.acquire_refresh_lock(path)
        original(data)
    with patch.object(api,'run',provider),patch.object(api,'persist_job',side_effect=persist):
        result=c.post('/api/us/research/refresh',json={'symbols':'AAPL'})
    assert result.status_code==200
    assert c.get('/api/us/research/jobs/'+result.json()['job']['id']).json()['job']['state']=='completed'
    lock=api.acquire_refresh_lock(path);lock.release()


def test_task_scheduling_failure_releases_reservation(client):
    from unittest.mock import Mock
    c,_=client
    tasks=Mock();tasks.add_task.side_effect=RuntimeError('scheduling failed')
    with pytest.raises(RuntimeError):api.refresh(api.RefreshRequest(symbols='AAPL'),tasks,{'id':'owner'})
    lock=api.acquire_refresh_lock(api.settings.DATA_DIR/'us-refresh-lock.sqlite3');lock.release()


def test_next_exclusive_refresh_reconciles_old_jobs_without_claiming_publication_failure(client):
    from unittest.mock import AsyncMock
    c,_=client
    for owner,state in [('owner','running'),('other','queued')]:
        api.persist_job({'id':owner+'-old','owner':owner,'state':state})
    api.persist_job({'id':'completed','owner':'owner','state':'completed','package_id':'a'*64})
    with patch.object(api,'run',AsyncMock(return_value={'id':'b'*64})):
        response=c.post('/api/us/research/refresh',json={'symbols':'AAPL'})
    assert response.status_code==200
    old=c.get('/api/us/research/jobs/owner-old').json()['job']
    assert old['state']=='interrupted' and old['completion_unknown'] is True
    assert 'completion is unknown' in old['error'] and 'package_id' not in old
    assert c.get('/api/us/research/jobs/other-old').status_code==404
    other=api.repository.get_job('other-old','other',database_path=api.job_database(),stale_after=None)
    assert other['state']=='interrupted' and other['completion_unknown'] is True
    completed=c.get('/api/us/research/jobs/completed').json()['job']
    assert completed['state']=='completed' and completed['package_id']=='a'*64
    listing=c.get('/api/us/research/jobs').json()['jobs']
    assert next(row for row in listing if row['id']=='owner-old')['completion_unknown'] is True


def test_held_reservation_prevents_reconciliation_even_for_old_job(client):
    c,_=client
    api.persist_job({'id':'old','owner':'owner','state':'running'})
    lock=api.acquire_refresh_lock(api.settings.DATA_DIR/'us-refresh-lock.sqlite3')
    try:
        assert c.post('/api/us/research/refresh',json={'symbols':'AAPL'}).status_code==409
        assert c.get('/api/us/research/jobs/old').json()['job']['state']=='running'
    finally:lock.release()


def test_reconciliation_storage_failure_blocks_fetch_and_releases_lock(client):
    from unittest.mock import AsyncMock
    c,_=client
    with patch.object(api.repository,'interrupt_jobs',side_effect=OSError('private path')),patch.object(api,'run',AsyncMock()) as provider:
        response=c.post('/api/us/research/refresh',json={'symbols':'AAPL'})
    assert response.status_code==503 and 'private path' not in response.text
    provider.assert_not_called()
    assert c.get('/api/us/research/jobs').json()['jobs']==[]
    lock=api.acquire_refresh_lock(api.settings.DATA_DIR/'us-refresh-lock.sqlite3');lock.release()


def test_reconciliation_transaction_rolls_back_on_invalid_record(client):
    c,_=client
    api.persist_job({'id':'valid','owner':'owner','state':'running'})
    with api.repository.database(api.job_database()) as conn:
        conn.execute('INSERT INTO research_jobs VALUES (?,?,?,?)',('broken','owner','now','{bad'))
    with pytest.raises(ValueError):
        api.repository.interrupt_jobs(database_path=api.job_database(),updated_at='2026-10-20T10:00:00+00:00',message='completion unknown')
    assert c.get('/api/us/research/jobs/valid').json()['job']['state']=='running'



def test_remote_package_read_never_falls_back_to_local_file(monkeypatch):
    from app.routes import us_research as routes
    from fastapi import HTTPException
    monkeypatch.setenv('US_RESEARCH_STORE', 'supabase')
    with patch.object(routes.remote_research, 'execute', return_value=None) as remote:
        with pytest.raises(HTTPException) as error:
            routes.read_package('a' * 64, 'test-token')
    assert error.value.status_code == 404
    remote.assert_called_once_with('get', 'test-token', 'a' * 64)


def test_remote_package_rejects_wrong_identity(monkeypatch):
    from app.routes import us_research as routes
    from fastapi import HTTPException
    monkeypatch.setenv('US_RESEARCH_STORE', 'supabase')
    with patch.object(routes.remote_research, 'execute', return_value={'id':'b'*64}):
        with pytest.raises(HTTPException) as error:
            routes.read_package('a' * 64, 'test-token')
    assert error.value.status_code == 409


@pytest.mark.parametrize('status,payload,expected', [(500, {'secret':'provider'},503),
    (409, {},409), (200, {'wrong':'shape'},503)])
def test_remote_catalog_transport_errors_are_sanitized(status,payload,expected,monkeypatch):
    import httpx
    from types import SimpleNamespace
    from app.services import us_remote_research as remote
    from fastapi import HTTPException
    monkeypatch.setattr(remote, 'settings', SimpleNamespace(SUPABASE_URL='https://us.example',SUPABASE_ANON_KEY='public-test'))
    original = httpx.Client
    transport = httpx.MockTransport(lambda request: httpx.Response(status,json=payload))
    with patch.object(remote.httpx, 'Client', lambda **kwargs: original(transport=transport, **kwargs)):
        with pytest.raises(HTTPException) as error:
            remote.execute('list', 'test-token')
    assert error.value.status_code == expected
    assert 'provider' not in str(error.value) and 'test-token' not in str(error.value)


@pytest.mark.parametrize('fails',[False,True])
def test_remote_refresh_requires_publication_ack_and_never_persists_token(client,monkeypatch,fails):
    from unittest.mock import AsyncMock
    from fastapi import HTTPException
    c, root = client
    monkeypatch.setenv('US_RESEARCH_STORE','supabase')
    c.app.dependency_overrides[require_us_user] = lambda: {'id':'owner','_access_token':'private-test-token'}
    package = {'id':'e'*64}
    with patch.object(api,'run',AsyncMock(return_value=package)), patch.object(api.remote_research,'execute',
            side_effect=HTTPException(503,'private provider response') if fails else None,
            return_value=package) as publish:
        response = c.post('/api/us/research/refresh',json={'symbols':'AAPL'})
    publish.assert_called_once_with('publish','private-test-token',package['id'],package)
    job = c.get('/api/us/research/jobs/' + response.json()['job']['id']).json()['job']
    assert job['state'] == ('failed' if fails else 'completed')
    assert ('package_id' in job) is not fails
    stored = api.repository.list_jobs('owner',database_path=api.job_database())[0]
    assert 'private-test-token' not in json.dumps(stored)
    assert 'private provider response' not in json.dumps(job)



def test_remote_jobs_route_forwards_token_and_never_uses_local_history(client,monkeypatch):
    c,_ = client
    monkeypatch.setenv('US_JOB_STORE','supabase')
    monkeypatch.setenv('US_RESEARCH_STORE','supabase')
    c.app.dependency_overrides[require_us_user] = lambda: {'id':'owner','_access_token':'private-token'}
    with patch.object(api.remote_jobs,'execute',return_value=[]) as remote, patch.object(api.repository,'list_jobs') as local:
        result=c.get('/api/us/research/jobs')
    assert result.json() == {'success':True,'jobs':[]}
    remote.assert_called_once_with('list','private-token')
    local.assert_not_called()


def test_remote_job_transport_strips_identity_credentials_and_arbitrary_errors(monkeypatch):
    import httpx
    from types import SimpleNamespace
    from app.services import us_remote_jobs as remote
    monkeypatch.setattr(remote,'settings',SimpleNamespace(SUPABASE_URL='https://us.example',SUPABASE_ANON_KEY='public-test'))
    requests=[]
    original=httpx.Client
    transport=httpx.MockTransport(lambda request: (requests.append(request) or httpx.Response(200,json={'id':'one','state':'queued'})))
    payload={'id':'one','state':'queued','owner':'foreign','_access_token':'secret','error':'provider secret'}
    with patch.object(remote.httpx,'Client',lambda **kwargs:original(transport=transport,**kwargs)):
        remote.execute('save','verified-token','one',payload)
    body=json.loads(requests[0].content)
    assert body=={'action':'save','job_id':'one','job_payload':{'id':'one','state':'queued'}}
    assert requests[0].headers['authorization']=='Bearer verified-token'


def test_remote_jobs_require_remote_research_and_reject_unknown_modes(monkeypatch):
    from fastapi import HTTPException
    for mode in ['supabase','typo']:
        monkeypatch.setenv('US_JOB_STORE',mode)
        monkeypatch.setenv('US_RESEARCH_STORE','local')
        with pytest.raises(HTTPException) as error:api.remote_jobs.enabled()
        assert error.value.status_code==503


@pytest.mark.parametrize('row',[
    {'id':'other','state':'running'},
    {'id':'one','state':'invented'},
    {'id':'one','state':'running','updated_at':'private-provider-value'},
    {'id':'one','state':'running','updated_at':'2026-10-22T10:00:00'},
    {'id':'one','state':'completed','package_id':'not-a-package'},
])
def test_remote_job_read_rejects_wrong_identity_or_unverifiable_completion(row,monkeypatch):
    import httpx
    from types import SimpleNamespace
    from fastapi import HTTPException
    from app.services import us_remote_jobs as remote
    monkeypatch.setattr(remote,'settings',SimpleNamespace(SUPABASE_URL='https://us.example',SUPABASE_ANON_KEY='public-test'))
    original=httpx.Client
    transport=httpx.MockTransport(lambda request:httpx.Response(200,json=row))
    with patch.object(remote.httpx,'Client',lambda **kwargs:original(transport=transport,**kwargs)):
        with pytest.raises(HTTPException) as error:remote.execute('get','token','one')
    assert error.value.status_code==503


def test_remote_observation_drops_unapproved_fields_and_sanitizes_error():
    from app.services.us_remote_jobs import public_observation
    result=public_observation({'id':'one','state':'failed','owner':'private-owner',
        '_access_token':'private-token','error':'private provider body','package_id':'a'*64},'one')
    assert result=={'id':'one','state':'failed','error':'Research refresh failed; saved research remains available'}
    assert 'private' not in json.dumps(result)


@pytest.mark.parametrize('change',[
    {'symbols':['MSFT']}, {'state':'partial'}, {'currency':'INR'},
    {'computed_at':'no-observation-time'},
])
def test_remote_publication_rejects_same_id_with_changed_or_invalid_evidence(change,monkeypatch):
    import httpx
    from types import SimpleNamespace
    from fastapi import HTTPException
    from app.services import us_remote_research as remote
    payload={'id':'a'*64,'universe':'us-test','market':'US','currency':'USD','state':'final',
        'session':'2026-10-23','computed_at':'2026-10-24T00:00:00Z','symbols':['AAPL']}
    monkeypatch.setattr(remote,'settings',SimpleNamespace(SUPABASE_URL='https://us.example',SUPABASE_ANON_KEY='public-test'))
    original=httpx.Client
    transport=httpx.MockTransport(lambda request:httpx.Response(200,json={**payload,**change}))
    with patch.object(remote.httpx,'Client',lambda **kwargs:original(transport=transport,**kwargs)):
        with pytest.raises(HTTPException) as error:remote.execute('publish','token',payload['id'],payload)
    assert error.value.status_code==503
    assert 'AAPL' not in str(error.value) and 'token' not in str(error.value)


def test_remote_publication_accepts_identical_replay_with_original_observation(monkeypatch):
    import httpx
    from types import SimpleNamespace
    from app.services import us_remote_research as remote
    payload={'id':'a'*64,'universe':'us-test','market':'US','currency':'USD','state':'final',
        'session':'2026-10-23','computed_at':'2026-10-24T01:00:00Z','symbols':['AAPL'],
        'instrument_snapshot':{'observed_at':'2026-10-24T01:00:00Z','records':{'AAPL':'synthetic'}}}
    earlier={**payload,'computed_at':'2026-10-24T00:00:00Z',
        'instrument_snapshot':{'observed_at':'2026-10-24T00:00:00Z','records':{'AAPL':'synthetic'}}}
    monkeypatch.setattr(remote,'settings',SimpleNamespace(SUPABASE_URL='https://us.example',SUPABASE_ANON_KEY='public-test'))
    original=httpx.Client
    transport=httpx.MockTransport(lambda request:httpx.Response(200,json=earlier))
    with patch.object(remote.httpx,'Client',lambda **kwargs:original(transport=transport,**kwargs)):
        assert remote.execute('publish','token',payload['id'],payload)==earlier


@pytest.mark.parametrize('status',[409,503])
def test_remote_admission_failure_never_schedules_provider_and_releases_local_lock(client,monkeypatch,status):
    from unittest.mock import AsyncMock
    from fastapi import HTTPException
    c,_=client
    monkeypatch.setenv('US_JOB_STORE','supabase')
    monkeypatch.setenv('US_RESEARCH_STORE','supabase')
    with patch.object(api.remote_jobs,'execute',side_effect=HTTPException(status,'Refresh admission unavailable')), \
         patch.object(api,'run',AsyncMock()) as provider:
        response=c.post('/api/us/research/refresh',json={'symbols':'AAPL'})
    assert response.status_code==status
    provider.assert_not_called()
    lock=api.acquire_refresh_lock(api.settings.DATA_DIR/'us-refresh-lock.sqlite3')
    lock.release()


@pytest.mark.parametrize('requested,reply',[
    ({'state':'queued'},{'state':'running'}),
    ({'state':'running'},{'state':'queued'}),
    ({'state':'completed','package_id':'a'*64},{'state':'completed','package_id':'b'*64}),
])
def test_remote_job_save_requires_exact_transition_acknowledgement(monkeypatch,requested,reply):
    import httpx
    from types import SimpleNamespace
    from fastapi import HTTPException
    from app.services import us_remote_jobs as remote
    monkeypatch.setattr(remote,'settings',SimpleNamespace(SUPABASE_URL='https://us.example',SUPABASE_ANON_KEY='public-test'))
    original=httpx.Client
    transport=httpx.MockTransport(lambda request:httpx.Response(200,json={'id':'one',**reply}))
    with patch.object(remote.httpx,'Client',lambda **kwargs:original(transport=transport,**kwargs)):
        with pytest.raises(HTTPException) as error:
            remote.execute('save','private-token','one',{'id':'one',**requested})
    assert error.value.status_code==503
    assert 'private-token' not in str(error.value)


def test_remote_refresh_uses_atomic_publication_without_second_terminal_write(client,monkeypatch):
    from unittest.mock import AsyncMock
    c,_=client
    monkeypatch.setenv('US_JOB_STORE','supabase'); monkeypatch.setenv('US_RESEARCH_STORE','supabase')
    package={'id':'a'*64}
    with patch.object(api.remote_jobs,'execute',return_value={}) as jobs, \
         patch.object(api.remote_research,'execute') as separate_publish, \
         patch.object(api,'run',AsyncMock(return_value=package)):
        response=c.post('/api/us/research/refresh',json={'symbols':'AAPL'})
    assert response.status_code==200
    calls=jobs.call_args_list
    assert [call.args[0] for call in calls]==['save','save','publish']
    assert calls[-1].args[2]==response.json()['job']['id']
    assert calls[-1].args[3]==package
    separate_publish.assert_not_called()


@pytest.mark.parametrize('change',['none','package','job'])
def test_atomic_publication_transport_validates_both_records(monkeypatch,change):
    import httpx
    from types import SimpleNamespace
    from fastapi import HTTPException
    from app.services import us_remote_jobs as remote
    monkeypatch.setattr(remote,'settings',SimpleNamespace(SUPABASE_URL='https://us.example',SUPABASE_ANON_KEY='public-test'))
    package={'id':'a'*64,'universe':'us-test','market':'US','currency':'USD','state':'final',
             'session':'2026-10-23','computed_at':'2026-10-24T00:00:00Z'}
    result={'package':dict(package),'job':{'id':'one','state':'completed','package_id':package['id']}}
    if change=='package':result['package']['state']='partial'
    if change=='job':result['job']['package_id']='b'*64
    requests=[]; original=httpx.Client
    transport=httpx.MockTransport(lambda request:(requests.append(request) or httpx.Response(200,json=result)))
    with patch.object(remote.httpx,'Client',lambda **kwargs:original(transport=transport,**kwargs)):
        if change=='none':assert remote.execute('publish','token','one',package)['state']=='completed'
        else:
            with pytest.raises(HTTPException) as error:remote.execute('publish','token','one',package)
            assert error.value.status_code==503
    assert requests[0].url.path=='/rest/v1/rpc/us_job_publish'
    assert json.loads(requests[0].content)=={'job_id':'one','package_payload':package}


def test_remote_interrupted_observation_retains_unknown_and_drops_private_fields():
    from app.services.us_remote_jobs import public_observation
    result=public_observation({'id':'one','state':'interrupted','completion_unknown':False,
        'error':'private worker body','package_id':'a'*64,'owner':'private-owner'})
    assert result['completion_unknown'] is True
    assert 'private' not in json.dumps(result)
    assert 'package_id' not in result
