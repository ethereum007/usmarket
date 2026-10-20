# Render private MVP setup

Account creation confirmed by user. No Render connector is available in this chat; creating an account does not establish account access here. Do not share API keys in chat. No paid service or deployment has been created by this guide.

## Current decision: $0 preview first

On 20 October the user selected a $0 starting budget and reported submitting the Free service deployment. Its URL, build result and deployed commit have not yet been supplied or verified. Do not activate paid compute or a disk. The earlier paid-volume proposal below is deferred, not the current setup.

For Free compute, remove any attached disk and use an ephemeral writable DATA_DIR such as /tmp/usmarket, not the former /var/data mount. Current SQLite plans, refresh jobs and file-based research are temporary on that service. A successful save/reload in one running process does not prove restart retention. Do not invite users to rely on saved plans until external durable storage is implemented and rehearsed.

The next storage increment must preserve existing immutable revisions, expected_revision conflicts, owner isolation, exact package identities and atomic publication. It must also replace local refresh coordination for deployments that can lose their filesystem. Merely changing DATA_DIR or copying SQLite files to object storage is insufficient. Evaluate an external Postgres-backed repository and immutable package storage without buying services; no external database has yet been provisioned or integrated.

Free services sleep after 15 minutes of inactivity and lose filesystem changes on restart, redeploy or spin-down. Free Render Postgres expires after 30 days, so it is not a durable launch solution. Avoid adding payment details or upgrading services as part of this preview.

## Review the service form

- New Web Service, connect only ethereum007/usmarket, branch main.
- Name: usmarket-api. Runtime: Python 3. Root directory: backend.
- Build: pip install -r requirements-us.txt
- Start: uvicorn app.us_main:app --host 0.0.0.0 --port $PORT --workers 1
- Health check: /api/health (liveness only, not authenticated readiness).
- Auto-deploy: disabled during initial acceptance; deploy reviewed commits manually.
- backend/.python-version selects the latest available Python 3.11 patch, matching the CI minor version. Do not override it with Render's newer default runtime.
- Deferred paid alternative only: review a compute size sufficient for pandas/numpy research and a persistent disk; no exact cost or capacity is certified before the service form and load checks.
- Deferred paid alternative disk mount: /var/data; environment DATA_DIR=/var/data/usmarket. Only data under the mount persists.

Stop before activating paid compute/disk and review the displayed combined estimate with the user. The user's standing instructions prohibit buying subscriptions without authorization. Free ephemeral storage is not a substitute for persistent plans.

## Configuration before real use

Use Render's secret environment settings for SUPABASE_URL, SUPABASE_ANON_KEY, US_INVITED_USER_IDS, ALPACA_API_KEY, ALPACA_SECRET_KEY and approved SEC_USER_AGENT. Configure a separate US Supabase project and actual confirmed invited identities. Do not copy original Alpha Radar credentials/configuration. Do not paste secret values into chat or Git.

Keep one instance and one worker for initial MVP; SEC and quote caches/rate coordination are process-local. The network-reachable API still enforces bearer identity, confirmed email and invitations. Protect the frontend as agreed. Liveness alone is not private access acceptance. Data-display permission for the intended audience remains required before provider data is shown.

Run python -m app.services.us_readiness --check-storage in the running service shell, not a build/pre-deploy step (the disk is runtime-only). Then complete docs/WEEKEND-MVP.md with real invited/uninvited requests, save/reload, restart retention and online backup/restore. Do not distribute the private URL as a working MVP before those checks pass.

Persistent-disk services have deployment downtime and do not scale across instances. Disk snapshots do not replace SQLite online backups and restore rehearsals. No original repositories/deployments are changed.

Official references checked 20 October 2026:
- https://render.com/docs/deploy-fastapi
- https://render.com/docs/python-version
- https://render.com/docs/monorepo-support
- https://render.com/docs/disks

Free-tier reference checked 20 October 2026: https://render.com/docs/free
