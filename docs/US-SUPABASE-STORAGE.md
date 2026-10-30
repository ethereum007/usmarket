# US Supabase storage — schema applied; runtime activation pending

Target supplied by user: apidhmrlawbjvisnadht, under US Markets. Source migration: supabase/migrations/202610200001_us_plan_revisions.sql. The reviewed six-file bundle was applied to this replacement project on 29 October 2026; all nine structural security checks passed. Earlier increment sections below retain their historical status. See docs/SUPABASE-ACTIVATION-REVIEW.md for application evidence; runtime flags and hosted acceptance remain pending.

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


## Remote generation without local package publication

The API selects one publication destination. With remote research storage, generation returns the existing engine's package in memory without writing local JSON/package pointers or printing a local publication path. The caller still requires a verified remote publication acknowledgement (atomic with completion when jobs are remote). Local/CLI defaults retain their existing immutable filesystem publisher. No remote error falls back to a local package. This removes ephemeral package-file availability as a prerequisite for remote publication; it does not remove the current process-local refresh lock or other DATA_DIR requirements. Tests mock provider retrieval and prove the remote generation path never calls the local publisher even when it would fail, while the default local path still publishes. Hosted flags remain off and actual storage acceptance remains open.


## Fully remote refresh admission without SQLite

When both refresh jobs and research use Supabase, the API now relies on the queued RPC write/unique active-owner index for admission and does not open a local SQLite refresh lock, write local job records or reconcile local abandoned observations. Rejected/unconfirmed admission still prevents provider scheduling. Generation bypasses local JSON publication, and completion remains atomic remotely. Local-only and remote-research/local-job modes retain the single-volume lock and local status semantics. Tests force local lock/job writes to fail and prove remote requests never call them, while rejected remote admission never fetches provider data. Different accounts may run independently; aggregate provider limits and live hosted concurrency remain acceptance gaps. Readiness may still require DATA_DIR for its broader configuration/probe checks. No hosted flags, grants or migrations are activated by this source change.


## Readiness directory requirements

The operator preflight now requires an absolute DATA_DIR whenever any repository remains local. Fully remote plans/research/jobs can pass configuration-presence checks without a local directory. The report includes data_directory_required and absolute_data_directory facts, plus data_directory_requirement_satisfied in checks. When --check-storage is requested for fully remote storage, storage_probe is not_applicable_remote and no temporary SQLite files are created. This is never a passed remote probe: migrations, real account isolation, restart retention and hosted backup/restore remain explicitly unverified. Invalid selectors and remote jobs paired with local research still fail closed. No environment values are printed and no network/credential operation is added.


## Bounded research catalog payload

The un-applied research RPC migration now projects its latest-120 catalog to ten fields only: id, market, currency, universe, session, state, benchmark, feed, computed_at and symbols. It preserves existing owner filtering and session/time/id ordering without returning price bars, setups, instrument snapshots or unexpected payload fields. Exact get/publication still returns and preserves the full immutable package; this changes neither source identity nor partial/final semantics. Existing API summaries consume this same metadata contract, so no frontend API change is needed. PostgreSQL tests compare the exact projected fields, cross-owner exclusion and complete unchanged exact reads. The disposable restore verifier also compares projected owner reads after restore. Hosted migration/flags and actual bandwidth/load acceptance remain pending.


## Current activation review bundle

See SUPABASE-ACTIVATION-REVIEW.md for the ordered six-file source review, normalized hashes and bundle fingerprint. The read-only us_migration_review CLI does not inspect hosted state or apply SQL. CI rejects inventory changes or a stale review fingerprint, so source changes must update the concrete review before activation. Pending approval remains separate from source work and is not permission to create access grants or enable flags.


## Complete plan acknowledgement comparison

