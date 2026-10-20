"""Saved US research APIs. Credentials never cross the browser boundary."""

from __future__ import annotations

import asyncio

import json

import re

import threading

from pathlib import Path

from types import SimpleNamespace

from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException

from pydantic import BaseModel, Field

from typing import Literal

from app.config import settings

from app.us_auth import require_us_user

from app.services.us_research import run
from app.services.us_publication import validate as publication_order

router = APIRouter(prefix='/api/us/research', tags=['US research'])

DEFAULT_SYMBOLS = 'AAPL,MSFT,NVDA,AMZN,META,GOOGL,AVGO,TSLA,AMD,ORCL,CRM,PLTR,JPM,BAC,GS,V,MA,UNH,LLY,JNJ,XOM,CVX,CAT,GE,COST,WMT,HD,NFLX,MU,AMAT'

_lock = threading.Lock()

_jobs: dict[str, dict] = {}

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


def read_package(package_id: str):
    if not re.fullmatch(r'[a-f0-9]{64}', package_id):
        raise HTTPException(422, 'Invalid package identity')
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


@router.get('/packages')
def packages(user: dict = Depends(require_us_user)):
    rows = []
    unavailable = 0
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

    return {'success': True, 'package': read_package(package_id)}

class RefreshRequest(BaseModel):

    symbols: str = Field(default=DEFAULT_SYMBOLS, min_length=1, max_length=1000)

    benchmark: Literal['SPY','QQQ'] = 'SPY'

    feed: Literal['sip','iex'] = 'sip'

async def refresh_job(job_id: str, payload: RefreshRequest):

    job = _jobs[job_id]

    job['state'] = 'running'

    try:

        package = await run(SimpleNamespace(symbols=payload.symbols, benchmark=payload.benchmark, feed=payload.feed, output=str(directory())))

        job['state'] = 'completed'

        job['package_id'] = package['id']

    except Exception as exc:

        job['state'] = 'failed'

        # Provider response bodies and credentials must never enter the job API.

        job['error'] = str(exc) if isinstance(exc, ValueError) else 'Provider refresh failed; saved research remains available'

    finally:

        _lock.release()

@router.post('/refresh')

def refresh(payload: RefreshRequest, tasks: BackgroundTasks, user: dict = Depends(require_us_user)):

    symbols = sorted(set(s.strip().upper() for s in payload.symbols.split(',') if s.strip()))

    if not 1 <= len(symbols) <= 50 or any(not re.fullmatch(r'[A-Z][A-Z0-9.\-]{0,14}', s) for s in symbols):

        raise HTTPException(422, 'Use 1–50 valid ticker symbols per refresh')

    if payload.benchmark in symbols:

        raise HTTPException(422, 'Keep the benchmark separate from stock symbols')

    if not _lock.acquire(blocking=False):

        raise HTTPException(409, 'A US research refresh is already running in this worker')

    if len(_jobs) >= 100:

        for key in list(_jobs):

            if _jobs[key]['state'] in {'completed','failed'}:

                del _jobs[key]

                break

    job_id = str(uuid4())

    _jobs[job_id] = {'id':job_id, 'owner':user['id'], 'state':'queued'}

    tasks.add_task(refresh_job, job_id, payload.model_copy(update={'symbols':','.join(symbols)}))

    return {'success': True, 'job':{'id':job_id,'state':'queued'}}

@router.get('/jobs/{job_id}')

def job(job_id: str, user: dict = Depends(require_us_user)):

    data = _jobs.get(job_id)

    if not data or data['owner'] != user['id']:

        raise HTTPException(404, 'Refresh job not found; a server restart clears job progress')

    return {'success': True, 'job':{k:v for k,v in data.items() if k != 'owner'}}

@router.get('/live')
async def live_quotes(symbols: str = 'AAPL,NVDA,SPY', feed: Literal['iex','sip'] = 'iex', user: dict = Depends(require_us_user)):
    members = sorted(set(s.strip().upper() for s in symbols.split(',') if s.strip()))
    if not 1 <= len(members) <= 10 or any(not re.fullmatch(r'[A-Z][A-Z0-9.\-]{0,14}', s) for s in members):
        raise HTTPException(422, 'Use 1-10 valid US symbols for quote diagnostics')
    from app.services.us_live import cached_snapshot
    return {'success': True, 'live': await cached_snapshot(members,feed)}
