-- Read-only structural inspection. No user rows, credentials or grants are changed.
-- A passing result does not prove function-body identity or hosted acceptance.
with roles as (
 select (select oid from pg_roles where rolname='anon') as anon,
        (select oid from pg_roles where rolname='authenticated') as authenticated,
        (select count(*)=2 and bool_and(not rolsuper and not rolbypassrls)
         from pg_roles where rolname in ('anon','authenticated')) as client_roles_enforce_rls
), expected_tables(name, primary_key) as (
 values ('us_plan_revisions','PRIMARY KEY (id, revision)'),
        ('us_research_packages','PRIMARY KEY (owner, id)'),
        ('us_refresh_jobs','PRIMARY KEY (owner, id)')
), expected_functions(signature, argument_names, optional_count) as (
 values ('us_plan_store(text,uuid,integer,integer,jsonb)',
         array['action','plan_id','wanted_revision','expected_revision','plan_payload'],4),
        ('us_research_store(text,text,jsonb)',array['action','package_id','package_payload'],2),
        ('us_job_store(text,uuid,jsonb)',array['action','job_id','job_payload'],2),
        ('us_job_publish(uuid,jsonb)',array['job_id','package_payload'],0),
        ('us_job_interrupt(uuid)',array['job_id'],0)
), checks as (
 select 'table' as object_kind, e.name as object_name, c.oid is not null as present,
   coalesce(c.relkind='r' and c.relpersistence='p' and c.relrowsecurity and r.client_roles_enforce_rls
    and exists (
     select 1 from pg_constraint k
     where k.conrelid=c.oid and k.contype='p' and not k.condeferrable
      and pg_get_constraintdef(k.oid)=e.primary_key
    )
    and exists (
     select 1 from pg_constraint fk
     join pg_attribute owner_column on owner_column.attrelid=c.oid and owner_column.attname='owner'
     join pg_attribute user_id on user_id.attrelid=fk.confrelid and user_id.attname='id'
     where fk.conrelid=c.oid and fk.contype='f' and fk.convalidated
      and not fk.condeferrable and fk.confdeltype='a' and fk.confupdtype='a'
      and fk.confrelid=to_regclass('auth.users')
      and fk.conkey=array[owner_column.attnum] and fk.confkey=array[user_id.attnum]
      and owner_column.attnotnull
    )
    and not has_table_privilege(r.anon,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_table_privilege(r.authenticated,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_any_column_privilege(r.anon,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
    and not has_any_column_privilege(r.authenticated,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'),false) as security_contract
 from expected_tables e cross join roles r
 left join pg_class c on c.oid=to_regclass('public.'||e.name)
 union all
 select 'function',e.signature,p.oid is not null,
   coalesce(p.prokind='f' and p.provolatile='v' and not p.proisstrict
    and p.prorettype='jsonb'::regtype and not p.proretset
    and p.proargnames=e.argument_names and p.pronargdefaults=e.optional_count
    and not exists (
     select 1
     from generate_series(p.pronargs-p.pronargdefaults+1,p.pronargs) args(position)
     where pg_get_function_arg_default(p.oid,args.position) is distinct from
      'NULL::'||format_type(p.proargtypes[args.position-1],null)
    )
    and p.prosecdef and p.proconfig = array['search_path=""']::text[]
    and not has_function_privilege(r.anon,p.oid,'EXECUTE')
    and has_function_privilege(r.authenticated,p.oid,'EXECUTE')
    and not has_function_privilege(r.authenticated,p.oid,'EXECUTE WITH GRANT OPTION'),false)
 from expected_functions e cross join roles r
 left join pg_proc p on p.oid=to_regprocedure('public.'||e.signature)
 union all
 select 'index','us_refresh_jobs_one_active_owner',i.indexrelid is not null,
   coalesce(i.indisunique and i.indisvalid and i.indisready and i.indislive
    and pg_get_expr(i.indpred,i.indrelid) =
     $$((payload ->> 'state'::text) = ANY (ARRAY['queued'::text, 'running'::text]))$$
    and i.indnkeyatts=1 and pg_get_indexdef(i.indexrelid,1,true)='owner'
    and i.indrelid=to_regclass('public.us_refresh_jobs'),false)
 from roles r left join pg_index i on i.indexrelid=to_regclass('public.us_refresh_jobs_one_active_owner')
)
select object_kind,object_name,present,security_contract from checks order by object_kind,object_name;
