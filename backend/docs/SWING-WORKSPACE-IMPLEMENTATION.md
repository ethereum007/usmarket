# Swing workspace implementation ledger

18 October 2026. Status: research MVP and persistent conditional plans implemented locally; full roadmap remains incomplete.

## Source reconciliation

The initial audit checkouts were stale: frontend `7b06d479`, backend `c2d25a15`.
Remote main was fetched read-only. Implementation now lives in isolated sibling
checkouts, on `swing-foundation-current`, based on:

| Repository | Base SHA | Checkout |
| --- | --- | --- |
| charantrezofin/alpha-radar-frontend | 2e8b217d76b8c850b91e1f008224badffd46dbf5 | G:/Alpha Radar New/alpha-radar-frontend-swing |
| charantrezofin/alpha-radar-backend | 65369485f89e8cce697fe9408b87f09340b540de | G:/Alpha Radar New/alpha-radar-backend-swing |

The frontend's main deployment workflow succeeded for that SHA:
https://github.com/charantrezofin/alpha-radar-frontend/actions/runs/38141883837
The current backend main.py health handler matches the live response's field
names (kiteConnected, redisConnected and instrument cache fields). The older
routes/health.py handler was misleading because main.py registers its own handler.
No backend deployment record or check run was returned for the current main SHA;
the latest two listed backend deployment runs failed and refer to older commits.
Matching response shape is supporting evidence, not proof of a deployed SHA.
Runtime backend SHA and applied database migrations remain unverified. No secrets,
broker settings, production configuration, migrations or orders were changed.

The original checkouts contain user TopNav/ORB work and backend main/runner work.
Those are not part of this increment. Contribution rules require founder review;
do not push main. No PR or deployment has been made.

## Existing implementation map

Rechecked against fetched main, rather than assuming the audit checkout was current.

| Brief gaps | Reuse | Remaining work |
| --- | --- | --- |
| G1–G3 | frontend rrg/, sector views; backend RRG services | Versioned industry taxonomy, denominators, actual historical breadth, participation and cycles; sector classifications are not a verified industry taxonomy |
| G4–G5 | engines/cpr/swing_detector.py, VCP and NR engines, routes/scanner.py; SwingContent.tsx | Shared base geometry, source bars and persistent breakout/pullback identity |
| G6 | stock universe/IPO instrument support | Specialist short-history base policy and evaluation |
| G7 | abnormal momentum/radar services and AbnormalMovesContent | Known-as-of catalyst and earnings linkage; no new detector justified yet |
| G8 | benchmark_rs_20/60, RRG | Percentile history with explicit benchmark, universe and eligibility; benchmark fallback needs repair |
| G9–G10 | current frontend latest-updates announcement feed | Announcements are not verified earnings dates or period-aligned financial statements; integrated event/fundamental provider still needed |
| G11–G12 | alerts and existing authentication/Supabase | Tenant-owned notes, immutable plan revisions, mentor publishing ownership |
| G13 | SwingContent, radar-trade, CandlestickChart and current PulseWorkspace | Dedicated daily/weekly terminal, persistent shortlist and shared plan context |
| G14 | session_cache, snapshots and swing signal_fires | Immutable universe/session packages, appearance history and export |
| G15 | guide/help shell | Setup/rejection-linked lessons and reviewed content |

Existing signal_validator and Performance/Strategy Memory must be reconciled;
eight playbooks were visible in the audit's final state. Do not describe all swing
outcomes as absent. Trigger/discovery records are not fills.

## Sequence and acceptance gates

1. **Foundation:** reconcile source/schema; suppress unsupported measurements;
   actual completed-bar breadth, returns and trailing extremes; durable EOD bars
   and atomic packages; scope identity; canonical lifecycle; independent execution
   gates; structural room distinct from policy targets; signed cohort statistics.
   Accept only with fixtures, missing-provider cases, closed-session checks and
   matched queue/detail/statistics records.
2. **Industry Leadership:** point-in-time membership, eligible/available counts,
   historical industry RS and breadth, normalized participation, new/fading groups.
   Unknown classification cannot become leadership. Reuse RRG as a separate view.
3. **Research Terminal:** daily/weekly chart and text geometry from existing
   scanners, one selected setup version, next/previous shortlist and source package.
   Different entry/stop theses remain selectable, not merged into one geometry.
