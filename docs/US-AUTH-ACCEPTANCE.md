# US access acceptance — 20 October 2026

## Implemented

- Reuse the imported Supabase session/token provider with subscription checks explicitly disabled at the standalone US root. No `/api/user-tier` request is needed for US access.
- Dedicated `/us/login` email/password screen, anonymous-session rejection, configuration-missing state, generic sign-in error and explicit sign-out error handling.
- US route guard has no hostname, origin or administrator-header bypass. Client navigation is not authorization: hosted US APIs independently validate each token.
- Legacy login/signup routes redirect to US sign-in; password routes redirect to US recovery; no inherited India pricing, index polling or premium gate is reached through this journey.
- Session setup/refresh continues priming the shared API bearer-token transport.

## Automated evidence

`npm run test:us`: ten executable component/provider tests cover loading, signed-out, signed-in and anonymous access; missing configuration; signed-in redirect; US subscription-service independence; sign-out failure; legacy auth redirects. Tests transpile the actual TSX and render React markup with mocked router/auth services. They are not a browser or real identity-provider acceptance test.

TypeScript and optimized webpack build are included in GitHub CI, together with the backend strict-auth and research regression suite.

## Remaining release gates (issue #2 stays open)

- Configure a separate US Supabase project consistently in frontend and backend, callback/allowlist and email settings; do not reuse Indian production identity implicitly.
- Real hosted sign-in, expiry/refresh, revocation/sign-out, outage and cross-account tests.
- Signup source is implemented behind a default-off UI rollout flag; provider signup/confirmation configuration and real acceptance remain open. See [US-SIGNUP-CONFIRMATION.md](US-SIGNUP-CONFIRMATION.md). Password recovery source is implemented in [US-PASSWORD-RECOVERY.md](US-PASSWORD-RECOVERY.md); real link delivery, expiry and hosted lifecycle acceptance remain open.
- Desktop/mobile/keyboard browser acceptance. No fresh browser verification was available for this increment.
- Owner-isolated durable plans/research remain issue #4. Authentication alone does not satisfy storage isolation.

Local preview no longer grants frontend access merely because the hostname is localhost. The explicit backend loopback harness remains for API-only development; no frontend preview bypass was introduced.


## Next controlled hosted rehearsal

The replacement project's reviewed schema is applied; real-account and browser acceptance are still pending. Follow [US-HOSTED-ACCEPTANCE.md](US-HOSTED-ACCEPTANCE.md) for required account/frontend inputs, configuration review, isolated rehearsal and evidence. No account, invitation, credential destination or runtime flag is authorized by the checklist itself.


## Sign-in submission guard

The sign-in handler now locks synchronously before authentication or anonymous-session sign-out begins. Rapid duplicate submits cannot create concurrent provider requests before the busy render commits. Unconfigured/loading submissions invoke neither sign-in nor sign-out, and a failed request releases the guard for an explicit retry with sanitized feedback. Synthetic handler tests cover these boundaries. This changes no account, provider setting, credential destination or hosted access grant; real hosted identity and browser acceptance remain pending.
