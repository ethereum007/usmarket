# Durable US refresh observations

Refresh job observations use the imported swing_repository job table in a separate `DATA_DIR/us-refresh-jobs.sqlite3`. Queued, running, completed and failed records persist across app/process restarts on a retained volume. Reads require the authenticated owner; the response omits owner and exception text. Completed results retain their exact immutable package ID. Writes carry an aware UTC updated_at timestamp.

A queued write must succeed before scheduling; a running write must succeed before provider fetching. Storage errors return a sanitized 503 on requests. Background storage failures retain the last durable observation and release the shared-volume reservation. If publishing succeeds but the completed write fails, the record can remain running: it does not imply publication failed. Inspect saved research before retrying. Provider failures keep the fixed public error boundary.

Status is an observation, not a lease or heartbeat. Unlike the imported job reader's default timeout behavior, the US reader does not infer that a worker died merely because 15 minutes elapsed. No automatic retry, cancellation or abandoned-worker takeover is implemented. The UI labels the state as last recorded and explains this limit. The authenticated GET /api/us/research/jobs endpoint returns the latest 20 owner-scoped records. The workspace shows this history after reload, with ET write times and an explicit action to open the exact completed package. Invalid package IDs do not produce open actions. History failures are distinct from an empty history. The panel remounts on owner change and ignores late responses after unmount; it refreshes when the current job changes state or the user reloads history. History does not automatically resume polling old running jobs.

API refresh exclusion now uses a dedicated `DATA_DIR/us-refresh-lock.sqlite3` connection with a nonblocking SQLite BEGIN IMMEDIATE reservation. It is acquired before queued status is saved and held through provider fetching, publication and the final status write. A contender receives 409 before a job is created. Coordination storage errors return sanitized 503. Scheduling, status and provider failures release the reservation. The synchronous request transfers sole connection ownership to its background task; cross-thread access is enabled for that handoff, with no concurrent connection operations.

The reservation has no time-based expiry. A slow or paused worker retains ownership; another worker cannot take over merely because its status is old. Process exit releases the OS-backed SQLite lock, permitting a later request. Old queued/running observations remain last known until a later request exclusively acquires the same reservation. While holding it, that request transactionally marks all previous queued/running records interrupted, with completion_unknown=true and an explicit instruction to check saved research. It never marks them failed/completed or guesses a package ID. Completed and failed records remain unchanged; owners remain isolated. Reconciliation must succeed before a new job is queued or provider work begins. A competing request that receives 409 cannot reconcile anything. There is no automatic job retry, cancellation or crash-result reconstruction; interruption records loss of coordinator ownership, not publication outcome. Operators must stop a stuck worker and inspect saved research before retrying. Never delete, replace or rotate the lock file while any worker is running: doing so can split the coordination domain.

Scope is cooperating API workers using the exact same local SQLite-compatible DATA_DIR on one host. Separate volumes, serverless/ephemeral storage, multi-host/NFS locking and deployment rollouts have not been certified. Direct CLI/service invocations do not acquire this API reservation and must not run alongside API refreshes. Publication retains its independent immutable-file/monotonic-pointer lock. Multi-host designs would require a shared coordinator with publication fencing. Persistent volume selection, hosted backups/restore, retention, operator diagnostics and recovery drills remain issue #4/#9 release gates.

Tests exercise fresh app and separate Python-process reads, owner isolation, provider-error privacy, queued/running write failures, ambiguous completion writes, lock release and old running observations. Tests use temporary databases and synthetic results; they do not certify hosted storage or live provider behavior.

History regression checks cover bounded ordering, authentication, owner isolation, storage failures, loading/empty/error states, exact-package actions, sanitized transport failures and stale responses after unmount. Frontend checks use mocked React/transport rather than a real browser; hosted/browser acceptance remains open.

Reservation tests cover two connections, thread handoff, separate spawned processes, forced holder termination/reacquisition, storage errors, exclusion before job creation, ownership during provider/status work and scheduling cleanup. Windows local checks plus Linux CI exercise these primitives; neither certifies an untested hosted filesystem.

Reconciliation regressions cover multiple owners, preserved completed results, unknown-completion history, refusal while another worker holds the reservation, rollback on malformed storage, sanitized storage failure and reservation cleanup. Actual hosted crash/publication drills remain required.


## Workspace status transport failures

A failed status request leaves the last recorded job unchanged and displays separate, sanitized feedback with an explicit check-again action. It does not release the refresh button as if the server job had failed. Poll cleanup ignores late responses after unmount; the workspace remounts for each authenticated owner. Job identity and state must match the request contract before an observation is accepted. Only queued/running jobs poll.

A completed job remains completed if catalog reloading fails. The exact package can still be selected, while catalog failure receives separate feedback; the UI no longer claims research reloaded merely because a completed status arrived. History remains available for explicit result opening. Unit tests simulate disconnect/retry, terminal outcomes, unexpected responses and late completion. These checks do not substitute for a real browser or market-open outage drill.


## Page reload rediscovery

An authenticated account workspace reads its owner-scoped recent job history on mount and resumes observation of a single queued/running record. This does not restart provider work or prove worker liveness. Terminal records do not become active; multiple active or malformed/duplicate observations fail without guessing. A new manual request takes precedence over a late discovery response, and cleanup ignores responses after the account workspace unmounts. Failed discovery keeps an explicit warning to inspect/reload history before another refresh. The latest-20 history window and actual hosted account/restart acceptance remain limits. No storage flag or hosted migration is enabled by this source change.


## Admission submission guard

The workspace locks submission synchronously before the refresh POST returns and displays a submitting state, preventing rapid duplicate clicks before job acknowledgement. Only a canonical queued-job acknowledgement starts observation; unexpected fields are excluded. Account cleanup ignores late acknowledgements/errors and does not invent a job outcome. Timeout or malformed response is unconfirmed and asks the user to inspect history before an explicit retry. This UI guard is not server idempotency and cannot prove a timed-out request was not admitted. Durable remote admission remains authoritative; no automatic resubmission is added. Hosted browser acceptance remains open.


## Completion source identity in observation

Workspace polling now requires a valid lowercase 64-hex package ID on completed observations before accepting completion. Missing/malformed identity keeps the previous recorded observation unchanged and shows status-unavailable feedback; it never reloads unrelated catalog evidence as the new result. Verified completion retains its exact package ID. This is a response-consistency check, not proof of worker liveness or hosted durability. Backend ownership and exact package reads remain authoritative; hosted/browser acceptance remains open.


## Bounded historical provider retries

Historical calendar/bar GETs now allow at most three attempts for transport failures and HTTP 429/502/503/504, with short exponential backoff. Numeric Retry-After values up to five seconds are respected; longer, negative, nonfinite or unrecognized cooldowns stop rather than retry early. Access/invalid-request errors are not retried. The exact endpoint, query, pagination token and selected feed remain unchanged; there is no SIP-to-IEX downgrade or new provider data invented. Exhaustion fails publication with sanitized feedback. Instrument lookup and other providers retain their existing behavior. Mocked transport fixtures verify limits/cooldowns/denials; this is not aggregate multi-host rate limiting or actual market-open recovery evidence.
