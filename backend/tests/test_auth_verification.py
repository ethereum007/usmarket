import asyncio
from dataclasses import replace

from fastapi import HTTPException

from app import dependencies


def _clear_auth_state():
    with dependencies._auth_state_lock:
        dependencies._auth_user_cache.clear()
        dependencies._auth_inflight.clear()


def test_supabase_user_verification_caches_positive_result(monkeypatch):
    _clear_auth_state()
    calls = 0

    async def fake_fetch(_token):
        nonlocal calls
        calls += 1
        return {"id": "user-1", "email": "user@example.com"}

    monkeypatch.setattr(
        dependencies,
        "settings",
        replace(dependencies.settings, SUPABASE_URL="https://example.supabase.co"),
    )
    monkeypatch.setattr(dependencies, "_fetch_supabase_user", fake_fetch)

    first = asyncio.run(dependencies._verify_supabase_jwt("valid-token"))
    first["email"] = "mutated@example.com"
    second = asyncio.run(dependencies._verify_supabase_jwt("valid-token"))

    assert calls == 1
    assert second["email"] == "user@example.com"
    _clear_auth_state()


def test_supabase_user_verification_collapses_concurrent_requests(monkeypatch):
    _clear_auth_state()
    calls = 0

    async def fake_fetch(_token):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)
        return {"id": "user-1", "email": "user@example.com"}

    monkeypatch.setattr(
        dependencies,
        "settings",
        replace(dependencies.settings, SUPABASE_URL="https://example.supabase.co"),
    )
    monkeypatch.setattr(dependencies, "_fetch_supabase_user", fake_fetch)

    async def scenario():
        return await asyncio.gather(
            *(dependencies._verify_supabase_jwt("shared-token") for _ in range(5))
        )

    users = asyncio.run(scenario())

    assert calls == 1
    assert [user["id"] for user in users] == ["user-1"] * 5
    _clear_auth_state()


def test_supabase_auth_server_failure_is_not_reported_as_bad_token(monkeypatch):
    class Response:
        status_code = 503

    class Client:
        async def get(self, *_args, **_kwargs):
            return Response()

    monkeypatch.setattr(
        dependencies,
        "settings",
        replace(dependencies.settings, SUPABASE_URL="https://example.supabase.co"),
    )
    monkeypatch.setattr(dependencies, "_get_auth_http_client", lambda: Client())

    try:
        asyncio.run(dependencies._fetch_supabase_user("valid-token"))
    except HTTPException as exc:
        assert exc.status_code == 503
    else:
        raise AssertionError("Expected a transient authentication failure")
