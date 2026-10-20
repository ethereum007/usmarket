import multiprocessing
from concurrent.futures import ThreadPoolExecutor
import pytest
from app.services.us_refresh_lock import acquire, RefreshBusy


def hold_lock(path, ready):
    lock=acquire(path)
    ready.send(True)
    ready.recv()  # Parent terminates this process while it still owns the lock.
    lock.release()


def attempt_lock(path):
    try:
        lock=acquire(path)
        lock.release()
        return True
    except RefreshBusy:
        return False


def test_two_connections_and_thread_handoff(tmp_path):
    path=tmp_path/'lock.sqlite3'
    lock=acquire(path)
    with pytest.raises(RefreshBusy):acquire(path)
    with ThreadPoolExecutor(max_workers=1) as pool:
        assert not pool.submit(attempt_lock,path).result()
        pool.submit(lock.release).result()
    lock.release()  # Idempotent cleanup.
    replacement=acquire(path);replacement.release()


def test_separate_process_exclusion_and_recovery_after_forced_exit(tmp_path):
    context=multiprocessing.get_context('spawn')
    parent,child=context.Pipe()
    path=tmp_path/'lock.sqlite3'
    process=context.Process(target=hold_lock,args=(path,child))
    process.start()
    try:
        assert parent.poll(20), 'Child did not acquire lock'
        assert parent.recv() is True
        with pytest.raises(RefreshBusy):acquire(path)
        process.terminate();process.join(10)
        assert not process.is_alive()
        replacement=acquire(path);replacement.release()
    finally:
        if process.is_alive():process.terminate();process.join(10)
        parent.close();child.close()


def test_invalid_storage_is_not_misreported_as_busy(tmp_path):
    path=tmp_path/'lock.sqlite3';path.write_text('not a database',encoding='utf-8')
    import sqlite3
    with pytest.raises(sqlite3.DatabaseError):acquire(path)
