# US Market Research

Standalone US equity research product. Initial source snapshot from the Alpha Radar US work, developed independently in this repository from now on.

## Layout

- `frontend/`: Next.js 16, React 19, TypeScript; US terminal at `/us` and guide at `/us/guide`.
- `backend/`: FastAPI, historical research, Alpaca feed diagnostics, reused swing detectors and tests.
- `docs/`: product status and separation notes.

The default frontend route redirects to `/us`. Its navigation, search, benchmarks, prices and market clock use the US workspace. Indian source modules retained for reuse are not a claim of supported US features.

## Working features

- Completed-session, split-adjusted research packages; SPY/QQQ relative strength and breadth for an explicit custom universe.
- Searchable research queue; daily/weekly source charts; detector-specific thesis levels.
- Browser-local shortlist and notes; JSON export; custom-universe refresh.
- US plan API with owner-isolated immutable revisions, concurrency conflicts and USD sizing; see [persistence contract](docs/US-PLAN-PERSISTENCE.md). The workspace can save/reopen/revise these plans; shared hosted storage remains open.
- Read-only live quote diagnostics: feed entitlements, quote/trade timestamps, freshness and spreads. Browser updates use REST polling, not streaming.

## Run locally (Windows PowerShell)

Requirements: Python 3.11+, Node.js 20.9+ and npm.

Backend setup:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-us.txt
python -m pip install pytest
Copy-Item .env.example .env.us.local
```

Enter Alpaca credentials into the ignored `backend/.env.us.local` file. Never put credentials into frontend environment variables or commits.

Start the loopback-only local API:

```powershell
python tests/serve_us_preview.py
```

This harness uses a development identity. It binds to `127.0.0.1:9018`; do not deploy it or expose it publicly.

In another terminal:

```powershell
cd frontend
npm ci
Copy-Item .env.example .env.local
npm run dev -- --webpack --hostname 127.0.0.1 --port 3108
```

Open `http://localhost:3108/us`. The frontend now requires a US beta account even on localhost; configure the separate US Supabase public URL/key in the ignored frontend environment. The loopback backend harness remains an explicit test identity override and must never be hosted.

A fresh clone has no market-data packages. Use the terminal's universe refresh, or run from `backend/`:

```powershell
python -m app.services.us_research --symbols AAPL,MSFT,NVDA,AMZN,META --benchmark SPY --feed sip
```

Recent consolidated SIP data requires the corresponding provider entitlement. Successful historical SIP requests do not establish real-time SIP access. No account funding, order placement or subscription purchase is performed by this code.

## Validation

From `backend/`:

```powershell
python -m pytest tests/test_us_auth.py tests/test_us_main.py tests/test_us_research.py tests/test_us_live.py tests/test_us_research_routes.py tests/test_us_plans.py tests/test_swing_detector.py tests/test_swing_early_momentum.py tests/test_swing_acceleration.py tests/test_swing_institutional_setups.py -q
```

From `frontend/`:

```powershell
npx tsc --noEmit
npm run build -- --webpack
```

## Hosted entry point

Use `uvicorn app.us_main:app` from `backend/` for the US API, not the inherited `app.main` entry point. Configure authentication, a separate Supabase project, durable storage and the frontend's server-only `ALPHA_API_PROXY_URL` before hosting. The US entry point mounts only research routes and health; it does not start Kite/Arrow connections, Indian market schedulers or payment services.

The US API uses its own strict bearer-token verifier; Host/Origin and admin headers cannot grant access. Local identity overrides exist only in the explicit preview harness. The US frontend uses `/us/login`, skips inherited Indian subscription checks, and rejects anonymous sessions without a hostname bypass. Legacy auth URLs redirect there. Private-beta accounts and recovery are administrator-managed; self-service signup/recovery and real hosted account-lifecycle acceptance remain open before public release. The inherited full requirements.txt is retained for legacy-code audits, not the US runtime.

## Known product limits

- US detector thresholds and predictive value remain uncalibrated.
- Breadth represents the selected custom universe, not the entire US stock market.
- Earnings calendar, industry leadership, portfolio risk, hosted plan durability validation and fill-aware outcomes are unfinished.
- Notes/shortlist are browser-local. Jobs, refresh lock and quote cache are process-local; multiworker deployment needs shared state.
- No order execution. Saved research bars are not overwritten by live quotes.
- No deployment workflows or credentials from the original application are included.

See `docs/PRODUCT-STATUS.md` and the component docs for the remaining work. Tests verify software behavior; they do not establish a trading edge.

## Thanksgiving public beta

Target: 26 November 2026. See [release gates](docs/RELEASE-PLAN.md), [India-to-US reuse map](docs/INDIA-US-PARITY.md) and [the GitHub milestone](https://github.com/ethereum007/usmarket/milestone/1). Development continuation runs every 30 minutes in the owning Codex chat; all completed source changes and evidence are pushed here. Public deployment is blocked until release gates pass.
