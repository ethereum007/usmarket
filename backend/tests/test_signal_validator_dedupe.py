from app.services import signal_validator


class FakeQuery:
    def __init__(self, owner, table):
        self.owner = owner
        self.table = table
        self.operation = None
        self.payload = None

    def select(self, *_args):
        self.operation = "select"
        return self

    def insert(self, payload):
        self.operation = "insert"
        self.payload = payload
        return self

    def eq(self, *_args):
        return self

    def gte(self, *_args):
        return self

    def limit(self, *_args):
        return self

    def execute(self):
        self.owner.calls.append((self.table, self.operation, self.payload))
        if self.table == "signal_fires" and self.operation == "select":
            return type("Response", (), {"data": self.owner.existing})()
        if self.table == "signal_fires" and self.operation == "insert":
            if self.owner.fail_fire_insert:
                raise RuntimeError("database unavailable")
            return type("Response", (), {"data": [{"id": "fire-1"}]})()
        return type("Response", (), {"data": []})()


class FakeClient:
    def __init__(self, *, existing=None, fail_fire_insert=False):
        self.calls = []
        self.existing = list(existing or [])
        self.fail_fire_insert = fail_fire_insert

    def table(self, name):
        return FakeQuery(self, name)


def _clear_local_dedupe():
    with signal_validator._recent_signal_fires_lock:
        signal_validator._recent_signal_fires.clear()


def _log_fire():
    return signal_validator.log_signal_fire(
        symbol="RELIANCE",
        signal_type="INTRADAY_BREAKOUT",
        trigger_price=100.0,
        strength=80.0,
        direction="BULLISH",
    )


def test_repeated_signal_is_deduped_without_requerying_supabase(monkeypatch):
    _clear_local_dedupe()
    client = FakeClient()
    monkeypatch.setattr(signal_validator, "get_supabase_client", lambda: client)

    assert _log_fire() == "fire-1"
    assert _log_fire() is None

    assert [(table, operation) for table, operation, _payload in client.calls] == [
        ("signal_fires", "select"),
        ("signal_fires", "insert"),
        ("signal_outcomes", "insert"),
    ]
    _clear_local_dedupe()


def test_failed_signal_insert_releases_local_reservation(monkeypatch):
    _clear_local_dedupe()
    client = FakeClient(fail_fire_insert=True)
    monkeypatch.setattr(signal_validator, "get_supabase_client", lambda: client)

    assert _log_fire() is None
    client.fail_fire_insert = False
    assert _log_fire() == "fire-1"

    fire_selects = [
        call for call in client.calls if call[:2] == ("signal_fires", "select")
    ]
    assert len(fire_selects) == 2
    _clear_local_dedupe()
