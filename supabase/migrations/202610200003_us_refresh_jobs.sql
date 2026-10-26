create table public.us_refresh_jobs (
  owner uuid not null references auth.users(id), id uuid not null,
  updated_at timestamptz not null default now(), payload jsonb not null,
  primary key(owner,id)
);
alter table public.us_refresh_jobs enable row level security;
revoke all on public.us_refresh_jobs from public, anon, authenticated;
create or replace function public.us_job_store(action text, job_id uuid default null,
 job_payload jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare previous jsonb; saved jsonb;
begin
 if auth.uid() is null then raise insufficient_privilege; end if;
 if action = 'list' then
  return coalesce((select jsonb_agg(t.payload order by t.updated_at desc,t.id desc) from
   (select payload,updated_at,id from public.us_refresh_jobs where owner=auth.uid()
    order by updated_at desc,id desc limit 20) t),'[]'::jsonb);
 elsif action = 'get' then
  return (select payload from public.us_refresh_jobs where owner=auth.uid() and id=job_id);
 elsif action is distinct from 'save' then
  raise exception using errcode='22023',message='Invalid operation';
 end if;
 if job_id is null or job_payload->>'id' is distinct from job_id::text
    or job_payload->>'state' is null or job_payload->>'state' not in ('queued','running','completed','failed') then
  raise exception using errcode='22023',message='Invalid job';
 end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text || job_id::text,2));
 select payload into previous from public.us_refresh_jobs where owner=auth.uid() and id=job_id;
 -- A lost HTTP acknowledgement may be retried. Preserve the original timestamp
 -- and terminal evidence; this is replay, never a new worker heartbeat.
 if previous is not null and previous->>'state'=job_payload->>'state' then
  if previous->>'state' <> 'completed'
     or previous->>'package_id' is not distinct from job_payload->>'package_id' then
   return previous;
  end if;
  raise exception using errcode='PT409',message='Job result conflict';
 end if;
 if previous is null and job_payload->>'state' <> 'queued' then
  raise exception using errcode='PT409',message='Job must start queued';
 end if;
 if previous is not null and not (
   (previous->>'state'='queued' and job_payload->>'state'='running') or
   (previous->>'state'='running' and job_payload->>'state' in ('completed','failed'))
 ) then
  raise exception using errcode='PT409',message='Job transition conflict';
 end if;
 -- Build an explicit public-status payload; never persist bearer tokens or owners.
 saved := jsonb_build_object('id',job_id,'state',job_payload->>'state','updated_at',now());
 if job_payload->>'state'='completed' then
  if job_payload->>'package_id' is null or job_payload->>'package_id' !~ '^[a-f0-9]{64}$'
    or not exists(select 1 from public.us_research_packages where owner=auth.uid() and id=job_payload->>'package_id') then
   raise exception using errcode='PT409',message='Published research not found';
  end if;
  saved := saved || jsonb_build_object('package_id',job_payload->>'package_id');
 elsif job_payload->>'state'='failed' then
  saved := saved || jsonb_build_object('error','Research refresh failed; saved research remains available');
 end if;
 insert into public.us_refresh_jobs values(auth.uid(),job_id,now(),saved)
 on conflict(owner,id) do update set updated_at=excluded.updated_at,payload=excluded.payload;
 return saved;
end $$;
revoke all on function public.us_job_store(text,uuid,jsonb) from public,anon;
grant execute on function public.us_job_store(text,uuid,jsonb) to authenticated;
