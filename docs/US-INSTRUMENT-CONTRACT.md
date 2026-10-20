# Current US instrument identity — first increment

Release issue #5 remains open. New refreshes resolve the explicit requested universe and benchmark through the read-only [Alpaca asset lookup](https://docs.alpaca.markets/us/reference/get-v2-assets-symbol_or_asset_id) before requesting their histories. This is a provider-scoped current observation, not a complete security master or historical mapping service.

## Resolution and publication

- Preserve the exact requested ticker and provider UUID, class, exchange and current status. Reject a mismatched returned symbol rather than silently accepting an alias.
- Require active `us_equity` identity for the benchmark; otherwise no package is published.
- Missing, malformed, ambiguous, wrong-class or inactive stock identities withhold affected setups and make the attempt partial. Only resolved stocks are requested from the history provider; the original requested universe remains visible, including unavailable coverage.
- Two requested tickers sharing a provider UUID are both ambiguous. No automatic ticker merge, rename history or share-class equivalence is inferred.
- Requests use bounded concurrency (five) and GET only. Access denial aborts with a sanitized error. Other failed/malformed lookup responses remain unavailable, never invented assets. No order or account mutation is performed.

The asset response does not establish verified stock/ETF/ADR/share-class classification, historical listing/delisting dates, historical ticker ownership or corporate-action factors. These remain explicitly unknown. Current inactive status is not converted into a guessed delisting date. Provider tradability is not treated as research or execution permission.

## Evidence and identity

Runtime refreshes produce `us-swing-eod-v3` packages containing `instrument_snapshot` (contract version, canonical content hash, observed-at UTC time, provider and normalized records) and `instrument_exclusions`. The snapshot content ID excludes observation time; repeat observations of identical content retain content identity. Immutable publication keeps the first saved observation metadata for repeated content.

Instrument content feeds the research source manifest/snapshot and setup identity/version. The same ticker resolving to a different provider UUID creates a different thesis identity. This prevents ticker-only reuse from appearing as the same plan source; it does not prove that the provider UUID remains stable across all corporate events. US plans record the provider asset ID derived from their source setup and keep it immutable across revisions.

The workspace displays current observed identity or an exclusion reason. Older packages without this evidence are labelled legacy; they are not rewritten. The pure research calculation helper still supports legacy/session-only fixtures; the production refresh path always resolves and binds instrument evidence before publication.

## Validation and open gates

Synthetic tests cover valid IDs, absent/malformed records, symbol/class mismatch, inactive status, duplicate identity ambiguity, ticker reuse, repeated observation identity, access denial sanitization, GET-only transport and refresh-to-publication wiring. Tests use mocked providers and temporary storage; no runtime asset data or credentials enter Git.

Still required: observed provider acceptance, symbol-change/listing/delisting history, explicit security subtype/share class, historical membership, verified split and other corporate-action lineage, and plan/outcome handling across such events. Daily history requests still ask the provider for split adjustment; that request is **not** independent validation of split factors. Public display rights remain release gate G1.

Provider references: [asset lookup](https://docs.alpaca.markets/us/reference/get-v2-assets-symbol_or_asset_id), [working with assets](https://docs.alpaca.markets/us/docs/working-with-assets).
