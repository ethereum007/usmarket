-- US-only project. Apply only after reviewing target project and access policy.
create table if not exists public.us_plan_revisions (
  id uuid not null, revision integer not null check (revision > 0),
  owner uuid not null default auth.uid() references auth.users(id),
  updated_at timestamptz not null default now(), payload jsonb not null,
  primary key (id, revision)
);
alter table public.us_plan_revisions enable row level security;
revoke all on public.us_plan_revisions from public, anon, authenticated;
-- Table access is private; only the owner-filtered RPC below can append.
create policy us_plan_owner_read on public.us_plan_revisions for select to authenticated using (owner = auth.uid());
create policy us_plan_owner_insert on public.us_plan_revisions for insert to authenticated with check (owner = auth.uid());

create or replace function public.us_plan_store(action text, plan_id uuid default null,
  wanted_revision integer default null, expected_revision integer default null,
  plan_payload jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare latest public.us_plan_revisions; result jsonb; saved jsonb; field text;
begin
  if auth.uid() is null then raise insufficient_privilege; end if;
  if action = 'list' then
    select coalesce(jsonb_agg(t.payload order by t.updated_at desc), '[]'::jsonb) into result
      from (select distinct on (id) payload, updated_at from public.us_plan_revisions
            where owner = auth.uid() order by id, revision desc) t;
    return result;
  elsif action = 'get' then
    select payload into result from public.us_plan_revisions
      where owner = auth.uid() and id = plan_id and revision = wanted_revision;
    return result;
  elsif action = 'export' then
    if (select count(*) from public.us_plan_revisions where owner = auth.uid()) > 10000 then
      raise exception using errcode = 'PT409', message = 'Download limit exceeded';
    end if;
    select coalesce(jsonb_agg(payload order by id, revision), '[]'::jsonb) into result
      from public.us_plan_revisions where owner = auth.uid();
    return result;
  elsif action <> 'save' or action is null then
    raise exception using errcode = '22023', message = 'Invalid operation';
  end if;
  if plan_id is null or expected_revision is null or expected_revision < 0
     or jsonb_typeof(plan_payload) is distinct from 'object'
     or plan_payload->>'market' is distinct from 'US'
     or plan_payload->>'currency' is distinct from 'USD' then
    raise exception using errcode = '22023', message = 'Invalid plan';
  end if;
  -- Transaction-scoped serialization includes the first revision (no row yet).
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(plan_id::text, 0));
  select * into latest from public.us_plan_revisions
    where owner = auth.uid() and id = plan_id order by revision desc limit 1;
  -- Lost-response retry: acknowledge only the exact latest committed content.
  -- Never append a duplicate revision or turn a changed stale edit into success.
  if latest.revision = expected_revision + 1 and
     (latest.payload - 'owner' - 'id' - 'revision' - 'updated_at') =
     (plan_payload - 'owner' - 'id' - 'revision' - 'updated_at') then
    return latest.payload;
  end if;
  if coalesce(latest.revision, 0) <> expected_revision then
    raise exception using errcode = 'PT409', message = 'Revision conflict';
  end if;
  if latest.revision is not null then
    foreach field in array array['setup_id','package_id','setup_version','source_snapshot_id','symbol','direction','provider_asset_id'] loop
      if latest.payload->field is distinct from plan_payload->field then
        raise exception using errcode = 'PT409', message = 'Source identity changed';
      end if;
    end loop;
  end if;
  saved := (plan_payload - 'owner' - 'id' - 'revision' - 'updated_at') ||
    jsonb_build_object('id', plan_id, 'revision', expected_revision + 1, 'updated_at', now());
  begin
    insert into public.us_plan_revisions(id, revision, owner, payload)
      values(plan_id, expected_revision + 1, auth.uid(), saved);
  exception when unique_violation then
    -- Also hides a foreign owner's colliding UUID; never overwrite it.
    raise exception using errcode = 'PT409', message = 'Plan unavailable or changed';
  end;
  return saved;
end $$;
revoke all on function public.us_plan_store(text, uuid, integer, integer, jsonb) from public, anon;
grant execute on function public.us_plan_store(text, uuid, integer, integer, jsonb) to authenticated;
