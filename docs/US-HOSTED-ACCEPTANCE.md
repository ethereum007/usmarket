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


## Browser connection policy scope

Production CSP connect-src now permits same-origin API traffic and only the dedicated replacement Supabase HTTPS/WebSocket host. Inherited wildcard Supabase and loopback service allowances are removed from production; development retains the previous local allowances. Configuration tests exercise both modes and reject old-project/wildcard destinations in the generated policy. Other CSP directives are unchanged. This is source policy evidence, not proof that a hosted frontend serves these headers or that browser sign-in works. No hosted policy, credential or flag was changed.

The anonymous probe sends standalone requests with redirects and client authentication disabled. Cookies issued by one endpoint and headers configured on the client are excluded from subsequent requests. The synthetic probe tests exercise these boundaries. The 25 October private MVP target remains missed, with hosted account and persistence acceptance pending.

The US API cache middleware preserves repeated upstream Vary fields when applying private, no-store. Regression tests cover upstream negotiation fields, an existing Authorization token and wildcard variation. This source check leaves hosted acceptance pending.

The US API rejects repeated Authorization headers and comma-joined credentials with a Bearer challenge before calling the identity provider. Synthetic request tests cover both forms. Hosted identity and persistence acceptance remain pending after the missed 25 October private MVP target.

The identity verifier rejects explicitly malformed anonymity values, including null, numbers and strings. Boolean true remains denied, and an omitted field retains compatibility with existing provider responses. Synthetic invited-user tests cover these cases.

The shared browser API client requests no-store and rejects redirects for private US calls, including same-account session retries. Synthetic GET and POST tests verify both attempts. Hosted account isolation and persistence acceptance remain pending.

The anonymous probe now also checks the browser's workspace access endpoint (/api/us/research/access) for a 401 Bearer challenge and private cache headers. A synthetic 200 response on that endpoint fails the probe. This extends probe coverage beyond the historical hosted observation above.

On 9 November 2026 the expanded headers-only probe at source 7cc1fbeddee3d68a3ea032f3e2120cd663c122e5 reported transport unavailable for health and workspace access at 02:31:53 UTC. Plans and packages passed. At 02:32:02 UTC a single retry passed all four checks, with health 200 and all private paths returning 401 with Bearer, private/no-store and Vary: Authorization. Cause and deployed revision remain unknown. The missed 25 October target and hosted acceptance gates remain open.

The health endpoint can report a full lowercase Git SHA from Render in X-US-Source-Revision. The anonymous probe records a valid value or null. This is host-reported evidence and does not establish hosted acceptance.

The health endpoint sends Cache-Control: no-store so caches do not retain its deployment revision response.

The anonymous probe requires HTTP 200 and Cache-Control no-store on health. A missing directive fails the check, including on older deployments.

On 11 November 2026 at 05:02:32 UTC, Render health returned transport unavailable while all three private routes passed. At 05:02:39 UTC the retry passed all four checks. Health returned HTTP 200 with no-store and reported source revision 18b40aee74af2201e244cb9583fbace3b5e63c79. Each private route returned 401 with a Bearer challenge and the expected cache headers. The initial timeout cause is unknown. Hosted sign-in, account isolation, restart persistence and backup restoration still await acceptance following the missed 25 October target.

## Anonymous boundary observation on 19 November 2026

The credential-free hosted probe at 13:20:08 UTC reported transport_unavailable for /api/health and /api/us/research/access. The plans and research-package endpoints returned 401 with private/no-store, Vary Authorization and a Bearer challenge.

A retry completed at 13:20:17 UTC. Health returned 200 with no-store and source revision 82240f158e3d6fb1d029300953a30ebbd43fd0c3. All three protected endpoints returned 401 with the expected private cache headers and Bearer challenge.

These observations used app.services.us_hosted_probe, which reads status and selected headers without credentials or response bodies. The first failures are retained as availability evidence. A Free-service wake-up is a possible explanation, with no cause confirmed by this probe. Market-open reliability and cold-start acceptance remain open in issue #9.

The 25 October private MVP target remains missed. Actual sign-in, two-account isolation, research/save/reopen/restart and controlled backup/restore remain outstanding in issue #4.

Future hosted probes retain result=transport_unavailable and add a fixed failure_kind of total_deadline, network_timeout or transport_error. Exception text remains excluded. Synthetic tests cover deadline cancellation, HTTPX timeouts and connection errors. The earlier 19 November observations retain their original unspecified transport category. Refs #9.

US browser requests keep their existing network deadline active through response-body receipt. A response that sends headers and then stalls is aborted before JSON parsing and follows the existing request failure path. Synthetic GET/save tests verify cancellation without an auth retry. Existing identity-refresh and private error-header tests cover the buffered response behavior. Hosted acceptance remains open in issues #4 and #9.

## Expanded anonymous boundary probe — 20 November 2026

The read-only hosted probe now includes plan-history export, refresh-job history and live diagnostics alongside health, access, plans and research packages. It sends standalone credential-free GETs, follows no redirects and reads no bodies. Each private route must return 401, private/no-store, Vary Authorization and a Bearer challenge. Twelve additional synthetic regressions independently fail status/cache/vary/challenge on the three added routes. Together with cache-policy checks, 28 local tests passed.

At 18:26:01 UTC, health and access observations timed out; the other five routes returned the required 401/cache/auth boundary. The probe failed overall. One retry completed at 18:26:11 UTC with all seven checks passing. Health reported source revision 726a50ee9d817973de69ac392189e0a56719cabb. Both observations are retained; the initial timeout cause is unknown and is not attributed to Render sleep without evidence. This is anonymous status/header evidence only. It does not prove sign-in, real-account isolation, saved persistence, restart/restore, market-data recovery or sustained reliability. Issue #9 remains open. Storage flags remain unchanged/off. The 25 October private MVP target remains missed without hosted acceptance; no revised private deadline is assigned. Public beta 26 November remains subject to release gates.
