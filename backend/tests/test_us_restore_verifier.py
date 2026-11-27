"""Restore-verifier regressions using synthetic cursor rows, never runtime data."""
from types import SimpleNamespace
from unittest.mock import patch

import pytest
import verify_us_restore as restore


class Connection:
    def __init__(self, name, payload):
        self.info = SimpleNamespace(dbname=name)
        self.payload = payload

    def __enter__(self):return self
    def __exit__(self, *args):return False

    def execute(self, query):
        if query.startswith('select to_jsonb(t)'):
            return SimpleNamespace(fetchall=lambda: [(self.payload,)])
        # The preceding structural inspection succeeds; record comparison must
        # independently detect changed JSON types even with intact schema/grants.
        return SimpleNamespace(fetchall=lambda: [('synthetic', 'check', True, True)] * 9)


@pytest.mark.parametrize('original,changed', [
    ({'payload': {'flag': True}}, {'payload': {'flag': 1}}),
    ({'payload': {'flag': False}}, {'payload': {'flag': 0}}),
    ({'payload': {'observations': [None, {'flag': True}]}},
     {'payload': {'observations': [None, {'flag': 1}]}}),
])
def test_restore_rejects_boolean_number_changes_despite_python_equality(original, changed):
    assert original == changed  # Regression: ordinary equality hid this change.
    connections = {
        'source': Connection('usmarket_contract_test', original),
        'restored': Connection('usmarket_contract_restore_test', changed),
    }
    with patch.object(restore.psycopg, 'connect', side_effect=connections.__getitem__):
        with pytest.raises(AssertionError, match='^Restored records differ$'):
            restore.verify('source', 'restored')


def test_record_collection_removes_cursor_tuples_for_recursive_json_comparison():
    payload = {'owner': 'synthetic-owner', 'payload': {'unknown': None, 'quantity': 1}}
    rows = restore.records(Connection('usmarket_contract_test', payload))
    assert rows == {table: [payload] for table in restore.TABLES}
    assert restore.same_value(rows, {table: [dict(payload)] for table in restore.TABLES})
