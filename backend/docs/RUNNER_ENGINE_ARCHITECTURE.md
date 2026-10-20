# Runner Engine Architecture (PR1-PR3)

## Objective

Runner is the backend-owned research foundation for detecting unusual Indian-equity participation early. It monitors a configurable broad universe, creates point-in-time minute features, and persists those features for later research. A transparent volume-first participation rank reduces those observations to at most five names for operator review; it is not a Runner Score, entry decision, or trade recommendation. Runner does not manage setup states or place orders.

The intended future funnel is broad market → statistically unusual → runner candidate → high quality → zero to three actionable decisions. “No trade” is a valid future output.

## Additive architecture

The existing abnormal momentum, accumulation, institutional buying, live signal tracker, market pulse, intraday radar, scanner, Arrow diagnostics, Kite connectivity, WebSocket hub, alerts, snapshots, and Algo Lab remain in place. Runner can be disabled independently and its startup and persistence failures fail softly.

Data flows as follows:

1. Existing Kite streaming or Arrow batched quotes enter a thin provider adapter.
2. Provider payloads become `NormalizedMarketTick`; calculations never consume provider dictionaries.
3. `MarketStateStore` owns latest state in the backend.
4. `MinuteBarBuilder` converts cumulative volume/turnover into incremental one-minute OHLCV bars and bounded rolling state.
5. The baseline service provides same-symbol, same-session-minute historical expectations.
6. The feature engine calculates a versioned `RunnerFeatureSnapshot` on a configurable broad cadence.
7. The participation shortlist applies explicit volume, acceleration, liquidity, freshness, and quality gates and returns zero to five research candidates.
8. The versioned Runner ranking compares eligible snapshots with the live cross-section and labels observation, unusual, candidate, and high-quality research tiers.
9. The feature store batch-upserts the last snapshot for each completed minute.

Raw ticks are deliberately not persisted for the broad universe.

## Universe

Runner reuses `stock_universes.resolve_universe`. Supported production configurations are `nifty50`, `nifty100`, `nifty200`, `nifty500`, the existing `smallcap` universe, and `broad`, which de-duplicates Nifty 500, Smallcap 250, and the microcap watchlist. The production default is `broad`; it is not restricted to F&O securities.

## Normalized live state and provider abstraction

`NormalizedMarketTick` carries identity, exchange/source and processing timestamps, LTP, daily OHLC, previous close, cumulative volume/turnover, average price, best bid/ask, spread, total buy/sell quantity, depth, OI, freshness, and explicit quality states. Unavailable values stay null.

`MarketDataProvider` exposes quote, depth, history, and subscription capabilities. `KiteProvider` wraps the existing Kite client/ticker; `ArrowProvider` wraps `arrow_market_data_service`. The existing `/api/arrow/benchmark/quotes` contract is unchanged. Arrow’s current integration has batched quote/history access but no existing streaming socket, so an Arrow-primary Runner uses batched broad refreshes.

## Minute bars and rolling windows

The builder is thread-safe and uses bounded deques rather than per-tick DataFrames. It stores minute OHLC, incremental volume, cumulative volume, incremental/cumulative traded value, VWAP, and tick count. It handles:

- first observation and day reset;
- minute rollover without inventing missing candles;
- duplicate suppression;
- older/out-of-order tick rejection;
- reconnect-safe cumulative deltas;
- explicit cumulative-volume reset quality;
- Asia/Kolkata session timestamps.

Windows of 1, 3, 5, 10, 15, and 30 minutes are computed from bounded recent bars. A service that starts after the open cannot reconstruct missed per-minute volume from one cumulative observation; that state is observable as partial history rather than fabricated data.

## Time-of-day baselines

For every symbol and minute-of-session, the builder calculates robust statistics from completed sessions before `as_of_date`. The current/incomplete session is excluded. Short and stable lookbacks default to 20 and 60 sessions.

Stored metrics include cumulative and 1/3/5/10/15-minute volume, cumulative turnover, intraday range, absolute move from open/previous close, and 1/5/15-minute returns. Each metric stores median, mean, population standard deviation, p10/p25/p75/p90/p95, sample count, as-of date, and baseline version.

