"""Bound private write bodies before JSON parsing; never logs request content."""
import asyncio

from starlette.responses import JSONResponse

MAX_BODY_BYTES = 256 * 1024
BODY_DEADLINE_SECONDS = 10


class USRequestBodyLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get('path', '')
        if (scope['type'] != 'http' or scope.get('method') not in {'POST', 'PUT', 'PATCH'}
                or not (path == '/api/us' or path.startswith('/api/us/'))):
            return await self.app(scope, receive, send)

        async def reject(status, detail):
            await JSONResponse({'detail': detail}, status_code=status, headers={
                'Cache-Control': 'private, no-store', 'Pragma': 'no-cache',
                'Expires': '0', 'Vary': 'Authorization',
            })(scope, receive, send)

        for key, value in scope.get('headers', []):
            if key.lower() == b'content-length' and value.isdigit():
                declared = value.lstrip(b'0') or b'0'
                if len(declared) > 9 or int(declared) > MAX_BODY_BYTES:
                    return await reject(413, 'US request body exceeds supported size')
        body = bytearray()
        oversized = False
        try:
            async with asyncio.timeout(BODY_DEADLINE_SECONDS):
                while True:
                    message = await receive()
                    if message['type'] == 'http.disconnect':
                        return
                    if message['type'] != 'http.request':
                        continue
                    chunk = message.get('body', b'')
                    if len(body) + len(chunk) > MAX_BODY_BYTES:
                        oversized = True
                        break
                    body.extend(chunk)
                    if not message.get('more_body', False):
                        break
        except TimeoutError:
            return await reject(408, 'US request body was not received in time')
        if oversized:
            return await reject(413, 'US request body exceeds supported size')

        delivered = False
        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {'type': 'http.request', 'body': bytes(body), 'more_body': False}
            return await receive()
        await self.app(scope, replay, send)
