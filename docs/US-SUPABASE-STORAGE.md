# US Supabase plan storage (not activated)

Target supplied by user: etwmtakotrqlwwzttekc, under US Markets. Source migration: supabase/migrations/202610200001_us_plan_revisions.sql. No SQL has been applied by this increment.

The optional US_PLAN_STORE=supabase adapter uses the existing SUPABASE_URL/public key and each verified user's bearer token, never a service role key. Leave the flag unset until migration and real acceptance pass. Unknown modes fail closed; remote failures do not fall back to SQLite. SQLite remains the default for existing local tests/previews.

The migration revokes direct table access from anon/authenticated, enables RLS and exposes only a fixed-search-path, owner-filtered RPC to authenticated identities. Its security-definer function always uses auth.uid(); it accepts no owner selector. A transaction advisory lock serializes first and later saves by plan UUID. Source identity is immutable across revisions; stale edits and foreign UUID collisions return conflicts. Reads and downloads filter by verified database identity. No delete or update API is granted. Client-created own-account payloads are not verified research; the application API remains responsible for source-package/setup validation and invitations.

Before activation: apply the reviewed SQL only to the dedicated project; verify grants and two real test identities, concurrent expected_revision conflicts, source immutability, anonymous rejection and restart retention. Python transport mocks do not verify PostgreSQL semantics. Review the function and policies in Supabase before enabling the flag. Do not paste secrets into Git or chat.

This adapter stores plans only. Research packages, refresh jobs and coordination still use local files/SQLite and remain ephemeral on Render Free. Exported plan history does not contain its research packages. No complete durable-MVP or backup/restore acceptance is claimed. Remote package/job storage is the next increment; never enable a new-user journey that promises complete restart recovery until it passes.


## Research package adapter (not activated)

Migration 202610200002 adds owner-scoped immutable research packages and a fixed-search-path RPC. US_RESEARCH_STORE=supabase selects it; default local remains unchanged. Catalog/read requests use the verified account token; background publication receives its token only in memory, never in the persisted job payload. Completion is recorded only after the remote publish acknowledges the package ID. Failed remote reads never fall back to local evidence. Source packages are validated by the existing US metadata boundary before use in a plan. Same-identity replay retains the original observation; conflicting content is rejected. No shared cross-account research grants are introduced.

The SQL uses PostgREST PT409 errors for explicit conflicts. Python tests cover transport and routing only, not actual SQL execution. No migration has been applied. Jobs and refresh coordination remain local; token expiry during a long refresh can prevent remote publication and must remain a visible failure, not a completed claim. Research catalog reads return up to 120 newest recorded packages. A complete multi-host refresh/restore design remains open.


## Durable refresh observations (not activated)

Migration 202610200003 and US_JOB_STORE=supabase store owner-filtered status observations. This mode requires US_RESEARCH_STORE=supabase; terminal completion requires the referenced owner package to exist. The RPC accepts queued -> running -> completed/failed transitions only. Terminal states cannot be overwritten. Status is constructed from a fixed allowlist in SQL and transport; owner IDs, bearer tokens and exception text are not stored in status payloads. Reads use the authenticated identity and never fall back locally.

This is persistence, not a distributed lease. The existing local lock still excludes cooperating workers on one host only. Remote records are never automatically interrupted based on that local lock or elapsed time. A process crash may leave the last observed queued/running state indefinitely; the UI must report only that observation. Multiple hosts, crash recovery and a durable worker queue remain unverified. Token expiry can prevent a later status write, so a successfully published package may coexist with an older running observation. No success/failure is invented when status storage fails.

The SQL and transport have not been activated or tested on the real database. All three flags stay off until migration review and hosted account/restart/concurrency acceptance. No complete MVP readiness is claimed.


## Disposable PostgreSQL CI

