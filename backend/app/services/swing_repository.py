"""Durable research packages and private plan revisions. No broker execution."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

from app.config import settings


def identity(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str, separators=(",", ":")).encode()).hexdigest()


def now_iso() -> str:
    return datetime.now(settings.TIMEZONE).isoformat()


@contextmanager
def database(database_path: Path | None = None):
    target = database_path if database_path is not None else settings.DATA_DIR / "swing_research.sqlite3"
    target.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(target, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS daily_bars (
            symbol TEXT NOT NULL, session TEXT NOT NULL, payload TEXT NOT NULL,
            observed_at TEXT NOT NULL, PRIMARY KEY(symbol, session));
        CREATE TABLE IF NOT EXISTS research_packages (
            id TEXT PRIMARY KEY, universe TEXT NOT NULL, session TEXT NOT NULL,
            state TEXT NOT NULL, published_at TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS research_jobs (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS conditional_plans (
            id TEXT NOT NULL, revision INTEGER NOT NULL, owner TEXT NOT NULL,
            updated_at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(id, revision));
    """)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def save_bars(symbol: str, bars: list[dict]) -> None:
    with database() as conn:
        conn.executemany("INSERT OR REPLACE INTO daily_bars VALUES (?, ?, ?, ?)", [
            (symbol, str(bar["date"])[:10], json.dumps(bar, default=str), now_iso()) for bar in bars
        ])


def load_bars(symbol: str) -> list[dict]:
    with database() as conn:
        return [json.loads(row[0]) for row in conn.execute(
            "SELECT payload FROM daily_bars WHERE symbol=? ORDER BY session", (symbol,))]


def source_manifest(symbols: list[str]) -> list[dict]:
    if not symbols:
        return []
    with database() as conn:
        placeholders = ",".join("?" for _ in symbols)
        return [dict(row) for row in conn.execute(
            f"SELECT symbol, MAX(session) last_session, MAX(observed_at) last_observed_at, COUNT(*) stored_bars FROM daily_bars WHERE symbol IN ({placeholders}) GROUP BY symbol", symbols)]


def publish(package: dict) -> dict:
    package_id = identity({k: v for k, v in package.items() if k not in {"computed_at", "published_at", "source_manifest"}})
    saved = {**package, "id": package_id, "published_at": now_iso()}
    with database() as conn:
        conn.execute("INSERT OR IGNORE INTO research_packages VALUES (?, ?, ?, ?, ?, ?)",
                     (package_id, package["universe"], package["session"], package["state"], saved["published_at"], json.dumps(saved)))
        return json.loads(conn.execute("SELECT payload FROM research_packages WHERE id=?", (package_id,)).fetchone()[0])


def latest_package(universe: str, final_only: bool = True) -> dict | None:
    with database() as conn:
        row = conn.execute("SELECT payload FROM research_packages WHERE universe=? " +
                           ("AND state='final' " if final_only else "") +
                           "ORDER BY session DESC, published_at DESC LIMIT 1", (universe,)).fetchone()
        return json.loads(row[0]) if row else None


def get_package(package_id: str) -> dict | None:
    with database() as conn:
        row = conn.execute("SELECT payload FROM research_packages WHERE id=?", (package_id,)).fetchone()
        return json.loads(row[0]) if row else None


def package_sessions(universe: str) -> list[dict]:
    with database() as conn:
        # Metadata only: do not deserialize every historical chart package.
        rows = conn.execute("SELECT id, session, published_at FROM research_packages WHERE universe=? AND state='final' ORDER BY session DESC, published_at DESC", (universe,))
        sessions = {}
        for row in rows:
            sessions.setdefault(row["session"], dict(row))
            if len(sessions) >= 60:
                break
        return list(sessions.values())


def save_job(job: dict, *, database_path: Path | None = None, updated_at: str | None = None) -> None:
    with database(database_path) as conn:
        conn.execute("INSERT OR REPLACE INTO research_jobs VALUES (?, ?, ?, ?)",
                     (job["id"], job["owner"], updated_at or now_iso(), json.dumps(job)))


def create_job(job: dict) -> None:
    with database() as conn:
        conn.execute("BEGIN IMMEDIATE")
        for row in conn.execute("SELECT updated_at, payload FROM research_jobs"):
            data = json.loads(row[1])
            age = (datetime.now(settings.TIMEZONE) - datetime.fromisoformat(row[0])).total_seconds()
            if data["state"] in {"queued", "running"} and age < 900:
                raise ValueError("A research refresh is already running. Saved research remains available.")
        conn.execute("INSERT INTO research_jobs VALUES (?, ?, ?, ?)", (job["id"], job["owner"], now_iso(), json.dumps(job)))


def get_job(job_id: str, owner: str, *, database_path: Path | None = None, stale_after: int | None = 900) -> dict | None:
    with database(database_path) as conn:
        row = conn.execute("SELECT payload, updated_at FROM research_jobs WHERE id=? AND owner=?", (job_id, owner)).fetchone()
        if not row:
            return None
        job = json.loads(row[0])
        age = (datetime.now(settings.TIMEZONE) - datetime.fromisoformat(row[1])).total_seconds()
        if stale_after is not None and job["state"] in {"queued", "running"} and age > stale_after:
            return {**job, "state": "interrupted", "error": "No progress for 15 minutes. Retry refresh; last final package is preserved."}
        return job


def list_plans(owner: str, *, database_path: Path | None = None) -> list[dict]:
    with database(database_path) as conn:
        rows = conn.execute("""SELECT p.payload FROM conditional_plans p
            JOIN (SELECT id, MAX(revision) revision FROM conditional_plans WHERE owner=? GROUP BY id) latest
            ON p.id=latest.id AND p.revision=latest.revision WHERE p.owner=? ORDER BY p.updated_at DESC""", (owner, owner))
        return [json.loads(row[0]) for row in rows]


def get_plan(owner: str, plan_id: str, revision: int, *, database_path: Path | None = None) -> dict | None:
    with database(database_path) as conn:
        row = conn.execute("SELECT payload FROM conditional_plans WHERE owner=? AND id=? AND revision=?", (owner, plan_id, revision)).fetchone()
        return json.loads(row[0]) if row else None


def save_plan(owner: str, plan_id: str, expected_revision: int, payload: dict, *,
              database_path: Path | None = None, updated_at: str | None = None,
              immutable_fields: tuple[str, ...] = ("setup_id",)) -> dict:
    with database(database_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute("SELECT owner, MAX(revision) revision FROM conditional_plans WHERE id=? GROUP BY owner", (plan_id,)).fetchone()
        if existing and existing["owner"] != owner:
            raise PermissionError("Plan not found")
        revision = existing["revision"] if existing else 0
        if revision != expected_revision:
            raise ValueError("Plan changed; reload before saving another revision")
        if existing:
            previous = json.loads(conn.execute("SELECT payload FROM conditional_plans WHERE id=? AND revision=?", (plan_id, revision)).fetchone()[0])
            if any(previous.get(key) != payload.get(key) for key in immutable_fields):
                raise ValueError("A different thesis requires a new plan")
        saved = {**payload, "id": plan_id, "revision": revision + 1, "updated_at": updated_at or now_iso()}
        conn.execute("INSERT INTO conditional_plans VALUES (?, ?, ?, ?, ?)",
                     (plan_id, revision + 1, owner, saved["updated_at"], json.dumps(saved)))
        return saved
