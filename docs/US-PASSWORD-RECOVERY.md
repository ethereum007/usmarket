# US password recovery — source implementation

Issue #2 remains open. `/us/recover` provides the US-only recovery request and password-update flow. US sign-in links there; inherited forgot/reset-password URLs redirect there. Account creation remains administrator-managed in this increment.

## Flow and boundaries

1. The user requests a reset link. The SDK receives a trimmed email and a fixed `/us/recover` destination on the current application origin; no caller-supplied return URL/query is followed. Feedback does not reveal whether an account exists.
2. The Supabase client subscribes at creation to capture `PASSWORD_RECOVERY` before React mounts. Recovery intent is held in memory and scoped to the recovered user. Sign-out, normal sign-in or another account's session clears it. No flag is inferred from an untrusted query parameter.
3. The shared auth provider exposes recovery state. US sign-in/workspace navigation sends that state to recovery rather than opening the research workspace. Anonymous/ordinary sessions do not show the password-update form.
4. Matching new passwords (at least 12 characters, plus any stronger provider policy) are submitted through the SDK. Supabase independently authorizes the update; the client recovery flag is navigation state, not a server authorization boundary.
5. A confirmed update clears password fields and signs out. If sign-out fails after the update, the UI reports that the password **was updated** and offers a sign-out retry; it does not submit the password update again or claim the session ended.

Duplicate submissions are guarded. Provider errors are generic, passwords are not logged or persisted by this flow, and missing configuration fails closed. A full page reload can lose in-memory recovery intent; the page explicitly offers a fresh link rather than inferring recovery permission from a stored ordinary session. The API's existing independent bearer verification remains unchanged.

## Checks and remaining acceptance

Mocked executable tests cover fixed redirect destination, generic reset failures, provider-required update calls, confirmation/length guards, early recovery events, account-switch/sign-out reset, ordinary-session UI rejection, recovery navigation, safe form labels and mixed update-success/sign-out-failure reporting. Existing US access, plan and filing tests remain in CI. No real recovery email, password update, account creation or configuration change occurred during implementation.

Before hosted release: configure the separate US Supabase project, allowed HTTPS recovery redirect, email templates/delivery and provider rate/abuse controls. Test real link delivery, one-time/expired links, token refresh/revocation, sign-out behavior, keyboard/mobile paths and outage recovery. Self-service signup/confirmation and real hosted lifecycle acceptance remain open. These mocked checks are not proof of email delivery or real provider/browser acceptance.

References: [Supabase reset request](https://supabase.com/docs/reference/javascript/auth-resetpasswordforemail), [recovery auth events](https://supabase.com/docs/reference/javascript/auth-onauthstatechange), [authenticated password update](https://supabase.com/docs/reference/javascript/auth-updateuser).
