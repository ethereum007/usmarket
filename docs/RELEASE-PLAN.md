# Public beta release plan

Owner: Kiran Dutta. Repository: ethereum007/usmarket. Target: US Thanksgiving, Thursday 26 November 2026. Aim to complete the public launch rehearsal by 23 November and ship by 25 November; reserve the holiday as contingency, not a first live-market test.

## Weekend milestone

Private hosted MVP for invited users by Sunday, 25 October 2026, confirmed by the user on 20 October. Execute docs/WEEKEND-MVP.md before adding broader features. Private access and actual display permissions still apply; source tests alone do not satisfy hosted acceptance.

The 25 October target was missed without hosted acceptance. The gate remains failed; no revised private-MVP deadline is assigned. The user supplied replacement project apidhmrlawbjvisnadht on 29 October after the old project was inaccessible. The user approved the replacement bundle on 29 October; all six migrations were applied in one transaction and all nine structural security checks passed. Runtime flags remain unchanged; real-account and hosted persistence acceptance remain pending. Continue independent source work. See docs/SUPABASE-ACTIVATION-REVIEW.md; approval does not enable storage flags or establish hosted acceptance.

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

## Current hosting constraint

20 October: user selected $0 initial hosting and reported deploying a Render Free preview. Build/live URL remains unverified. Paid compute/disk activation is deferred. Current SQLite/file repositories cannot satisfy restart persistence on Free; prioritize external durable storage adaptation before invited-user saved-plan acceptance. Preserve immutable revisions, owner isolation and publication/refresh coordination contracts. Do not treat a running preview as the weekend MVP gate passing.

## Decision log

- Existing Alpaca keys have historical SIP and live IEX access in earlier tests. Real-time SIP was denied. Market-open coverage and commercial distribution remain explicit decisions/evidence, not assumptions.
- Shared persistence provider/hosting, separate US Supabase configuration, public product name/domain and eventual pricing are open. Continue provider-independent work while these are resolved.
- Technical release readiness and trading edge are different claims. Do not imply a profitable strategy because software tests pass.

Date reference: https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/
Provider rights reference: https://alpaca.markets/support/redistribute-alpaca-api

## Refresh failure boundary (20 October 2026)

US refresh jobs return a fixed failure message for all exception types, including validation errors. Exception text is not a safe public diagnostic: a provider adapter or storage validator may include credentials, response fragments or local paths. Regression tests inject ValueError, RuntimeError and OSError failures, assert owner/exception details are absent, then verify a subsequent refresh completes after the failed worker releases its lock.

This does not satisfy durable job coordination or operator observability. Durable last-recorded job status and exclusion between cooperating API workers on one SQLite-compatible local volume are now implemented (docs/US-REFRESH-STATUS.md). A later exclusive request can now reconcile abandoned queued/running observations as interrupted with completion unknown. Hosted/multi-host coordination and crash/publication outcome reconstruction stay open in issue #4. Market-open and hosted acceptance gates remain open.

## 19 November acceptance checkpoint

The feature-freeze checkpoint has no completed hosted product acceptance evidence. G2 identity, G3 storage and G8 product acceptance remain open. Required inputs are the dedicated private frontend URL and two approved controlled test accounts with an authorized way to exercise their sessions. Keep credentials outside issues and source.

The approved replacement schema was applied once on 29 October. Structural checks and disposable restore CI have passed. They leave actual Supabase gateway isolation, hosted sign-in/research/save/exact reopen/backend restart and controlled backup/restore to be exercised. Storage flags stay off until controlled acceptance.

Source verification through 19e6015b950b89221a37a15d784b2abb66ae9b14 passed CI run 44537333131. The 19 November anonymous hosted probe recovered after initial transport failures and reported backend revision 82240f158e3d6fb1d029300953a30ebbd43fd0c3. The dated results are in US-HOSTED-ACCEPTANCE.md. Reliability acceptance remains open in issue #9.

The 25 October private MVP target remains missed without hosted acceptance. No revised private deadline is assigned. Public beta remains targeted for 26 November, subject to all release gates. Issue #10 tracks the incomplete product checkpoint, and issue #4 tracks hosted persistence acceptance.

