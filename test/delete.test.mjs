import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const SERVER = process.env.SERVER_UNDER_TEST ?? join(HERE, '..', 'dist', 'index.js');
const STUB = join(HERE, 'stub-delete.mjs');
const WORK = mkdtempSync(join(tmpdir(), 'figma-comments-delete-'));
const FIXTURE = join(WORK, 'comments.json');

const comment = (id, handle, created_at, message, parent_id = '', resolved_at = null) => ({
  id,
  message,
  file_key: 'KEY',
  parent_id,
  user: { handle },
  created_at,
  resolved_at,
  client_meta: { node_id: '506:5214', node_offset: { x: 10, y: 10 } }
});

writeFileSync(
  FIXTURE,
  JSON.stringify([
    comment('102', 'Louis', '2026-10-31T11:00:00.000Z', 'Second reply\nwith two lines', '100'),
    comment('100', 'Louis', '2026-10-31T10:00:00.000Z', 'Root note\n\nwith a gap'),
    comment('101', 'Eun Ji', '2026-10-31T10:30:00.000Z', 'First reply', '100'),
    comment('200', 'Louis', '2026-10-31T09:00:00.000Z', 'Resolved, no replies', '', '2026-10-31T09:30:00.000Z'),
    comment('300', 'Reviewer', '2026-10-31T08:00:00.000Z', 'Written by someone else')
  ])
);

let runCount = 0;

async function call(args, env = {}, tool = 'delete_figma_comment') {
  const logPath = join(WORK, `requests-${++runCount}.log`);
  const child = spawn(process.execPath, ['--import', STUB, SERVER], {
    env: {
      PATH: process.env.PATH,
      FIGMA_TOKEN: 'fixture-not-a-token',
      STUB_FIXTURE: FIXTURE,
      STUB_LOG: logPath,
      ...env
    },
    stdio: ['pipe', 'pipe', 'inherit']
  });

  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
    }
  });

  let nextId = 0;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'fixture', version: '1' }
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  const response = tool ? await rpc('tools/call', { name: tool, arguments: args }) : await rpc('tools/list', {});
  child.kill();

  const requests = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n') : [];
  return {
    tools: response.result?.tools,
    text: response.result?.content?.[0]?.text ?? response.error?.message ?? '',
    isError: !!response.result?.isError || !!response.error,
    requests,
    deletes: requests.filter((request) => request.startsWith('DELETE'))
  };
}

const THREAD = { file: 'KEY', comment_id: '100', expected_reply_count: 2 };
const FULL_RECORD = [
  '100 · Louis · 2026-10-31 10:00',
  '  Root note',
  '  ',
  '  with a gap',
  '  ↳ 101 · Eun Ji · 2026-10-31 10:30',
  '    First reply',
  '  ↳ 102 · Louis · 2026-10-31 11:00',
  '    Second reply',
  '    with two lines'
].join('\n');

test('tool is listed, marked destructive, and requires all three inputs', async () => {
  const { tools } = await call({}, {}, null);
  const tool = tools.find((candidate) => candidate.name === 'delete_figma_comment');
  assert.equal(tools.length, 3);
  assert.equal(tool.annotations.destructiveHint, true);
  assert.deepEqual([...tool.inputSchema.required].sort(), ['comment_id', 'expected_reply_count', 'file']);
});

test('success: reads first, deletes once at the exact path, returns the full record', async () => {
  const result = await call(THREAD);
  assert.equal(result.isError, false);
  assert.deepEqual(result.requests, [
    'GET api.figma.com/v1/files/KEY/comments',
    'DELETE api.figma.com/v1/files/KEY/comments/100'
  ]);
  assert.ok(result.text.includes(FULL_RECORD), result.text);
  assert.match(result.text, /^Deleted comment 100 from KEY/);
});

for (const mode of ['empty', 'json', 'notJson']) {
  test(`success is the status alone: ${mode} body`, async () => {
    const result = await call(THREAD, { STUB_DELETE: mode });
    assert.equal(result.isError, false, result.text);
    assert.ok(result.text.includes(FULL_RECORD));
  });
}

test('success with no replies: 0 is a real count, and a resolved thread can go', async () => {
  const result = await call({ file: 'KEY', comment_id: '200', expected_reply_count: 0 });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(result.deletes, ['DELETE api.figma.com/v1/files/KEY/comments/200']);
});

test('a file URL works, and comment_id is taken from a match, not trusted', async () => {
  const result = await call({ ...THREAD, file: 'https://www.figma.com/design/KEY/Name?node-id=1-2' });
  assert.deepEqual(result.deletes, ['DELETE api.figma.com/v1/files/KEY/comments/100']);
});

