# US live-data verification — 19 October 2026

Observed at 09:10–09:14 America/New_York (18:40–18:44 IST).

- Alpaca clock: regular market closed; next open 2026-10-19 09:30 ET / 19:00 IST.
- Real-time SIP latest quotes: HTTP 403, subscription does not permit recent SIP. WebSocket auth: error 409, insufficient subscription. No feed downgrade is hidden.
- IEX latest quotes and trades: HTTP 200. Streaming auth and subscription accepted. Bounded 20-second sample: 0 quote/trade events. Authentication is verified; active regular-session streaming is not.
- AAPL/NVDA quotes were from Friday close and had very wide spreads. SPY quote was approximately 30 minutes old. All were marked stale, not live. Last trade ages are evaluated independently.

## Added

- Premium-protected GET /api/us/research/live?symbols=AAPL,SPY&feed=iex. Maximum 10 symbols. Quotes, trades and provider clock requested independently. Credentials remain server-side.
- US page live diagnostics panel polls REST every five seconds while visible. Feed selector exposes IEX and SIP permission failure. Displays exchange timestamps, quote/trade ages, spread, unknown data and regular-session status. This is REST polling, not browser streaming.
- Quote freshness: finite positive non-crossed bid/ask and timestamp age <=30 seconds; future timestamps beyond five seconds rejected. Wide spread >100 bps disclosed separately. No execution authorization or research-bar mutation.
- Snapshot cache: three seconds per symbol set/feed, bounded 64 entries. Shared streaming and distributed rate limiting remain later work.

## Required next evidence

At/after 19:00 IST with the page visible, confirm selected IEX quotes update with fresh exchange timestamps and compare bid/ask ages and spread. This has not yet passed a market-open live test. Consolidated live SIP requires the appropriate provider entitlement; no purchase or account change was made.

Tests: 33 combined targeted checks passed, then the added route input-limit test passed with the live service/route group (14 checks). TypeScript passed.
