from datetime import datetime, timezone
import httpx
import pytest
from app.services.us_research import completed_sessions, normalize_bars, research_package, AlpacaHistory


def test_early_close_and_dst():
    calendar = [{'date':'2026-11-27', 'close':'13:00'}]
    assert completed_sessions(calendar, datetime(2026,11,27,18,29,tzinfo=timezone.utc)) == []
    assert completed_sessions(calendar, datetime(2026,11,27,18,30,tzinfo=timezone.utc)) == ['2026-11-27']
    assert completed_sessions([{'date':'2026-07-01','close':'16:00'}], datetime(2026,7,1,20,30,tzinfo=timezone.utc)) == ['2026-07-01']


def bar(day='2026-07-01', close=10):
    return dict(t=day+'T04:00:00Z', o=10,h=12,l=9,c=close,v=100)


def test_missing_calendar_and_bad_bars_are_excluded():
    assert normalize_bars([bar(), bar('2026-07-02'), bar(close=100)], ['2026-07-02']) == [dict(date='2026-07-02',open=10,high=12,low=9,close=10,volume=100)]


def test_missing_latest_benchmark_fails():
    with pytest.raises(ValueError, match='Benchmark missing'):
        research_package(['AAPL'], {'SPY':[]}, [{'date':'2026-07-01','close':'16:00'}], datetime(2026,7,2,tzinfo=timezone.utc))


def test_us_identity_partial_coverage_and_unknown_events():
    package = research_package(['AAPL','MSFT'], {'SPY':[bar()], 'AAPL':[bar()]}, [{'date':'2026-07-01','close':'16:00'}], datetime(2026,7,2,tzinfo=timezone.utc))
    assert package['market'] == 'US'
    assert package['benchmark'] == 'SPY'
    assert package['state'] == 'partial'
    assert package['missing_symbols'] == ['MSFT']
    assert package['earnings_status'] == 'unavailable'
    assert package['features']['AAPL']['rs20'] is None
    assert package['groups'] == []


def test_pagination_keeps_other_symbols():
    import asyncio
    calls=[]
    def handler(request):
        calls.append(request)
        if request.url.path.endswith('calendar'):
            return httpx.Response(200,json=[{'date':'2026-07-01','close':'16:00'}])
        if 'page_token' not in request.url.params:
            return httpx.Response(200,json={'bars':{'AAPL':[bar()]},'next_page_token':'next'})
        return httpx.Response(200,json={'bars':{'MSFT':[bar()]},'next_page_token':None})
    async def exercise():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            _, rows = await AlpacaHistory(client).load(['AAPL','MSFT'],'2026-07-01','2026-07-02')
        assert len(rows['AAPL']) == len(rows['MSFT']) == 1
    asyncio.run(exercise())
    assert calls[1].url.params['adjustment'] == 'split'


def test_immutable_publication_and_partial_preserves_final(tmp_path):
    import json
    from app.services.us_research import save_package
    original={'id':'a'*64,'universe':'us-test','session':'2026-07-01','state':'final','computed_at':'first'}
    path,saved=save_package(original,tmp_path)
    _,repeat=save_package({**original,'computed_at':'second'},tmp_path)
    assert repeat['computed_at']=='first'
    assert json.loads(path.read_text())['computed_at']=='first'
    save_package({**original,'id':'b'*64,'state':'partial'},tmp_path)
    assert json.loads((tmp_path/'us-test-latest-final.json').read_text())['id']=='a'*64


def test_benchmark_explanations_use_the_actual_package_input():
    from types import SimpleNamespace
    from unittest.mock import patch
    from app.services.swing_research import build_package
    import pandas as pd
    history=[{'date':day.strftime('%Y-%m-%d'),'open':100+i,'high':101+i,'low':99+i,'close':100+i,'volume':1000} for i,day in enumerate(pd.bdate_range('2024-01-01',periods=300))]
    signal=SimpleNamespace(strategy='TEST',signal='BULL',trigger_date='2025-01-01')
    with patch('app.services.swing_research.scan_swing_spectrum',return_value=[signal]), patch('app.services.swing_research.swing_signal_to_dict',return_value={'symbol':'AAPL','reasons':['Nifty 500 RS 20D +99.0 pp','Base held']}):
        result=build_package('us-test',['AAPL'],{'AAPL':history},history,market='US',benchmark_name='SPY',sector_map={})
    reasons=result['setups'][0]['reasons']
    assert 'SPY RS 20D +0.0 pp' in reasons
    assert 'SPY RS 60D +0.0 pp' in reasons
    assert not any('Nifty' in reason for reason in reasons)
