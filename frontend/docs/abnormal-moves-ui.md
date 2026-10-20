# Abnormal Moves UI

Route:

- `Signals -> Abnormal Moves`

Purpose:

- Dense trader dashboard for unusual price-volume-delivery moves.
- Screening and risk workflow only; it does not claim manipulation detection.

Primary API:

```http
POST /api/abnormal/radar
```

Payload:

```json
{
  "filters": {
    "minVolumeSpike": 1.5,
    "minPriceChange": 2,
    "marketCapBucket": "all",
    "avoidSurveillance": true,
    "onlyBreakout": false
  }
}
```

CSV upload:

```http
POST /api/abnormal/upload
```

Expected CSV fields are documented in the backend at:

- `docs/abnormal-momentum-radar.md`
- `data/abnormal_momentum_sample.csv`

Future frontend integrations:

- Persist watchlist tags per user.
- Add sparkline price/volume mini charts.
- Add vendor live feed source selector.
- Add route to a dedicated stock detail page for abnormal move review.
