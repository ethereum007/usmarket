-- One admitted refresh per account across cooperating API hosts.
-- Queued/running observations reserve admission until a recorded terminal state.
-- No clock expiry: age cannot prove that an earlier worker stopped publishing.
create unique index us_refresh_jobs_one_active_owner
 on public.us_refresh_jobs(owner)
 where payload->>'state' in ('queued','running');
