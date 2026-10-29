"""Real SQL contracts in a disposable CI database, never the hosted project."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
from uuid import uuid4
import pytest

DSN = os.getenv('US_TEST_POSTGRES_DSN')
pytestmark = pytest.mark.skipif(not DSN, reason='Disposable PostgreSQL DSN not supplied')
A = '11111111-1111-4111-8111-111111111111'
B = '22222222-2222-4222-8222-222222222222'


@pytest.fixture(scope='module')
def pg():
    psycopg = pytest.importorskip('psycopg')
    with psycopg.connect(DSN, autocommit=True) as conn:
        # Refuse the supplied real project or any non-test database.
        assert conn.info.dbname == 'usmarket_contract_test'
        conn.execute('create role anon nologin; create role authenticated nologin; create schema auth')
        conn.execute('create table auth.users(id uuid primary key)')
        conn.execute("create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$")
        conn.execute('grant usage on schema auth,public to authenticated,anon')
        conn.execute('insert into auth.users values (%s),(%s)', (A,B))
        # Model a project whose existing defaults grant every new table to PUBLIC.
        conn.execute('alter default privileges in schema public grant select,insert,update,delete on tables to public')
        for migration in sorted((Path(__file__).resolve().parents[2]/'supabase'/'migrations').glob('*.sql')):
            conn.execute(migration.read_text(encoding='utf-8-sig'))
    return psycopg


def rpc(pg, owner, name, body, role='authenticated'):
    with pg.connect(DSN) as conn:
        conn.execute('select set_config(%s,%s,true)', ('request.jwt.claim.sub',owner or ''))
        # Fixed test-only role names, never interpolate caller-controlled SQL.
        assert role in {'authenticated','anon'}
        conn.execute('set local role ' + role)
        from psycopg.types.json import Jsonb
        keys = list(body)
        assert set(keys) <= {'action','plan_id','wanted_revision','expected_revision','plan_payload','package_id','package_payload','job_id','job_payload'}
        assert name in {'us_plan_store','us_research_store','us_job_store','us_job_publish','us_job_interrupt'}
        args = ','.join(key+' => %s' for key in keys)
        values = [Jsonb(value) if isinstance(value,dict) else value for value in body.values()]
        return conn.execute('select public.'+name+'('+args+')', values).fetchone()[0]


def plan_body(plan_id, expected=0, **changes):
    payload={'market':'US','currency':'USD','setup_id':'setup','package_id':'a'*64,
             'setup_version':'version','source_snapshot_id':'snapshot','symbol':'AAPL',
             'direction':'BULL','provider_asset_id':'asset','notes':'Synthetic only'}
    payload.update(changes)
    return dict(action='save',plan_id=plan_id,expected_revision=expected,plan_payload=payload)


def test_real_plan_revisions_owner_isolation_conflict_and_source_immutability(pg):
    key=str(uuid4())
    first=rpc(pg,A,'us_plan_store',plan_body(key))
    second=rpc(pg,A,'us_plan_store',plan_body(key,1,notes='Second'))
    assert [first['revision'],second['revision']]==[1,2]
    assert rpc(pg,A,'us_plan_store',dict(action='get',plan_id=key,wanted_revision=1))==first
    assert rpc(pg,B,'us_plan_store',dict(action='get',plan_id=key,wanted_revision=1)) is None
    for owner,body in [(A,plan_body(key,0)),(A,plan_body(key,2,symbol='MSFT')),(B,plan_body(key))]:
        with pytest.raises(pg.Error) as error:rpc(pg,owner,'us_plan_store',body)
        assert error.value.sqlstate=='PT409'
    assert rpc(pg,A,'us_plan_store',dict(action='get',plan_id=key,wanted_revision=2))==second


def test_concurrent_first_save_accepts_exactly_one_revision(pg):
    key=str(uuid4())
    def save(note):
        try:return rpc(pg,A,'us_plan_store',plan_body(key,notes=note))['revision']
        except pg.Error as error:return error.sqlstate
    with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(save,['First writer','Different writer']))
    assert sorted(map(str,results))==['1','PT409']


def test_anon_null_identity_and_direct_table_access_are_denied(pg):
    for role,owner in [('anon',None),('authenticated',None)]:
        with pytest.raises(pg.Error):rpc(pg,owner,'us_plan_store',dict(action='list'),role)
    with pg.connect(DSN) as conn:
        conn.execute('set local role authenticated')
        with pytest.raises(pg.Error):conn.execute('select * from public.us_plan_revisions')


def test_research_replay_is_immutable_and_private(pg):
    key=uuid4().hex*2
    payload={'id':key,'market':'US','currency':'USD','state':'final','session':'2026-10-19',
             'computed_at':'2026-10-20T00:00:00Z','instrument_snapshot':{'observed_at':'2026-10-20T00:00:00Z'},'symbols':['AAPL']}
    first=rpc(pg,A,'us_research_store',dict(action='publish',package_id=key,package_payload=payload))
    replay={**payload,'computed_at':'2026-10-20T01:00:00Z','instrument_snapshot':{'observed_at':'2026-10-20T01:00:00Z'}}
    assert rpc(pg,A,'us_research_store',dict(action='publish',package_id=key,package_payload=replay))==first
    assert rpc(pg,B,'us_research_store',dict(action='get',package_id=key)) is None
    with pytest.raises(pg.Error) as error:
        rpc(pg,A,'us_research_store',dict(action='publish',package_id=key,package_payload={**payload,'symbols':['MSFT']}))
    assert error.value.sqlstate=='PT409'


def test_job_transitions_require_published_owner_package_and_hide_other_owners(pg):
    job=str(uuid4()); key=uuid4().hex*2
    def save(state,**extra):return rpc(pg,A,'us_job_store',dict(action='save',job_id=job,job_payload={'id':job,'state':state,**extra}))
    queued=save('queued',owner=B,_access_token='do-not-store',error='private exception')
    assert set(queued)=={'id','state','updated_at'}
    save('running')
    with pytest.raises(pg.Error) as error:save('completed',package_id=key)
    assert error.value.sqlstate=='PT409'
    payload={'id':key,'market':'US','currency':'USD','state':'partial','session':'2026-10-19','computed_at':'2026-10-20T00:00:00Z'}
    rpc(pg,A,'us_research_store',dict(action='publish',package_id=key,package_payload=payload))
    assert save('completed',package_id=key)['package_id']==key
    assert rpc(pg,B,'us_job_store',dict(action='get',job_id=job)) is None
    with pytest.raises(pg.Error):save('failed')


@pytest.mark.parametrize('table',['us_plan_revisions','us_research_packages','us_refresh_jobs'])
@pytest.mark.parametrize('role',['authenticated','anon'])
def test_no_direct_table_access_even_with_permissive_public_defaults(pg,table,role):
    for statement in [f'select * from public.{table}',f'delete from public.{table}',
                      f'update public.{table} set payload=payload']:
        with pg.connect(DSN) as conn:
            conn.execute('select set_config(%s,%s,true)',('request.jwt.claim.sub',A))
            conn.execute('set local role '+role)
            with pytest.raises(pg.Error) as error:conn.execute(statement)
            assert error.value.sqlstate=='42501'


def test_authenticated_client_cannot_append_revision_outside_rpc(pg):
    from psycopg.types.json import Jsonb
    with pg.connect(DSN) as conn:
        conn.execute('select set_config(%s,%s,true)',('request.jwt.claim.sub',A))
        conn.execute('set local role authenticated')
        with pytest.raises(pg.Error) as error:
            conn.execute('insert into public.us_plan_revisions(id,revision,owner,payload) values(%s,99,%s,%s)',
                         (str(uuid4()),A,Jsonb({'notes':'Bypass expected revision'})))
        assert error.value.sqlstate=='42501'


@pytest.mark.parametrize('terminal',['completed','failed'])
def test_job_retry_preserves_observation_and_terminal_evidence(pg,terminal):
    job=str(uuid4()); key=uuid4().hex*2
    def save(state,**extra):
        return rpc(pg,A,'us_job_store',dict(action='save',job_id=job,
                   job_payload={'id':job,'state':state,**extra}))
    queued=save('queued')
    assert save('queued',error='ignored private detail')==queued
    running=save('running')
    assert save('running')==running
    with pytest.raises(pg.Error) as error:save('queued')
    assert error.value.sqlstate=='PT409'
    payload={'id':key,'market':'US','currency':'USD','state':'partial',
             'session':'2026-10-19','computed_at':'2026-10-20T00:00:00Z'}
    rpc(pg,A,'us_research_store',dict(action='publish',package_id=key,package_payload=payload))
    extra={'package_id':key} if terminal=='completed' else {}
    first=save(terminal,**extra)
    # Separate connections and competing retries must return the original record.
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda _:save(terminal,**extra),range(2)))
    assert results==[first,first]
    if terminal=='completed':
        for changed in [None,uuid4().hex*2]:
            with pytest.raises(pg.Error) as error:save('completed',package_id=changed)
            assert error.value.sqlstate=='PT409'
    with pytest.raises(pg.Error) as error:save('running')
    assert error.value.sqlstate=='PT409'
    assert rpc(pg,A,'us_job_store',dict(action='get',job_id=job))==first
    assert rpc(pg,B,'us_job_store',dict(action='get',job_id=job)) is None


def test_concurrent_refresh_admission_is_owner_scoped_and_released_only_by_terminal(pg):
    jobs=[str(uuid4()),str(uuid4())]
    def save(owner,job,state):
        return rpc(pg,owner,'us_job_store',dict(action='save',job_id=job,
                   job_payload={'id':job,'state':state}))
    def admit(job):
        try:return save(A,job,'queued')
        except pg.Error as error:return error.sqlstate
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(admit,jobs))
    winners=[row for row in results if isinstance(row,dict)]
    assert len(winners)==1
    assert [row for row in results if isinstance(row,str)]==['23505']
    winner=winners[0]['id']
    loser=next(job for job in jobs if job!=winner)
    foreign=str(uuid4())
    assert save(B,foreign,'queued')['state']=='queued'
    assert rpc(pg,B,'us_job_store',dict(action='get',job_id=winner)) is None
    save(A,winner,'running')
    # Old observations still reserve admission; elapsed time is not fencing.
    with pg.connect(DSN) as conn:
        conn.execute("update public.us_refresh_jobs set updated_at='2020-01-01T00:00:00Z' where owner=%s and id=%s",(A,winner))
    with pytest.raises(pg.Error) as error:save(A,loser,'queued')
    assert error.value.sqlstate=='23505'
    assert save(A,winner,'failed')['state']=='failed'
    assert save(A,loser,'queued')['state']=='queued'
    save(A,loser,'running'); save(A,loser,'failed')
    save(B,foreign,'running'); save(B,foreign,'failed')


def test_atomic_refresh_publication_and_replay(pg):
    job=str(uuid4()); key=uuid4().hex*2
    def state(value):return rpc(pg,A,'us_job_store',dict(action='save',job_id=job,job_payload={'id':job,'state':value}))
    payload={'id':key,'market':'US','currency':'USD','state':'final','session':'2026-10-23','computed_at':'2026-10-24T00:00:00Z'}
    body=dict(job_id=job,package_payload=payload)
    for role in ['anon','authenticated']:
        with pytest.raises(pg.Error):rpc(pg,None,'us_job_publish',body,role)
    state('queued')
    with pytest.raises(pg.Error):rpc(pg,A,'us_job_publish',body)
    assert rpc(pg,A,'us_research_store',dict(action='get',package_id=key)) is None
    state('running')
    with pytest.raises(pg.Error):rpc(pg,B,'us_job_publish',body)
    result=rpc(pg,A,'us_job_publish',body)
    assert result['job']['state']=='completed' and result['job']['package_id']==key
    assert rpc(pg,A,'us_research_store',dict(action='get',package_id=key))==payload
    assert rpc(pg,A,'us_job_publish',body)==result
    for changed in [{**payload,'state':'partial'},{**payload,'id':uuid4().hex*2}]:
        with pytest.raises(pg.Error):rpc(pg,A,'us_job_publish',dict(job_id=job,package_payload=changed))
    assert rpc(pg,A,'us_job_store',dict(action='get',job_id=job))==result['job']


def test_atomic_publication_rolls_back_when_completion_fails(pg):
    job=str(uuid4()); key=uuid4().hex*2
    for state in ['queued','running']:
        rpc(pg,A,'us_job_store',dict(action='save',job_id=job,job_payload={'id':job,'state':state}))
    # Inject a database failure after package insertion but before status completion.
    with pg.connect(DSN) as conn:
        conn.execute("create function public.test_reject_completion() returns trigger language plpgsql as $$ begin raise exception 'Synthetic completion failure'; end $$")
        conn.execute('create trigger test_reject_completion before update on public.us_refresh_jobs for each row execute function public.test_reject_completion()')
    try:
        payload={'id':key,'market':'US','currency':'USD','state':'partial'}
        with pytest.raises(pg.Error):rpc(pg,A,'us_job_publish',dict(job_id=job,package_payload=payload))
        assert rpc(pg,A,'us_research_store',dict(action='get',package_id=key)) is None
        assert rpc(pg,A,'us_job_store',dict(action='get',job_id=job))['state']=='running'
    finally:
        with pg.connect(DSN) as conn:
            conn.execute('drop trigger test_reject_completion on public.us_refresh_jobs')
            conn.execute('drop function public.test_reject_completion()')
    rpc(pg,A,'us_job_store',dict(action='save',job_id=job,job_payload={'id':job,'state':'failed'}))


@pytest.mark.parametrize('initial',['queued','running'])
def test_explicit_interruption_fences_publication_and_releases_admission(pg,initial):
    job=str(uuid4()); key=uuid4().hex*2
    def save(identity,state):
        return rpc(pg,A,'us_job_store',dict(action='save',job_id=identity,job_payload={'id':identity,'state':state}))
    save(job,'queued')
    if initial=='running':save(job,'running')
    for owner,role in [(None,'anon'),(None,'authenticated'),(B,'authenticated')]:
        with pytest.raises(pg.Error):rpc(pg,owner,'us_job_interrupt',dict(job_id=job),role)
    interrupted=rpc(pg,A,'us_job_interrupt',dict(job_id=job))
    assert interrupted['state']=='interrupted' and interrupted['completion_unknown'] is True
    assert rpc(pg,A,'us_job_interrupt',dict(job_id=job))==interrupted
    payload={'id':key,'market':'US','currency':'USD','state':'partial'}
    with pytest.raises(pg.Error):rpc(pg,A,'us_job_publish',dict(job_id=job,package_payload=payload))
    assert rpc(pg,A,'us_research_store',dict(action='get',package_id=key)) is None
    for state in ['running','failed']:
        with pytest.raises(pg.Error):save(job,state)
    replacement=str(uuid4())
    assert save(replacement,'queued')['state']=='queued'
    rpc(pg,A,'us_job_interrupt',dict(job_id=replacement))


def test_publication_interruption_race_has_one_preserved_outcome(pg):
    job=str(uuid4()); key=uuid4().hex*2
    for state in ['queued','running']:
        rpc(pg,A,'us_job_store',dict(action='save',job_id=job,job_payload={'id':job,'state':state}))
    payload={'id':key,'market':'US','currency':'USD','state':'partial'}
    def publish():
        try:return rpc(pg,A,'us_job_publish',dict(job_id=job,package_payload=payload))['job']
        except pg.Error as error:
            assert error.sqlstate=='PT409'
            return None
    def interrupt():return rpc(pg,A,'us_job_interrupt',dict(job_id=job))
    with ThreadPoolExecutor(max_workers=2) as pool:
        publishing=pool.submit(publish); interrupting=pool.submit(interrupt)
        publication=publishing.result(); interruption=interrupting.result()
    final=rpc(pg,A,'us_job_store',dict(action='get',job_id=job))
    package=rpc(pg,A,'us_research_store',dict(action='get',package_id=key))
    assert interruption==final
    if publication is None:
        assert final['state']=='interrupted' and package is None
    else:
        assert final==publication and final['state']=='completed' and package==payload
        assert rpc(pg,A,'us_job_interrupt',dict(job_id=job))==publication


def test_identical_plan_retry_returns_original_revision_without_append(pg):
    key=str(uuid4()); body=plan_body(key)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda _:rpc(pg,A,'us_plan_store',body),range(2)))
    assert results[0]==results[1] and results[0]['revision']==1
    first=results[0]
    assert rpc(pg,A,'us_plan_store',body)==first
    exported=rpc(pg,A,'us_plan_store',dict(action='export'))
    assert [row for row in exported if row['id']==key]==[first]
    for changed in [plan_body(key,notes='Changed stale notes'),plan_body(key,symbol='MSFT')]:
        with pytest.raises(pg.Error) as error:rpc(pg,A,'us_plan_store',changed)
        assert error.value.sqlstate=='PT409'
    second_body=plan_body(key,1,notes='Second revision')
    second=rpc(pg,A,'us_plan_store',second_body)
    assert rpc(pg,A,'us_plan_store',second_body)==second
    assert second['revision']==2
    # A response replay may not hide a still later revision.
    with pytest.raises(pg.Error) as error:rpc(pg,A,'us_plan_store',body)
    assert error.value.sqlstate=='PT409'
    with pytest.raises(pg.Error):rpc(pg,B,'us_plan_store',body)
    assert rpc(pg,A,'us_plan_store',dict(action='get',plan_id=key,wanted_revision=1))==first


def test_research_catalog_returns_only_metadata_and_exact_read_keeps_full_evidence(pg):
    key=uuid4().hex*2
    payload={'id':key,'market':'US','currency':'USD','state':'final',
             'universe':'us-synthetic','session':'2026-10-23','computed_at':'2026-10-24T00:00:00Z',
             'symbols':['AAPL'],'benchmark':'SPY','feed':'sip',
             'source_bars':{'AAPL':[{'date':'2026-10-23','close':100}]},
             'setups':[{'setup_version':'synthetic-exact-identity'}],
             'instrument_snapshot':{'records':{'AAPL':'synthetic-asset'}},
             'unexpected_internal':'must not enter the catalog'}
    rpc(pg,A,'us_research_store',dict(action='publish',package_id=key,package_payload=payload))
    catalog=rpc(pg,A,'us_research_store',dict(action='list'))
    summary=next(row for row in catalog if row['id']==key)
    fields={'id','market','currency','state','universe','session','computed_at','symbols','benchmark','feed'}
    assert summary=={field:payload[field] for field in fields}
    assert all(set(row)==fields for row in catalog)
    assert not any(row['id']==key for row in rpc(pg,B,'us_research_store',dict(action='list')))
    assert rpc(pg,A,'us_research_store',dict(action='get',package_id=key))==payload


@pytest.mark.parametrize('lost_revision',[None,1,2])
def test_api_remote_plan_journey_uses_real_sql_and_preserves_account_boundaries(pg,monkeypatch,lost_revision):
    import httpx
    from types import SimpleNamespace
    from unittest.mock import patch
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routes import us_plans
    from app.services import us_remote_plans,us_remote_research
    from app import us_auth
    key=uuid4().hex*2; version=uuid4().hex*2; plan=str(uuid4())
    package={'id':key,'market':'US','currency':'USD','state':'final','universe':'us-contract-journey',
             'session':'2026-10-23','computed_at':'2026-10-24T00:00:00Z','symbols':['AAPL'],'benchmark':'SPY','feed':'sip',
             'setups':[{'setup_version':version,'setup_id':'synthetic-setup','source_snapshot_id':'c'*64,
                        'symbol':'AAPL','signal':'BULL','provider_asset_id':'synthetic-asset'}]}
    rpc(pg,A,'us_research_store',dict(action='publish',package_id=key,package_payload=package))
    app=FastAPI();app.include_router(us_plans.router)
    client=TestClient(app)
    monkeypatch.setenv('US_PLAN_STORE','supabase');monkeypatch.setenv('US_RESEARCH_STORE','supabase')
    config=SimpleNamespace(SUPABASE_URL='https://apidhmrlawbjvisnadht.supabase.co',SUPABASE_ANON_KEY='public-test')
    monkeypatch.setattr(us_remote_plans,'settings',config);monkeypatch.setattr(us_remote_research,'settings',config)
    monkeypatch.setattr(us_auth,'settings',config)
    monkeypatch.setenv('US_INVITED_USER_IDS',A)
    requests=[];auth_requests=[];lost=[]
    def provider_identity(request):
        auth_requests.append(request)
        assert request.url.path=='/auth/v1/user' and request.headers['apikey']=='public-test'
        owner={'Bearer synthetic-account-a':A,'Bearer synthetic-account-b':B}.get(request.headers.get('authorization'))
        if owner is None:return httpx.Response(401,json={})
        return httpx.Response(200,json={'id':owner,'email':'synthetic@example.test',
            'email_confirmed_at':'2026-10-20T00:00:00Z','is_anonymous':False})
    def gateway(request):
        # Synthetic PostgREST wire shim only; execute actual migrated RPCs in PostgreSQL.
        requests.append(request)
        owner={'Bearer synthetic-account-a':A,'Bearer synthetic-account-b':B}[request.headers['authorization']]
        name=request.url.path.rsplit('/',1)[-1]
        try:
            body=json.loads(request.content)
            result=rpc(pg,owner,name,body)
            if name=='us_plan_store' and body.get('action')=='save' and result['revision']==lost_revision and not lost:
                lost.append(result)
                raise httpx.ReadTimeout('Synthetic lost plan acknowledgement after commit',request=request)
            # httpx json=None constructs an empty body, not JSON null.
            return httpx.Response(200,content=json.dumps(result),headers={'content-type':'application/json'})
        except pg.Error as error:
            return httpx.Response(409 if error.sqlstate in {'PT409','23505'} else 400,json={'code':error.sqlstate})
    original=httpx.Client;original_async=httpx.AsyncClient
    transport=httpx.MockTransport(gateway)
    values={'expected_revision':0,'package_id':key,'setup_version':version,'expiry':'2099-12-31',
            'exit_policy':'Conditional structural exit','notes':'Synthetic private thesis','state':'draft',
            'trigger':100,'stop':95,'capital':10000,'risk_pct':1,'allocation_cap_pct':25}
    with patch.object(us_remote_plans.httpx,'Client',lambda **kwargs:original(transport=transport,**kwargs)), \
         patch.object(us_auth.httpx,'AsyncClient',lambda **kwargs:original_async(transport=httpx.MockTransport(provider_identity),**kwargs)):
        assert client.get('/api/us/plans').status_code==401
        assert client.get('/api/us/plans',headers={'Authorization':'Bearer invalid-token'}).status_code==401
        assert requests==[]
        client.headers['Authorization']='Bearer synthetic-account-a'
        first=client.post('/api/us/plans/'+plan,json=values)
        assert first.status_code==(503 if lost_revision==1 else 200)
        if lost_revision==1:
            assert 'plan' not in first.json() and 'Synthetic' not in first.text
            saved=client.get('/api/us/plans/'+plan+'?revision=1').json()['plan']
            assert saved==lost[0]
            # Changing the ambiguous first write is not an identical retry.
            assert client.post('/api/us/plans/'+plan,json={**values,'notes':'Changed ambiguous draft'}).status_code==409
        else:
            saved=first.json()['plan']
        assert saved['revision']==1 and saved['quantity']==20 and saved['filled'] is False
        assert 'owner' not in saved and '_access_token' not in saved
        assert client.post('/api/us/plans/'+plan,json=values).json()['plan']==saved
        changed={**values,'expected_revision':1,'notes':'Revised synthetic thesis'}
        second=client.post('/api/us/plans/'+plan,json=changed)
        assert second.status_code==(503 if lost_revision==2 else 200)
        if lost_revision==2:
            assert 'plan' not in second.json() and 'Synthetic' not in second.text
            reopened=client.get('/api/us/plans/'+plan+'?revision=2').json()['plan']
            assert reopened==lost[0]
            replay=client.post('/api/us/plans/'+plan,json=changed)
            assert replay.status_code==200 and replay.json()['plan']==reopened
            assert client.post('/api/us/plans/'+plan,json={**changed,'notes':'Changed ambiguous revision'}).status_code==409
        else:
            assert second.json()['plan']['revision']==2
        assert client.get('/api/us/plans/'+plan+'?revision=1').json()['plan']==saved
        assert client.get('/api/us/plans').json()['plans'][0]['revision']==2
        client.headers['Authorization']='Bearer synthetic-account-b'
        before=len(requests)
        assert client.get('/api/us/plans').status_code==403
        assert len(requests)==before
        monkeypatch.setenv('US_INVITED_USER_IDS',A+','+B)
        assert client.get('/api/us/plans/'+plan+'?revision=1').status_code==404
        assert client.get('/api/us/plans').json()['plans']==[]
        # Even with its own source copy, B cannot collide with A's plan UUID.
        rpc(pg,B,'us_research_store',dict(action='publish',package_id=key,package_payload=package))
        assert client.post('/api/us/plans/'+plan,json=values).status_code==409
        client.headers['Authorization']='Bearer synthetic-account-a'
        exported=client.get('/api/us/plans/export').json()['plan_revisions']
        revisions=[row for row in exported if row['id']==plan]
        assert [row['revision'] for row in revisions]==[1,2]
        assert revisions[0]==saved and revisions[1]['notes']==changed['notes']
    assert auth_requests and requests and all('owner' not in json.loads(request.content) for request in requests)
    assert all(request.headers['authorization'] in {'Bearer synthetic-account-a','Bearer synthetic-account-b'} for request in requests)


    assert len(lost)==int(lost_revision is not None)


@pytest.mark.parametrize('interrupt_during_generation,lost_ack',[(False,None),(True,None),(False,'queued'),(False,'running'),(False,'publish')])
def test_api_remote_refresh_journey_and_interruption_use_real_sql(pg,monkeypatch,tmp_path,interrupt_during_generation,lost_ack):
    import httpx
    from dataclasses import replace
    from types import SimpleNamespace
    from unittest.mock import patch
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routes import us_research as api
    from app.services import us_remote_jobs,us_remote_research
    from app.us_auth import require_us_user
    key=uuid4().hex*2
    package={'id':key,'market':'US','currency':'USD','state':'partial','universe':'us-refresh-contract',
             'session':'2026-10-23','computed_at':'2026-10-24T00:00:00Z','symbols':['AAPL'],
             'benchmark':'SPY','feed':'sip','setups':[]}
    identity={'id':A,'_access_token':'synthetic-account-a'}
    app=FastAPI();app.include_router(api.router)
    app.dependency_overrides[require_us_user]=lambda:identity
    client=TestClient(app)
    monkeypatch.setenv('US_JOB_STORE','supabase');monkeypatch.setenv('US_RESEARCH_STORE','supabase')
    monkeypatch.setattr(api,'settings',replace(api.settings,DATA_DIR=tmp_path))
    config=SimpleNamespace(SUPABASE_URL='https://apidhmrlawbjvisnadht.supabase.co',SUPABASE_ANON_KEY='public-test')
    monkeypatch.setattr(us_remote_jobs,'settings',config);monkeypatch.setattr(us_remote_research,'settings',config)
    requests=[];generated=[];lost=[]
    def gateway(request):
        requests.append(request)
        owner={'Bearer synthetic-account-a':A,'Bearer synthetic-account-b':B}[request.headers['authorization']]
        name=request.url.path.rsplit('/',1)[-1]
        try:
            body=json.loads(request.content)
            result=rpc(pg,owner,name,body)
            stage='publish' if name=='us_job_publish' else body.get('job_payload',{}).get('state')
            if stage==lost_ack and lost_ack is not None and not lost:
                lost.append(result)
                # rpc() has exited its connection/transaction and committed before the reply is lost.
                raise httpx.ReadTimeout('Synthetic lost post-commit response',request=request)
            return httpx.Response(200,content=json.dumps(result),headers={'content-type':'application/json'})
        except pg.Error as error:
            return httpx.Response(409 if error.sqlstate in {'PT409','23505'} else 400,json={'code':error.sqlstate})
    async def generate(args):
        generated.append(args)
        assert args.publish_local is False
        active=[row for row in rpc(pg,A,'us_job_store',dict(action='list')) if row['state']=='running']
        assert len(active)==1
        if interrupt_during_generation:
            rpc(pg,A,'us_job_interrupt',dict(job_id=active[0]['id']))
        return package
    original=httpx.Client
    with patch.object(us_remote_jobs.httpx,'Client',lambda **kwargs:original(transport=httpx.MockTransport(gateway),**kwargs)), \
         patch.object(api,'run',generate), \
         patch.object(api,'acquire_refresh_lock',side_effect=OSError('No local storage allowed')) as local:
        response=client.post('/api/us/research/refresh',json={'symbols':'AAPL'})
        assert response.status_code==(503 if lost_ack=='queued' else 200)
        job=lost[0]['id'] if lost_ack=='queued' else response.json()['job']['id']
        recorded=client.get('/api/us/research/jobs/'+job).json()['job']
        if lost_ack in {'queued','running'}:
            assert recorded['state']==lost_ack
            assert generated==[]
            assert client.get('/api/us/research/packages/'+key).status_code==404
            # A committed admission remains reserved; response loss never means safe takeover.
            assert client.post('/api/us/research/refresh',json={'symbols':'AAPL'}).status_code==409
            assert generated==[]
            identity={'id':B,'_access_token':'synthetic-account-b'}
            assert client.post('/api/us/research/jobs/'+job+'/interrupt').status_code==409
            identity={'id':A,'_access_token':'synthetic-account-a'}
            recovered=client.post('/api/us/research/jobs/'+job+'/interrupt')
            assert recovered.status_code==200
            assert recovered.json()['job']['state']=='interrupted'
            assert recovered.json()['job']['completion_unknown'] is True
            retry=client.post('/api/us/research/refresh',json={'symbols':'AAPL'})
            assert retry.status_code==200 and retry.json()['job']['id']!=job
            assert client.get('/api/us/research/jobs/'+retry.json()['job']['id']).json()['job']['state']=='completed'
            assert client.get('/api/us/research/packages/'+key).json()['package']==package
        elif interrupt_during_generation:
            assert recorded['state']=='interrupted' and recorded['completion_unknown'] is True
            assert 'package_id' not in recorded
            assert client.get('/api/us/research/packages/'+key).status_code==404
        else:
            assert recorded['state']=='completed' and recorded['package_id']==key
            assert client.get('/api/us/research/packages/'+key).json()['package']==package
            catalog=client.get('/api/us/research/packages').json()['packages']
            assert any(row['id']==key and row['state']=='partial' for row in catalog)
            if lost_ack=='publish':
                assert recorded==us_remote_jobs.public_observation(lost[0]['job'],job)
                recovered=client.post('/api/us/research/jobs/'+job+'/interrupt').json()['job']
                assert recovered==recorded
                assert client.get('/api/us/research/packages/'+key).json()['package']==package
                attempted=[json.loads(request.content) for request in requests]
                assert any(body.get('job_payload',{}).get('state')=='failed' for body in attempted)
                # SQL has rejected that failure write; completion and the exact package persist.
                assert rpc(pg,A,'us_job_store',dict(action='get',job_id=job))['state']=='completed'

        identity={'id':B,'_access_token':'synthetic-account-b'}
        assert client.get('/api/us/research/jobs/'+job).status_code==404
        assert client.get('/api/us/research/packages/'+key).status_code==404
    local.assert_not_called()
    assert len(generated)==1 and list(tmp_path.iterdir())==[]
    assert 'synthetic-account-a' not in json.dumps(rpc(pg,A,'us_job_store',dict(action='get',job_id=job)))

    assert len(lost)==int(lost_ack is not None)


def inspection_sql():
    return (Path(__file__).resolve().parents[2]/'supabase'/'inspect_us_storage.sql').read_text(encoding='utf-8')


def test_read_only_operator_inspection_recognizes_applied_structure(pg):
    with pg.connect(DSN) as connection:
        rows=connection.execute(inspection_sql()).fetchall()
    assert len(rows)==9
    assert all(present and secure for _,_,present,secure in rows)


def test_operator_inspection_detects_permission_drift_without_printing_records(pg):
    with pg.connect(DSN) as connection:
        connection.execute('grant select on public.us_plan_revisions to anon')
        connection.execute('grant execute on function public.us_job_interrupt(uuid) to anon')
        rows=connection.execute(inspection_sql()).fetchall()
        checks={name:secure for _,name,_,secure in rows}
        assert checks['us_plan_revisions'] is False
        assert checks['us_job_interrupt(uuid)'] is False
        connection.rollback()
    with pg.connect(DSN) as connection:
        assert all(secure for _,_,_,secure in connection.execute(inspection_sql()).fetchall())


def test_operator_inspection_reports_missing_objects_instead_of_failing(pg):
    query=inspection_sql().replace('us_plan_revisions','missing_us_plan_revisions').replace('us_job_interrupt','missing_us_job_interrupt')
    with pg.connect(DSN) as connection:
        rows=connection.execute(query).fetchall()
    missing=[row for row in rows if row[1].startswith('missing_')]
    assert len(missing)==2
    assert all(present is False and secure is False for _,_,present,secure in missing)
