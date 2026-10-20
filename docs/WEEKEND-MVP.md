# Private hosted MVP — Sunday, 25 October 2026

User confirmed a private hosted MVP for invited users on 20 October. Thanksgiving public beta remains separate. Sunday acceptance is a working hosted journey, not source/CI completion.

## Budget and hosting decision

Start with $0 hosting, per user decision on 20 October. The user reported submitting a Render Free deployment; live URL/build acceptance is pending. No paid activation is authorized under the current budget. Existing local SQLite/file storage on Free is ephemeral. External durable storage is a prerequisite for invited users to rely on saved plans; retain the restart/restore gate below. The paid-volume checklist is an alternative architecture, not an instruction to purchase a disk. See docs/RENDER-SETUP.md.

## Minimum journey

1. Invited confirmed-email user signs in; uninvited/anonymous users cannot access research APIs.
2. Open a saved US research package with date, feed, coverage and partial/final status visible.
3. Inspect a brief candidate, daily/weekly chart and source-linked SEC filings. Missing events remain unknown.
4. Save a conditional USD plan from final evidence, confirm it, reload the app and reopen the exact plan/source.
5. Inspect read-only earlier plan revisions without overwriting the current draft.
6. Refresh research with honest status/errors; retain saved evidence across backend restarts.

## Scope held for later

Verified upcoming earnings calendar, industry leadership, calibrated strategy edge, fill-aware forward outcomes, execution, billing and public signup are not weekend promises. Keep these limits visible. No fabricated sample data disguised as live data.

## Hosted acceptance checklist

- [ ] Dedicated US frontend project and protected/private access confirmed; no changes to original Alpha Radar deployments.
- [ ] Separate US Supabase project, confirmed-email/callback/recovery configuration and invited accounts verified.
- [ ] Backend US_INVITED_USER_IDS configured with actual provider user UUIDs; invited succeeds, uninvited/forged-header requests fail.
- [ ] US-only backend on one persistent local SQLite-compatible volume; DATA_DIR retained through restart; online backup/restore rehearsed.
- [ ] Frontend server proxy targets the HTTPS backend; browser cannot receive provider secrets.
- [ ] Alpaca access and permission for the actual invited audience/display confirmed before provider data is exposed.
- [ ] Operator-approved SEC_USER_AGENT and aggregate provider request limits configured.
- [ ] Real hosted desktop/mobile/keyboard journey above exercised with dated evidence; status/reload failures recorded.
- [ ] Rollback and outage behavior checked before distributing the private URL.

## Current inspection

Vercel connector is available; its project listing has no USMarket project. No frontend/.vercel project link exists. Local frontend Supabase URL/public-key values are empty. These observations do not establish the state of other cloud accounts. No project, identity, secret, deployment or invitation email was created during this inspection.

## Invitation boundary

All protected US routes continue to verify the bearer token with Supabase and require confirmed email. They now additionally require the provider user UUID in server-only US_INVITED_USER_IDS. Empty, malformed or oversized configuration denies access (503); a verified uninvited identity receives 403. No request header, hostname or frontend signup switch can grant invitation. Identity membership is checked on each request; running workers must receive configuration updates consistently for revocation. No response exposes the list. The loopback preview's explicit test dependency override remains development-only.

This is application access control, not a substitute for Vercel protection, provider signup policy, invite provisioning or data-display permission. No real users were invited. Existing valid tokens do not override removal from the configured invitation list. Tests use synthetic provider users; actual hosted invitation/revocation acceptance remains unchecked.


## Operator preflight

Run from backend in the intended hosted runtime with its actual environment already loaded:

```powershell
python -m app.services.us_readiness
python -m app.services.us_readiness --check-storage
```

The command emits only named booleans, probe status and unverified gates, never environment values, user IDs, paths, tokens or provider response text. Nonzero exit means missing/invalid checked configuration or a failed requested probe. It requires an explicit absolute DATA_DIR. The optional probe creates a temporary sibling database in that directory using the imported repository schema, writes a synthetic row, performs SQLite online backup/integrity/read checks, and cleans up normally without touching real plans/research/refresh locks. Interrupted cleanup can leave a private temporary probe directory for operator review. No network requests or real provider data are used.

Presence checks do not certify public-key type, credential correctness, separate-project identity, SEC contact-policy compliance or invitation provisioning. A successful probe does not prove a persistent disk is mounted or backups are scheduled. Explicitly unverified gates remain in the report even when configuration_ready is true. No public readiness endpoint is added; this is an operator CLI, not a deployment approval. Execute real hosted acceptance separately.

Real plan/job database backup tooling and offline restore rehearsal steps are now in docs/US-BACKUPS.md. No actual runtime backups were taken by the source implementation or tests.


## Workspace invitation check

A confirmed browser session now waits for GET /api/us/research/access before mounting research panels. The endpoint reuses the same strict provider/invitation dependency as data routes and returns no user ID, email or invitation list. Failed, malformed or wrong-market responses keep panels unmounted with generic retry/sign-out feedback. Account IDs key the check panel; cleanup ignores late responses. Recovery and unauthenticated navigation retain priority.

This is UX gating only. Every backend request still checks the current token and configured invitations independently. A prior UI grant does not override server-side revocation. The local preview endpoint uses its explicit test dependency override, never hostname trust. Tests use mocked transport/provider identities; real hosted invitation and recovery acceptance remain open.


## Private HTTP cache policy

The hosted API sets `Cache-Control: private, no-store`, legacy no-cache headers and `Vary: Authorization` on `/api/us` responses, including handled authentication, validation and missing-route errors. Existing Vary dimensions are preserved. Compliant HTTP caches must not store these private responses across account changes. This does not erase downloaded content or replace per-request ownership checks. Hosting/proxy acceptance must verify these headers reach the browser without an overriding CDN cache rule; source tests do not establish that evidence.


## Interim private plan download

Authenticated GET `/api/us/plans/export` downloads all revisions belonging to the verified account, ordered by plan ID/revision, with exact saved source identities and an export timestamp. It accepts no owner selector, excludes other accounts and does not modify records. More than 10,000 revisions fails rather than silently truncates. Keep the downloaded JSON private; notes and conditional research are sensitive. Research packages are not included, and no import/restore facility or durable hosted storage is implied. A download must happen before ephemeral storage disappears; it cannot recover already-lost data. External persistence remains the next storage gate.
