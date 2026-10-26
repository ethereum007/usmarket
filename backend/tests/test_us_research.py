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
    original={'id':'a'*64,'universe':'us-test','session':'2026-07-01','state':'final','computed_at':'2026-07-02T00:00:00+00:00'}
    path,saved=save_package(original,tmp_path)
    _,repeat=save_package({**original,'computed_at':'2026-07-02T01:00:00+00:00'},tmp_path)
    assert repeat['computed_at']=='2026-07-02T00:00:00+00:00'
    assert json.loads(path.read_text())['computed_at']=='2026-07-02T00:00:00+00:00'
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


@pytest.mark.parametrize('local',[False,True])
def test_generation_publication_mode_keeps_remote_off_local_filesystem(monkeypatch,tmp_path,local,capsys):
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock,patch
    from app.services import us_research as research
    monkeypatch.setenv('ALPACA_API_KEY','synthetic-test-key')
    monkeypatch.setenv('ALPACA_SECRET_KEY','synthetic-test-secret')
    args=SimpleNamespace(symbols='AAPL',benchmark='SPY',feed='sip',output=str(tmp_path))
    if not local:args.publish_local=False
    instruments={'records':{'SPY':{'resolution':'resolved'},'AAPL':{'resolution':'resolved'}}}
    package={'id':'a'*64,'state':'partial','session':'2026-10-23','breadth':{'available':1},'setups':[]}
    with patch.object(research,'load_dotenv'), \
         patch.object(research,'load_instruments',AsyncMock(return_value=instruments)), \
         patch.object(research.AlpacaHistory,'load',AsyncMock(return_value=([],{}))), \
         patch.object(research,'research_package',return_value=package), \
         patch.object(research,'bind_instruments',return_value=package), \
         patch.object(research,'save_package',side_effect=(lambda *args:(tmp_path/'synthetic.json',package)) if local else OSError('disk unavailable')) as publish:
        result=asyncio.run(research.run(args))
    assert result==package
    if local:publish.assert_called_once()
    else:
        publish.assert_not_called()
        assert capsys.readouterr().out==''
        assert list(tmp_path.iterdir())==[]
