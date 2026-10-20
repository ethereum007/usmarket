# Intraday coverage and entry checks

Intraday keeps its own untruncated Nifty 500 snapshot (`intraday_monitor_nifty500`). The existing Radar builder copies its full ranked candidates and exact score inputs into this snapshot before its normal top-80 response is returned. No second quote scan is made. The shared Radar formula, quality grades, response fields and top-80/top-30 lists are unchanged.

## Coverage

- All LONG candidates and SHORT candidates in the F&O universe are monitored. The former 30-long/20-short caps no longer apply; their environment settings are retired.
- Smaller scans cannot overwrite the full snapshot. The existing broad and general Radar caches remain recovery fallbacks, explicitly marked as partial coverage. Prior-session snapshots are excluded.
- Requested, quoted, missing-quote, ranked, eligible, monitored, complete-candle, pending-candle and confirmed counts are exposed. A stock leaving the candidate list remains monitored if it has a stored signal.
- History warming retains `INTRADAY_BREAKOUT_HISTORY_FETCHES_PER_CYCLE` and shared provider pacing. Attempts rotate so an unavailable symbol cannot occupy every batch. More names can take longer to warm; the UI shows this backlog. No provider limits are increased.
- New confirmations require all completed five-minute buckets from the session open. Stream aggregation requires five source minute bars. Historical five-minute candles are authoritative and may correct prior history.
- Session restoration paginates candles and signals with stable ordering, including when the server returns fewer rows than requested.

## Score interpretation

The Intraday response includes the current Radar score breakdown: setup total, momentum, volume, range, rounding/cap and the actual market adjustment. Exact raw inputs are captured during scoring rather than reconstructed from rounded display values. The public Radar response does not gain these fields.

Each new signal retains its Radar context, score explanation, Radar timestamp and detection timestamp in the existing `metadata` JSON column. Detection may occur after historical confirmation during backfill, so the UI calls it **score when detected**, not score at confirmation. Older stored signals do not have this context; no history is invented for them. No schema migration is needed.

## Entry policy v1

The assessment is per signal basis (5M, 15M or PDH/PDL), independent of the Radar score. These are review rules, not calibrated probabilities or order instructions.

For `CHECKS_PASSED`, require a live session, healthy feed, positive quote with source timestamp at most 180 seconds old, Radar context at most 180 seconds old, complete session candles, matching confirmation close, daily levels and VWAP, current directional agreement and the favourable side of VWAP, confirmation no older than 15 minutes, no observed stop touch or failed-level close since confirmation, entry extension at most 0.5R and remaining reference reward/risk at least 1.5R. Closed sessions, missing context, failed levels, reached targets, old confirmations and extended entries receive distinct statuses and reasons.

The structural stop uses the retracement candle's low for longs/high for shorts (confirmation candle if no retracement), plus a buffer of max(0.1% of confirmation price, ₹0.05). Initial R is the distance from confirmation close to that stop. The reference target is 2R from confirmation, limited by an opposing previous-session level if one is nearer. Remaining reward/risk uses the current quote against these levels. This target is a planning reference, not independently forecast upside/downside. Fees, slippage and spread are not estimated.

Stop/target touches use completed candles after confirmation and the current quote. Level invalidation uses subsequent closes and the current quote. Missing candle history blocks a positive assessment. Stored direction comes from the signal type, so a later Radar flip cannot relabel an old signal.

Intraday table returns use the confirmation close and only subsequent candles, before costs. Existing level-based return fields remain available for chart compatibility. Neither return series implies executable or realized P&L. Outcome calibration by score band remains future research; no win-rate claims are shown.

## Rollout and verification

### Daily priority and repeat confirmations

The default **Priority now** view uses the latest event for the selected basis and direction. Its order is entry checks passed, watch for confirmation, review only, then invalidated/data check. Within each group, more current valid confirmation types come first, followed by fresher confirmation, higher remaining reference reward/risk, higher current Radar score, and symbol/direction for deterministic ties. Only entry and watch groups receive priority numbers. Rank is an ordering of review criteria, not a probability or an additional trade score. Closed/stale data cannot retain an entry priority; the client also ages out confirmations and assessments between refreshes.

**Today's history** lists all retained confirmations for the selected basis, newest first by default, with optional return sorting. It shows the score captured at detection. Previous events of the same type are marked superseded and cannot add votes to current agreement.

A second range breakout requires a new pullback and another completed close through the preceding session range; continuation candles alone do not generate events. A previous-day-level setup must first close back across its level, then recross favourably. Both long and short 5M/15M events are supported. Stable event IDs and event numbers distinguish setups.

The existing unique database row per session/symbol/type holds the latest event, with flat prior events in `metadata.priorEvents`. Old rows remain readable and `signals` remains the latest-per-type API; `events` exposes full history. Restarts restore all events, equivalent UTC/IST times deduplicate, and failed saves retry on later refreshes even without new market events. Pending saves are visible in the UI. No database migration is required.

Deploy backend and frontend together, then allow a normal broad market scan and candle warm-up. Until the full snapshot is available the page shows partial coverage. No Signal Qui UI change, shared scoring migration or database schema change is required.

Focused regression command:

```powershell
.venv/Scripts/python.exe -m pytest tests/test_intraday_monitoring.py tests/test_intraday_repeat_events.py tests/test_intraday_breakout_service.py tests/test_intraday_freshness.py tests/test_intraday_route_cache.py tests/test_market_snapshot_service.py -q -p no:cacheprovider
```

Frontend verification: `npm run test:intraday`, TypeScript, file-specific ESLint, production build, and browser checks with synthetic data for priority/history, repeat setups, score disclosure, signal basis, bearish filtering, stale/empty states, keyboard activation and mobile/light-theme layout. Backend repeat-event tests cover continuation suppression, UTC/IST deduplication, storage/restoration and save retries using a database double. Production market feeds and a live database rollout are not part of this local verification.
