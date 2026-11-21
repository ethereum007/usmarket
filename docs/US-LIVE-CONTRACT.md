# Live diagnostic response validation

REST live diagnostics validate each endpoint independently. A successful HTTP code does not establish valid data: responses must be JSON objects, and quotes/trades envelopes must contain object maps. Requested rows must be objects with finite positive numeric prices (booleans are rejected), uncrossed bid/ask and aware timestamps within the future tolerance. Invalid source timestamps are omitted from returned rows rather than echoed as arbitrary provider objects.

Missing or invalid requested observations produce degraded state and fixed endpoint feedback. Valid observations from another endpoint remain visible. Permission denial remains denied for the requested feed; there is no silent SIP-to-IEX fallback. Connected means endpoint/row contracts were valid at receipt, not that all observations are fresh: quote/trade freshness remains independently assessed against the 30-second threshold. Old valid observations remain stale.

Clock status requires a real boolean is_open and an aware timestamp no older than 60 seconds, using the existing five-second future tolerance. Otherwise market status is unknown; invalid optional next-open/close values are removed. This does not infer market holidays or extended sessions and does not certify provider clock correctness.

Tests use synthetic HTTP responses and independent row/clock fixtures: malformed JSON shapes, missing symbols, non-object rows, invalid numeric values/timestamps, invalid schedules, valid endpoint preservation and feed denial. No actual provider session, subscription or display entitlement was changed. Market-open and real disconnect/recovery evidence, caching across workers, provider rate limits and public display permission remain release gates.


## Shared observations within one worker

Concurrent requests for the same normalized symbol set and feed now await one in-flight provider snapshot, then reuse the existing three-second cache without changing source/receipt timestamps. IEX and SIP remain separate keys; denied SIP never becomes IEX. Cancelling one HTTP waiter does not cancel the shared producer. At most eight distinct observations can be in flight per worker; saturation returns explicit unavailable/busy feedback rather than starting more provider calls. Producer errors are sanitized, briefly cached and release the in-flight slot; expired cache entries may recover normally.

This is request coalescing, not an aggregate provider rate limit or cross-worker cache. Each snapshot still performs separate clock/quote/trade requests. The private MVP remains one worker/instance pending actual provider-limit/load acceptance. Tests exercise concurrent callers, feed denial separation, waiter cancellation, saturation/recovery, preserved timestamps and failure/expiry cleanup using synthetic observations. No live subscription or credential changes.

## Local market-open liveness probe — 20 November 2026

Run `python -m app.services.us_live_probe` from backend. This read-only command reuses the existing bounded live adapter for one SPY IEX REST snapshot. Exit zero requires connected state, a genuine open-market boolean, exactly one expected symbol and fresh quote/trade statuses. Output is an allowlist of status fields and the probe observation time; it excludes prices, source payloads, provider errors and credentials. Cancellation propagates. Synthetic tests cover closed/unknown market status, feed mismatch, stale/malformed/missing rows, sanitized exceptions and cancellation. CI runs these tests.

Three actual local samples on 20 November at 14:47:22, 14:47:37 and 14:47:45 UTC reported connected, market open, fresh quotes and fresh trades. These are probe receipt times, not provider timestamps. No market values or runtime payloads are retained in source. This establishes only sampled local IEX liveness. It does not satisfy source-timestamp audit, sustained reliability, disconnect/recovery, representative load, consolidated coverage, display rights or hosted real-account acceptance. Issue #9 remains open. Storage flags remain off. The 25 October private MVP target remains missed without hosted acceptance; the 26 November public beta target remains subject to release gates.

## Finite spread arithmetic

Spread basis points now use ask-scaled ratios, avoiding midpoint underflow when both positive finite prices are subnormal. The prior midpoint could round to zero and raise division by zero, preventing the live response from serializing. Tests exercise equal/minimum positive prices, unequal subnormal prices, mixed minimum/large prices and large finite prices through the JSON response serializer. The formula retains the same midpoint-based definition and wide-spread threshold; invalid prices remain unknown. These are synthetic numeric-boundary regressions, not additional market-open or hosted acceptance evidence.

## Browser feed and symbol correspondence

The live panel verifies that responses belong to the selected feed and contain exactly the requested symbol set, without duplicates, missing rows or foreign symbols, before displaying the observation. Malformed collections and unknown connection states follow fixed unavailable feedback. Explicit denied/unavailable responses may omit rows; their feed must still match. Provider row ordering is preserved and no fallback feed or invented rows are introduced. Twelve synthetic browser-contract regressions run in the US frontend CI suite. This does not prove actual provider recovery, aggregate rate limits or hosted real-account acceptance. No subscription, credential or storage flag changed.
