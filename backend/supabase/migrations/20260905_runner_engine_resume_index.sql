-- Supports constant-time lookup of a baseline job interrupted by process restart.
create index if not exists runner_engine_runs_active_baseline_idx
    on public.runner_engine_runs (started_at desc)
    where run_type = 'BASELINE_REBUILD' and status = 'RUNNING';
