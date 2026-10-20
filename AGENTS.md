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
