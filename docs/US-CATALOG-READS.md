# Saved US catalog read contract

Persistence/reliability increment for issue #4. This makes the read path consistent with chronological publication ordering and explicit failures; it does not deploy shared storage.

## Behavior

- Exact package lookup accepts a bounded hash identity. Missing files return 404, malformed JSON/identity/metadata return a sanitized 409, and storage access failures return a sanitized 503. Disk paths and file contents do not enter API errors.
- Metadata reuses the publication validator for canonical session, aware computation time, state, ID and universe. Catalog records additionally require US/USD, supported benchmark/feed and a bounded unique list of valid ticker strings. Research math, bar contents and historical provider claims are not independently recertified by this schema check.
- Catalog ordering is descending session, then the actual computation instant, with ID as a deterministic tie breaker. Textual offsets do not make an older observation sort ahead of a newer one. This matches publication's chronological comparison; equal-time ties do not establish which source is authoritative.
- Invalid/unreadable package files are omitted from catalog entries and counted in `unavailable_packages`. Healthy packages remain available. Known pointer/temporary files are not catalog package candidates and do not count as invalid packages.
- The frontend displays an incomplete-catalog warning when records are omitted and does not portray an entirely unreadable library as an empty first-use library. An explicit retry/selection can load readable saved research.

The existing 120-entry response limit remains. No immutable packages, pointers or runtime records are rewritten by the read path. Legacy packages with valid metadata stay readable; incompatible/corrupt metadata is reported rather than silently coerced into a US contract.

## Evidence and remaining gates

Synthetic API tests cover timezone-offset/session ordering, malformed JSON and non-object content, invalid timestamps/sessions/universes/symbol lists/benchmark/feed/currency/state, sanitized disk errors, correct omission counts and pointer exclusion. Plan fixtures now include valid source metadata, and ownership/revision/partial-source checks still run.

Shared hosted store, durable catalog indexing/pagination at large scale, production restore/recovery, provider/instrument/corporate-action validation and real browser/account acceptance remain open. No runtime data or credentials were read/changed or committed for this increment. This is schema/read-path verification, not a new claim of data-provider or strategy correctness.


## Workspace freshness and overlapping reads

The default selection now uses the first final package in the backend's session/computation/identity order, rather than preferring an older package merely because its universe has at least 20 symbols. Newer partial evidence still does not silently replace an available final default; explicit browsing remains available. If no final exists, the newest catalog entry is selected. Existing explicit selection is retained unless selecting newest was requested.

Catalog reloads carry a request generation. A late earlier result or error is ignored after a newer reload or account-workspace cleanup, preventing stale catalog/default-symbol/selection updates. This does not certify data freshness outside the recorded timestamps or make partial evidence final. Tests cover old broad vs new final, partial/final separation, empty catalogs and overlapping/abandoned reads. Hosted browser acceptance remains open.
