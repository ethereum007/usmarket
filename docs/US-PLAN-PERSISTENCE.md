# US plan persistence — first API increment

Issue #4 remains open. This increment ports the imported `swing_repository` ownership, immutable revisions and `BEGIN IMMEDIATE` / `expected_revision` concurrency semantics to US plans. It does not introduce another plan engine.

## API contract

All endpoints require the independent US bearer-token verifier. The authenticated identity supplies the owner; clients cannot submit an owner, fill state or claimed earnings clearance.

- `GET /api/us/plans`: latest revision of each plan owned by the caller.
- `GET /api/us/plans/{uuid}?revision=1`: exact owned historical revision; missing/foreign revisions return 404.
- `POST /api/us/plans/{uuid}`: create with `expected_revision: 0`, or append using the latest revision number. A stale revision returns 409. Another user's plan cannot be overwritten.

Synthetic request (not a real setup or recommendation):

```json
{
  "expected_revision": 0,
  "package_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "setup_version": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "trigger": 100,
  "stop": 95,
  "expiry": "2026-11-25",
  "exit_policy": "Review the stated invalidation",
  "notes": "Synthetic API example",
  "state": "draft",
  "capital": 10000,
  "risk_pct": 1,
  "allocation_cap_pct": 20
}
```

The referenced package must actually exist, be final, be US research denominated in USD and contain the exact setup version. The server derives symbol, direction and source snapshot from that evidence. A revision cannot change its package, setup/version, snapshot, symbol or direction; a new source thesis requires a new plan UUID. Notes, prices, expiry, policy and planning state can be revised without overwriting history.

Stops must invalidate the selected direction. Expiry cannot precede the source session; active plans cannot already be expired in New York. Whole-share quantity is the smaller of stop-risk capacity and allocation capacity, using decimal arithmetic. Zero capacity is recorded honestly as zero. Fees, gaps, slippage and liquidity are unverified. Bearish plans additionally disclose unverified borrow and short-sale constraints. No plan arms an alert or places an order; `filled` remains false and earnings/catalysts remain unknown.

## Storage boundary

Plans use `DATA_DIR/us-plans.sqlite3`, separate from inherited Indian research storage. The reused repository accepts an explicit database path and immutable-field policy; its default behavior remains compatible with imported callers. Revisions are committed transactionally, with timestamps in UTC and expiry semantics in America/New_York. Storage failures return a sanitized 503 and do not confirm a save.

SQLite persists across connections and application restarts **only when the file is retained on a persistent volume**. This is not yet a shared hosted store, and must not be treated as durable on ephemeral/serverless filesystems. Source research remains in the existing immutable JSON package store. There is no cloud storage deployment or credential change in this increment.

## Workspace integration

The US workspace now has a Plans section and navigation link. It adapts the imported swing editor flow: final setup -> explicit USD risk/expiry/notes -> private save -> reload account plans -> open exact revision and original source chart -> append revision. Existing plans stay pinned to their original evidence while other stocks/packages are browsed. Changing authenticated owner remounts the plan panel to clear prior account state. Browser-local shortlist/notes stay separate; no automatic import occurs.

Conflict/timeout responses do not confirm a save or replace the draft. Users can reload the saved list, then explicitly reopen the latest revision; reopening replaces unsaved edits. Retries retain the same new-plan UUID to avoid duplicate records after an ambiguous timeout. A response from an unmounted editor cannot replace another source editor. Plans have no inferred fills or verified event clearance.

Frontend checks render actual TSX and execute submit/API functions with mocked transport; they cover request allowlists, final-source guards, immutable source/revision verification, USD disclosures, duplicate submission, timeout/conflict and unmount behavior. These are not real browser or hosted identity/storage acceptance tests.

## Evidence and remaining work

Tests use synthetic packages and temporary databases. They exercise fresh app/client reloads, owner read/write isolation, real concurrent writers, immutable old revisions, evidence binding, invalid/spoofed inputs, New York midnight expiry, decimal sizing, storage failure and SQLite online-backup restoration of both revisions and ownership. Backup tests prove the local database mechanism; they do not establish production backup schedules, encryption, retention, access controls or recovery time.

For backups of a live SQLite database, use the SQLite online backup API; copying only the main file can omit WAL commits. Keep backups private and outside Git. A production operator runbook and hosted restore rehearsal remain required.

Open issue #4 gates:

- Validate the integrated flow in a real browser and hosted US account environment. Browser-local shortlist/notes are **not automatically migrated or account-synced** by this change.
- Choose and validate shared hosted storage, immutable package persistence and multi-worker refresh coordination.
- Demonstrate real hosted account isolation, backups/restore, retention and outage behavior.
- Add the daily plan/outcome journey and browser/mobile acceptance before claiming completion.


## Read-only revision review

Opening saved evidence now includes bounded older/newer revision navigation for that exact plan. Each requested revision reuses the existing owner-authenticated revision API and original-package/setup verification. Out-of-range or mismatched revisions are rejected. The history panel displays saved trigger/stop, expiry, state, notes and exit policy with ET write time; it never writes, replaces the current draft or opens a different thesis. Failed/late reads preserve the displayed revision; panel keys and cleanup isolate plan/revision changes. This reviews thesis history only, not triggers, fills, returns or forward outcomes. Real browser and hosted lifecycle acceptance remain open.
