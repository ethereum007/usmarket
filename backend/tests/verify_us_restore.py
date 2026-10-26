"""Compare disposable PostgreSQL backup/restore without printing stored content."""
import os
import psycopg

TABLES = ('us_plan_revisions','us_research_packages','us_refresh_jobs')
FUNCTIONS = ('us_plan_store','us_research_store','us_job_store','us_job_publish','us_job_interrupt')


def records(connection):
    result = {}
    for table in TABLES:
        # Fixed allowlist; compare every column including owner, revisions and timestamps.
        rows = connection.execute('select to_jsonb(t) from public.'+table+' t order by to_jsonb(t)::text').fetchall()
        assert rows, 'Missing synthetic test records'
        result[table] = rows
    return result


def definitions(connection):
    return connection.execute("select p.proname,pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(%s) order by p.proname",(list(FUNCTIONS),)).fetchall()


def verify(source_dsn, restored_dsn):
    with psycopg.connect(source_dsn) as source, psycopg.connect(restored_dsn) as restored:
        assert source.info.dbname=='usmarket_contract_test'
        assert restored.info.dbname=='usmarket_contract_restore_test'
        assert records(source)==records(restored), 'Restored records differ'
        original=definitions(source)
        assert len(original)==len(FUNCTIONS) and original==definitions(restored), 'Restored RPC definitions differ'
        for table in TABLES:
            assert restored.execute("select relrowsecurity from pg_class where oid=%s::regclass",('public.'+table,)).fetchone()==(True,)
        # Read the same owner through restored RPCs, using a real saved fixture identity.
        owner=source.execute('select id::text from auth.users order by id limit 1').fetchone()[0]
        for connection in (source,restored):
            connection.execute("select set_config('request.jwt.claim.sub',%s,true)",(owner,))
            connection.execute('set local role authenticated')
        for function in ('us_plan_store','us_research_store','us_job_store'):
            assert source.execute('select public.'+function+"('list')").fetchone()==restored.execute('select public.'+function+"('list')").fetchone(), 'Restored owner RPC differs'
    for role in ('anon','authenticated'):
        for table in TABLES:
            with psycopg.connect(restored_dsn) as connection:
                connection.execute('set local role '+role)
                try:
                    connection.execute('select * from public.'+table)
                except psycopg.Error as error:
                    assert error.sqlstate=='42501'
                else:
                    raise AssertionError('Restored direct table access was granted')
    # Restore must preserve function restrictions, including the recovery actions.
    with psycopg.connect(restored_dsn) as connection:
        for name in FUNCTIONS:
            privileges=connection.execute("select has_function_privilege('anon',p.oid,'execute'),has_function_privilege('authenticated',p.oid,'execute') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=%s",(name,)).fetchall()
            assert privileges==[(False,True)], 'Restored RPC permissions differ'


if __name__=='__main__':
    try:
        verify(os.environ['US_TEST_POSTGRES_DSN'],os.environ['US_TEST_POSTGRES_RESTORE_DSN'])
    except Exception:
        raise SystemExit('Disposable PostgreSQL restore verification failed; no stored content printed') from None
    print('Disposable PostgreSQL restore verified: exact records, RPCs, owner reads, RLS and access restrictions')