4. **Conditional Plans:** tenant-isolated database migration and API, immutable
   revisions, trigger/structural stop/exit policy/expiry, notes and risk caps;
   alerts link exact plan versions. Test cross-user access and concurrent revisions.
5. **Confirm and review:** hand saved plan context into intraday monitoring;
   live tape cannot override invalidation. Triggered is distinct from filled;
   expired/invalidated outcomes and fill-aware paper records remain separate.
6. Add IPO/earnings continuation, RS history, financials/events, mentor brief,
   portfolio heat and lessons after the required data and validation gates.

## Implemented in this increment

* Queue direction, phase and price geometry refer to the primary thesis. Opposing
  votes still yield WAIT_CONFLICT. Normalization preserves UNKNOWN lifecycle.
  Server-computed research_phase is reused in the frontend's selected thesis.
* Explicit strict/blended warm scan modes. N50/N100 frontend requests are strict.
  Snapshot payloads retain scope version, requested universe and attempted symbols.
  The UI labels attempted symbols separately from candidates; old snapshots show
  unknown scope instead of borrowing the selector's universe. These are attempted
  members, not proof of historical-data coverage or point-in-time membership.
* Swing/replay handoffs carry researchOnly and unverified freshness. A mandatory
  cockpit gate rejects missing/stale setup age, quote receipt, spread, thin
  liquidity, invalid stop geometry, closed regular hours and feed errors before
  any ranking score can yield entry guidance.
* Browser scans use provider history without manufacturing a daily quote candle.
  Server quote merges require a recent session timestamp and regular configured
  hours; weekends, configured holidays, missing/future/stale timestamps and
  post-close quotes preserve original history. No special-session calendar is
  inferred. A provisional package contract still needs implementation.
* Current main had already removed the stale checkout's generated breadth
  fallback. Preserve that upstream repair. This increment additionally withholds
  breadth regime guidance when the API declares estimated EMA breadth, because
  those numbers still come from daily-pressure proxies.

## First-checkpoint gaps (superseded in part by the second increment below)

The breadth API itself still computes proxies; suppression is containment, not an
actual historical calculation fix. Durable bars, last-final EOD publication,
setup/plan identity, industry taxonomy/board, research terminal, persistent plans
and alerts are not implemented here. Scores still saturate; 2.2R policy targets
still need honest structural-room handling. Outcome cohort/sign reconciliation
and overdue recovery remain open. The quote gate checks receipt time, not a new
verified exchange session service; regular-hours checks do not establish holiday
or special-session eligibility in the frontend. Backend-only execution consumers
must not treat this UI gate as authorization to trade. No browser visual QA has
been performed for this increment.

## Verification

Run in the new checkouts, not the stale audit directories:

```text
FE: npx tsc --noEmit
FE: node --test app/lib/execution-readiness.test.mjs tests/intraday-priority.test.cjs
BE: python -m pytest tests/test_swing_foundation.py tests/test_swing_warm.py tests/test_swing_signal_validation.py tests/test_scanner_service.py tests/test_swing_detector.py tests/test_intraday_monitoring.py -q
```

Final upstream-port results: TypeScript passed; frontend 9/9 tests passed; backend 44/44 tests passed (one existing python_multipart deprecation warning). Both diffs pass git whitespace checks.

Tests exercise opposing strategies, missing lifecycle, strict membership, absent
execution fields, long/short stop geometry, stale/weekend/post-close candle
merges, existing swing behavior and current intraday monitoring. Applied schema remains unverified.


## Second increment: completed-session research and private plans

Implemented `/swing` with sector coverage, existing-detector research playlist,
daily/weekly source chart, persistent browser shortlist/export, private notes and
conditional plans with immutable revisions and optimistic concurrency. Cockpit
handoff preserves exact plan revision and original levels. A durable SQLite source
store and atomic package publication replace breadth proxies with actual historical
EMA/return/extreme calculations. Missing/misaligned benchmark RS is null in both
the new pipeline and the existing scanner. No alert is armed and no fill inferred.

See [SWING-RESEARCH-OPERATIONS.md](SWING-RESEARCH-OPERATIONS.md) for API/data contracts,
test evidence, ownership rules, response-contract compatibility and remaining gaps.
Industry taxonomy is a concrete unavailable input; sector coverage is disclosed
as sector coverage. Production backend SHA and applied schema remain unverified.
No production configuration was changed and no deployment was made.