Remote save acknowledgement now compares every submitted persisted plan field, not just immutable source identities. Changed notes, trigger/stop, capital, state, quantity, nested sizing or unexpected persisted fields fail with sanitized unconfirmed-save feedback. Server-managed owner/id/revision/updated_at are handled separately; exact replays may retain the original server timestamp. Equivalent JSON int/float numbers are accepted, but booleans cannot substitute for numeric values. Reads still apply identity/revision/US/USD checks without pretending to know an unsent request. Source migrations and their review fingerprint are unchanged; hosted flags and acceptance remain pending.


## API-to-PostgreSQL plan journey in CI

The disposable PostgreSQL suite now sends FastAPI plan requests through the real remote adapters and a synthetic PostgREST wire shim that invokes the actual migrated RPCs. It exercises source-package read/validation, server USD sizing, save confirmation, exact lost-response replay, revision append, old-revision reopening, list/export, and second-account read/write denial even when that account has its own source copy. Requests carry synthetic account tokens and no owner selector; no real provider or Supabase account is used. This closes a source integration gap between HTTP mocks and standalone SQL tests. It does not certify actual PostgREST/Supabase gateway behavior, hosted sign-in, browser operation or restart retention. No migration/flag is activated.


## API-to-PostgreSQL refresh journey in CI

The source integration suite also drives refresh admission, running persistence, mocked provider generation, atomic publication/completion, catalog/exact read and foreign-account denial through FastAPI/remote adapters into real PostgreSQL. A second case interrupts the running job during simulated generation and verifies that late atomic publication cannot store its package or overwrite the interrupted/unknown outcome. The fully remote path creates no local files/SQLite lock and does not persist synthetic tokens. Provider work and the HTTP gateway remain synthetic; real Supabase authentication/PostgREST, live data rights, hosted concurrency and restart acceptance remain open. No hosted flag or migration is activated.


## Strict authentication included in plan integration

The API-to-PostgreSQL plan journey now invokes the actual require_us_user dependency rather than overriding it. A synthetic identity-provider HTTP response supplies confirmed UUID identities; missing/invalid bearer tokens return 401, and a verified uninvited account returns 403 before any storage RPC. After explicitly adding the second synthetic account to test invitations, actual SQL still denies foreign plan reads and UUID collisions. The same verified bearer is relayed to owner-scoped RPCs, with no client owner selector. Provider/gateway HTTP remains synthetic and does not certify real Supabase sign-in or invitation provisioning. No actual accounts, tokens, grants or flags are changed.


## Authentication origin validation (26 October 2026)

Authentication and storage preflight now share a dependency-free HTTPS-origin validator. Authentication rejects URL credentials, paths, query strings, fragments, invalid ports, whitespace/control characters and backslashes before constructing an HTTP client or forwarding the bearer token. A single trailing slash remains supported. Invalid configuration returns a fixed 503 without echoing the configured value. Regression tests assert that no provider request is attempted. This validates URL structure, not ownership of the configured hostname or actual hosted authentication. The 25 October private MVP gate remains missed; migrations, grants and feature flags remain unchanged pending reviewed activation and hosted acceptance.


## Plan request numeric types

The save and sizing-preview API require JSON numbers for trigger, stop, capital, risk percentage and allocation percentage. Booleans and numeric strings return 422 before sizing, source retrieval or storage. expected_revision requires a JSON integer, rejecting booleans, strings and floating-point values rather than coercing them into concurrency identities. Integer and fractional sizing inputs retain the existing Decimal calculation, whole-share limits and USD planning policy. The workspace already serializes sizing fields as numbers and revisions as integers; no client contract change or migration is required. Synthetic API tests verify rejection without side effects and valid numeric sizing. Hosted persistence/sign-in acceptance remains outstanding; this does not change migration approval, grants or flags.


## Account-bound US session refresh

The workspace recognizes the US API's fixed 401/Bearer challenge and attempts one Supabase session refresh. A retry retains the exact request method/body and requires the refreshed JWT subject to match the original account. Missing/malformed subjects, account changes and sign-out prevent automatic replay. Decoded subjects only restrict retry; they never authorize access, which remains server-verified on every request. Auth events during refresh also prevent a late refresh response/failure from replacing or clearing a newer account token. A normal refresh event installing the returned token remains supported. Other rejection statuses, transport failures and a second 401 are not automatically retried. Synthetic fetch/auth tests cover GET, plan POST, account races and failures; real hosted token expiry, browser behavior and the full invited-user journey remain unverified. No hosted settings, accounts, migrations or flags change.


