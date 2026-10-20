# Arrow Market Data Adapter

Alpha Radar can now run Arrow beside Kite for market-data benchmarking.
This is intentionally an adapter first, not a replacement.

## Environment

```env
MARKET_DATA_PROVIDER=kite
ARROW_BASE_URL=https://edge.arrow.trade
ARROW_LOGIN_URL=https://app.arrow.trade/app/login
ARROW_APP_ID=
ARROW_APP_SECRET=
ARROW_ACCESS_TOKEN=
ARROW_AUTO_LOGIN_ENABLED=false
ARROW_USER_ID=
ARROW_PASSWORD=
ARROW_TOTP_SECRET=
ARROW_AUTO_LOGIN_HOUR=8
ARROW_AUTO_LOGIN_MINUTE=30
ARROW_PRICE_SCALE=100
```

Arrow's docs say static IP registration is mandatory for API apps, and access
tokens expire after 24 hours.

## Automated Auth Flow

Arrow's official `pyarrow-client` SDK supports credentials + TOTP automation.
Alpha Radar schedules it at 08:30 IST Monday-Friday by default and persists the
fresh token in `DATA_DIR/arrow_token.json` with file mode `0600`.

1. Register the backend server's static public IP in Arrow's Trading API app.
2. Set the five required secret/config values:

```env
ARROW_APP_ID=your_app_id
ARROW_APP_SECRET=your_app_secret
ARROW_AUTO_LOGIN_ENABLED=true
ARROW_USER_ID=your_arrow_user_id
ARROW_PASSWORD=your_arrow_password
ARROW_TOTP_SECRET=your_base32_totp_seed
```

`ARROW_TOTP_SECRET` is the stable Base32 seed shown during TOTP setup, not the
rotating six-digit code. Keep `ARROW_ACCESS_TOKEN` blank in auto-login mode.
Do not commit these values or expose them in the frontend.

The admin status endpoint reports whether all settings are present and the last
attempt result without returning credentials or access tokens:

```text
GET /api/arrow/status
```

An admin can run a safe immediate verification after updating the environment:

```text
POST /api/arrow/auto-login
```

If a scheduled or startup catch-up attempt fails, the backend logs the error and
sends a Telegram admin alert when Telegram is configured. Manual Arrow login
remains available as a fallback.

## Manual Auth Fallback

1. Open:

```text
GET /api/arrow/login-url
```

2. Complete Arrow login.
3. Copy `request-token` from the redirect URL.
4. Exchange it:

```text
POST /api/arrow/exchange-token
{ "request_token": "..." }
```

5. Alpha Radar persists the returned token automatically. Alternatively, set a
   manually managed token in `ARROW_ACCESS_TOKEN` while auto-login is disabled.

## Benchmark

With Kite and Arrow both configured:

```text
GET /api/arrow/benchmark/quotes?symbols=RELIANCE,TCS,INFY,HDFCBANK,ICICIBANK
```

Arrow-only quote validation:

```text
POST /api/arrow/quotes
{
  "symbols": ["RELIANCE", "TCS", "INFY"],
  "exchange": "NSE",
  "mode": "ohlcv"
}
```

## Notes

- Arrow quote prices are normalized by `ARROW_PRICE_SCALE`.
- NSE cash symbols are sent as `SYMBOL-EQ` by default.
- The adapter returns Kite-like quote dictionaries keyed as `NSE:SYMBOL`.
- Keep Kite as fallback until Arrow has been benchmarked during market open.
