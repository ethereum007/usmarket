# Swing research: local implementation and verification

## Scope

The new frontend route is `/swing`; it is in Discover and the existing premium
page guard. Existing intraday routes remain in place. The backend mounts research
under the existing scanner router at `/api/scanner/research`.

This is a research MVP. It does not place orders, send messages, arm alerts, infer
fills, or promote a strategy. Nothing has been deployed. Runtime backend SHA and
applied production schema still require reconciliation before release.

## Data and persistence

`DATA_DIR/swing_research.sqlite3` is a new application-owned SQLite store. It uses
transactions and WAL for workers sharing one VM filesystem. This deliberately
requires no applied Supabase migration or production configuration change during
development. Deployment must preserve DATA_DIR (the existing workflow does).
Back up the database using SQLite's backup API, including consistent WAL handling;
do not copy only an actively written database file. Horizontal hosts would need a
shared database migration; separate host-local stores are not supported.

Tables: daily_bars (symbol/session source values), research_packages (immutable
JSON snapshots including chart bars), research_jobs (progress/failures/owner),
conditional_plans (owner, ID, immutable revision). No broker credentials are stored.
Stock identity currently uses NSE symbol; instrument aliases, corporate actions,
listing dates and historical membership are not certified. Package manifests say
current configured membership explicitly. They must not be treated as unbiased
historical backtest universes.

Completed bars must have finite positive OHLC, nonnegative volume and valid range
geometry. Deduplication uses source session. Today's source candle is not admitted
before 16:30 IST. Configured holidays and weekends are excluded: a verified
special-session calendar is still required. No missing date is manufactured.
Each EMA/return window requires aligned benchmark session dates; IPO/short/gapped
histories yield null with explicit eligible counts. EMA is recursive, seeded by
the first available close; period length is a minimum availability rule.

High-volume moves use current volume / prior 20 sessions >=1.5 and a +/-4% daily
move. Five-session extremes use actual close-to-close returns. High/low metrics
mean close at the trailing 252-session high/low, not proximity to today's range.
RS is excess return in percentage points versus Nifty 500, not a percentile.
The existing Swing Spectrum enrichment now also preserves null RS when the
benchmark or aligned lookback is missing; absence cannot supply a score bonus.

Refresh is explicit and bounded to the configured universe (maximum 500 stocks),
with a 600-calendar-day history request and rate spacing. Work runs in a background
task; status is persisted. Only one refresh can run per shared store. A 15-minute
heartbeat gap is exposed as interrupted and allows retry. A process restart does
not silently resume the job. Provider failures create a partial attempt if cached
bars permit computation. No benchmark means no publication. A partial attempt
cannot replace the selected last-final package. Identical source content is
idempotent; actual revisions create new snapshots. A scheduled publication job,
bounded backfill operator and retention policy remain future operations work.

## API

Market data reads use the existing get_current_user dependency (guest reads are
allowed by that existing policy). Refresh, jobs and private plans use the existing
require_premium dependency; the established localhost development bypass remains.

| Method | Path below `/api/scanner/research` | Behavior |
| --- | --- | --- |
| GET | `/package?universe=nifty50` | Last final plus latest attempt; partial only if no final |
| GET | `/packages/{id}` | Exact immutable market-data package |
| GET | `/history?universe=nifty50` | Metadata for up to 60 actual final sessions; latest final revision per session |
| POST | `/refresh` | Start bounded job; 503 without historical provider, 409 if busy |
| GET | `/jobs/{id}` | Owner-only job progress; other user sees 404 |
| GET | `/plans` | Latest revision of each caller-owned plan |
| GET | `/plans/{id}?revision=N` | Exact owned revision and current latest revision |
| POST | `/plans/{uuid}` | Create/revise with expected_revision; stale writes get 409 |

`/api/analysis/breadth-thrust` now returns actual saved research, with no synthetic
EMA formula, generated history or regime score. Its sole in-repo frontend consumer
was updated together. This is a response-contract change: release frontend and
backend together, and check any out-of-repo clients before deploying.

Plans bind package_id, setup_version, setup_id, source snapshot and original
session. A plan cannot be reassigned to a different thesis. The server validates
directional trigger/stop geometry, source membership, expiry and finite sizing
inputs. Quantity is min(stop-risk size, allocation cap size). Liquidity caps,
portfolio concentration and overnight gap stress are not implemented. Earnings
checks are user declarations labelled as such; provider event data is unknown.
Saving does not create an alert. Alerts and signal outcomes remain separate until
an exact-version integration is implemented and tested.

## Browser verification, 18 October 2026

Story: saved market package -> setup/chart -> private conditional plan -> reload
and immutable revision -> original context beside existing intraday cockpit.

`python tests/serve_swing_fixture.py` serves an isolated temporary SQLite database
on loopback port 9017. Its auth overrides and synthetic symbol TESTFIXTURE exist
only in this test harness. The app lifespan and production services are never
started. The fixture banner says synthetic data, not market research. The frontend
was run on localhost:3107 with the existing local-only proxy pointing to 9017.
Both test servers were stopped afterwards.

| Boundary | Evidence |
| --- | --- |
| UI -> package API -> SQLite | Package and source chart rendered; GET package 200 |
| Plan form -> API -> database | POST plan 200; quantity capped to 75 shares at fixture trigger 132 and 10% of 100000 capital |
| Database -> reload -> form | Browser reload retained revision 1, notes, trigger 132, stop 126 and expiry 2026-10-23 |
| Revision conflict/ownership | Unit tests cover stale revisions, wrong owner, wrong source and thesis reassignment |
| Revision 2 | Revised note saved; original trigger/stop preserved; plan list and edit form showed revision 2 |
| Daily/weekly chart | Both rendered using the same saved bars; weekly arithmetic independently tested |
| Browser shortlist | Add -> reload retained shortlist membership |
| Provider unavailable | Refresh returned 503; saved package, shortlist and plan remained visible |
| Cockpit handoff | Exact revision 2 loaded; original levels/expiry visible; missing live price stayed unavailable and planning-only |

The fixture does not serve global ticker or live intraday endpoints. Those return
404 in this isolated harness and are not evidence of a live feed regression or
live provider verification. Existing intraday regression tests are run separately.
The browser check covered desktop. Mobile, assistive technology and live-market
confirmation remain unverified. No exchange prices or strategy edge were verified.

Final checks: 59 targeted backend tests passed, including existing swing engine
and intraday monitoring regressions; 11 frontend tests passed, including existing
intraday priority checks. The final optimized webpack production build passed
and generated `/swing`; TypeScript and scoped ESLint passed. One existing
python_multipart deprecation warning and Node's module-type inference warning
were observed. No new runtime dependencies were installed. The saved-session
selector was added after browser verification and covered by package-history
unit checks plus the final production build.

## Remaining dependencies

Sector context reuses the configured sector map and discloses unclassified names.
There is no verified industry taxonomy: do not relabel sectors as industries or
invent Strong/Weak industry ratings. Participation/cycle history, RS percentiles,
earnings/fundamentals, mentor publishing and IPO/EP models need their respective
versioned input data. Shared detector-specific base/coil geometry, portfolio heat,
alert evaluation, fill-aware paper outcomes and signed cohort reconciliation also
remain open. The existing engine score is labelled uncalibrated, and its target
is labelled a policy objective with structural room unknown.
