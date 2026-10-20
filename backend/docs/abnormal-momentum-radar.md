# Alpha Radar Abnormal Momentum Radar

India-focused price-volume-delivery surveillance screen for NSE/BSE stocks.

This is a screening and risk tool. It is not investment advice and it is not a manipulation detector.

## Endpoints

### POST `/api/abnormal/radar`

Scores supplied rows or built-in sample rows.

```json
{
  "filters": {
    "minVolumeSpike": 2,
    "minPriceChange": 3,
    "marketCapBucket": "all",
    "avoidSurveillance": true,
    "onlyBreakout": false
  },
  "rows": [
    {
      "symbol": "NETWEB",
      "last_price": 4533,
      "prev_close": 4195,
      "volume": 3100000,
      "avg_volume20": 900000,
      "delivery_pct": 54,
      "high20": 4310,
      "high50": 4475,
      "sector": "IT",
      "sector_change_pct": 1.7,
      "market_cap_bucket": "mid",
      "turnover_lakh": 140523
    }
  ]
}
```

### POST `/api/abnormal/upload`

Multipart CSV upload. Returns parsed rows plus a scored preview.

## CSV Format

See `data/abnormal_momentum_sample.csv`.

Required-ish fields:

- `symbol`
- `last_price` or `ltp` or `close`
- `prev_close`
- `volume`
- `avg_volume20`

Useful optional fields:

- `delivery_pct`
- `high20`
- `high50`
- `sector`
- `sector_change_pct`
- `market_cap_bucket`
- `turnover_lakh`
- `asm_gsm`
- `trade_to_trade`
- `circuit_hit`
- `news_tag`
- `bulk_deal`
- `block_deal`

## Score Model

Total score is 10 points:

- Volume expansion: 0-2
- Delivery strength: 0-2
- Clean 20D/50D breakout: 0-2
- Sector/theme support: 0-1
- Bulk/block deal or institutional footprint: 0-1
- Liquidity quality: 0-1
- Governance/surveillance cleanliness: 0-1

## Risk Flags

- Clean Momentum
- Watch Carefully
- Liquidity Trap
- Circuit Risk
- News-Only Move
- Avoid: Surveillance/Low Liquidity

## Future Data Integrations

The engine accepts normalized rows, so these can be added without changing the UI:

- NSE/BSE bhavcopy EOD import
- NSE delivery data import
- Bulk/block deal CSV ingestion
- ASM/GSM/trade-to-trade list ingestion
- Vendor historical APIs for 20D/50D breakout levels
- Vendor market-cap/liquidity buckets