## Type-preserving immutable research comparison

Research replay and remote publication acknowledgement now reuse the plan comparator through a shared JSON-equality helper. Nested boolean values cannot compare equal to numeric zero/one. This covers local immutable files, separate remote research publication and atomic job/publication acknowledgement. Equivalent JSON integer/float numbers remain equal; the existing computed_at/instrument observed_at replay exclusions remain unchanged. Local regressions verify a rejected collision leaves original file bytes and final pointer intact; synthetic transport regressions verify mismatched research never confirms publication/completion. SQL JSONB comparison already distinguishes boolean/number types, so migrations and review fingerprint are unchanged. Hosted grants/flags remain off and actual hosted acceptance remains outstanding.


## Initial-session account-change fence

Pending initial session lookups now preserve newer auth events: late lookup success/failure cannot replace or clear an account token installed after the lookup started. Requests waiting on that lookup stop with explicit account-change feedback instead of submitting a previously prepared draft under another account. Concurrent callers still share a single lookup and all stop on the change. The US transport rechecks the prepared bearer immediately before the first fetch, covering the async gap after header preparation; same-account token rotation remains supported. These are client-side replay restrictions, not an authentication substitute. Synthetic tests cover late success/failure, sign-out, account changes, concurrent callers and the pre-fetch gap. Real hosted browser/sign-in/restart acceptance remains outstanding; no cloud configuration or feature flag changes.


## Dedicated-project operator preflight

configuration_ready now requires the exact dedicated US Supabase hostname apidhmrlawbjvisnadht.supabase.co on HTTPS default port/443, with optional trailing slash. Valid HTTPS URLs for other projects or lookalike hosts no longer pass the operator gate. A shared source project-reference constant also supplies the migration-review manifest; migration files and bundle fingerprint are unchanged. The check emits a named boolean without echoing configured origins and performs no network request. It is an operator configuration gate, not a change to runtime adapters or proof that the supplied public key, hosted accounts, migrations or grants belong to that project. Custom domains require explicit target review. No hosted configuration, resources, credentials or flags were changed; actual acceptance remains open.


## Post-commit response-loss rehearsal

The disposable PostgreSQL/API journey now injects HTTP timeouts after the database transaction has committed queued admission, running status or atomic publication. Queued/running response loss must retain admission without invoking the provider; a second refresh remains blocked until explicit owner interruption records completion unknown. The recovery journey then admits new work and reopens its exact package. Publication response loss must preserve completed status and exact research even when the worker attempts a failed-state write; interruption returns the already completed record unchanged. Foreign accounts cannot recover or read these jobs. This exercises actual SQL through a synthetic HTTP gateway, not real Supabase networking, token expiry or process death. No hosted migration/grant/flag is activated and the missed private MVP/hosted acceptance gate remains open.


## Lost plan acknowledgement rehearsal

The authenticated FastAPI-to-PostgreSQL plan journey now injects a timeout after first-save or revision-update commit. The API must report unconfirmed 503 without returning a confirmed plan, while an explicit exact-revision read reopens the committed values. Identical request replay must return the original revision/timestamp; changed stale notes must conflict. Final export must retain exactly revisions one and two, with no retry duplicate, and the second account remains unable to read/write the plan. These cases use actual migrated SQL and strict API auth with synthetic identity/gateway responses. They do not certify real Supabase transport, hosted browser/restart retention or deployment approval. No hosted migration, grant, flag or account is changed.


## Free-worker refresh capacity

