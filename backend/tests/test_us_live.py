from datetime import datetime,timezone,timedelta
import asyncio
import httpx
import pytest
from app.services.us_live import quote_diagnostic,event_age,snapshot

NOW=datetime(2026,10,19,14,tzinfo=timezone.utc)
def quote(seconds=1,**changes):
    return {'bp':100,'ap':100.02,'t':(NOW-timedelta(seconds=seconds)).isoformat(),**changes}

def test_fresh_and_stale_quote_are_distinct_from_last_trade():
    row=quote_diagnostic('AAPL',quote(),{'p':99,'t':(NOW-timedelta(days=3)).isoformat()},NOW)
    assert row['quote_status']=='fresh'
    assert row['trade_status']=='stale'
    assert row['spread_bps']==pytest.approx(1.9998,rel=.001)
    assert quote_diagnostic('AAPL',quote(seconds=31),{},NOW)['quote_status']=='stale'

@pytest.mark.parametrize('changes',[{'bp':0},{'ap':float('nan')},{'bp':102},{'t':'bad'},{'t':(NOW+timedelta(minutes=1)).isoformat()}])
def test_invalid_and_future_quotes_never_become_fresh(changes):
    assert quote_diagnostic('AAPL',quote(**changes),{},NOW)['quote_status']=='invalid'

def test_wide_spread_and_unknown_data():
    assert quote_diagnostic('AAPL',quote(ap=104),{},NOW)['wide_spread']
    assert quote_diagnostic('AAPL',{},None,NOW)['quote_status']=='invalid'
    assert event_age('2026-10-19T14:00:00',NOW) is None


def test_feed_denied_is_not_silently_downgraded():
    requests=[]
    def handler(request):
        requests.append(request)
        return httpx.Response(403,json={'message':'permission denied'}) if 'data.alpaca' in str(request.url) else httpx.Response(200,json={'is_open':True,'timestamp':NOW.isoformat()})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result=await snapshot(['AAPL'],'sip',client)
        assert result['state']=='denied'
        assert result['feed']=='sip'
        assert result['rows'][0]['quote_status']=='invalid'
    asyncio.run(run())
    assert all(r.url.params.get('feed')=='sip' for r in requests if 'data.alpaca' in str(r.url))
