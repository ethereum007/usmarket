# US terminal — local preview

The first US terminal is available at /us in the frontend checkout.

Delivered: saved package selection, actual universe breadth, RS-sorted searchable research queue, daily/weekly source charts, selectable detector theses and chart levels, browser shortlist and notes, JSON research export, custom universe and SPY/QQQ refresh. Production endpoints use the existing Premium dependency. The loopback-only preview harness has an explicit development identity and never starts the production application lifespan.

## Start locally

Terminal 1, backend checkout:

```powershell
cd 'G:\Alpha Radar New\alpha-radar-backend-swing'
python tests/serve_us_preview.py
```

Terminal 2, frontend checkout:

```powershell
cd 'G:\Alpha Radar New\alpha-radar-frontend-swing'
$env:ALPHA_API_PROXY_URL='http://127.0.0.1:9018'
npm run dev -- --webpack --hostname 127.0.0.1 --port 3108
```

Open http://localhost:3108/us. Use localhost for the existing frontend development access handling. Stop both terminals with Ctrl+C. Webpack avoids the existing cross-checkout node_modules symlink restriction in Turbopack.

Credentials remain only in the ignored backend .env.us.local; they are never copied into the frontend.

## Boundaries

- This is local work, not a production release. Persist DATA_DIR/us-research on deployment.
- The 30-stock starter list is manually curated, not an index or market-wide breadth sample.
- Earnings verification, industry taxonomy, account-synced conditional plans, alerts and execution are not implemented in this US terminal.
- Notes/shortlist are browser-local and shared by users of that browser profile. Export is the backup path.
- Refresh progress and the refresh lock are process-local. Restart clears job status; saved packages survive. A shared queue/lock is required before multiworker production deployment.
- The JSON catalog reads saved package files; indexing, retention and shared Postgres persistence remain production work.
- US detector thresholds are uncalibrated. Policy targets are not measured structural room. Daily aggregates are not certified regular-session-only volume.

## Verification, 19 October 2026

- Real Alpaca SIP refresh: 30/30 stocks, benchmark SPY, completed session 2026-10-16; 26 detector setups across 15 symbols.
- Browser refresh: POST accepted, job polled to completion, saved research catalog reloaded. Identical source data produced the same package identity.
- Browser shortlist and note survived reload. QA notes and shortlist changes were removed afterward.
- Daily and weekly charts rendered; multiple XOM theses were selectable.
- 390px mobile viewport: no horizontal overflow. Scoped axe accessibility audit: 0 violations, 28 passes.
- Browser page errors: none observed.
- Backend: 25 targeted tests passed, including package identity validation, US-only file reads, request validation, ownership, auth boundary, pagination, immutable repeat publication, partial/final separation and existing swing regressions.
- TypeScript and optimized webpack production build passed; /us generated successfully. Existing chart consumers retain default behavior; the US chart opts into explicit theme appearance.

Final preview checks confirmed New York ET clock and dark chart rendering. Temporary QA notes and shortlist entries were cleared. Preview servers were stopped after verification. Desktop/mobile screenshots are saved alongside this runbook.

## Dedicated US workspace increment

- /us and /us/guide use USWorkspaceNav with brand/home, US stock search, market context, live tape, research, shortlist, US guide and universe links. All application header links remain under /us. No shared Indian search, subscription, options, F&O or navigation menus are mounted in this shell.
- US layouts override page title/description. Market timestamps and live panel next-open display use ET.
- Optional ALPHA_MARKET_MODE=us enables root and legacy page redirects to /us. Enabled only in ignored local .env.local for this preview; default India application routing is preserved when unset. Set this variable for a dedicated US deployment.
- Corrected detector explanations to use the actual package benchmark and aligned RS values; refreshed the 30-stock SPY package. Older package explanations are corrected in the US display from their recorded benchmark/RS fields.
- TypeScript passed after a preview restart resolved local memory pressure. Backend package/foundation regression group: 21 passed, including explicit benchmark-explanation test.
- HTTP checks: /us and /us/guide 200; /, /stocks and /fno redirect into /us in the enabled US-only preview mode.

Final US-shell browser checks: NVDA search selected NVDA inside /us; navbar shortlist opened the US shortlist; guide loaded with US metadata and links. No visible Nifty/NSE/rupee/IST terms on the research or guide pages. Header links all stayed under /us. 390px mobile guide/header had no horizontal overflow. No page errors observed. Preview servers remain running for the user.
