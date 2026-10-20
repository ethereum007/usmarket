-- ============================================
-- Alpha Radar -- RRG (Relative Rotation Graph) tables
-- Run once against the Alpha Radar Supabase project.
-- All tables are read-only for the anon role (Next.js frontend reads via PostgREST).
-- Writes happen from the backend service-role client only.
-- ============================================

-- ------------------------------------------------------------
-- 1. Daily OHLCV cache for the indices we track.
--    Volume on index instruments from Kite is typically 0, kept for schema parity.
-- ------------------------------------------------------------
create table if not exists public.prices (
  symbol text not null,
  date date not null,
  open numeric(14, 4) not null,
  high numeric(14, 4) not null,
  low numeric(14, 4) not null,
  close numeric(14, 4) not null,
  volume bigint not null default 0,
  primary key (symbol, date)
);

create index if not exists prices_date_idx on public.prices (date desc);

alter table public.prices enable row level security;

drop policy if exists "prices_read_anon" on public.prices;
create policy "prices_read_anon"
  on public.prices for select to anon using (true);


-- ------------------------------------------------------------
-- 2. RRG snapshot per (sector, benchmark, timeframe, date).
--    The "tail" rendered on the chart is the last N rows for a given symbol
--    ordered by as_of_date.
-- ------------------------------------------------------------
create table if not exists public.rrg_snapshots (
  as_of_date date not null,
  symbol text not null,
  benchmark text not null,
  timeframe text not null check (timeframe in ('daily', 'weekly')),
  rs_ratio numeric(10, 4) not null,
  rs_momentum numeric(10, 4) not null,
  quadrant text not null check (quadrant in ('leading', 'weakening', 'lagging', 'improving')),
  primary key (as_of_date, symbol, benchmark, timeframe)
);

create index if not exists rrg_snapshots_symbol_date_idx
  on public.rrg_snapshots (symbol, benchmark, timeframe, as_of_date desc);

create index if not exists rrg_snapshots_latest_idx
  on public.rrg_snapshots (benchmark, timeframe, as_of_date desc);

alter table public.rrg_snapshots enable row level security;

drop policy if exists "rrg_snapshots_read_anon" on public.rrg_snapshots;
create policy "rrg_snapshots_read_anon"
  on public.rrg_snapshots for select to anon using (true);


-- ------------------------------------------------------------
-- 3. Quadrant-crossing events. When a sector transitions between quadrants
--    (e.g. Improving -> Leading), the worker inserts a row here.
-- ------------------------------------------------------------
create table if not exists public.alerts (
  id bigserial primary key,
  fired_at timestamptz not null default now(),
  as_of_date date not null,
  symbol text not null,
  benchmark text not null,
  timeframe text not null,
  from_quadrant text not null,
  to_quadrant text not null,
  dispatched_at timestamptz
);

create index if not exists alerts_recent_idx on public.alerts (fired_at desc);
create unique index if not exists alerts_unique_transition
  on public.alerts (as_of_date, symbol, benchmark, timeframe);

alter table public.alerts enable row level security;

drop policy if exists "alerts_read_anon" on public.alerts;
create policy "alerts_read_anon"
  on public.alerts for select to anon using (true);
