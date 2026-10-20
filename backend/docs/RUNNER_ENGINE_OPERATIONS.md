# Runner Engine Operations

## Enable or disable safely

Runner foundation is enabled by default. Set `RUNNER_ENGINE_ENABLED=false` and
restart the backend to disable every Runner subscription and scheduled job
without affecting existing Alpha Radar routes. Production should still declare
the flag explicitly so the intended state is visible in VM configuration.

Apply `supabase/migrations/20260905_runner_engine_foundation.sql` and `20260905_runner_engine_resume_index.sql` before enabling minute persistence or baseline rebuilds.

Recommended initial configuration:

```env
RUNNER_ENGINE_ENABLED=true
RUNNER_UNIVERSE=broad
RUNNER_FEATURE_VERSION=runner-v1
RUNNER_BASELINE_VERSION=runner-baseline-v1
RUNNER_BROAD_REFRESH_SECONDS=10
RUNNER_PERSIST_MINUTE_FEATURES=true
RUNNER_BASELINE_SHORT_SESSIONS=20
RUNNER_BASELINE_LONG_SESSIONS=60
RUNNER_PRIMARY_PROVIDER=kite
RUNNER_PROVIDER_CROSSCHECK_ENABLED=false
RUNNER_PROVIDER_CROSSCHECK_SAMPLE_SIZE=10
RUNNER_PROVIDER_LTP_TOLERANCE_BPS=20
RUNNER_QUALITY_EVENT_COOLDOWN_SECONDS=60
RUNNER_STALE_AFTER_SECONDS=30
RUNNER_BASELINE_AUTO_UPDATE=true
RUNNER_BASELINE_LOAD_RETRY_SECONDS=60
RUNNER_DAILY_CONTEXT_ENABLED=true
RUNNER_HISTORY_REQUEST_DELAY_SECONDS=0.35
RUNNER_MARKET_CONTEXT_MIN_SYMBOLS=20
RUNNER_PROVIDER_LIVENESS_SECONDS=45
RUNNER_RUN_HEARTBEAT_SECONDS=300
RUNNER_BASELINE_BOOTSTRAP_ENABLED=true
RUNNER_SHORTLIST_LIMIT=5
RUNNER_SHORTLIST_MIN_RVOL_TOD=1.5
RUNNER_SHORTLIST_MIN_RVOL_5M=1.5
RUNNER_SHORTLIST_MIN_ACCELERATION=1.05
RUNNER_SHORTLIST_MIN_TURNOVER_CRORE=5
```

Keep existing Kite, Arrow, Supabase, and admin credentials in their current environment variables. Runner never logs those values.

## Build or rebuild baselines

Authenticate as an existing Alpha Radar administrator and call:

```text
POST /api/runner/baselines/rebuild
{}
```

Optional bodies:

```json
{"symbol":"RELIANCE"}
```

```json
{"universe":"nifty200","limit":50}
```

The endpoint returns 202 and starts one tracked job in the existing application process. Concurrent admin requests cannot race into duplicate rebuilds. Progress—including the exact symbol list, lookbacks, version, completed index, failures, and persisted rows—is checkpointed to `runner_engine_runs` every 25 symbols. After a process restart, Runner finds the latest compatible `RUNNING` checkpoint and resumes from the next symbol; the bounded upserts also make replaying the last batch safe. Incompatible or incomplete legacy checkpoints are marked `INTERRUPTED_UNRESUMABLE`. The job fetches through the configured provider at a conservative sequential cadence and excludes the current date.

The scheduled incremental rebuild runs at 16:30 IST on weekdays when `RUNNER_BASELINE_AUTO_UPDATE=true`.

When `RUNNER_BASELINE_BOOTSTRAP_ENABLED=true`, startup also checks the current session-minute coverage after daily context warming and automatically rebuilds symbols without a usable baseline. This means a new installation begins calibration without a manual admin request. The Supabase migrations are still required before the generated baselines and minute features can be stored.

Rebuild input is restricted to regular NSE session candles (09:15–15:29 IST). Provider responses may arrive out of order or contain repeated minutes; normalization sorts and deterministically deduplicates them before cumulative statistics are calculated.

## Warm daily structure context

Runner warms ATR14 and prior-session 20/50-day highs in the background at startup and at 08:35 IST on weekdays. Historical requests are sequential and controlled by `RUNNER_HISTORY_REQUEST_DELAY_SECONDS`; baseline and context history jobs share one lock so they cannot burst the provider together. Set `RUNNER_DAILY_CONTEXT_ENABLED=false` to disable this optional warmer while keeping the rest of Runner active.

An administrator can retry the full configured universe or one symbol without restarting:

```text
POST /api/runner/context/rebuild
{}

POST /api/runner/context/rebuild
{"symbol":"RELIANCE"}
```

Only candles strictly before the target session date are accepted. Current-session or future candles, malformed OHLC, and lower-quality duplicates are excluded deterministically. Until complete current-session context exists, ATR/high fields remain null and the feature carries `MISSING_HISTORY`.

## Verify health

Call the protected endpoint:

```text
GET /api/runner/status
```

The protected live diagnostics feed used by the Runner Lab UI is bounded to
100 current in-memory snapshots and never exposes historical feature-store rows:

