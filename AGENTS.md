# Repository instructions

This is Kiran Dutta's standalone US-market product at github.com/ethereum007/usmarket.

- Work in this repository for future US development. Do not modify or deploy the original Alpha Radar repositories as part of US work.
- Keep frontend and backend changes together when their API contracts change.
- US defaults: USD, America/New_York (ET), SPY/QQQ benchmarks and provider session calendars. Never relabel Indian measurements as US measurements.
- Preserve immutable research packages, partial/final separation and unknown values. Live observations do not authorize trades or overwrite completed-session research.
- Keep all credentials, local environments, market-data files, build output and dependencies out of Git.
- Use the loopback preview harness for local development; `app.us_main` is the separate hosted API entry point. Do not deploy inherited Indian schedulers or deployment workflows.
- Existing product gaps are documented in README.md. Do not claim earnings coverage, calibrated strategy edge or market-open validation without evidence.
- Push directly to main when the user asks to push this solo product, unless instructed otherwise. Do not deploy or change market-data subscriptions merely to save source code.

## Continuous build and release

- Public beta target: US Thanksgiving, 26 November 2026. Read docs/RELEASE-PLAN.md, docs/INDIA-US-PARITY.md and open milestone issues before selecting work.
- The 30-minute continuation cadence must deliver meaningful bounded increments, not timer/status messages. Preserve user changes, avoid overlapping runs, test, commit and push completed work to this repository.
- Reuse imported Indian capabilities; adapt US inputs, calendars, identity and units instead of duplicating working engines.
- Commercial display rights are a release gate. Personal Alpaca access does not establish public redistribution permission. Never publish runtime market data into this public source repository.
- Hosted US endpoints use app.us_auth.require_us_user. Never add a Host/Origin/admin-header development bypass. Local identity overrides belong only in the explicit loopback harness.
- Close issues only when their acceptance evidence is complete; keep frontend/onboarding, hosted persistence and live validation gaps visible.
