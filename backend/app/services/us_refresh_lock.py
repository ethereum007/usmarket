"""Cooperating API-worker exclusion on one SQLite-compatible local volume."""
from pathlib import Path
import sqlite3


class RefreshBusy(Exception):
    pass


class RefreshLock:
    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection

    def release(self):
        connection, self.connection = self.connection, None
        if connection is not None:
            # Closing an uncommitted reservation releases it, including on errors.
            connection.close()


def acquire(path: Path) -> RefreshLock:
    path.parent.mkdir(parents=True, exist_ok=True)
    # The synchronous request hands sole ownership to its background task, which
    # can finish on another thread. No concurrent use of this connection occurs.
    connection = sqlite3.connect(path, timeout=0, check_same_thread=False)
    try:
        connection.execute("BEGIN IMMEDIATE")
        return RefreshLock(connection)
    except sqlite3.Error as exc:
        connection.close()
        if (getattr(exc, "sqlite_errorcode", 0) & 255) in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}:
            raise RefreshBusy() from None
        raise
    except BaseException:
        connection.close()
        raise