The backend CI job now provisions PostgreSQL 17 with a disposable test-only database, applies the actual migration files and runs tests/test_us_postgres.py using psycopg. A minimal auth.users/auth.uid fixture models JWT identity via transaction-local settings; these tests do not use real Supabase users, credentials or the hosted project. The harness refuses database names other than usmarket_contract_test. It verifies SQL permissions, null/anonymous denial, owner isolation, immutable research replay, first-save concurrency, revision/source conflicts and job transitions requiring owner research. This adds real PostgreSQL semantics to HTTP mocks, but does not certify Supabase gateway behavior, configured invitations or hosted persistence. Locally the suite skips when US_TEST_POSTGRES_DSN is absent; do not point it at a production database.


## Operator mode validation

The readiness CLI now rejects unknown US_PLAN_STORE, US_RESEARCH_STORE and US_JOB_STORE modes, and remote jobs paired with local research. all_storage_remote reports only that all three configuration selectors use Supabase, never that migrations were applied or durable retention was demonstrated. The optional local SQLite probe still tests only its temporary files. Real Supabase migrations/account isolation and remote worker crash coordination remain explicit unverified gates. Invalid environment values are never echoed. PostgreSQL CI success does not certify the hosted Supabase gateway or project configuration.


Remote job responses are also checked at the transport boundary: single observations must match the requested job ID, states must be recognized, and completed observations must include a valid source-package identity. Only status fields are returned; unknown keys and arbitrary provider error text are discarded. Invalid observations produce a sanitized storage-unavailable error rather than invented completion or a local fallback.


Remote plan acknowledgements now require a canonical plan UUID, positive integer revision and US/USD metadata. Get/save responses must match the requested identity and revision; save acknowledgements must also match every immutable source identity sent by the API. Malformed or mismatched replies fail with sanitized storage-unavailable feedback, never confirmed-save feedback or a local fallback. Owner/token transport fields are excluded from returned plan records. This checks acknowledgement consistency; it does not establish hosted storage durability.


Research publication acknowledgements now reuse the imported publication validator/content comparison: both ID and immutable payload must match before completion is recorded. Identical replay may retain the original computed_at and instrument observation time, consistent with local publication and the SQL RPC. Changed symbols, state, units or other immutable content, and invalid acknowledgement timestamps, produce sanitized unconfirmed-publication errors. These response checks do not certify actual Supabase gateway/hosted acceptance.


## Inherited PUBLIC grants

All storage tables now revoke direct access from PostgreSQL PUBLIC as well as anon/authenticated. This prevents an inherited PUBLIC grant from reopening direct inserts that bypass the RPC revision/identity checks. Real PostgreSQL CI deliberately grants permissive default table privileges before applying the migrations, then verifies direct select/update/delete are denied for both client roles on all three tables and authenticated direct plan insertion is denied. Restricted RPCs remain available under their explicit grants. The migrations are still un-applied to the hosted project; this does not authorize activation.


## Refresh observation retry (not activated)

An identical job-state write can replay its original observation after a lost HTTP acknowledgement. The per-owner/job transaction lock serializes concurrent retries; the RPC returns the original timestamp instead of implying renewed worker liveness. Completed retries must retain exactly the original package ID. Changed results, backward transitions and terminal-to-running writes still conflict. Disposable PostgreSQL tests exercise queued/running and both terminal replays, concurrent retries, result conflicts and owner isolation. This does not add automatic retries, a distributed lease or crash recovery. The source migration remains un-applied; hosted grants and flags remain off pending approval and acceptance.


## Cross-host refresh admission (not activated)

Migration 202610260001 adds a partial unique index reserving at most one queued/running job per authenticated owner. The queued write happens before background scheduling/provider calls. Competing hosts cannot both admit different jobs for one account; PostgreSQL unique conflicts become the existing sanitized HTTP 409. Other accounts reserve independently, and no conflicting account/job identity is exposed. A recorded completed/failed transition releases admission atomically. Identical status replay retains its earlier timestamp and reservation.

