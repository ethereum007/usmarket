# India-to-US capability map

Evidence: imported source in this repository, inspected 20 October 2026. Source presence is not proof that a feature is fully validated or production-ready.

## Reuse the working foundations

| Capability | Existing source | What the US product needs | Launch priority |
|---|---|---|---|
| Daily/weekly chart terminal | frontend/app/components/charts/CandlestickChart.tsx; app/us | Already adapted to USD and US source sessions. Add benchmark overlays and base annotations only where supported by detector geometry. | P0 refinement |
| Swing setups, VCP, squeeze, momentum | backend/app/engines/cpr; services/swing_research.py | Reuse calculations; audit India-specific defaults, volume/turnover units, benchmark assumptions and thresholds. Validate on US cohorts before edge claims. | P0 |
| Breadth and benchmark RS | services/swing_research.py; services/us_research.py | Already uses SPY/QQQ and eligible counts. Add broad versioned US universe, listing identity, splits/delistings, history quality and historical membership. | P0 |
| Saved sessions and immutable plans | services/swing_repository.py; routes/swing_research.py; frontend/app/swing | Reuse owner/revision/concurrency semantics. Connect to US package identity, USD sizing and hosted durable storage; remove browser-only dependence. | P0 |
| RRG and sector rotation | services/rrg_service.py; frontend/app/rrg | Reuse rotation mathematics and views. Replace Kite retrieval, NSE sector maps and benchmark defaults with US data and versioned classification. Do not call SIC codes a verified investment-industry taxonomy. | P1 |
| Corporate announcement priority queue | frontend/app/latest-updates | Reuse event/price linking and evidence-table interaction. Replace NSE publisher with US filings/releases; distinguish publication time from earnings event time and fiscal period. | P0 |
| Intraday monitor / runner | services/intraday_breakout_service.py; services/runner_service.py | Audit exact module names/contracts before porting. US sessions, pre/after-hours separation, feed liveness, consolidated volume, corrections and gap risks differ. | P1 contextual confirmation |
| Alerts and validation | routes/alerts.py; services/signal_validator.py; engines/live_signal_tracker.py | Reuse existing alert rules and signal validation; audit their exact contract before connecting US inputs. Reuse dedupe and outcome concepts, bind exact US plan revisions, distinguish discovery/trigger/paper fill, evaluate forward outcomes honestly. | P0 outcomes; P1 alerts |
| Auth and premium access | dependencies.py; frontend auth | Existing host/origin dev handling and India pricing are not a US production boundary. Implement independent fail-closed US auth and an explicit dev harness. | P0 |
| Operations, caching and tests | shared_store, provider_gateway, tests | Reuse proven patterns, not India schedulers. Add US-only CI, shared persistence, backups/restore, rate limits, operator diagnostics and rollback. | P0 |

## Genuinely US-specific inputs and behavior

1. **Instrument master:** stable security identity beyond ticker, exchange, listing/delisting dates, share class, ADR/ETF distinction, symbol changes and point-in-time universe membership.
2. **Market sessions:** New York daylight saving, provider-certified holidays/early closes, regular versus extended hours, timestamp validity and completed-session finality.
3. **Feed coverage:** explicit IEX versus consolidated SIP, feed identity on every observation, adjustments, trade/quote conditions, corrections, liveness and public-display entitlement. Personal research access is not public distribution clearance.
4. **Earnings/catalysts:** verified BMO/AMC timing, event revisions, estimates versus actuals where licensed, period alignment, SEC filings and company releases with source URLs and known-as-of timestamps.
5. **Fundamentals:** SEC XBRL/tag variability, fiscal calendars, restatements and as-reported availability. Do not manufacture EPS growth or earnings dates from filing timestamps.
6. **Leadership:** versioned US sectors/industries and eligible membership denominators; industry-relative strength, participation and historical leadership changes.
7. **US setup validation:** liquidity in USD, overnight/earnings gaps, IPO/short histories, split effects and bearish/short-side constraints. Reusing a detector is not validating its performance.
8. **Risk/review:** USD allocation and stop-risk caps, concentration, event exposure, immutable thesis revisions and fill-aware paper outcomes. No order execution in the launch scope.

## What is not a direct port

Nifty/Bank Nifty, NSE F&O leaderboards, FII/DII flows, India VIX context and broker-specific Kite/Arrow services have no automatic US equivalent. US options/OI/Greeks, ETF flows, VIX inputs and short-interest data need their own providers, timestamps, definitions and validation. They are outside the first release unless the core release gates are already satisfied.

## Next sequence

Protect the US API and establish CI -> durable US packages/plans -> verified earnings/catalysts -> industry/market context -> daily research brief and forward outcome review -> launch rehearsal. Keep the imported code as a reference until every dependency is classified; do not rewrite working engines solely to remove their original filenames.


## Historical OHLCV type boundary

US historical normalization rejects boolean open/high/low/close/volume values before numeric conversion. Python boolean-to-number coercion is not market evidence. Rejected stock bars flow through existing missing-session checks: incomplete history is partial and affected setups are withheld. A missing benchmark session blocks publication. Genuine numeric zero volume remains valid; no replacement bar or volume is invented. This validation is independent of provider display rights and actual market-open acceptance, which remain release gates.


## Historical OHLCV JSON types

US history normalization accepts only JSON number values for open/high/low/close/volume. Numeric strings, booleans, nulls and containers remain rejected bars, not coerced observations. Existing finite/range/calendar checks still apply; actual zero volume remains valid. Tests cover every field and verify malformed stock evidence leaves partial coverage with no setups, while missing benchmark evidence blocks research. This changes no provider feed, source revision, hosted storage mode or data-display entitlement. Hosted and real-account acceptance remain open.


## Bounded live diagnostic observation

Live snapshots now have a twenty-second total asynchronous deadline covering client entry and the concurrent clock/quote/trade requests, alongside HTTPX operation timeouts. Expiry cancels pending provider requests; the shared cache returns sanitized unavailable feedback and releases its in-flight slot. It does not downgrade the feed or invent market/price observations. Tests cover all three request cancellations, subsequent use of the released capacity and caller cancellation propagation. Existing disconnected-waiter shielding remains in place. This bounds asynchronous I/O, not synchronous parsing, and is not evidence of actual market-open reliability. No provider subscription, hosted storage flag or completed research package changed.
