# Local Redis market-refresh setup

The first release keeps Redis on the existing Alpha Radar EC2 VM. It does not
create ElastiCache, another VM, a load balancer, or a separate worker process.

Run these commands once on the VM before deploying the backend change:

```bash
sudo apt-get update
sudo apt-get install -y redis-server
sudo systemctl enable --now redis-server
redis-cli ping
```

The final command must return `PONG`. Redis remains bound to localhost; do not
open port 6379 in the AWS security group.

Add the following values to the backend `.env` (keep all existing broker and
payment values unchanged):

```dotenv
REDIS_URL=redis://127.0.0.1:6379/0
REDIS_RECONNECT_SECONDS=30
MARKET_ACTIVE_TTL_SECONDS=90
MARKET_CORE_REFRESH_SECONDS=30
MARKET_BROAD_REFRESH_SECONDS=60
MARKET_MANUAL_RESCAN_COOLDOWN_SECONDS=60
MARKET_SNAPSHOT_RETENTION_SECONDS=900
ARROW_PROVIDER_REQUESTS_PER_MINUTE=420
KITE_PROVIDER_REQUESTS_PER_MINUTE=120
ARROW_PROVIDER_CONCURRENCY=1
KITE_PROVIDER_CONCURRENCY=1
ARROW_PROVIDER_MIN_INTERVAL_SECONDS=0.15
KITE_PROVIDER_MIN_INTERVAL_SECONDS=0.5
PROVIDER_MAX_RETRIES=2
PROVIDER_RETRY_BASE_SECONDS=0.6
API_RATE_LIMIT_WINDOW_SECONDS=60
API_RATE_LIMIT_MAX_REQUESTS=600
API_REFRESH_RATE_LIMIT_MAX_REQUESTS=8
```

After deployment, verify the worker and Redis without exposing credentials:

```bash
pm2 logs alpha-radar-backend --lines 120 --nostream
curl -fsS http://127.0.0.1:8000/api/health
redis-cli INFO memory | sed -n '1,8p'
```

Expected backend logs include `Connected to local Redis` and `Shared market
refresh worker registered`. Premium sessions send a heartbeat every 60 seconds;
the worker then refreshes the Nifty 100 core feed every 30 seconds and the Nifty
500 broad feed every 60 seconds during market hours. It pauses after 90 seconds
without a Premium heartbeat.

For an authenticated Premium admin/browser session, `GET /api/market-snapshots/status`
reports cache-hit rate, stale responses, queued/failed refreshes, provider
budget/retry counters, and age for each scheduled snapshot.
