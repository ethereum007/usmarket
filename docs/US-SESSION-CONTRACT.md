# US session and history completeness contract

First increment for release issue #5. Stable instruments, ticker changes, corporate-action lineage and historical membership remain open; this change addresses provider sessions and missing history.

## Publication rules

- The provider calendar supplies actual session dates and closes. No weekday-generated holiday calendar or fabricated price bars are substituted.
- Calendar rows must have canonical dates and valid local close times for US regular equity sessions; supplied opens must precede the close. Malformed rows, timezone-bearing clock fields, weekend sessions and conflicting duplicate rows reject the attempt. Identical rows deduplicate and ordering is canonical.
- Interpret closes in America/New_York, including daylight saving. A session becomes eligible at its provider close plus the existing 30-minute finalization buffer. The buffer is a product policy, not a guarantee that a provider will never correct data.
- Benchmark bars must cover **every completed session in the supplied calendar**. Missing leading, interior or latest benchmark sessions block publication; the previous saved final remains untouched. This prevents a shortened benchmark calendar from making stock return windows look complete.
- Within a stock's observed history, missing provider sessions are recorded in `history_gaps`. No gap is inferred before its first observed bar, so short/new listings are not assumed to have existed earlier. The instrument-master project must eventually establish actual listing dates.
- Stocks with such gaps do not enter setup detectors, even if the latest bar exists. The reused feature engine retains explicit eligibility windows and unknown metrics. The attempt is partial, and cannot replace the last-final pointer or back a new US plan.

The detector exclusion is an optional input to the imported package builder. Its calculations and detector implementations are reused; this change does not claim to calibrate US strategies.

## Versioned evidence

New packages use `us-swing-eod-v2` and record:

- `session_calendar`: canonical completed provider rows, local offset-bearing close, UTC finalized time, timezone, buffer, contract version and content hash.
- `history_gaps`: observed missing session dates per stock.
- `setup_exclusions`: reasons affected symbols did not enter detectors.

Calendar identity feeds the source manifest and setup versions. Identical row ordering/duplicates do not create different lineage; close corrections do. Package content identity still records the other research inputs. Older immutable packages are not rewritten; the workspace labels absent calendar evidence as legacy and displays explicit withholding reasons for new gapped stock histories.

## Evidence and limits

Synthetic fixtures cover both sides of March/November DST changes, early closes, exact finalization boundaries, omitted provider holiday sessions, malformed/conflicting rows, missing benchmark sessions, stock gaps, short history, canonical identities, close corrections and last-final preservation. The saved-package API contract retains the evidence fields.

These are implementation/contract tests, not a provider uptime or observed market-open run. Provider calendar completeness is still an external input: a date omitted by the provider cannot be independently certified as a holiday by this code. Daily aggregate regular-session volume and split-adjustment provenance remain unverified. No runtime market data was added to Git or fetched for these tests.

Keep issue #5 open for stable security identity, symbol/listing/delisting history, versioned membership, split/adjustment evidence and broader data-quality acceptance. Shared persistence and market-open reliability remain issues #4 and #9.