test('reply-count mismatch (new reply): refused, no DELETE, new reply visible', async () => {
  const result = await call({ ...THREAD, expected_reply_count: 1 });
  assert.equal(result.isError, true);
  assert.deepEqual(result.deletes, []);
  assert.match(result.text, /^Nothing was deleted: this thread has 2 replies, not the 1 you expected/);
  assert.ok(result.text.includes('Second reply'));
  assert.ok(result.text.includes(FULL_RECORD));
});

test('reply-count mismatch (0 expected on a live thread): refused, no DELETE', async () => {
  const result = await call({ ...THREAD, expected_reply_count: 0 });
  assert.equal(result.isError, true);
  assert.deepEqual(result.deletes, []);
});

test('reply-count mismatch (fewer than expected): refused, no DELETE', async () => {
  const result = await call({ ...THREAD, expected_reply_count: 3 });
  assert.equal(result.isError, true);
  assert.deepEqual(result.deletes, []);
});

test('missing comment: refused, no DELETE', async () => {
  const result = await call({ file: 'KEY', comment_id: '999', expected_reply_count: 0 });
  assert.equal(result.isError, true);
  assert.deepEqual(result.deletes, []);
  assert.match(result.text, /^Nothing was deleted: no comment with id "999"/);
});

test('a reply id is not a thread: refused, no DELETE, points at the root', async () => {
  const result = await call({ file: 'KEY', comment_id: '101', expected_reply_count: 0 });
  assert.equal(result.isError, true);
  assert.deepEqual(result.deletes, []);
  assert.match(result.text, /The thread's root is 100/);
  assert.ok(result.text.includes(FULL_RECORD));
});

test('no bulk, no traversal: lists and path tricks match nothing', async () => {
  for (const comment_id of ['100,200', '*', 'all', '100/../200', '']) {
    const result = await call({ file: 'KEY', comment_id, expected_reply_count: 2 });
    assert.equal(result.isError, true, comment_id);
    assert.deepEqual(result.deletes, [], comment_id);
  }
});

test('expected_reply_count is required and must be a whole number: no request is made', async () => {
  for (const expected_reply_count of [undefined, -1, 1.5, '2', null]) {
    const result = await call({ file: 'KEY', comment_id: '100', expected_reply_count });
    assert.equal(result.isError, true, String(expected_reply_count));
    assert.deepEqual(result.requests, [], String(expected_reply_count));
  }
});

test('403 for missing scope: says so plainly, no raw error, thread kept', async () => {
  const result = await call(THREAD, { STUB_DELETE: 'scope403' });
  assert.equal(result.isError, true);
  assert.equal(result.deletes.length, 1);
  assert.match(result.text, /^Nothing was deleted: this Figma token needs write access for comments \(file_comments:write\)/);
  assert.match(result.text, /Generate a new Figma personal access token/);
  assert.ok(!result.text.includes('Figma said'));
  assert.ok(!result.text.includes('Invalid scope'));
  assert.ok(result.text.includes(FULL_RECORD));
});

test('403 with no scope wording: does not claim a scope problem, names both causes', async () => {
  const result = await call({ file: 'KEY', comment_id: '300', expected_reply_count: 0 }, { STUB_DELETE: 'plain403' });
  assert.equal(result.isError, true);
  assert.match(result.text, /only its author \(Reviewer\) can delete it/);
  assert.match(result.text, /needs write access for comments/);
});

test('403 reading the thread first: no DELETE is attempted', async () => {
  const result = await call(THREAD, { STUB_GET: 'forbidden' });
  assert.equal(result.isError, true);
  assert.deepEqual(result.deletes, []);
});

test('404 on the delete: explained, thread kept', async () => {
  const result = await call(THREAD, { STUB_DELETE: 'gone404' });
  assert.equal(result.isError, true);
  assert.match(result.text, /probably deleted in the meantime/);
  assert.ok(result.text.includes(FULL_RECORD));
});

test('429 on the delete: a clean refusal', async () => {
  const result = await call(THREAD, { STUB_DELETE: 'limited429' });
  assert.equal(result.isError, true);
  assert.match(result.text, /^Nothing was deleted\. Rate limited/);
  assert.ok(result.text.includes(FULL_RECORD));
});

for (const mode of ['server500', 'dropped']) {
  test(`unknown outcome (${mode}): never claims nothing happened, keeps the record`, async () => {
    const result = await call(THREAD, { STUB_DELETE: mode });
    assert.equal(result.isError, true);
    assert.match(result.text, /^The delete may or may not have gone through/);
    assert.ok(!result.text.includes('Nothing was deleted'));
    assert.ok(result.text.includes(FULL_RECORD));
  });
}