Provider history is normalized before statistics are built: timestamps are converted to Asia/Kolkata, malformed candles are rejected, responses are sorted, duplicate minutes are resolved deterministically, and only 09:15 through 15:29 candles from sessions strictly before `as_of_date` are admitted. Cumulative volume and turnover are calculated only after this normalization, so descending or repeated provider responses cannot alter the result.

Only the current minute and the exact five-minute-prior acceleration slice are retained in the hot baseline index. This avoids loading millions of Nifty 500 baseline rows at startup while preserving restart-safe volume acceleration. Loaded-minute state resets each trading date so the next session sees the latest EOD baselines.

## Feature definitions

`RVOL_TOD` is current cumulative volume divided by the historical median cumulative volume for the same symbol and session minute. Both 20-session and 60-session variants are retained. A zero or absent expectation returns null, never a fabricated ratio.

Window RVOL and volume velocity compare current 1/3/5/10/15-minute participation with the historical median for the same ending minute. Volume acceleration compares the current five-minute RVOL with the preceding five-minute RVOL using the corresponding earlier baseline.

`GET /api/runner/shortlist` ranks only features that pass configurable minimums for 20-session same-minute RVOL, latest-five-minute RVOL, current acceleration (or a stronger latest-minute spike), cumulative turnover, freshness, and non-blocking data quality. Its bounded, volume-dominated score is an explainable operator triage device. It intentionally returns no names while baselines are missing and never claims `ENTRY_READY`.

`GET /api/runner/rankings` implements the versioned PR4 research score. Six bounded components cover participation, current volume velocity, normalized price movement, range expansion, structure, and market/sector alignment. The absolute score is blended with its percentile within the eligible live universe so one static threshold cannot dominate every market regime. Missing optional inputs contribute zero and reduce `evidenceCompleteness`; stale data, missing TOD baselines, provider mismatch, volume reset, clock anomaly, and insufficient turnover fail closed. `HIGH_QUALITY` requires both score and cross-sectional percentile thresholds, adequate evidence completeness, and coherent price/VWAP direction. The response always has `entryReady=false` because setup, extension, invalidation, and risk gates belong to later phases.

Price features include rolling 1/3/5/10/15/30-minute returns, return from open/previous close, and point-in-time return z-scores against historical same-minute return distributions.

Range features compare current high-low range with expected range at the same session minute and expose both a median ratio and mean/std expansion z-score. A rate-aware daily context warmer calculates ATR14 using only completed prior sessions.

Structure joins reuse PDH/PDL and ORB caches. VWAP, day-range location, close-location value, and spread are calculated when source fields exist. Prior-session 20/50-day highs come from the daily context warmer; CPR and VCP metadata remain nullable unless supplied by their existing cached scanners.

## Market, sector, and existing-engine context

