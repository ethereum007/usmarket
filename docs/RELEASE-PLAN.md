# Public beta release plan

Owner: Kiran Dutta. Repository: ethereum007/usmarket. Target: US Thanksgiving, Thursday 26 November 2026. Aim to complete the public launch rehearsal by 23 November and ship by 25 November; reserve the holiday as contingency, not a first live-market test.

## Product promise

A US swing-research workspace that answers: what is leading, why a stock deserves attention today, which evidence supports the setup, what invalidates the thesis, which events change the risk, and what happened afterward.

First release is research and paper review. No order execution, guaranteed returns, unsupported signal win rates or automated personalized investment advice. A public beta is not an excuse for incorrect timestamps, exposed accounts or fabricated evidence.

## Working method

- GitHub is the source of truth. All finished increments, acceptance evidence and blockers belong in this repo's commits and issues.
- A 30-minute thread continuation cadence selects one highest-priority unblocked increment. Reconcile remote/local state, implement, test, document and push. Do not overlap runs or merely create progress messages.
- Reuse existing imported Indian capabilities according to INDIA-US-PARITY.md. Port data contracts and market assumptions before UI labels.
- Keep product promises tied to evidence. Clearly mark missing, stale, partial, historical and uncalibrated data.
- Do not buy data, alter credentials or publish a public service before the concrete required entitlement/deployment decisions are resolved.

## Sequence and dates

| Window | Deliverable | Exit evidence |
|---|---|---|
| 20–26 October | Capability map, US auth boundary, CI, release backlog; data-provider/display rights decision | Reproducible CI; unauthenticated/spoofed-host rejection; no secrets or Indian runtime startup |
| 27 October–2 November | Durable packages, plan revisions, user isolation, universe/instrument and calendar contracts | Concurrent revision/ownership tests; backup-and-restore rehearsal; session/corporate-action fixtures |
| 3–9 November | Verified earnings/catalysts, industry context and evidence-first daily workflow | Source-linked events with known-as-of times; honest missing-data states; daily research story works end-to-end |
| 10–16 November | Forward paper review, reliability runs, operator diagnostics | At least 10 completed observed market sessions where feasible; failures recorded, no synthetic substitution; outcome cohorts distinguish discovery/trigger/fill |
| 17–19 November | Feature freeze, private acceptance testing and major fixes | User task checks, mobile/keyboard checks, accessibility risks resolved or documented; no open release-critical defects |
| 20–23 November | Production dress rehearsal | Approved data rights; hosting/env/auth; representative load; storage restore; rollback and outage drill; release signoff record |
| 24–26 November | Public beta | All gates below satisfied; otherwise explicitly report gate failure and defer the unsafe part rather than claiming success |

## Release gates

- [ ] G1 Data rights: provider confirmation/contract covers intended public display, derived outputs, exports, audience and latency. Personal API credentials alone are not clearance.
- [ ] G2 Identity: separate US auth, real tokens verified server-side, no Host/Origin privilege bypass, no cross-user plan/note access, no India pricing/onboarding leakage.
- [ ] G3 Storage: hosted shared research/plan state, idempotent packages, immutable revisions, concurrency behavior, backups/restore and retention tested.
- [ ] G4 Data correctness: stable instrument identity, split/adjustment lineage, aligned benchmark sessions, explicit universe coverage, holiday/early-close and missing-provider behavior.
- [ ] G5 Research usefulness: evidence-linked catalyst/events, verified earnings proximity, industry/market context, clear thesis/invalidation and uncalibrated score disclosures.
- [ ] G6 Validation: meaningful regression/contract tests; market-open behavior with source timestamps, disconnects/recovery and partial publication observed; no unsupported performance claims.
- [ ] G7 Operations: deployment smoke checks, rate limits, secret handling, error observability, stable shared storage, outage handling, privacy/terms/data-retention decisions and rollback.
- [ ] G8 Product acceptance: first-time user can find a stock, inspect evidence, save a plan, reload it and review the outcome; desktop/mobile and keyboard paths verified.

## Decision log

- Existing Alpaca keys have historical SIP and live IEX access in earlier tests. Real-time SIP was denied. Market-open coverage and commercial distribution remain explicit decisions/evidence, not assumptions.
- Shared persistence provider/hosting, separate US Supabase configuration, public product name/domain and eventual pricing are open. Continue provider-independent work while these are resolved.
- Technical release readiness and trading edge are different claims. Do not imply a profitable strategy because software tests pass.

Date reference: https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/
Provider rights reference: https://alpaca.markets/support/redistribute-alpaca-api

## Refresh failure boundary (20 October 2026)

US refresh jobs return a fixed failure message for all exception types, including validation errors. Exception text is not a safe public diagnostic: a provider adapter or storage validator may include credentials, response fragments or local paths. Regression tests inject ValueError, RuntimeError and OSError failures, assert owner/exception details are absent, then verify a subsequent refresh completes after the failed worker releases its lock.

This does not satisfy durable job coordination or operator observability. Durable last-recorded job status and exclusion between cooperating API workers on one SQLite-compatible local volume are now implemented (docs/US-REFRESH-STATUS.md). A later exclusive request can now reconcile abandoned queued/running observations as interrupted with completion unknown. Hosted/multi-host coordination and crash/publication outcome reconstruction stay open in issue #4. Market-open and hosted acceptance gates remain open.