This is durable admission, not a renewable worker lease or automatic crash recovery. An abandoned active observation keeps the account blocked; neither old timestamps nor possession of a local lock authorizes clearing it. No age-based takeover or abandoned-worker publication is enabled. Token expiry or an ambiguous terminal write can require operator recovery after the worker and publication outcome are established. Local-only mode remains single-volume coordination. All four source migrations remain un-applied; flags stay off pending approved migration activation and real hosted acceptance. Disposable PostgreSQL tests cover concurrent one-winner admission, independent accounts, terminal release and stale-observation retention; API tests prove rejected admission never invokes the provider and releases its local lock.


## Atomic refresh publication/completion (not activated)

Migration 202610260002 adds us_job_publish, restricted to authenticated identities with a fixed empty search path. It locks the owner/job, requires a running job (or identical completed replay), calls the existing immutable research RPC, and records completion within the same PostgreSQL transaction. Any error rolls both changes back. A failed/queued/foreign job cannot publish through this operation. Completed replay preserves the original observation and immutable package; changed completion identities/content conflict.

When both job and research stores are remote, the API uses this operation instead of separate publish and completion calls. Transport validation checks both returned immutable research and exact completed job/package identity. A lost HTTP response remains ambiguous to the caller, but the database cannot commit only one half. A subsequent failed-state write cannot overwrite an already completed result. Local-only and remote-research/local-job paths retain their existing behavior. This does not recover workers that crash before the atomic call or make local cache files durable. All five migrations remain un-applied; hosted flags/grants and acceptance remain unchanged. Disposable PostgreSQL tests inject a completion-write failure to prove package rollback, plus owner/state rejection and immutable retry behavior.


## Fenced interruption primitive (not activated)

Migration 202610260003 prepares an owner-only us_job_interrupt RPC. It shares the owner/job transaction lock with atomic publication. Explicit interruption of queued/running work records interrupted with completion_unknown=true and releases active admission; it does not assert worker death or erase saved research. Later atomic publication and status transitions for that job are rejected. If completion/failed/interrupted already won, interruption returns that original terminal record unchanged. Simultaneous publication/interruption therefore preserves either completed research plus its job, or interrupted with no publication through the atomic path.

This source increment prepares the database primitive and status reader; it does not expose a recovery button or API action yet. All six migrations remain un-applied, so no hosted permissions or flags change. It fences the cooperating atomic API path, not arbitrary direct calls to the separate research RPC, old deployments, provider requests already in flight or local cache files. A worker may finish provider work after interruption; remote atomic publication must still reject it. PostgreSQL fixtures cover queued/running interruption, owner/null/anonymous denial, idempotent replay, new admission and a concurrent publication race. Complete hosted recovery/account/browser acceptance remains open.


## Explicit recovery API and workspace action (not activated)

POST /api/us/research/jobs/{canonical-uuid}/interrupt uses the verified account token and owner-scoped interruption RPC. It accepts no owner selector. Local-only mode rejects the action; remote history advertises interruption_available. The workspace offers queued/running interruption only with this capability, requires explicit confirmation with completion-unknown wording, prevents duplicate submissions and ignores late responses after account-panel cleanup. A completed result that won the race stays completed and can reopen its exact research; interruption failure is unconfirmed, never optimistic success. Neither timestamps nor UI age automatically interrupt work. The action releases remote admission but does not kill provider work already in flight. All six source migrations remain un-applied, flags remain off, and real hosted account/browser/restart acceptance is still required.


## Exact plan save replay (not activated)

The un-applied plan migration now acknowledges an identical retry when the latest stored revision is exactly expected_revision+1 and all stored plan content matches, excluding only server-managed owner/id/revision/updated_at. It returns the original revision and timestamp without appending. Changed stale notes, source identities or other content still conflict; retrying an older write after another revision exists also conflicts. Foreign-owner UUID collisions remain private conflicts. Concurrent identical requests converge on one revision, while different concurrent edits retain one-winner conflict behavior. Disposable PostgreSQL tests verify these cases and exact revision retention. This is optional remote-store behavior; the existing local SQLite expected-revision contract is unchanged. No hosted migration, flag or access grant is activated.