## 24 November rehearsal checkpoint

The 23 November rehearsal deadline passed without completed hosted acceptance evidence. This is a missed release checkpoint. G2 identity, G3 storage and G8 product acceptance remain open: controlled two-account isolation, hosted sign-in/research/save/exact reopen/backend restart and backup/restore have not been demonstrated. The private frontend URL and two approved test accounts with an authorized session-access method remain required inputs.

Source verification at 925a323ef7fc77e797d3f3a70082cc3d669add97 passed full CI 45064281876, including disposable PostgreSQL restore. It does not replace the missing hosted rehearsal. Storage flags remain off; the approved six-migration bundle is not replayed. The 25 October private MVP target remains missed without hosted acceptance, with no revised private deadline. The 26 November public beta target remains subject to all release gates and is not an authorization to launch with these gates open.

## 27 November beta target outcome

At 05:06 UTC on 27 November, the 26 November target date has ended in America/New_York without completed public beta acceptance evidence. The public beta target was missed, following the missed 25 October private MVP and 23 November rehearsal. No replacement deadline is assigned. Source CI and structural database checks do not establish hosted acceptance.

G2 identity, G3 storage and G8 product acceptance remain open, as do data-display rights and the other release gates. The private frontend URL and two approved controlled test accounts with an authorized session-access method remain required. Actual hosted isolation, sign-in/research/save/exact reopen/backend restart and controlled backup/restore remain unproven. Storage flags remain off; no migration replay, paid resource or public launch is authorized by the elapsed target. Continue bounded source work while these hosted inputs are pending.

## Bounded identity-provider responses

US token verification now streams the dedicated identity-provider response under the existing five-second total deadline. It retains at most 256 KiB of decoded JSON input, checks each chunk before appending and closes the response on rejection or cancellation. Missing or compressed Content-Length does not bypass the decoded-byte check. Non-success statuses are handled without consuming their bodies. Oversized responses return fixed authentication-unavailable feedback and grant no identity. This caps retained JSON input; it does not claim a bound on HTTPX decompressor internals.

Synthetic transport regressions cover oversized plain and gzip responses, early plain-stream termination, response closure, a subsequent valid verification, the exact accepted size boundary and a stalled body deadline. Existing invitation, target-project, cancellation and cache behavior remain covered. No account, credential, invitation or storage flag changed. Real hosted two-account isolation and persistence acceptance remain open in #2, #4 and #10; both missed release targets remain recorded above.

## Strict JSON equality in disposable restore verification

The disposable PostgreSQL restore verifier now reuses the strict JSON comparator for all stored columns and owner RPC list results. Cursor tuples are unwrapped before recursive comparison, so a restored nested boolean cannot compare equal to numeric 1/0. Unknown nulls remain unchanged. Synthetic verifier regressions reproduce substitutions that ordinary Python equality accepted, and CI runs them before the actual disposable dump/restore rehearsal. Thirty focused restore-verifier and SQLite-backup tests passed locally.

This improves the source verification gate only. It does not provide the missing real Supabase accounts, hosted restart/persistence or operator backup/restore acceptance. No source migration, hosted data, account, credential or storage flag changed. The missed 25 October private MVP and 26 November beta targets remain recorded without a replacement deadline. Refs #4 and #10.

## SQLite backup verification deadline

The local SQLite backup utility now applies its existing 30-second deadline to schema and integrity verification as well as the online copy. A SQLite progress handler interrupts long verification VM work, with explicit checks around verification for short queries. A synthetic 5,000-row regression expires the clock as the integrity scan starts, confirms interruption removes only the newly created backup, preserves source bytes and proves a later independent attempt succeeds. All 27 SQLite-backup tests passed locally.

This is a cooperative SQLite copy/verification deadline, not a hard bound on filesystem open/fsync or OS stalls. It does not cover remote Supabase backups, research JSON retention or actual hosted restore acceptance. No hosted files, accounts, credentials, migrations or storage flags changed. The missed private MVP and public beta targets remain recorded without a replacement deadline. Refs #4 and #9.
