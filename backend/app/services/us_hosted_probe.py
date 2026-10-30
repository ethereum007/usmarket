"""Read-only, credential-free hosted US HTTP boundary probe. Never reads bodies."""
import asyncio
from datetime import datetime, timezone
import json
import httpx

ORIGIN = 'https://usmarket.onrender.com'
REQUEST_DEADLINE_SECONDS = 25
PATHS = ('/api/health', '/api/us/plans', '/api/us/research/packages')


async def report(client=None):
    if client is None:
        async with httpx.AsyncClient(timeout=20, follow_redirects=False) as owned:
            return await report(owned)
    checks = []
    for path in PATHS:
        try:
            async with asyncio.timeout(REQUEST_DEADLINE_SECONDS):
                async with client.stream('GET', ORIGIN + path) as response:
                    row = {'path': path, 'status': response.status_code}
                    if path == '/api/health':
                        row['passed'] = response.status_code == 200
                    else:
                        cache = {part.strip().lower() for part in response.headers.get('cache-control', '').split(',')}
                        vary = {part.strip().lower() for part in response.headers.get('vary', '').split(',')}
                        row.update(private_no_store={'private', 'no-store'} <= cache,
                                   vary_authorization='authorization' in vary,
                                   bearer_challenge=response.headers.get('www-authenticate', '').lower() == 'bearer')
                        row['passed'] = response.status_code == 401 and all(row[key] for key in ('private_no_store', 'vary_authorization', 'bearer_challenge'))
                    checks.append(row)
        except (httpx.HTTPError, TimeoutError):
            checks.append({'path': path, 'passed': False, 'result': 'transport_unavailable'})
    return {'passed': all(row['passed'] for row in checks), 'checks': checks,
            'observed_at': datetime.now(timezone.utc).isoformat(),
            'scope': 'Anonymous HTTP status and cache headers only; deployed revision, sign-in, isolation and persistence unverified'}


def main():
    result = asyncio.run(report())
    print(json.dumps(result, sort_keys=True))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
