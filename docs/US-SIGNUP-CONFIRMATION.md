# US signup and confirmed-email access

Issue #2 remains open. The US account-creation source flow is implemented at `/us/signup`, disabled by default. No provider settings, real account, credentials or email were changed during implementation.

## Rollout and provider boundary

`NEXT_PUBLIC_US_SIGNUP_ENABLED=true` enables the frontend signup form and sign-in link at build time. Missing/other values keep the screen informational and prevent the helper from calling signup. **This public flag is only UI rollout control, not server authorization or provider signup policy.** For a closed beta, independently disable public signup in the separate US Supabase project and provision approved accounts there. Never treat a hidden form as an access boundary.

Configure provider Confirm Email, allowed HTTPS `/us/login` callback, email templates/delivery, password policy and abuse/rate protection before enabling the UI. A provider with confirmation disabled can implicitly mark emails confirmed; a timestamp alone does not independently prove an email link was clicked. Real provider-policy acceptance is therefore still a release gate.

## Source behavior

- Reuse the existing Supabase client/session provider. Submit only trimmed email, password and a fixed same-origin US confirmation callback; never a user-controlled return URL.
- Require matching passwords of at least 12 characters, plus any stronger provider policy. Do not enumerate returned identities or show provider “account exists” details. Normal no-session results show the same inbox/sign-in/recovery guidance, including obfuscated existing-user responses. Returned and thrown SDK errors are generic; provider anti-enumeration configuration remains authoritative.
- An unexpected signup session is not silently accepted as the intended confirmation flow. Attempt local sign-out and require operator review. Failed cleanup is explicitly reported with sign-out retry; do not falsely claim the session ended.
- Users with an existing session must sign out before requesting another account. Duplicate submit is guarded, and password fields clear after a confirmed signup response. Passwords are not logged/persisted by this form.
- US workspace navigation requires provider-confirmed email status and directs unconfirmed users to US sign-in guidance. Recovery routing retains priority.
- Hosted US APIs independently fetch the provider identity and reject missing/unconfirmed email status with 403. Malformed confirmation timestamps fail closed with 503. Anonymous/spoofed-header access remains rejected. Client cache or frontend rollout flags cannot grant API access.

## Evidence and open gates

Mocked tests cover disabled/missing config, fixed callback and request allowlist, password guards, obfuscated-user response, generic thrown/returned errors, unexpected-session cleanup and failure, disabled UI, confirmed/unconfirmed navigation and server provider-response verification. TypeScript and production build are CI gates. These checks are not real signup, email delivery or browser acceptance.

Before closing #2: configure/validate the separate US identity project, provider signup/confirmation policy and redirect allowlist, delivered/expired/reused confirmation links, recovery, refresh/revocation/sign-out, account isolation and desktop/mobile/keyboard paths. Public rollout also depends on the remaining release gates; no deployment was performed.

References: [Supabase signup](https://supabase.com/docs/reference/javascript/auth-signup), [provider auth configuration and implicit confirmation](https://supabase.com/docs/guides/auth/general-configuration), [server-verified user identity](https://supabase.com/docs/reference/javascript/auth-getuser).
