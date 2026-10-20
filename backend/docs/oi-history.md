# Five-minute OI history

Alpha Radar captures one option chain per configured index every five minutes during market hours. Each capture produces:

- one overall row for total CE/PE OI;
- one row for every strike returned by the chain;
- five-minute OI and premium changes;
- a positioning label and plain-language explanation;
- a shared Redis chain used by customer requests instead of another Arrow/Kite call.

The explanation is derived positioning evidence, not a claim that OI caused the price move.

## Database boundary

The durable table belongs only in Alpha Radar Supabase project `xphrxbmvavrbqgmldbak`. Never apply the OI migration to Trezofin Production.

Apply `supabase/migrations/20260816_option_oi_history.sql` to the Alpha Radar project during deployment. The table has RLS enabled, grants access only to `service_role`, and has no browser policy.

Runtime writes require all of these conditions:

1. `OI_HISTORY_ENABLED=true`;
2. `SUPABASE_URL` resolves to project `xphrxbmvavrbqgmldbak`;
3. `ALPHA_RADAR_SUPABASE_PROJECT_REF=xphrxbmvavrbqgmldbak`;
4. `SUPABASE_SERVICE_ROLE_KEY` is the Alpha Radar service-role key.

The worker refuses to register if the expected ref is missing, does not match the URL, is not the repository-approved Alpha Radar ref, or points at the explicitly blocked Trezofin project.

## Environment

```dotenv
# Separate Alpha Radar Supabase project only
SUPABASE_URL=https://xphrxbmvavrbqgmldbak.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<alpha-radar-service-role-key>
SUPABASE_ANON_KEY=<alpha-radar-anon-key>
ALPHA_RADAR_SUPABASE_PROJECT_REF=xphrxbmvavrbqgmldbak

OI_HISTORY_ENABLED=true
OI_HISTORY_INTERVAL_MINUTES=5
OI_HISTORY_SHARED_CHAIN_SECONDS=360
OI_HISTORY_REDIS_SNAPSHOTS=96
OI_HISTORY_RETENTION_DAYS=30
OI_HISTORY_INDICES=nifty,banknifty,finnifty,midcpnifty,sensex
```

`SUPABASE_SERVICE_ROLE_KEY` is server-only. Do not add it to the frontend or any `NEXT_PUBLIC_*` variable.

## Deployment order

1. Verify the target Supabase project ref is `xphrxbmvavrbqgmldbak`.
2. Apply the migration to that project.
3. Configure the backend environment above.
4. Ensure Redis is available at `REDIS_URL`.
5. Deploy/restart the backend, then verify the `option_oi_history_capture` scheduler job logs a capture after the next five-minute boundary.
6. Open the Premium OI Clock and confirm overall and strike history appear without a new broker request on each page open.