```text
GET /api/runner/latest?limit=50&sort=rvol_tod_20d
```

Supported diagnostic sort fields are `rvol_tod_20d`, `rvol_tod_60d`,
`rvol_5m`, `volume_acceleration`, `ret_5m`, `range_tod_ratio`, and
`freshness_seconds`. Missing values remain null and sort behind observed values.

The primary operator feed is the bounded participation shortlist:

```text
GET /api/runner/shortlist?universe=broad&limit=5
```

`universe` accepts `nifty100`, `nifty500`, `smallcap`, or `broad`. A response of `NO_PARTICIPATION` is intentional when no symbol passes every same-minute volume, five-minute volume, acceleration, turnover, freshness, and quality gate. The response always reports `entryReady=false`; it is a research shortlist, not permission to trade.

The cross-sectional PR4 research ranking is available at:

```text
GET /api/runner/rankings?universe=broad&limit=10
```

Read `runnerScore` together with `crossSectionPercentile`, `tier`, component scores, evidence completeness, quality, source, and reasons. `NO_HIGH_QUALITY_CANDIDATE` is a normal response. Even a `HIGH_QUALITY` row is not an entry: the endpoint always reports `entryReady=false`, because PR5/PR6 setup and risk gates have not run.

Check `running`, `providerReady`, `providerLive`, provider receipt/source ages, configured and monitored symbol counts, both baseline coverage values, `dailyContextCoverage`, `dailyContextJob`, `marketContext`, latest feature time, stale count, quality summary, processing latency, persisted row count, retry queue, `baselineTaskActive`, and baseline job progress. `providerReady` means setup or the latest request succeeded; `providerLive` requires both a recent accepted receipt and a recent exchange timestamp within `RUNNER_PROVIDER_LIVENESS_SECONDS`. The last provider error exposes only its exception class, never payload text. `marketContext` reports the fresh breadth sample size, advances/declines, coverage sufficiency, regime, sector coverage, and Nifty return/VWAP state. A regime remains null until `RUNNER_MARKET_CONTEXT_MIN_SYMBOLS` fresh observations exist.

At startup during market hours, monitored symbols should rise as Kite ticks arrive or the first Arrow batch completes. Missing baseline is expected before the first rebuild.

## Inspect a feature or baseline

Use:

```text
GET /api/runner/features/RELIANCE
GET /api/runner/baseline/RELIANCE
GET /api/runner/baseline/RELIANCE?minute=17
```

The feature endpoint returns only the latest internal diagnostic snapshot for one symbol. The baseline endpoint performs a bounded database lookup for one symbol and one minute; when `minute` is omitted it uses the current session minute, clamped to 09:15/15:29 outside market hours. Its `source` identifies database data or the safe in-memory fallback. There is intentionally no broad feature-store dump and no trading endpoint.

For a 09:32 check, confirm `minute_of_session=17`, compare the current cumulative volume with the baseline `cumulative_volume` median for minute 17, and verify `rvol_tod_20d`/`rvol_tod_60d`.

## Diagnose stale or partial data

- `STALE`: compare source timestamp, processing timestamp, and freshness. Check provider authentication and Kite socket reconnect or Arrow status.
- `MISSING_BASELINE`: run a baseline rebuild and verify its completion/sample counts.
- `MISSING_HISTORY` or `PARTIAL`: the process started after the session began or the provider returned incomplete history. Do not infer missing values.
- `VOLUME_RESET`: the provider cumulative counter fell. The bar builder starts a new positive delta and records the anomaly.
- `CLOCK_ANOMALY`: an older tick arrived after a newer tick for that symbol and was rejected.
- `PROVIDER_MISMATCH`: inspect `runner_data_quality_events` and the Arrow benchmark endpoint before trusting the source.

## Check persistence

Query `runner_minute_features` for the current session and version, grouped by minute. The expected maximum is approximately universe size × completed minutes, with one logical row per symbol/minute/version. Duplicate reruns update the same uniqueness key. A 15:31 IST close job performs an idempotent flush so the last completed 15:29 bar is retained even when no rollover tick arrives.

Check `persistenceRetryRows` and `persistenceRetryRowsDropped` in status. A temporary Supabase outage should increase the bounded retry queue while live feature calculation continues; the next completed-minute write retries queued rows. A non-zero dropped count means the outage exceeded the safety buffer and requires database reconciliation. Baseline slice loads back off for the configured retry period during an outage rather than querying on every feature refresh.

Inspect `runner_engine_runs` for baseline job completion/failure totals and `LIVE_SESSION` records. Live sessions use one run ID from startup through shutdown, checkpoint every `RUNNER_RUN_HEARTBEAT_SECONDS`, and retain a `RUNNING` row after an unclean process exit for diagnosis. Inspect `runner_data_quality_events` for provider divergence. `runner_state_events` remains intentionally unused until the PR5 state machine.

## Rollback

Set `RUNNER_ENGINE_ENABLED=false` and restart. Existing scanners, Arrow diagnostics, WebSocket clients, alerts, snapshots, signal validation, and Algo Lab remain independent. Tables can remain in place for research history; no destructive database rollback is required.
