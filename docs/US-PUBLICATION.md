# Immutable US publication on one retained volume

Bounded persistence increment for issue #4. This hardens the current JSON package store; it does not select or deploy shared cloud storage.

## Behavior

`save_package` delegates to the US publisher, which reuses the imported repository's SQLite transaction context with a dedicated `.publication.sqlite3` lock database in the output directory. `BEGIN IMMEDIATE` serializes cooperating publishers across threads/processes that use the same directory and filesystem lock semantics.

- Validate bounded hash/universe filenames, canonical session date, aware compute timestamp, publication state and finite JSON values before publishing.
- Create unique temporary files, flush/fsync them, close them and atomically replace the destination. Normal failures clean up their temporary file.
- Under the shared lock, an existing package ID is immutable. Different source content using that ID is rejected. Replayed content retains its first recorded compute/asset-observation metadata, consistent with US content identity exclusions.
- Partial attempts never replace last-final pointers. Final pointers advance by source session, then the actual compute instant, regardless of textual timezone offset. An older session finishing later cannot regress the pointer.
- Distinct content with exactly equal session/compute ordering is rejected for operator review rather than chosen by completion timing.
- Validate existing pointer evidence and its referenced package before replacing it. Corrupt/missing/mismatched last-final evidence fails closed; it is not silently guessed or erased.

If the package file completes but pointer replacement fails, no save is confirmed by the caller. The previous pointer remains available; retry can safely reuse the already written immutable package and advance the pointer. A process crash can leave an orphan package/temp file; API package scans ignore temporary files. Do not remove another live publisher's files as automatic cleanup.

## Evidence

Synthetic tests use isolated temporary directories. They cover separate OS processes, independent threads, duplicate publication, immutable-ID conflict, original observation retention, late older sessions, timezone-equivalent ordering, equal-order conflicts, partial preservation, invalid paths/metadata, corrupt pointer rejection and injected pointer-write failure/retry recovery. Existing US research/session/instrument regression tests exercise the delegated save path.

These tests do not certify physical power-loss durability, network-filesystem locking, object-storage atomicity, backup recovery time or hosted deployment behavior. A file fsync/atomic replacement is not a substitute for production backups. The SQLite transaction acts as a cooperating-process lock; it does not make two filesystem replacements a single database transaction.

## Still open in issue #4

Choose and validate the production shared store and retained storage topology, durable packages/plans, distributed refresh-job coordination and rate limits, backups/restore/retention and real hosted account isolation. Workers with separate ephemeral directories do not share this lock or their package data. Concurrent provider refreshes are not prevented by this publication-only lock. No public deployment, credentials, runtime data or subscriptions changed in this increment.
