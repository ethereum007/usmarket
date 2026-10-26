-- Explicit owner interruption fences later atomic publication for this job.
-- This is not evidence that the provider worker stopped or that nothing published.
create or replace function public.us_job_interrupt(job_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare previous jsonb; interrupted jsonb;
begin
 if auth.uid() is null then raise insufficient_privilege; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text || job_id::text,2));
 select payload into previous from public.us_refresh_jobs where owner=auth.uid() and id=job_id;
 if previous is null then
  raise exception using errcode='PT409',message='Refresh unavailable';
 end if;
 -- Publication/terminal result may have won the race. Never replace that evidence.
 if previous->>'state' in ('completed','failed','interrupted') then return previous; end if;
 if previous->>'state' not in ('queued','running') then
  raise exception using errcode='PT409',message='Refresh unavailable';
 end if;
 interrupted := jsonb_build_object('id',job_id,'state','interrupted','updated_at',now(),
   'completion_unknown',true,'error','Refresh interrupted; completion is unknown. Check saved research before retrying.');
 update public.us_refresh_jobs set updated_at=now(),payload=interrupted
 where owner=auth.uid() and id=job_id;
 return interrupted;
end $$;
revoke all on function public.us_job_interrupt(uuid) from public,anon;
grant execute on function public.us_job_interrupt(uuid) to authenticated;
