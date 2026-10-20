# Durable US refresh observations

Refresh job observations use the imported swing_repository job table in a separate `DATA_DIR/us-refresh-jobs.sqlite3`. Queued, running, completed and failed records persist across app/process restarts on a retained volume. Reads require the authenticated owner; the response omits owner and exception text. Completed results retain their exact immutable package ID. Writes carry an aware UTC updated_at timestamp.

A queued write must succeed before scheduling; a running write must succeed before provider fetching. Storage errors return a sanitized 503 on requests. Background storage failures retain the last durable observation and release the process lock. If publishing succeeds but the completed write fails, the record can remain running: it does not imply publication failed. Inspect saved research before retrying. Provider failures keep the fixed public error boundary.

Status is an observation, not a lease or heartbeat. Unlike the imported job reader's default timeout behavior, the US reader does not infer that a worker died merely because 15 minutes elapsed. No automatic retry, cancellation or abandoned-worker takeover is implemented. The UI labels the state as last recorded and explains this limit. A browser reload does not yet rediscover job IDs; clients retaining a job ID can resume reading it.

This increment is durable status only. Refresh exclusion still uses a process-local lock; separate workers can overlap provider requests. Safe multi-worker coordination requires a shared lease and publication fencing so expired workers cannot publish. Persistent volume selection, hosted backups/restore, retention, operation diagnostics and recovery drills remain issue #4/#9 release gates. Do not deploy multiple refresh workers or claim distributed coordination from this change.

Tests exercise fresh app and separate Python-process reads, owner isolation, provider-error privacy, queued/running write failures, ambiguous completion writes, lock release and old running observations. Tests use temporary databases and synthetic results; they do not certify hosted storage or live provider behavior.
