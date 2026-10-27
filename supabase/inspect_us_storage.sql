-- Read-only structural inspection. No user rows, credentials or grants are changed.
-- A passing result does not prove function-body identity or hosted acceptance.
with roles as (
 select (select oid from pg_roles where rolname='anon') as anon,
        (select oid from pg_roles where rolname='authenticated') as authenticated
), expected_tables(name) as (
 values ('us_plan_revisions'),('us_research_packages'),('us_refresh_jobs')
), expected_functions(signature) as (
 values ('us_plan_store(text,uuid,integer,integer,jsonb)'),
        ('us_research_store(text,text,jsonb)'),('us_job_store(text,uuid,jsonb)'),
        ('us_job_publish(uuid,jsonb)'),('us_job_interrupt(uuid)')
), checks as (
 select 'table' as object_kind, e.name as object_name, c.oid is not null as present,
   coalesce(c.relkind='r' and c.relrowsecurity
    and not has_table_privilege(r.anon,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_table_privilege(r.authenticated,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),false) as security_contract
 from expected_tables e cross join roles r
 left join pg_class c on c.oid=to_regclass('public.'||e.name)
 union all
 select 'function',e.signature,p.oid is not null,
   coalesce(p.prosecdef and p.proconfig @> array['search_path=""']::text[]
    and not has_function_privilege(r.anon,p.oid,'EXECUTE')
    and has_function_privilege(r.authenticated,p.oid,'EXECUTE'),false)
 from expected_functions e cross join roles r
 left join pg_proc p on p.oid=to_regprocedure('public.'||e.signature)
 union all
 select 'index','us_refresh_jobs_one_active_owner',i.indexrelid is not null,
   coalesce(i.indisunique and i.indisvalid and i.indpred is not null
    and i.indrelid=to_regclass('public.us_refresh_jobs'),false)
 from roles r left join pg_index i on i.indexrelid=to_regclass('public.us_refresh_jobs_one_active_owner')
)
select object_kind,object_name,present,security_contract from checks order by object_kind,object_name;
