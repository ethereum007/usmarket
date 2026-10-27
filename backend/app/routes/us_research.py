"""Saved US research APIs. Credentials never cross the browser boundary."""

from __future__ import annotations

import asyncio

import json

import re

import sqlite3
from datetime import datetime, timezone

from pathlib import Path

from types import SimpleNamespace

from uuid import uuid4
from threading import BoundedSemaphore

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException

from pydantic import BaseModel, Field

from typing import Literal

from app.config import settings

from app.us_auth import require_us_user

from app.services.us_research import run
from app.services import swing_repository as repository
from app.services.us_refresh_lock import acquire as acquire_refresh_lock, RefreshBusy, RefreshLock
from app.services.us_publication import validate as publication_order
from app.services import us_remote_research as remote_research
from app.services import us_remote_jobs as remote_jobs

router = APIRouter(prefix='/api/us/research', tags=['US research'])

# Free-worker protection across accounts; remote SQL still owns durable admission.
_REMOTE_REFRESH_CAPACITY = BoundedSemaphore(1)

DEFAULT_SYMBOLS = 'AAPL,MSFT,NVDA,AMZN,META,GOOGL,AVGO,TSLA,AMD,ORCL,CRM,PLTR,JPM,BAC,GS,V,MA,UNH,LLY,JNJ,XOM,CVX,CAT,GE,COST,WMT,HD,NFLX,MU,AMAT'


def job_database():
    return settings.DATA_DIR / 'us-refresh-jobs.sqlite3'


def persist_job(data: dict, access_token=None):
    saved = {**data, 'updated_at': datetime.now(timezone.utc).isoformat()}
    if remote_jobs.enabled():
        remote_jobs.execute('save', access_token, saved['id'], saved)
    else:
        repository.save_job(saved, database_path=job_database(), updated_at=saved['updated_at'])


STORAGE_ERRORS = (OSError, sqlite3.Error, ValueError, TypeError, KeyError)


def directory():

    return settings.DATA_DIR / 'us-research'

def package_summary(data: dict):
    try:
        if not isinstance(data, dict) or data.get('market') != 'US' or data.get('currency') != 'USD':
            raise ValueError()
        order = publication_order(data)
        symbols = data.get('symbols')
        if not isinstance(symbols, list) or not 1 <= len(symbols) <= 500:
            raise ValueError()
        if any(not isinstance(symbol, str) or not re.fullmatch(r'[A-Z][A-Z0-9.\-]{0,14}', symbol) for symbol in symbols):
            raise ValueError()
        if len(set(symbols)) != len(symbols) or data.get('benchmark') not in {'SPY', 'QQQ'} or data.get('feed') not in {'iex', 'sip'}:
            raise ValueError()
    except (ValueError, TypeError, AttributeError, KeyError):
        raise HTTPException(409, 'Saved US research metadata is invalid') from None
    return {key: data[key] for key in ('id', 'universe', 'session', 'state', 'benchmark', 'feed', 'computed_at', 'symbols')}, order


def read_package(package_id: str, access_token=None):
    if not re.fullmatch(r'[a-f0-9]{64}', package_id):
        raise HTTPException(422, 'Invalid package identity')
    if remote_research.enabled():
        data = remote_research.execute('get', access_token, package_id)
        if data is None:
            raise HTTPException(404, 'US research package not found')
        if data.get('id') != package_id:
            raise HTTPException(409, 'Invalid US research package')
        package_summary(data)
        return data
    try:
        data = json.loads((directory() / (package_id + '.json')).read_text(encoding='utf-8'))
    except FileNotFoundError:
        raise HTTPException(404, 'US research package not found') from None
    except (ValueError, UnicodeError):
        raise HTTPException(409, 'Saved US research content is invalid') from None
    except OSError:
        raise HTTPException(503, 'Saved US research is temporarily unavailable') from None
    if not isinstance(data, dict) or data.get('id') != package_id:
        raise HTTPException(409, 'Invalid US research package')
    package_summary(data)
    return data


