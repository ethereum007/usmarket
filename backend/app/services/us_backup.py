"""Private online SQLite backups. Never uploads data or replaces a live database."""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import time

REPOSITORY = Path(__file__).resolve().parents[3]
DATABASES = {'plans':'us-plans.sqlite3', 'jobs':'us-refresh-jobs.sqlite3'}


def backup_database(source: Path, target: Path):
    source = source.resolve(strict=True)
    if target.is_symlink():
        raise ValueError('Backup destination cannot be a symbolic link')
    target = target.resolve()
    if target.is_relative_to(REPOSITORY) or source == target:
        raise ValueError('Backup destination must be private and outside the source repository')
    if not target.parent.is_dir():
        raise ValueError('Create the private destination directory first')
    created = False
    try:
        # Exclusive creation prevents replacing a backup, symlink or live DB.
        descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(descriptor)
        created = True
        deadline = time.monotonic() + 30
        def progress(status, remaining, total):
            if time.monotonic() > deadline:
                raise TimeoutError('Backup exceeded time limit')
        with closing(sqlite3.connect(source.as_uri()+'?mode=ro', uri=True, timeout=5)) as reader:
            with closing(sqlite3.connect(target, timeout=5)) as destination:
                reader.backup(destination, pages=128, progress=progress, sleep=0.1)
                if destination.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise ValueError('Backup integrity check failed')
        with target.open('rb+') as handle:
            os.fsync(handle.fileno())
    except BaseException:
        if created:
            target.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kind', choices=DATABASES, required=True)
    parser.add_argument('--output', type=Path, required=True, help='New private file outside the source checkout; parent must exist')
    args = parser.parse_args()
    try:
        directory = Path(os.environ.get('DATA_DIR', ''))
        if not os.environ.get('DATA_DIR') or not directory.is_absolute() or not args.output.is_absolute():
            raise ValueError('Explicit absolute paths required')
        backup_database(directory/DATABASES[args.kind], args.output)
    except (OSError, ValueError, sqlite3.Error, TimeoutError):
        print(json.dumps({'success':False,'kind':args.kind,'error':'Backup not confirmed; check private source, destination and storage access'}))
        return 1
    print(json.dumps({'success':True,'kind':args.kind,'integrity':'ok',
                      'scope':'SQLite database only; research JSON, off-host retention and restore acceptance remain separate'}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
