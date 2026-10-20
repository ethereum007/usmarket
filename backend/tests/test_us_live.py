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


@pytest.mark.parametrize('value',[True,False,{},[],10**1000])
def test_non_price_values_never_become_valid_prices(value):
    row=quote_diagnostic('AAPL',quote(bp=value),{'p':value,'t':NOW.isoformat()},NOW)
    assert row['quote_status']=='invalid' and row['trade_status']=='invalid'


@pytest.mark.parametrize('value',[True,'private-provider-text',[1],23])
def test_non_object_rows_are_unavailable_without_crashing(value):
    row=quote_diagnostic('AAPL',value,value,NOW)
    assert row['quote_status']=='invalid' and row['trade_status']=='invalid'
    assert row['quote_timestamp'] is None and row['trade_timestamp'] is None


def live_result(overrides):
    observed=datetime.now(timezone.utc).isoformat()
    payloads={'clock':{'is_open':True,'timestamp':observed},
              'quotes':{'quotes':{'AAPL':{'bp':100,'ap':101,'t':observed}}},
              'trades':{'trades':{'AAPL':{'p':100,'t':observed}}}}
    payloads.update(overrides)
    def handler(request):
        name='clock' if '/clock' in request.url.path else 'quotes' if '/quotes/' in request.url.path else 'trades'
        return httpx.Response(200,json=payloads[name])
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await snapshot(['AAPL'],'iex',client)
    return asyncio.run(run())


@pytest.mark.parametrize('endpoint,payload', [('clock',[]),('quotes',[]),('quotes',{'quotes':[]}),
    ('trades',None),('trades',{'trades':True}),('quotes',{}),('trades',{})])
def test_malformed_envelopes_degrade_without_hiding_valid_other_endpoint(endpoint,payload):
    result=live_result({endpoint:payload})
    assert result['state']=='degraded' and endpoint in result['errors']
    assert result['feed']=='iex'
    if endpoint!='quotes':assert result['rows'][0]['quote_status']=='fresh'
    if endpoint!='trades':assert result['rows'][0]['trade_status']=='fresh'


@pytest.mark.parametrize('payload',[{'quotes':{}},{'quotes':{'AAPL':['private']}},
    {'quotes':{'AAPL':{'bp':True,'ap':101,'t':{'private':'value'}}}}])
def test_missing_or_malformed_requested_rows_never_claim_connected(payload):
    result=live_result({'quotes':payload})
    assert result['state']=='degraded' and result['rows'][0]['quote_status']=='invalid'
    assert result['rows'][0]['quote_timestamp'] is None
    assert 'private' not in str(result)


@pytest.mark.parametrize('clock',[{'is_open':'true','timestamp':NOW.isoformat()},
    {'is_open':True,'timestamp':'2026-10-20T10:00:00'},
    {'is_open':True,'timestamp':'bad'}, {'is_open':True,'timestamp':'2000-01-01T00:00:00+00:00'}])
def test_bad_or_stale_clock_cannot_claim_market_open(clock):
    result=live_result({'clock':clock})
    assert result['state']=='degraded' and result['market']['is_open'] is None
    assert result['market']['timestamp'] is None


def test_invalid_schedule_is_removed_without_discarding_valid_clock():
    result=live_result({'clock':{'is_open':False,'timestamp':datetime.now(timezone.utc).isoformat(),
                                'next_open':{'private':'value'}}})
    assert result['state']=='degraded'
    assert result['market']['is_open'] is False and result['market']['next_open'] is None
    assert 'private' not in str(result)


def test_connected_requires_valid_requested_observations_and_clock():
    result=live_result({})
    assert result['state']=='connected' and result['errors']=={}
    assert result['rows'][0]['quote_status']=='fresh'


def test_old_valid_quote_is_stale_not_invalid_or_fresh():
    old=(datetime.now(timezone.utc)-timedelta(hours=1)).isoformat()
    result=live_result({'quotes':{'quotes':{'AAPL':{'bp':100,'ap':101,'t':old}}}})
    assert result['rows'][0]['quote_status']=='stale'
    assert result['rows'][0]['quote_timestamp']==old
    assert result['state']=='connected'  # Transport validity is separate from freshness.


def test_non_json_response_is_degraded_and_body_is_not_exposed():
    def handler(request):return httpx.Response(200,content=b'private malformed response')
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await snapshot(['AAPL'],'sip',client)
    result=asyncio.run(run())
    assert result['state']=='degraded' and result['feed']=='sip'
    assert 'private' not in str(result)


def test_large_finite_prices_do_not_overflow_spread_midpoint():
    row=quote_diagnostic('AAPL',quote(bp=1e308,ap=1.7e308),{},NOW)
    assert row['spread_bps']==pytest.approx(5185.185185)
    assert row['wide_spread'] is True
