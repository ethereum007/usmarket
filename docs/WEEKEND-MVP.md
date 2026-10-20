# Private hosted MVP — Sunday, 25 October 2026

User confirmed a private hosted MVP for invited users on 20 October. Thanksgiving public beta remains separate. Sunday acceptance is a working hosted journey, not source/CI completion.

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