`app/caches/sector_map.py` is the canonical sector map used by both market routes and Runner. Each broad refresh derives breadth, regime, sector returns, and sector ranks directly from fresh normalized universe state. Nifty 50 is subscribed alongside the equity universe (or included in Arrow's batch) to provide benchmark return and VWAP context; unavailable or stale benchmark data remains null. Unknown `Others` classifications are not treated as a synthetic sector. `RunnerContextStore` is an injectable cache for this context and precomputed abnormal momentum, accumulation, institutional, CPR and VCP metadata. Slow scanners are joined through the cache and are never invoked on the tick path.

## Data quality and provider validation

Quality states are `GOOD`, `STALE`, `MISSING_BASELINE`, `MISSING_HISTORY`, `PARTIAL`, `PROVIDER_MISMATCH`, `VOLUME_RESET`, and `CLOCK_ANOMALY`. Every feature carries source/processing timestamps and freshness. Missing provider timestamps/volume are partial, and materially future-dated ticks are rejected as clock anomalies before they can advance live state. Non-good states remove `GOOD`, allowing future risk logic to fail closed. Provider setup readiness is distinct from liveness: liveness requires both a recent accepted receipt and a recent exchange timestamp, so repeated stale responses cannot appear healthy. Operational errors retain only exception class names. Actionable runtime incidents (staleness, volume resets, clock anomalies, and provider mismatches) are cooldown-limited and persisted; failed quality-event writes are retried without stopping feature calculation.

Optional sampled cross-provider checks compare LTP, cumulative volume, timestamps, and daily OHLC and record divergence in `runner_data_quality_events`. Samples rotate through the monitored universe, and repeated events are cooldown-limited. Sampling size, price/OHLC tolerance, and event cooldown are configurable so 500 symbols are not cross-queried every cycle or written repeatedly during one incident.

## Storage and scale

`runner_minute_features` is unique by session date, symbol, minute timestamp, and feature version, with date/time, symbol/time, and version/date indexes. At Nifty 500 scale it supports roughly 187,500 feature rows per normal session. Writes are batched upserts at minute rollover; a bounded retry queue absorbs temporary Supabase failure without stopping live calculations.

`runner_baseline_stats`, `runner_data_quality_events`, `runner_engine_runs`, and the future-facing but currently unused `runner_state_events` are service-role-only RLS tables. Baseline rebuilds upsert the latest reproducible `as_of_date` for each symbol/minute/lookback/metric/version, keeping table size bounded instead of appending millions of duplicate daily definitions. Live Runner processes also upsert one `LIVE_SESSION` run from startup through periodic low-frequency checkpoints and clean shutdown, without adding a row per refresh. A partial index supports startup lookup of the newest interrupted baseline run without scanning completed run history.

Admin baseline diagnostics query only one symbol and one session minute (at most 100 metric rows) directly from the versioned store. This remains useful outside market hours without expanding the API into a broad feature-store export, and falls back to the hot cache when persistence is unavailable.

## Scheduling and failure isolation

Runner uses the existing APScheduler singleton. Streaming state updates continuously; broad feature calculation defaults to 10 seconds during market hours; completed-minute persistence occurs on rollover, with an idempotent 15:31 close flush for the final minute. The first tick of a new session atomically clears prior-session market/bar/feature state. The EOD baseline update defaults to 16:30 IST. Network and database operations run asynchronously or in worker threads. Baseline builds persist their exact inputs and progress without retaining the universe-wide result set in memory. A compatible interrupted run resumes automatically from its last durable checkpoint after restart; admin launch is tracked to prevent concurrent-request races.

The full subsystem is gated by `RUNNER_ENGINE_ENABLED`. Supabase, Arrow, Kite, baseline, or feature errors are logged and contained. Existing API startup is not made dependent on Runner health. Kite minute history is fetched in non-overlapping, rate-aware chunks so a 60-session build does not rely on an oversized provider request.

Daily ATR14 and prior-session 20/50-day highs are warmed by `RunnerDailyContextService`, never inside the tick path. It accepts Kite dictionaries and Arrow candle arrays, sorts and deduplicates completed daily candles deterministically, and rejects every candle dated on or after the target session. Output is tagged with the exact `as_of_date`; feature assembly fails closed with `MISSING_HISTORY` instead of joining stale process context. Daily context and TOD baseline builders share a provider-history lock, preventing concurrent broad-universe jobs from overrunning broker limits.

## Research safety and versioning

Historical fetches end at the prior session. Baseline construction accepts an explicit `as_of_date` and filters sessions to dates strictly before it. Live features only use bars no later than the source timestamp and reject future-dated baseline records. No full-day current-session volume, future candle, future high/low, or eventual close is used.

Every feature row carries `RUNNER_FEATURE_VERSION`; every baseline row carries `RUNNER_BASELINE_VERSION`; every derived ranking carries `RUNNER_SCORE_VERSION`. Formula changes should create new versions rather than overwrite research meaning.

## Deferred phases

PR4's research score and cross-sectional ranking are implemented. PR5 adds the state machine. PR6 adds setup engines, risk gating, and paper-only execution. PR7 adds chronological replay and validation metrics. No state transition, entry permission, or broker order placement exists in the PR4 layer.
