from concurrent.futures import ThreadPoolExecutor
import json
import multiprocessing
from pathlib import Path
from threading import Barrier
from unittest.mock import patch

import pytest

from app.services.us_research import save_package
from app.services import us_publication as publication


def package(key="a", session="2026-07-01", computed="2026-07-02T00:00:00+00:00", state="final"):
    return {"id": key * 64, "universe": "us-test", "session": session,
            "computed_at": computed, "state": state, "market": "US", "evidence": [1, 2, 3]}


def pointer(root):
    return json.loads((root / "us-test-latest-final.json").read_text(encoding="utf-8"))["id"]


def test_late_older_session_cannot_regress_latest_final(tmp_path):
    newest = package("b", "2026-07-02", "2026-07-02T21:00:00+00:00")
    save_package(newest, tmp_path)
    older = package("a", "2026-07-01", "2026-07-03T00:00:00+00:00")
    path, _ = save_package(older, tmp_path)
    assert path.exists() and pointer(tmp_path) == newest["id"]


def test_same_session_order_compares_instants_not_timestamp_strings(tmp_path):
    newer = package("b", computed="2026-07-02T00:30:00+00:00")
    save_package(newer, tmp_path)
    save_package(package("a", computed="2026-07-02T05:30:00+05:30"), tmp_path)
    assert pointer(tmp_path) == newer["id"]


def test_partial_attempt_and_identity_collision_preserve_final(tmp_path):
    original = package()
    path, _ = save_package(original, tmp_path)
    save_package(package("b", "2026-07-02", state="partial"), tmp_path)
    with pytest.raises(ValueError, match="immutable"):
        save_package({**original, "evidence": [99]}, tmp_path)
    assert pointer(tmp_path) == original["id"]
    assert json.loads(path.read_text())["evidence"] == [1, 2, 3]


def test_equal_order_different_content_requires_review(tmp_path):
    first = package()
    save_package(first, tmp_path)
    with pytest.raises(ValueError, match="operator review"):
        save_package(package("b"), tmp_path)
    assert pointer(tmp_path) == first["id"]
    assert not (tmp_path / ("b" * 64 + ".json")).exists()


def test_replay_retains_first_observation_metadata(tmp_path):
    first = {**package(), "instrument_snapshot": {"id": "snapshot", "observed_at": "first"}}
    save_package(first, tmp_path)
    _, repeated = save_package({**first, "computed_at": "2026-07-02T01:00:00+00:00",
                               "instrument_snapshot": {"id": "snapshot", "observed_at": "later"}}, tmp_path)
    assert repeated == first


def test_independent_threads_publishing_same_identity_preserve_one_complete_file(tmp_path):
    save_package(package(), tmp_path)  # Initialize lock schema before the race.
    barrier = Barrier(2)
    def write(hour):
        barrier.wait(timeout=5)
        return save_package(package("b", "2026-07-02", f"2026-07-03T0{hour}:00:00+00:00"), tmp_path)[1]
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(write, [1, 2]))
    assert results[0] == results[1]
    assert pointer(tmp_path) == "b" * 64
    assert list(tmp_path.glob(".us-publish-*.tmp")) == []


def worker(root, payload, start, results):
    try:
        start.wait(timeout=10)
        save_package(payload, Path(root))
        results.put("ok")
    except Exception as exc:
        results.put(type(exc).__name__)


def test_separate_processes_share_publication_lock(tmp_path):
    save_package(package(), tmp_path)
    context = multiprocessing.get_context("spawn")
    start, results = context.Event(), context.Queue()
    payloads = [package("b", "2026-07-02"), package("c", "2026-07-03")]
    processes = [context.Process(target=worker, args=(str(tmp_path), payload, start, results)) for payload in payloads]
    try:
        for process in processes:
            process.start()
        start.set()
        assert [results.get(timeout=25) for _ in processes] == ["ok", "ok"]
        for process in processes:
            process.join(timeout=10)
            assert process.exitcode == 0
        assert pointer(tmp_path) == "c" * 64
    finally:
        for process in processes:
            if process.is_alive():
                process.terminate()
                process.join(timeout=5)
        results.close()


def test_pointer_write_failure_leaves_final_and_retry_recovers(tmp_path):
    original = package()
    save_package(original, tmp_path)
    next_package = package("b", "2026-07-02")
    real_replace = publication.os.replace
    def fail_pointer(source, target):
        if str(target).endswith("latest-final.json"):
            raise OSError("synthetic disk failure")
        return real_replace(source, target)
    with patch.object(publication.os, "replace", side_effect=fail_pointer):
        with pytest.raises(OSError):
            save_package(next_package, tmp_path)
    assert pointer(tmp_path) == original["id"]
    assert list(tmp_path.glob(".us-publish-*.tmp")) == []
    save_package(next_package, tmp_path)
    assert pointer(tmp_path) == next_package["id"]


def test_corrupt_pointer_is_not_silently_replaced(tmp_path):
    save_package(package(), tmp_path)
    target = tmp_path / "us-test-latest-final.json"
    target.write_text('{"id":"../private"}')
    with pytest.raises(ValueError, match="evidence is invalid"):
        save_package(package("b", "2026-07-02"), tmp_path)
    assert target.read_text() == '{"id":"../private"}'


@pytest.mark.parametrize("change", [{"id": "../bad"}, {"universe": "../bad"}, {"session": "bad"},
    {"computed_at": "2026-07-02T00:00:00"}, {"state": "live"}, {"evidence": [float("nan")]}])
def test_invalid_publication_cannot_write_final_pointer(tmp_path, change):
    with pytest.raises(ValueError):
        save_package({**package(), **change}, tmp_path)
    assert not (tmp_path / "us-test-latest-final.json").exists()


@pytest.mark.parametrize('original,changed', [(0,False), (False,0), (1,True), (True,1)])
def test_boolean_numeric_collision_cannot_replay_immutable_nested_evidence(tmp_path, original, changed):
    first = {**package(), 'source_bars':{'AAPL':[{'volume':original}]}}
    path, _ = save_package(first,tmp_path)
    before = path.read_bytes()
    with pytest.raises(ValueError,match='immutable'):
        save_package({**first,'source_bars':{'AAPL':[{'volume':changed}]}},tmp_path)
    assert path.read_bytes() == before
    assert pointer(tmp_path) == first['id']


def test_equivalent_json_numbers_remain_valid_immutable_replay(tmp_path):
    first = {**package(), 'source_bars':{'AAPL':[{'close':100,'volume':0}]}}
    save_package(first,tmp_path)
    _, replayed = save_package({**first,'source_bars':{'AAPL':[{'close':100.0,'volume':0.0}]}},tmp_path)
    assert replayed == first
