"""Synthetic evidence only: isolation, restart persistence and real SQLite races."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
import json
import sqlite3
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app.config import settings
from app.routes import us_plans as api, us_research
from app.services import swing_repository as repo
from app.us_auth import require_us_user

PACKAGE = "a" * 64
VERSION = "b" * 64
SETUP = "c" * 64
SNAPSHOT = "d" * 64


def client_for(owner):
    app = FastAPI()
    app.include_router(api.router)
    app.dependency_overrides[require_us_user] = lambda: {"id": owner}
    return TestClient(app)


@pytest.fixture
def fixture(tmp_path):
    config = replace(settings, DATA_DIR=tmp_path)
    folder = tmp_path / "us-research"
    folder.mkdir()
    package = {"id": PACKAGE, "market": "US", "currency": "USD", "state": "final",
               "universe": "us-test", "computed_at": "2026-07-02T00:00:00+00:00",
               "symbols": ["AAPL"], "benchmark": "SPY", "feed": "sip",
               "session": "2026-07-01", "setups": [{"setup_version": VERSION, "setup_id": SETUP,
               "source_snapshot_id": SNAPSHOT, "symbol": "AAPL", "signal": "BULL"}]}
    path = folder / (PACKAGE + ".json")
    path.write_text(json.dumps(package), encoding="utf-8")
    payload = {"package_id": PACKAGE, "setup_version": VERSION, "trigger": 100, "stop": 95,
               "expiry": (date.today() + timedelta(days=30)).isoformat(), "exit_policy": "Review invalidation",
               "capital": 10000, "risk_pct": 1, "allocation_cap_pct": 20, "notes": "Synthetic test"}
    with patch.object(api, "settings", config), patch.object(us_research, "settings", config):
        yield client_for("owner-a"), client_for("owner-b"), payload, path, package, tmp_path


def test_revision_reload_restart_and_foreign_read_write(fixture):
    a, b, payload, _, _, root = fixture
    plan_id = str(uuid4())
    url = "/api/us/plans/" + plan_id
    first = a.post(url, json=payload)
    assert first.status_code == 200, first.text
    saved = first.json()["plan"]
    assert saved["quantity"] == 20
    assert saved["currency"] == "USD" and saved["timezone"] == "America/New_York"
    assert saved["execution_readiness"] == "PLANNING_ONLY" and not saved["filled"]
    assert "Unknown" in saved["event_risk"] and saved["updated_at"].endswith("+00:00")
    assert "owner" not in saved
    # Fresh app/client and fresh SQLite connection, no process-local state needed.
    restarted = client_for("owner-a")
    assert restarted.get(url + "?revision=1").json()["plan"] == saved
    assert b.get("/api/us/plans").json()["plans"] == []
    assert b.get(url + "?revision=1").status_code == 404
    assert b.post(url, json=payload).status_code == 404
    update = {**payload, "expected_revision": 1, "notes": "Second revision"}
    assert restarted.post(url, json=update).json()["plan"]["revision"] == 2
    assert restarted.get(url + "?revision=1").json()["plan"] == saved
    assert restarted.get("/api/us/plans").json()["plans"][0]["revision"] == 2
    assert restarted.post(url, json=update).status_code == 409
    assert not (root / "swing_research.sqlite3").exists()


def test_two_independent_writers_cannot_both_save_stale_revision(fixture):
    a, _, payload, _, _, _ = fixture
    url = "/api/us/plans/" + str(uuid4())
    assert a.post(url, json=payload).status_code == 200
    barrier = Barrier(2)
    def write(note):
        client = client_for("owner-a")
        barrier.wait(timeout=5)
        return client.post(url, json={**payload, "expected_revision": 1, "notes": note}).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(write, ["writer-a", "writer-b"])) == [200, 409]
    assert a.get(url + "?revision=2").status_code == 200
    assert a.get(url + "?revision=3").status_code == 404


@pytest.mark.parametrize("change", [
    {"trigger": 0}, {"stop": 100}, {"stop": 101}, {"capital": -1}, {"risk_pct": 6},
    {"allocation_cap_pct": 101}, {"setup_version": "e" * 64}, {"package_id": "../bad"},
    {"owner": "owner-b"}, {"filled": True}, {"earnings_state": "checked_no_event"},
    {"expiry": "2026-06-30"}, {"expected_revision": -1},
])
def test_invalid_or_spoofed_plan_fields_rejected(fixture, change):
    a, _, payload, _, _, _ = fixture
    assert a.post("/api/us/plans/" + str(uuid4()), json={**payload, **change}).status_code == 422
    assert a.get("/api/us/plans").json()["plans"] == []


@pytest.mark.parametrize("change", [{"state": "partial"}, {"currency": "INR"}])
def test_partial_or_wrong_currency_cannot_back_plan(fixture, change):
    a, _, payload, path, package, _ = fixture
    path.write_text(json.dumps({**package, **change}), encoding="utf-8")
    assert a.post("/api/us/plans/" + str(uuid4()), json=payload).status_code == (409 if "currency" in change else 422)


def test_revision_cannot_change_source_package_even_for_same_thesis(fixture):
    a, _, payload, path, package, _ = fixture
    url = "/api/us/plans/" + str(uuid4())
    assert a.post(url, json=payload).status_code == 200
    second_id = "f" * 64
    path.with_name(second_id + ".json").write_text(json.dumps({**package, "id": second_id}), encoding="utf-8")
    assert a.post(url, json={**payload, "expected_revision": 1, "package_id": second_id}).status_code == 409
    assert a.get(url + "?revision=2").status_code == 404


def test_decimal_sizing_whole_share_boundary_and_zero_capacity(fixture):
    a, _, payload, _, _, _ = fixture
    def quantity(**values):
        response = a.post("/api/us/plans/" + str(uuid4()), json={**payload, **values})
        assert response.status_code == 200, response.text
        return response.json()["plan"]["quantity"]
    assert quantity(trigger=0.3, stop=0.2, capital=100, risk_pct=1, allocation_cap_pct=100) == 10
    assert quantity(capital=1, allocation_cap_pct=1) == 0


def test_bearish_plan_does_not_claim_short_execution_readiness(fixture):
    a, _, payload, path, package, _ = fixture
    package["setups"][0]["signal"] = "BEAR"
    path.write_text(json.dumps(package), encoding="utf-8")
    response = a.post("/api/us/plans/" + str(uuid4()), json={**payload, "stop": 105})
    assert response.status_code == 200
    assert "unverified" in response.json()["plan"]["short_constraints"]


def test_storage_failure_does_not_echo_path_or_confirm_save(fixture):
    a, _, payload, _, _, _ = fixture
    with patch.object(repo, "save_plan", side_effect=sqlite3.OperationalError("private storage path")):
        response = a.post("/api/us/plans/" + str(uuid4()), json=payload)
    assert response.status_code == 503
    assert "private storage path" not in response.text
    assert a.get("/api/us/plans").json()["plans"] == []


def test_active_expiry_uses_new_york_date_and_rejects_expired_plan(fixture):
    a, _, payload, _, _, _ = fixture
    instant = datetime(2026, 10, 20, 1, tzinfo=timezone.utc)
    with patch.object(api, "datetime") as clock:
        clock.now.side_effect = lambda tz: instant.astimezone(tz)
        valid = {**payload, "state": "planned", "expiry": "2026-10-19"}
        assert a.post("/api/us/plans/" + str(uuid4()), json=valid).status_code == 200
        assert a.post("/api/us/plans/" + str(uuid4()), json={**valid, "expiry": "2026-10-18"}).status_code == 422


def test_sqlite_online_backup_restores_exact_private_revisions(fixture):
    a, _, payload, _, _, root = fixture
    plan_id = str(uuid4())
    url = "/api/us/plans/" + plan_id
    first = a.post(url, json=payload).json()["plan"]
    second = a.post(url, json={**payload, "expected_revision": 1, "notes": "Preserve this revision"}).json()["plan"]
    backup = root / "restore-test.sqlite3"
    with sqlite3.connect(root / "us-plans.sqlite3") as source, sqlite3.connect(backup) as target:
        source.backup(target)
    assert repo.get_plan("owner-a", plan_id, 1, database_path=backup) == first
    assert repo.get_plan("owner-a", plan_id, 2, database_path=backup) == second
    assert repo.list_plans("owner-b", database_path=backup) == []
    assert repo.get_plan("owner-b", plan_id, 1, database_path=backup) is None


def test_plan_endpoints_require_real_auth_even_on_localhost():
    from app.us_main import app
    client = TestClient(app)
    headers = {"Host": "localhost", "Origin": "http://localhost:3108"}
    assert client.get("/api/us/plans", headers=headers).status_code == 401
    assert client.get("/api/us/plans/" + str(uuid4()) + "?revision=1", headers=headers).status_code == 401
    assert client.post("/api/us/plans/" + str(uuid4()), json={}, headers=headers).status_code == 401


@pytest.mark.parametrize('direction,trigger,stop,quantity', [('BULL',100,95,20),('BEAR',100,105,20),('BULL',0.3,0.2,1000)])
def test_sizing_preview_matches_saved_policy_without_writing(fixture,direction,trigger,stop,quantity):
    a,_,payload,_,_,root=fixture
    values={key:payload[key] for key in ['trigger','stop','capital','risk_pct','allocation_cap_pct']}
    values.update(direction=direction,trigger=trigger,stop=stop)
    result=a.post('/api/us/plans/sizing-preview',json=values)
    assert result.status_code==200,result.text
    sizing=result.json()['sizing']
    assert sizing['quantity']==quantity
    assert sizing['stop_risk_usd']<=sizing['risk_budget_usd']
    assert sizing['planning_notional_usd']<=sizing['allocation_budget_usd']
    assert sizing['filled'] is False and sizing['execution_readiness']=='PLANNING_ONLY'
    assert a.get('/api/us/plans').json()['plans']==[]


def test_preview_zero_capacity_and_invalid_direction_stop(fixture):
    a,_,payload,*_=fixture
    values={key:payload[key] for key in ['trigger','stop','capital','risk_pct','allocation_cap_pct']}
    result=a.post('/api/us/plans/sizing-preview',json={**values,'direction':'BULL','capital':1})
    assert result.json()['sizing']['state']=='zero_capacity'
    assert a.post('/api/us/plans/sizing-preview',json={**values,'direction':'BULL','stop':100}).status_code==422
    assert a.post('/api/us/plans/sizing-preview',json={**values,'direction':'BULL','owner':'forged'}).status_code==422


def test_saved_revision_contains_same_authoritative_preview(fixture):
    a,_,payload,*_=fixture
    values={key:payload[key] for key in ['trigger','stop','capital','risk_pct','allocation_cap_pct']}
    expected=a.post('/api/us/plans/sizing-preview',json={**values,'direction':'BULL'}).json()['sizing']
    saved=a.post('/api/us/plans/'+str(uuid4()),json=payload).json()['plan']
    assert saved['sizing']==expected and saved['quantity']==expected['quantity']


def test_preview_requires_auth_and_rejects_unsafe_integer_precision(fixture):
    a,_,payload,*_=fixture
    values={key:payload[key] for key in ['trigger','stop','capital','risk_pct','allocation_cap_pct']}
    from app.us_main import app as hosted
    assert TestClient(hosted).post('/api/us/plans/sizing-preview',json={**values,'direction':'BULL'}).status_code==401
    response=a.post('/api/us/plans/sizing-preview',json={**values,'direction':'BEAR','trigger':0.0001,
        'stop':0.00010000000000000002,'capital':1000000000000,'risk_pct':5,'allocation_cap_pct':100})
    assert response.status_code==422 and 'precision' in response.text



def test_export_preserves_all_owner_revisions_and_exact_source(fixture):
    a, b, payload, _, _, root = fixture
    plan_id, foreign_id = str(uuid4()), str(uuid4())
    first = a.post('/api/us/plans/' + plan_id, json=payload).json()['plan']
    second = a.post('/api/us/plans/' + plan_id,
                    json={**payload, 'expected_revision': 1, 'notes': 'Private second revision'}).json()['plan']
    b.post('/api/us/plans/' + foreign_id, json={**payload, 'notes': 'Foreign private notes'})
    response = a.get('/api/us/plans/export')
    assert response.status_code == 200
    body = response.json()
    assert body['plan_revisions'] == [first, second]
    assert body['revision_count'] == 2 and body['market'] == 'US'
    assert body['schema_version'] == 1
    assert body['exported_at'].endswith('+00:00')
    assert 'Foreign private notes' not in response.text and foreign_id not in response.text
    assert 'owner-a' not in response.text
    assert response.headers['cache-control'] == 'private, no-store'
    assert 'attachment' in response.headers['content-disposition']
    assert client_for('empty-owner').get('/api/us/plans/export').json()['plan_revisions'] == []
    assert a.get('/api/us/plans/' + plan_id + '?revision=1').json()['plan'] == first


def test_export_storage_failure_does_not_return_partial_history(fixture):
    a, *_ = fixture
    with patch.object(repo, 'export_plan_revisions', side_effect=sqlite3.OperationalError('private path')):
        result = a.get('/api/us/plans/export')
    assert result.status_code == 503
    assert 'private path' not in result.text and 'plan_revisions' not in result.json()


def test_export_requires_authentication():
    app = FastAPI()
    app.include_router(api.router)
    response = TestClient(app).get('/api/us/plans/export')
    assert response.status_code == 401



def test_remote_plans_use_verified_token_without_owner_selector(fixture, monkeypatch):
    import httpx
    from app.services import us_remote_plans as remote
    from types import SimpleNamespace
    a, *_ = fixture
    monkeypatch.setenv('US_PLAN_STORE', 'supabase')
    monkeypatch.setattr(remote, 'settings', SimpleNamespace(SUPABASE_URL='https://us.example', SUPABASE_ANON_KEY='public-test'))
    requests = []
    transport = httpx.MockTransport(lambda request: (requests.append(request) or httpx.Response(200, json=[])))
    original = httpx.Client
    with patch.object(remote.httpx, 'Client', lambda **kwargs: original(transport=transport, **kwargs)):
        # Dependency fixture omits token: fail closed, no local fallback.
        assert a.get('/api/us/plans').status_code == 503
        assert requests == []
        assert remote.execute(repo.list_plans, ('forged-owner',), 'verified-token') == []
    assert requests[0].headers['authorization'] == 'Bearer verified-token'
    assert json.loads(requests[0].content) == {'action': 'list'}
    assert 'forged-owner' not in requests[0].content.decode()


@pytest.mark.parametrize('status,body,expected', [(409, {'code':'23505'},409),
    (400, {'code':'40001'},409), (500, {'private':'secret'},503), (200, {'wrong':'shape'},503)])
def test_remote_storage_conflicts_and_failures_are_sanitized(status,body,expected,monkeypatch):
    import httpx
    from app.services import us_remote_plans as remote
    from types import SimpleNamespace
    monkeypatch.setattr(remote, 'settings', SimpleNamespace(SUPABASE_URL='https://us.example', SUPABASE_ANON_KEY='public-test'))
    transport = httpx.MockTransport(lambda request: httpx.Response(status, json=body))
    original = httpx.Client
    with patch.object(remote.httpx, 'Client', lambda **kwargs: original(transport=transport, **kwargs)):
        with pytest.raises(Exception) as error:
            remote.execute(repo.list_plans, ('owner-a',), 'verified-token')
    assert error.value.status_code == expected
    assert 'secret' not in str(error.value) and 'verified-token' not in str(error.value)


@pytest.mark.parametrize('change',[
    {'id':'22222222-2222-4222-8222-222222222222'}, {'revision':1}, {'revision':True},
    {'currency':'INR'}, {'source_snapshot_id':'wrong'}, {'package_id':'wrong'},
])
def test_remote_save_requires_exact_identity_revision_and_source(change,monkeypatch):
    import httpx
    from types import SimpleNamespace
    from fastapi import HTTPException
    from app.services import us_remote_plans as remote
    key='11111111-1111-4111-8111-111111111111'
    source={'market':'US','currency':'USD','setup_id':'setup','package_id':'a'*64,
        'setup_version':'b'*64,'source_snapshot_id':'c'*64,'symbol':'AAPL','direction':'BULL','provider_asset_id':'asset'}
    response={**source,'id':key,'revision':2,**change}
    monkeypatch.setattr(remote,'settings',SimpleNamespace(SUPABASE_URL='https://us.example',SUPABASE_ANON_KEY='public-test'))
    original=httpx.Client
    transport=httpx.MockTransport(lambda request:httpx.Response(200,json=response))
    with patch.object(remote.httpx,'Client',lambda **kwargs:original(transport=transport,**kwargs)):
        with pytest.raises(HTTPException) as error:remote.execute(repo.save_plan,('owner',key,1,source),'token')
    assert error.value.status_code==503
    assert 'wrong' not in str(error.value) and key not in str(error.value)


def test_verified_plan_retains_notes_but_strips_identity_transport_fields():
    from app.services.us_remote_plans import verified_plan
    key='11111111-1111-4111-8111-111111111111'
    row={'id':key,'revision':2,'market':'US','currency':'USD','notes':'My thesis',
        'owner':'private-owner','_access_token':'private-token'}
    assert verified_plan(row,key,2)=={k:v for k,v in row.items() if k not in {'owner','_access_token'}}


@pytest.mark.parametrize('change',[
    {'notes':'Changed private notes'}, {'trigger':200}, {'stop':50}, {'capital':20000},
    {'quantity':True}, {'state':'cancelled'}, {'sizing':{'quantity':2,'risk_budget_usd':100}},
    {'unexpected_saved_field':'unrequested'},
])
def test_remote_save_acknowledgement_matches_all_plan_content(monkeypatch,change):
    import httpx
    from types import SimpleNamespace
    from fastapi import HTTPException
    from app.services import us_remote_plans as remote
    key='11111111-1111-4111-8111-111111111111'
    values={'market':'US','currency':'USD','setup_id':'setup','package_id':'a'*64,
            'notes':'Original private notes','trigger':100.0,'stop':90.0,'capital':10000.0,
            'quantity':1,'state':'draft','sizing':{'quantity':1,'risk_budget_usd':100}}
    row={**values,'id':key,'revision':1,'updated_at':'2026-10-26T00:00:00Z',**change}
    monkeypatch.setattr(remote,'settings',SimpleNamespace(SUPABASE_URL='https://us.example',SUPABASE_ANON_KEY='public-test'))
    original=httpx.Client
    transport=httpx.MockTransport(lambda request:httpx.Response(200,json=row))
    with patch.object(remote.httpx,'Client',lambda **kwargs:original(transport=transport,**kwargs)):
        with pytest.raises(HTTPException) as error:remote.execute(repo.save_plan,('owner',key,0,values),'token')
    assert error.value.status_code==503
    assert 'private notes' not in str(error.value) and 'unrequested' not in str(error.value)


def test_remote_save_accepts_original_timestamp_and_equivalent_json_numbers():
    from app.services.us_remote_plans import verified_plan
    key='11111111-1111-4111-8111-111111111111'
    values={'market':'US','currency':'USD','quantity':1,'trigger':100.0,'filled':False,
            'sizing':{'risk_budget_usd':100.0},'notes':'Exact retained thesis'}
    row={**values,'id':key,'revision':2,'trigger':100,'sizing':{'risk_budget_usd':100},
         'updated_at':'2026-10-20T00:00:00Z','owner':'private-owner','_access_token':'private-token'}
    result=verified_plan(row,key,2,values)
    assert result['updated_at']=='2026-10-20T00:00:00Z'
    assert result['notes']==values['notes'] and 'owner' not in result and '_access_token' not in result


@pytest.mark.parametrize('field', ['trigger', 'stop', 'capital', 'risk_pct', 'allocation_cap_pct'])
@pytest.mark.parametrize('value', [True, False, '1'])
def test_sizing_inputs_require_json_numbers_before_calculation_or_storage(fixture, field, value):
    a, _, payload, _, _, root = fixture
    preview = {key:payload[key] for key in ('trigger','stop','capital','risk_pct','allocation_cap_pct')}
    # No calculation, source read or persistence may occur after invalid input.
    with patch.object(api, 'calculate_sizing') as sizing, patch.object(api, 'read_package') as source, patch.object(api, 'store') as storage:
        responses = [
            a.post('/api/us/plans/sizing-preview', json={**preview, 'direction':'BULL', field:value}),
            a.post('/api/us/plans/'+str(uuid4()), json={**payload, field:value}),
        ]
    for response in responses:
        assert response.status_code == 422
        assert any(error['loc'] == ['body',field] for error in response.json()['detail'])
    sizing.assert_not_called()
    source.assert_not_called()
    storage.assert_not_called()
    assert not (root/'us-plans.sqlite3').exists()


@pytest.mark.parametrize('value', [True, False, 1.0, 1.5, '1'])
def test_expected_revision_requires_json_integer_before_source_or_storage(fixture, value):
    a, _, payload, _, _, _ = fixture
    with patch.object(api, 'read_package') as source, patch.object(api, 'store') as storage:
        response = a.post('/api/us/plans/'+str(uuid4()), json={**payload, 'expected_revision':value})
    assert response.status_code == 422
    assert any(error['loc'] == ['body','expected_revision'] for error in response.json()['detail'])
    source.assert_not_called()
    storage.assert_not_called()


def test_strict_sizing_preserves_integer_and_fractional_json_numbers(fixture):
    a, _, _, _, _, _ = fixture
    values = {'direction':'BULL', 'trigger':100, 'stop':95.5, 'capital':10000,
              'risk_pct':1.25, 'allocation_cap_pct':20}
    response = a.post('/api/us/plans/sizing-preview', json=values)
    assert response.status_code == 200
    sizing = response.json()['sizing']
    assert sizing['quantity'] == 20
    assert sizing['stop_risk_usd'] == 90
    assert sizing['risk_budget_usd'] == 125
