-- Publish immutable research and record completion in one transaction.
create or replace function public.us_job_publish(job_id uuid, package_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare previous jsonb; published jsonb; finished jsonb;
begin
 if auth.uid() is null then raise insufficient_privilege; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text || job_id::text,2));
 select payload into previous from public.us_refresh_jobs where owner=auth.uid() and id=job_id;
 if previous is null or previous->>'state' not in ('running','completed') then
  raise exception using errcode='PT409',message='Running refresh required';
 end if;
 if previous->>'state'='completed' and previous->>'package_id' is distinct from package_payload->>'id' then
  raise exception using errcode='PT409',message='Job result conflict';
 end if;
 published := public.us_research_store('publish',package_payload->>'id',package_payload);
 finished := public.us_job_store('save',job_id,jsonb_build_object('id',job_id,'state','completed','package_id',published->>'id'));
 return jsonb_build_object('job',finished,'package',published);
end $$;
revoke all on function public.us_job_publish(uuid,jsonb) from public,anon;
grant execute on function public.us_job_publish(uuid,jsonb) to authenticated;
