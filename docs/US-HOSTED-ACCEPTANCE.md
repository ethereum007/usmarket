# Controlled hosted acceptance — preparation, not signoff

The 25 October private MVP gate remains failed. Public beta target remains 26 November 2026. The reviewed six migrations were applied once to US Markets Free project apidhmrlawbjvisnadht on 29 October (evidence commit 7b9cb86); nine structural checks passed. Do not replay them. The superseded etwmtakotrqlwwzttekc project must receive no credentials or changes.

## Inputs still needed

- Two user-designated email addresses for separate acceptance identities, with mailbox access controlled by the user. No passwords, bearer tokens or keys in chat, issues or Git.
- The dedicated private frontend HTTPS origin, or confirmation that it has not been created. Do not guess a callback URL or reuse an original Alpha Radar deployment.
- Concrete action-time authorization for the specific account provisioning, auth configuration and credential destinations before those changes. Migration approval alone does not cover them. No invitation email is sent without explicit authorization.

## Configuration review before changes

Record project identity and Free plan, the proposed frontend origin, exact confirmation/recovery callbacks used by the source, frontend/backend environment destinations and the two designated accounts. Keep public signup UI off. Review provider signup/confirmation policy separately from that UI flag. Preserve existing accounts and configuration; do not reset user passwords. Use each user's own sign-in session; no service-role key is needed by the three storage adapters.

Backend target: SUPABASE_URL at the dedicated project origin and its public SUPABASE_ANON_KEY. Frontend target: NEXT_PUBLIC_SUPABASE_URL at that same origin and its public NEXT_PUBLIC_SUPABASE_ANON_KEY. The frontend proxy destination must be the intended US API. US_INVITED_USER_IDS is server-only, with verified provider UUIDs. No secrets or invitation list in public build output or evidence. Check callback paths against the current signup/recovery source before saving configuration.

## Controlled test sequence

1. Verify each real confirmed identity against the dedicated provider and its own session. Verify anonymous, invalid, unconfirmed and uninvited access denial. Record only pass/fail and sanitized errors.
2. Verify invitation removal denies the next request, without assuming sign-out revokes an existing token. Restore access only within the approved acceptance scope. Account switching must clear prior private UI state.
3. Rehearse storage with the approved accounts in an explicitly scoped test runtime using all three remote adapters together. Product runtime flags stay off. Review the test-runtime mode change and data writes before execution; never infer permission from this checklist. No migration replay, public rollout or paid resources.
4. Account A creates research and a plan revision using exact final source identities. Account B cannot read, revise, export or interrupt A's records. Repeat in the opposite direction. Do not publish payloads or use fabricated live provider evidence.
5. Verify identical retry, stale expected_revision conflict, immutable package/source binding, one-active-job admission and atomic completion/interruption behavior through real Supabase gateway sessions. An ambiguous timeout remains unconfirmed until exact records are reread.
6. Restart the scoped application process and reopen exact packages/plans under their original owners. A successful source test, SQL catalog check or browser cache is not restart-retention evidence.
7. Rehearse a private backup and restore into an explicitly approved isolated destination with the same access boundaries. Never overwrite the dedicated project or original Alpha Radar databases. A plan export alone is not a complete research backup.
8. Exercise the private hosted frontend sign-in/research/save/reopen journey, account switching and recovery on desktop/mobile/keyboard, with private no-store responses reaching the browser. Record failures and limitations. Confirm data-display rights before expanding audience.

## Evidence and exit

Record date, exact source revision, approved targets/modes, check names and pass/fail, with sensitive output retained privately. Do not store emails, UUID lists, tokens, keys, notes or runtime market data in the public repository. A test failure leaves the gate open. Obtain a separate reviewed rollout decision after acceptance; this checklist does not authorize turning product flags on, opening signup or publishing an incomplete service. Issues #2, #4, #9 and #10 remain open until their own acceptance evidence is complete.


## Frontend proxy destination boundary

Source configuration now permits ALPHA_API_PROXY_URL only at the dedicated HTTPS usmarket.onrender.com origin (default port/443), or HTTP localhost/127.0.0.1 outside production mode for development. Production mode rejects loopback destinations. Trailing slash is normalized; credentials, paths, query/fragment, whitespace/backslash, lookalikes and unreviewed hosts fail with a sanitized configuration error before rewrites are produced. Missing configuration produces no proxy. Custom destinations require explicit source review; do not point this frontend at inherited Alpha Radar services. Tests exercise allowed and rejected destinations. No environment value or hosted deployment was changed, and this does not verify reachability, private access or hosted acceptance.


## Anonymous hosted boundary observation — 30 October 2026

A credential-free headers-only GET observed health 200 and both /api/us/plans and /api/us/research/packages returning 401 with a Bearer challenge, private/no-store and Vary: Authorization. The initial twenty-second attempts were transport-unavailable; a subsequent retry passed. No cause or continuous availability is established by that retry. No response body, identity, market data or credential was read. Deployed source revision is unverified; this does not satisfy sign-in, two-account isolation, save/reopen/restart or backup/restore acceptance. Flags remain unchanged/off and the missed 25 October gate stays failed.

Repeat deliberately from backend with python -m app.services.us_hosted_probe. The tool uses a fixed dedicated Render origin, sends no credentials, follows no redirects and never consumes response bodies. It reports only status/check booleans and observation time, returning failure for unavailable or mismatched boundaries. Synthetic CI tests intercept HTTP and verify denial/header failures, redirect rejection and unread private bodies; CI never runs this probe against the live service.
