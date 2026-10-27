# SEC filing evidence — first catalyst increment

Issue #6 remains open. The authenticated `GET /api/us/filings?symbol=AAPL` endpoint resolves a current SEC ticker/CIK association and retrieves the issuer's recent submissions. The stock workspace displays the resulting source-linked filing evidence beside research notes. It reuses the imported announcement source-link validator with an explicit SEC host allowlist; inherited NSE defaults remain unchanged.

## What the evidence means

- Records include original SEC document URL, form, accession identity, filing date, offset-aware acceptance time, report date where supplied, amendment flag and declared filing items.
- An 8-K declaring item 2.02 is labelled “results item reported; verify the document.” It is not classified as a known forthcoming earnings event or assigned a materiality/trading score.
- Earnings event date, BMO/AMC timing and fiscal period remain unknown. Filing/report dates do not establish these values. Amendments remain separate source records rather than silently replacing or claiming to reconcile original financial figures.
- Mapping and submissions retrieval timestamps/source URLs are retained. Cached evidence retains its original retrieval time; the UI displays acceptance time in ET. Current ticker associations are issuer-level, not historical security identity or proof of share-class equivalence. The SEC does not guarantee mapping accuracy or scope.
- Only supported recent forms are considered (8-K, 10-Q, 10-K, 6-K, 20-F, 40-F and amendments), capped at 20 displayed records. No older submission files, document contents, future earnings calendar or estimates are searched.
- Malformed/future/duplicate records make evidence partial. Invalid column schemas, ambiguous mappings, missing configuration and provider failures return unavailable, never “no events” or earnings clearance. Source URLs are constructed from validated CIK/accession/document identifiers, with no arbitrary URL fetching.

## Operator configuration and limits

Set server-only `SEC_USER_AGENT` to an operator-approved organization/contact string, for example `YourOrganization operator@example.com`. No value was configured by this increment. The service refuses outbound requests without the contact configuration; it requires no SEC API key. Do not use EDGAR filing-management/submission credentials: these are read-only public-data endpoints.

Requests are GET-only, timeout-bounded, redirect-disabled and serialized at no more than two request starts per second in each worker. The process-local cache holds at most 64 URLs (ticker mapping one hour, submissions two minutes). There are no automatic retries or background scans. **Aggregate rate limiting across workers/machines remains a hosting gate**; the SEC's documented access limit applies across machines, so per-worker throttling alone does not certify deployment compliance.

## Evidence and remaining work

Mocked tests cover CIK mismatch/ambiguity, unsafe links, acceptance time vs filing/report dates, amendments, malformed columns, partial/duplicate/future records, provider denial/rate limit/outage/redirect handling, cache timestamps, GET-only requests, missing configuration and authenticated routes. Frontend tests render actual TSX, preserve imported NSE validation, reject spoofed SEC hosts and verify unknown-earnings/amendment/retrieval labels. No runtime filings or credentials enter Git, and no live provider/browser acceptance is claimed.

Still required in #6: licensed/verified forthcoming earnings timing, issuer release ingestion, fiscal-period and restatement reconciliation, materiality/evidence review workflow, immutable event revisions/known-as-of history, plan exposure bound to verified events and real provider/browser acceptance. Plan event risk remains unknown. This on-demand evidence does not mutate completed research packages or clear an existing plan's event risk.

Official references: [SEC data APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces), [accessing EDGAR data and ticker associations](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data), [developer resources and aggregate request limits](https://www.sec.gov/about/developer-resources).


## Filing review controls

The stock evidence panel now distinguishes acceptance timestamp (ET), filing date and report date. Date-only source values are displayed literally to avoid shifting them across timezones. Unknown report dates remain unknown; report dates do not establish fiscal quarter/year or earnings-event timing.

Client filters narrow the existing returned recent records to results-item reports or periodic reports (including amendments); they do not fetch older documents or a forthcoming calendar. Displayed/returned counts, partial-evidence warnings and separate empty-filter feedback prevent a filtered empty list from becoming an assertion of no events. Existing SEC-only source validation and amendment disclosures remain. This is evidence navigation for the weekend MVP, not verified earnings coverage; actual provider/browser acceptance remains open.


## Bounded evidence requests

Each SEC evidence load has a 20-second total async deadline covering rate-limit lock waits, spacing and both mapping/submission requests, including cached lookup paths. Deadline expiry cancels pending I/O, releases any held gateway lock and returns fixed unavailable feedback with earnings status still unknown. A successfully retrieved mapping may remain cached with its original observation time; failed submissions are not cached as empty evidence. Caller cancellation propagates. Synthetic blocked-lock/mapping/submission tests verify cancellation and subsequent recovery. The async deadline does not preempt synchronous JSON decoding or evidence normalization. This does not establish real SEC availability, earnings-calendar coverage or hosted market-open acceptance.
