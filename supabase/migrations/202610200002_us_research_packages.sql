-- Per-account immutable research, avoiding cross-account display grants.
create table public.us_research_packages (
  owner uuid not null references auth.users(id), id text not null,
  payload jsonb not null, primary key(owner, id)
);
alter table public.us_research_packages enable row level security;
revoke all on public.us_research_packages from public, anon, authenticated;
create or replace function public.us_research_store(action text, package_id text default null,
  package_payload jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare saved jsonb; canonical jsonb; prior_canonical jsonb;
begin
  if auth.uid() is null then raise insufficient_privilege; end if;
  if action = 'list' then
    return coalesce((select jsonb_agg(p.payload) from (
      select payload from public.us_research_packages where owner = auth.uid()
      order by (payload->>'session')::date desc, (payload->>'computed_at')::timestamptz desc, id desc limit 120
    ) p), '[]'::jsonb);
  elsif action = 'get' then
    return (select payload from public.us_research_packages where owner = auth.uid() and id = package_id);
  elsif action is distinct from 'publish' then
    raise exception using errcode = '22023', message = 'Invalid operation';
  end if;
  if package_id is null or package_id !~ '^[a-f0-9]{64}$'
     or package_payload->>'id' is distinct from package_id
     or package_payload->>'market' is distinct from 'US'
     or package_payload->>'currency' is distinct from 'USD'
     or package_payload->>'state' not in ('partial','final')
     or package_payload->>'state' is null then
    raise exception using errcode = '22023', message = 'Invalid research';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text || package_id, 1));
  select payload into saved from public.us_research_packages where owner = auth.uid() and id = package_id;
  if saved is not null then
    canonical := (package_payload - 'computed_at') #- '{instrument_snapshot,observed_at}';
    prior_canonical := (saved - 'computed_at') #- '{instrument_snapshot,observed_at}';
    if canonical is distinct from prior_canonical then
      raise exception using errcode = 'PT409', message = 'Immutable research conflict';
    end if;
    return saved;
  end if;
  insert into public.us_research_packages values(auth.uid(), package_id, package_payload);
  return package_payload;
end $$;
revoke all on function public.us_research_store(text, text, jsonb) from public, anon;
grant execute on function public.us_research_store(text, text, jsonb) to authenticated;