Remote refresh admission now first reserves one process-wide nonblocking capacity slot across accounts. A busy process returns retryable 429 before any storage/provider request; accepted work retains the slot through completion/error cleanup. Durable per-owner SQL admission, immutable publication and explicit recovery semantics remain unchanged. Different accounts remain independently reserved in SQL but cannot run provider pipelines simultaneously in one process. This does not impose a cross-host rate limit or kill interrupted provider work. Threaded route tests verify cross-account exclusion, no busy-request storage calls and release after work/admission/scheduling failure. Hosted load and aggregate provider limits remain unverified; migration/grants/flags are unchanged.


## Remote plan collection integrity

Remote plan list/export responses now reject more than 10,000 records rather than truncating. Latest lists require one record per plan UUID. Exports require each received plan history to contain revisions 1 through its received count without gaps/duplicates, then return deterministic plan-ID/revision order. Validation work is bounded by received rows rather than an untrusted maximum revision value. Existing identity/US/USD validation and owner/token stripping remain in place. Malformed history returns sanitized unavailable feedback before a download can be confirmed. This checks received history continuity; it cannot detect an omitted final revision without independent database evidence and does not make a plan-only download a complete backup. SQL/review fingerprints, hosted grants and flags are unchanged; real hosted acceptance remains open.


## Dedicated target enforced by runtime adapters

The backend authentication verifier and all three remote storage adapters now require the same dedicated-project origin as operator preflight before constructing an HTTP client. A different Supabase project, lookalike host or nonstandard port returns sanitized unconfigured 503 before forwarding bearer credentials or issuing a write. Local storage and explicit loopback auth overrides remain available for tests/previews. Synthetic transport and SQL-journey fixtures use the dedicated hostname with fake keys/tokens and intercepted HTTP; they make no real project connection. New regressions assert no auth/storage client is constructed for wrong-project configuration. This extends the earlier operator-only check to runtime enforcement; custom domains require explicit target review. It does not prove key validity, hosted migrations, accounts or durability. No cloud settings, credentials, grants or flags were changed, and hosted acceptance remains outstanding.


## Verified saved-plan observation time

Remote plan records now require updated_at to be an ISO timestamp with a timezone before save acknowledgement, exact read, list or export can return them. Missing/non-string/malformed/date-only/naive values fail with sanitized unconfirmed-storage feedback. Valid zoned text is preserved rather than replaced with the current clock, so exact retry retains the original observation. This does not certify wall-clock correctness or hosted retention. Synthetic tests cover save/get/export rejection and preserved UTC/offset timestamps; actual PostgreSQL journey/restore tests remain the SQL evidence. No migration, grant, flag or runtime data was changed.


## Refresh history integrity

The remote job adapter rejects duplicate job identities and more than one queued/running observation in an owner history. These responses contradict immutable job identity or the approved active-owner uniqueness contract; they return sanitized unavailable feedback instead of presenting ambiguous recovery choices or guessing which job is active. Empty history, distinct terminal jobs and one active job with terminal history remain valid. Synthetic transport tests cover these boundaries. This does not prove hosted schema activation or cross-host behavior; the approved six-migration fingerprint and all storage flags remain unchanged.


## Saved-evidence editor replacement guard

Opening saved evidence checks the current editor immediately before replacement, after the asynchronous evidence read. Unsaved changes require an explicit discard confirmation; a pending save blocks replacement. Returning from a saved revision to a new plan uses the same guard. Failed saves retain the dirty guard and successful saves clear it. Tests cover cancellation, confirmation, pending/failed saves and edits made while evidence loads. A new draft now captures its exact package/setup on its first input change or save attempt. Browsing another setup, package loading and automatic completed-refresh selection retain the same editor and source. The explicit start-new action uses the replacement guard before releasing that source. In-app navigation away from the workspace is still outside this guard; save before leaving. No hosted flags or account configuration changed; real-account and restart acceptance remain pending.


## Bounded identity verification

