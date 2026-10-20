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
        assert name in {'us_plan_store','us_research_store','us_job_store'}
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
