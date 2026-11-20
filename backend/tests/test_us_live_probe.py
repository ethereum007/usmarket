import asyncio
import copy
import json
from unittest.mock import AsyncMock

import pytest

from app.services import us_live_probe


def observation():
    return {'state': 'connected', 'feed': 'iex', 'market': {'is_open': True},
            'rows': [{'symbol': 'SPY', 'quote_status': 'fresh', 'trade_status': 'fresh',
                      'bid': 12345.67, 'private': 'PRIVATE_PROVIDER_PAYLOAD'}]}


def test_fresh_open_sample_and_allowlisted_output(monkeypatch):
    snapshot = AsyncMock(return_value=observation())
    monkeypatch.setattr(us_live_probe.us_live, 'snapshot', snapshot)
    result = asyncio.run(us_live_probe.report())
    snapshot.assert_awaited_once_with(['SPY'], 'iex')
    assert result['passed'] is True
    assert set(result) == {'state', 'feed', 'market_open', 'quote_status', 'trade_status', 'passed', 'scope', 'observed_at'}
    assert 'PRIVATE_PROVIDER_PAYLOAD' not in json.dumps(result)
    assert '12345.67' not in json.dumps(result)


@pytest.mark.parametrize('change', [
    {'market': {'is_open': False}}, {'market': {'is_open': 1}},
    {'state': 'denied'}, {'state': 'PRIVATE_PROVIDER_PAYLOAD'}, {'feed': 'sip'},
    {'rows': []}, {'rows': [None]}, {'rows': [observation()['rows'][0]] * 2},
    {'rows': [{'symbol': 'QQQ', 'quote_status': 'fresh', 'trade_status': 'fresh'}]},
    {'rows': [{'symbol': 'SPY', 'quote_status': 'stale', 'trade_status': 'fresh'}]},
    {'rows': [{'symbol': 'SPY', 'quote_status': 'fresh', 'trade_status': 'PRIVATE_PROVIDER_PAYLOAD'}]},
])
def test_incomplete_or_invalid_sample_fails(monkeypatch, change):
    value = copy.deepcopy(observation())
    value.update(change)
    monkeypatch.setattr(us_live_probe.us_live, 'snapshot', AsyncMock(return_value=value))
    result = asyncio.run(us_live_probe.report())
    assert result['passed'] is False
    assert 'PRIVATE_PROVIDER_PAYLOAD' not in json.dumps(result)


def test_exception_is_sanitized(monkeypatch):
    monkeypatch.setattr(us_live_probe.us_live, 'snapshot', AsyncMock(side_effect=RuntimeError('PRIVATE_SECRET')))
    result = asyncio.run(us_live_probe.report())
    assert result['state'] == 'unavailable'
    assert result['passed'] is False
    assert 'PRIVATE_SECRET' not in json.dumps(result)


def test_cancellation_propagates(monkeypatch):
    monkeypatch.setattr(us_live_probe.us_live, 'snapshot', AsyncMock(side_effect=asyncio.CancelledError()))
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(us_live_probe.report())
