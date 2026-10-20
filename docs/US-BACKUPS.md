# Private US SQLite backups

Run in the actual backend runtime with explicit absolute DATA_DIR and an existing private output directory outside the source checkout:

```sh
python -m app.services.us_backup --kind plans --output /private-backups/plans-unique.sqlite3
python -m app.services.us_backup --kind jobs --output /private-backups/jobs-unique.sqlite3
```

Choose a new filename for each run. The command opens source read-only, exclusively creates a private destination, uses SQLite online backup (including committed WAL state), checks integrity and flushes the file. It never overwrites an existing target or creates a missing source DB. Partial new files are removed on handled failure; process termination can leave an incomplete file, which must not be treated as a verified backup. Progress is bounded to 30 seconds; lock/access failures return nonzero and sanitized JSON without paths, owner records or exception text. Filesystem/ACL controls remain the operator's responsibility, especially on Windows.

This covers plan/job SQLite files only. Immutable research JSON is also required to reopen original plan evidence; plan DB backups alone are not a complete product restore. Refresh coordination DBs must not be copied/replaced while workers run. Never put backups in Git, public storage, chat or a shared URL. A backup on the same disk does not cover disk loss: configure private off-host retention separately with approved access.

## Restore rehearsal

Stop the API and writers before restoring. Retain the current data directory privately. Restore into a separate offline directory using an inspected copy of the verified backup, together with the matching immutable research files. Check SQLite integrity; use the existing owner-scoped repository reads to verify old/latest plan revisions and foreign-owner rejection. Reopen the exact source package/setup, then exercise the invited-user workflow in the private service. Do not replace a live database or its WAL/SHM files. No automated in-place restore or scheduled deletion is supplied.

Synthetic tests exercise committed WAL state, old/latest owner revisions, job identity, foreign-owner rejection, existing-file preservation, missing/corrupt sources and sanitized command failure. They do not establish production scheduling, encryption, retention, off-host access controls, full research restore or hosted recovery time. Complete the weekend checklist on the chosen persistent volume before signing off.
