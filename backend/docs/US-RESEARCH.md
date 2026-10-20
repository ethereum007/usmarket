# US Alpha Radar — first implementation

Implemented 19 October 2026. Local research foundation; no production deployment.

## Run

From this backend checkout, supply ALPACA_API_KEY and ALPACA_SECRET_KEY in the local process environment, then:

```powershell
python -m app.services.us_research --symbols AAPL,MSFT,NVDA,AMZN,META --benchmark SPY --feed sip
```

No credentials are included. Missing credentials fail without producing data.
The command only calls market data and calendar GET endpoints. It never submits orders.

## Delivered

- Shared swing package builder accepts explicit market, benchmark and classification map. Existing NSE defaults remain.
- Alpaca adapter reads split-adjusted daily bars, follows pagination, bounds requests, rejects HTTP errors and repeated pagination tokens.
- Provider calendar controls eligible dates, early closes and America/New_York daylight saving conversion. Close plus 30 minutes is an explicit publication policy, not a guarantee of provider finality.
- Latest completed benchmark bar is mandatory. Missing stock bars create a partial package with coverage counts.
- Existing breadth, aligned relative strength and swing detectors run on the source bars. US thresholds remain uncalibrated.
- Saved JSON packages use content identity, atomic file replacement and a separate last-final pointer per universe/benchmark/feed. Partial research cannot replace that pointer.
- US packages do not write into the NSE SQLite database. The application now mounts authenticated US research routes, locally verified but not deployed.
- Unknown earnings and classification remain explicit. Explicit ticker lists are not index constituents or unbiased historical universes.

## Next implementation gates

1. Verify actual account data and entitlements against liquid stocks and split cases; certify session aggregation before using daily volume as regular-session volume.
2. Add instrument identity, corporate action ledger and versioned universe membership.
3. Add durable shared Postgres publication, authenticated API and US terminal using the package contract.
4. Add verified earnings calendar, sector/industry taxonomy and leadership history.
5. Port conditional plans with USD risk, event exposure and portfolio caps; validate setup thresholds and outcomes before live alerts.

The CLI currently has no retry/resume, scheduled refresh, retention or distributed publication lock. Run one writer per output directory. This is a research foundation, not the completed US product.

Provider references:
- https://docs.alpaca.markets/us/reference/stockbars
- https://docs.alpaca.markets/us/reference/legacycalendar


## Terminal API increment

Mounted under /api/us/research using existing require_premium access control:

- GET /packages: saved US package metadata, newest sessions first (bounded 120 records).
- GET /packages/{64-character hex ID}: exact saved package; rejects non-US content and malformed identity.
- POST /refresh: 1–50 explicit symbols, SPY/QQQ benchmark, SIP/IEX feed. Starts a background job.
- GET /jobs/{ID}: caller-owned status and exact package ID on completion.

Refresh jobs and the lock are process-local; saved packages survive restart. This must move to a shared queue/lock before multiworker deployment. Local preview: python tests/serve_us_preview.py, loopback only on port 9018. Its development identity override is scoped to that explicit harness. Never deploy the harness.

Frontend /us implements package selection, breadth context, searchable/sortable stock queue, source charts, individual theses, browser-local shortlist/notes, export and refresh. Account-synced plans and earnings integration remain future work. See frontend docs/US-TERMINAL.md for launch and validation details.
