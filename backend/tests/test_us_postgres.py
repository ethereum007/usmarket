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
    def save():
        try:return rpc(pg,A,'us_plan_store',plan_body(key))['revision']
        except pg.Error as error:return error.sqlstate
    with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:save(),range(2)))
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