@router.get('/access')
def access(user: dict = Depends(require_us_user)):
    return {'success': True, 'allowed': True, 'market': 'US', 'private_mvp': True}


@router.get('/packages')
def packages(user: dict = Depends(require_us_user)):
    rows = []
    unavailable = 0
    if remote_research.enabled():
        for data in remote_research.execute('list', user.get('_access_token')):
            try:
                row, order = package_summary(data)
                rows.append((order, row['id'], row))
            except HTTPException:
                unavailable += 1
        rows.sort(key=lambda item: (item[0], item[1]), reverse=True)
        return {'success':True, 'packages':[item[2] for item in rows[:120]],
                'unavailable_packages':unavailable, 'default_symbols':DEFAULT_SYMBOLS}
    try:
        paths = list(directory().glob('*.json'))
    except OSError:
        raise HTTPException(503, 'Saved US research catalog is temporarily unavailable') from None
    for path in paths:
        if not re.fullmatch(r'[a-f0-9]{64}', path.stem):
            continue
        try:
            data = read_package(path.stem)
            row, order = package_summary(data)
            rows.append((order, row['id'], row))
        except HTTPException:
            unavailable += 1
    rows.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return {'success': True, 'packages': [item[2] for item in rows[:120]],
            'unavailable_packages': unavailable, 'default_symbols': DEFAULT_SYMBOLS}


@router.get('/packages/{package_id}')

def package(package_id: str, user: dict = Depends(require_us_user)):

    return {'success': True, 'package': read_package(package_id, user.get('_access_token'))}

class RefreshRequest(BaseModel):

    symbols: str = Field(default=DEFAULT_SYMBOLS, min_length=1, max_length=1000)

    benchmark: Literal['SPY','QQQ'] = 'SPY'

    feed: Literal['sip','iex'] = 'sip'

async def refresh_job(job_data: dict, payload: RefreshRequest, lock: RefreshLock | None, access_token=None, capacity=None):
    data = {**job_data, 'state': 'running'}
    try:
        # Do not fetch or publish if durable running status cannot be recorded.
        await asyncio.to_thread(persist_job, data, access_token)
        try:
            package = await run(SimpleNamespace(symbols=payload.symbols, benchmark=payload.benchmark,
                                                feed=payload.feed, output=str(directory()),
                                                publish_local=not remote_research.enabled()))
            if remote_jobs.enabled():
                # Atomic remote publication/completion; do not issue a second terminal write.
                await asyncio.to_thread(remote_jobs.execute, 'publish', access_token, data['id'], package)
                return
            if remote_research.enabled():
                await asyncio.to_thread(remote_research.execute, 'publish', access_token, package['id'], package)
            data.update(state='completed', package_id=package['id'])
        except Exception:
            data.update(state='failed', error='Research refresh failed; saved research remains available')
        await asyncio.to_thread(persist_job, data, access_token)
    except (*STORAGE_ERRORS, HTTPException):
        # Last durable state is retained. A failed status write cannot certify failure
        # or completion of publication; never replace it with an invented result.
        pass
    finally:
        if lock is not None:
            lock.release()
        if capacity is not None:
            capacity.release()

@router.post('/refresh')

