import { appendFileSync, readFileSync } from 'node:fs';

const comments = JSON.parse(readFileSync(process.env.STUB_FIXTURE, 'utf8'));
const log = (line) => appendFileSync(process.env.STUB_LOG, `${line}\n`);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const deleteResponses = {
  empty: () => new Response(null, { status: 200 }),
  json: () => json({ status: 200, error: false }),
  notJson: () => new Response('OK', { status: 200 }),
  scope403: () =>
    json({ status: 403, err: 'Invalid scope(s): file_comments:read. This endpoint requires the file_comments:write scope' }, 403),
  plain403: () => json({ status: 403, err: 'Forbidden' }, 403),
  gone404: () => json({ status: 404, err: 'Not found' }, 404),
  limited429: () => json({ status: 429, err: 'Rate limited' }, 429),
  server500: () => json({ status: 500, err: 'Internal error' }, 500),
  dropped: () => {
    throw new TypeError('fetch failed');
  }
};

globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET';
  const { hostname, pathname } = new URL(url);
  log(`${method} ${hostname}${pathname}`);

  if (method === 'GET' && pathname === '/v1/files/KEY/comments') {
    if (process.env.STUB_GET === 'forbidden') return json({ status: 403, err: 'Forbidden' }, 403);
    return json({ comments });
  }
  if (method === 'DELETE' && pathname.startsWith('/v1/files/KEY/comments/')) {
    return deleteResponses[process.env.STUB_DELETE ?? 'empty']();
  }
  throw new Error(`Unexpected request in stub: ${method} ${url}`);
};