Every hosted private request now gives the dedicated Supabase identity request a five-second total asynchronous deadline, in addition to HTTPX network-operation timeouts. A provider that keeps a connection or response pending cannot extend verification indefinitely by making intermittent progress. Deadline expiry cancels the pending request and returns the existing sanitized authentication-unavailable 503; caller cancellation propagates. Tests cover a stalled client entry/request, cancellation cleanup and a subsequent valid invited identity. This bounds asynchronous verification I/O, not synchronous response parsing, and changes no credentials, invitations or storage flags. Real hosted sign-in and isolation acceptance remain outstanding.


## Required refresh observation time

Remote job list/read/save, atomic publication and interruption acknowledgements now require a valid zoned updated_at. Missing, null, boolean, malformed, date-only and naive values return sanitized storage-unavailable feedback, with no current-clock substitution or local fallback. Valid offsets retain the recorded instant when normalized to UTC. The applied SQL already supplies these server timestamps; no migration changed or replayed. Synthetic transport regressions exercise all five acknowledgement paths and preserve earlier state/package mismatch checks. This is response validation, not hosted persistence or clock-correctness acceptance; runtime flags remain off.


## Browser refresh-history validation

The history panel and active-job restoration now share validation before accepting a fetched list. Non-arrays, more than 20 entries, missing/duplicate IDs, unknown states, multiple active observations, invalid completed-package identities and non-string display fields fail with sanitized unavailable feedback. Invalid history cannot enable recovery controls. This avoids rendering malformed payloads or choosing guessed active work; valid empty history remains distinct from failure. Synthetic component tests exercise malformed responses and confirm no records or interruption capability are accepted. No hosted settings or flags changed; real-account acceptance still needs the requested account/frontend inputs.


Interruption recovery now validates its returned observation with the same browser history boundary before replacing a recorded row. Completed race outcomes require an exact package identity; malformed display fields remain unconfirmed, preserving the prior observation and sanitized retry guidance. Component regressions cover malformed completion and private object payloads. No hosted flag or access change is included.


## Selected-plan thesis verification on reopen

The browser now compares the returned exact plan revision with the selected list record's immutable package, setup version, setup ID, source snapshot, symbol and direction, in addition to verifying the returned source against that plan. Internally consistent but rebound responses cannot silently open another thesis. Six transport regressions independently rebind each field while keeping the returned plan and package consistent; normal exact and historical reopening remain covered. This does not replace database immutability or constitute real hosted acceptance. No SQL, credentials or runtime flags changed.


Reopening also compares the selected plan's provider asset identity and source session with the returned revision, then checks the returned setup asset and package session against it. Regressions cover internally consistent rebinding and direct source/revision mismatches. Optional legacy asset metadata remains unknown; this does not invent a historical mapping or change existing revisions. These are browser consistency checks, not hosted isolation acceptance.


## Browser save acknowledgement identity

The browser accepts a save acknowledgement only for the requested plan ID, exact next revision and selected package/setup/snapshot/security/session in US/USD. A mismatched acknowledgement throws unconfirmed-save feedback, preserving the editor's draft and retry identity instead of opening or claiming another saved revision. Synthetic regressions cover each identity field, stale/skipped revisions and a valid new-plan revision one. Server validation and ownership remain authoritative; this is not full payload or hosted persistence acceptance. No flags, credentials or SQL changed.


Refresh polling now uses the same observation validator as history and interruption recovery before updating UI status. Null/array records and object-valued display fields remain unavailable rather than becoming a new recorded outcome or crashing rendering. Existing exact job/package checks and late-account cleanup remain covered. Four polling regressions verify unchanged prior status and sanitized feedback. No provider request, hosted access or storage flag changed.


## Local backup kind verification

The SQLite backup CLI now checks that the copied database contains the selected plans/jobs table and required columns, as well as passing integrity_check, before reporting success. Empty, unrelated, view-only or incomplete schemas fail with sanitized feedback and remove only the newly created copy. Synthetic CLI tests verify both kinds, preserve source bytes and leave no misleading output. This is structural validation of a selected local backup, not record-level restore acceptance or a hosted Supabase backup. Remote modes remain rejected by this local tool; no runtime data or flags changed.