def refresh(payload: RefreshRequest, tasks: BackgroundTasks, user: dict = Depends(require_us_user)):

    symbols = sorted(set(s.strip().upper() for s in payload.symbols.split(',') if s.strip()))

    if not 1 <= len(symbols) <= 50 or any(not re.fullmatch(r'[A-Z][A-Z0-9.\-]{0,14}', s) for s in symbols):

        raise HTTPException(422, 'Use 1–50 valid ticker symbols per refresh')

    if payload.benchmark in symbols:

        raise HTTPException(422, 'Keep the benchmark separate from stock symbols')

    remote_coordination = remote_jobs.enabled()
    capacity = None
    if remote_coordination:
        if not _REMOTE_REFRESH_CAPACITY.acquire(blocking=False):
            raise HTTPException(429, 'Research refresh capacity is busy; retry shortly', headers={'Retry-After':'30'})
        capacity = _REMOTE_REFRESH_CAPACITY
    try:
        # Remote queued persistence reserves per-account admission across hosts.
        lock = None if remote_coordination else acquire_refresh_lock(settings.DATA_DIR / 'us-refresh-lock.sqlite3')
    except RefreshBusy:
        raise HTTPException(409, 'A US research refresh is already running') from None
    except (OSError, sqlite3.Error):
        raise HTTPException(503, 'Refresh coordination is temporarily unavailable') from None

    job_id = str(uuid4())
    data = {'id': job_id, 'owner': user['id'], 'state': 'queued'}
    try:
        # Exclusive ownership proves earlier API workers no longer hold this
        # coordinator. It does not prove whether their publication completed.
        if not remote_coordination:
            repository.interrupt_jobs(database_path=job_database(),
                updated_at=datetime.now(timezone.utc).isoformat(),
                message='Previous refresh worker no longer owns coordination; completion is unknown. Check saved research before retrying.')
        persist_job(data, user.get('_access_token'))
        tasks.add_task(refresh_job, data, payload.model_copy(update={'symbols':','.join(symbols)}), lock, user.get('_access_token'), capacity)
    except BaseException as exc:
        if lock is not None:
            lock.release()
        if capacity is not None:
            capacity.release()
        if isinstance(exc, STORAGE_ERRORS):
            raise HTTPException(503, 'Refresh status storage is temporarily unavailable') from None
        raise

    return {'success': True, 'job':{'id':job_id,'state':'queued'}}

@router.get('/jobs')
def recent_jobs(user: dict = Depends(require_us_user)):
    try:
        rows = remote_jobs.execute('list', user.get('_access_token')) if remote_jobs.enabled() else repository.list_jobs(user['id'], database_path=job_database(), limit=20)
        jobs = [{k: v for k, v in row.items() if k in {'id', 'state', 'updated_at', 'package_id', 'error', 'completion_unknown'}} for row in rows]
    except STORAGE_ERRORS:
        raise HTTPException(503, 'Refresh status storage is temporarily unavailable') from None
    return {'success': True, 'jobs': jobs, 'interruption_available': remote_jobs.enabled()}


@router.post('/jobs/{job_id}/interrupt')
def interrupt_job(job_id: str, user: dict = Depends(require_us_user)):
    from uuid import UUID
    try:
        if str(UUID(job_id)) != job_id:
            raise ValueError()
    except ValueError:
        raise HTTPException(422, 'Invalid refresh identity') from None
    if not remote_jobs.enabled():
        raise HTTPException(409, 'Explicit interruption requires remote refresh coordination')
    observed = remote_jobs.execute('interrupt', user.get('_access_token'), job_id)
    return {'success': True, 'job': observed}


@router.get('/jobs/{job_id}')

def job(job_id: str, user: dict = Depends(require_us_user)):

    try:
        data = remote_jobs.execute('get', user.get('_access_token'), job_id) if remote_jobs.enabled() else repository.get_job(job_id, user['id'], database_path=job_database(), stale_after=None)
    except STORAGE_ERRORS:
        raise HTTPException(503, 'Refresh status storage is temporarily unavailable') from None
    if not data:
        raise HTTPException(404, 'Refresh job not found')
    # A timestamp is evidence of the last write, not a heartbeat or a worker lease.
    return {'success': True, 'job': {k: v for k, v in data.items() if k != 'owner'}}

@router.get('/live')
async def live_quotes(symbols: str = 'AAPL,NVDA,SPY', feed: Literal['iex','sip'] = 'iex', user: dict = Depends(require_us_user)):
    members = sorted(set(s.strip().upper() for s in symbols.split(',') if s.strip()))
    if not 1 <= len(members) <= 10 or any(not re.fullmatch(r'[A-Z][A-Z0-9.\-]{0,14}', s) for s in members):
        raise HTTPException(422, 'Use 1-10 valid US symbols for quote diagnostics')
    from app.services.us_live import cached_snapshot
    return {'success': True, 'live': await cached_snapshot(members,feed)}
