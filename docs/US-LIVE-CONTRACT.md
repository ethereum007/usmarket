# Live diagnostic response validation

REST live diagnostics validate each endpoint independently. A successful HTTP code does not establish valid data: responses must be JSON objects, and quotes/trades envelopes must contain object maps. Requested rows must be objects with finite positive numeric prices (booleans are rejected), uncrossed bid/ask and aware timestamps within the future tolerance. Invalid source timestamps are omitted from returned rows rather than echoed as arbitrary provider objects.

Missing or invalid requested observations produce degraded state and fixed endpoint feedback. Valid observations from another endpoint remain visible. Permission denial remains denied for the requested feed; there is no silent SIP-to-IEX fallback. Connected means endpoint/row contracts were valid at receipt, not that all observations are fresh: quote/trade freshness remains independently assessed against the 30-second threshold. Old valid observations remain stale.

Clock status requires a real boolean is_open and an aware timestamp no older than 60 seconds, using the existing five-second future tolerance. Otherwise market status is unknown; invalid optional next-open/close values are removed. This does not infer market holidays or extended sessions and does not certify provider clock correctness.

Tests use synthetic HTTP responses and independent row/clock fixtures: malformed JSON shapes, missing symbols, non-object rows, invalid numeric values/timestamps, invalid schedules, valid endpoint preservation and feed denial. No actual provider session, subscription or display entitlement was changed. Market-open and real disconnect/recovery evidence, caching across workers, provider rate limits and public display permission remain release gates.


## Shared observations within one worker

Concurrent requests for the same normalized symbol set and feed now await one in-flight provider snapshot, then reuse the existing three-second cache without changing source/receipt timestamps. IEX and SIP remain separate keys; denied SIP never becomes IEX. Cancelling one HTTP waiter does not cancel the shared producer. At most eight distinct observations can be in flight per worker; saturation returns explicit unavailable/busy feedback rather than starting more provider calls. Producer errors are sanitized, briefly cached and release the in-flight slot; expired cache entries may recover normally.

This is request coalescing, not an aggregate provider rate limit or cross-worker cache. Each snapshot still performs separate clock/quote/trade requests. The private MVP remains one worker/instance pending actual provider-limit/load acceptance. Tests exercise concurrent callers, feed denial separation, waiter cancellation, saturation/recovery, preserved timestamps and failure/expiry cleanup using synthetic observations. No live subscription or credential changes.
