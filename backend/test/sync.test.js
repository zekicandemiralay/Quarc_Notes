// End-to-end tests for the notes API against a real (temporary) SQLite
// database: offline sync (v2 + the legacy protocol older app versions still
// speak), conflict handling, trash/restore/purge, links, search, and
// attachment ownership. Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quarc-notes-test-'));
process.env.DB_PATH = path.join(tmp, 'notes.db');
process.env.ATTACHMENTS_DIR = path.join(tmp, 'attachments');
process.env.JWT_SECRET = 'test-secret';

const { initDb, getDb } = require('../src/db');
const { createApp } = require('../src/index');

let server;
let base;
const tokenA = jwt.sign({ id: 'user-a', username: 'alice' }, 'test-secret', { expiresIn: '1h' });
const tokenB = jwt.sign({ id: 'user-b', username: 'bob' }, 'test-secret', { expiresIn: '1h' });

async function api(method, url, body, token = tokenA) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `token=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const push = (mutations, extra = {}, token) =>
  api('POST', '/api/sync/push', { client_id: 'device-1', mutations, ...extra }, token);
const pull = (since = '', token) => api('GET', `/api/sync/pull?v=2&since=${encodeURIComponent(since)}`, undefined, token);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function el(id, version, extra = {}) {
  return { id, type: 'freedraw', version, versionNonce: version * 7, isDeleted: false, ...extra };
}

before(async () => {
  initDb();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  getDb().close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('creates a page through sync and pulls it back', async () => {
  const r = await push([{ id: 'p1', fields: { title: 'Hello', type: 'doc', content_json: [] } }]);
  assert.equal(r.status, 200);
  assert.equal(r.body.results[0].status, 'ok');
  assert.match(r.body.results[0].updated_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/);

  const p = await pull();
  const page = p.body.pages.find((x) => x.id === 'p1');
  assert.equal(page.title, 'Hello');
  assert.deepEqual(p.body.deleted, []);
});

test('sub-page created offline before its parent in the same batch keeps its parent', async () => {
  const r = await push([
    { id: 'child', fields: { title: 'Child', parent_id: 'parent' } },
    { id: 'parent', fields: { title: 'Parent' } },
  ]);
  assert.ok(r.body.results.every((x) => x.status === 'ok'));
  const child = (await api('GET', '/api/pages/child')).body;
  assert.equal(child.parent_id, 'parent');
});

test('rejects parent cycles and foreign parents', async () => {
  await push([{ id: 'cyc-a', fields: { title: 'A' } }, { id: 'cyc-b', fields: { title: 'B', parent_id: 'cyc-a' } }]);
  // Making A a child of its own child B must be ignored.
  await push([{ id: 'cyc-a', fields: { parent_id: 'cyc-b' } }]);
  assert.equal((await api('GET', '/api/pages/cyc-a')).body.parent_id, null);
  const put = await api('PUT', '/api/pages/cyc-a', { parent_id: 'cyc-b' });
  assert.equal(put.status, 400);

  await push([{ id: 'bob-page', fields: { title: 'Bob' } }], {}, tokenB);
  await push([{ id: 'cyc-a', fields: { parent_id: 'bob-page' } }]);
  assert.equal((await api('GET', '/api/pages/cyc-a')).body.parent_id, null);
});

test("a user can't touch another user's page", async () => {
  const r = await push([{ id: 'bob-page', fields: { title: 'hacked' } }]);
  assert.equal(r.body.results[0].status, 'error');
  assert.equal((await api('GET', '/api/pages/bob-page', undefined, tokenB)).body.title, 'Bob');
});

test('rename on one device and writing on another both survive', async () => {
  const created = await push([{ id: 'p2', fields: { title: 'Old', content_json: [{ id: 'b1', type: 'paragraph', content: [] }] } }]);
  const baseTs = created.body.results[0].updated_at;
  await sleep(5);
  // Device 2 renames.
  await api('POST', '/api/sync/push', { client_id: 'device-2', mutations: [{ id: 'p2', base_updated_at: baseTs, fields: { title: 'New' } }] });
  // Device 1 (still on the old base) edits the content.
  const content = [{ id: 'b1', type: 'paragraph', content: [{ type: 'text', text: 'typed', styles: {} }] }];
  const r = await push([{ id: 'p2', base_updated_at: baseTs, fields: { content_json: content } }]);
  assert.equal(r.body.results[0].conflict_copy_id, undefined);
  const page = (await api('GET', '/api/pages/p2')).body;
  assert.equal(page.title, 'New');
  assert.deepEqual(page.content_json, content);
});

test('a device never conflicts with its own earlier saves', async () => {
  const c = await push([{ id: 'p3', fields: { title: 'Mine', content_json: [] } }]);
  const staleBase = c.body.results[0].updated_at;
  await sleep(5);
  await push([{ id: 'p3', base_updated_at: staleBase, fields: { content_json: [{ id: 'x', type: 'paragraph', content: [] }] } }]);
  await sleep(5);
  const r = await push([{ id: 'p3', base_updated_at: staleBase, fields: { content_json: [{ id: 'y', type: 'paragraph', content: [] }] } }]);
  assert.equal(r.body.results[0].conflict_copy_id, undefined);
});

test("conflicting document edits keep the other device's version as a copy", async () => {
  const c = await push([{ id: 'p4', fields: { title: 'Plan', content_json: [{ id: 'a', type: 'paragraph', content: [] }] } }]);
  const baseTs = c.body.results[0].updated_at;
  await sleep(5);
  const theirs = [{ id: 'a', type: 'paragraph', content: [{ type: 'text', text: 'theirs', styles: {} }] }];
  await api('POST', '/api/sync/push', { client_id: 'device-2', mutations: [{ id: 'p4', base_updated_at: baseTs, fields: { content_json: theirs } }] });
  const mine = [{ id: 'a', type: 'paragraph', content: [{ type: 'text', text: 'mine', styles: {} }] }];
  const r = await push([{ id: 'p4', base_updated_at: baseTs, fields: { content_json: mine } }], { conflict_label: 'çakışma kopyası' });
  const copyId = r.body.results[0].conflict_copy_id;
  assert.ok(copyId);
  const copy = (await api('GET', `/api/pages/${copyId}`)).body;
  assert.equal(copy.title, 'Plan (çakışma kopyası)');
  assert.deepEqual(copy.content_json, theirs);
  assert.deepEqual((await api('GET', '/api/pages/p4')).body.content_json, mine);
});

test('retrying an already-applied push does not create a conflict copy', async () => {
  const c = await push([{ id: 'p5', fields: { title: 'Retry', content_json: [] } }]);
  const baseTs = c.body.results[0].updated_at;
  await sleep(5);
  const content = [{ id: 'z', type: 'paragraph', content: [] }];
  await api('POST', '/api/sync/push', { client_id: 'device-2', mutations: [{ id: 'p5', base_updated_at: baseTs, fields: { content_json: content } }] });
  // Same content again from another device that missed the response.
  const r = await api('POST', '/api/sync/push', { client_id: 'device-3', mutations: [{ id: 'p5', base_updated_at: baseTs, fields: { content_json: content } }] });
  assert.equal(r.body.results[0].conflict_copy_id, undefined);
});

test('drawings edited on two devices merge stroke by stroke', async () => {
  const c = await push([{ id: 'c1', fields: { title: 'Sketch', type: 'canvas', ink_json: { elements: [el('s1', 1)] } } }]);
  const baseTs = c.body.results[0].updated_at;
  await sleep(5);
  // Device 2 adds s2 and edits s1.
  await api('POST', '/api/sync/push', {
    client_id: 'device-2',
    mutations: [{ id: 'c1', base_updated_at: baseTs, fields: { ink_json: { elements: [el('s1', 3), el('s2', 1)] } } }],
  });
  // Device 1 (offline meanwhile) adds s3 and deletes nothing.
  const r = await push([{ id: 'c1', base_updated_at: baseTs, fields: { ink_json: { elements: [el('s1', 1), el('s3', 1)] } } }]);
  assert.equal(r.body.results[0].merged, true);
  const ids = r.body.results[0].page.ink_json.elements.map((e) => `${e.id}@${e.version}`).sort();
  assert.deepEqual(ids, ['s1@3', 's2@1', 's3@1']);
});

test('trash, restore and purge cascade through sub-pages and reach other devices', async () => {
  await push([
    { id: 't-root', fields: { title: 'Root' } },
    { id: 't-kid', fields: { title: 'Kid', parent_id: 't-root' } },
    { id: 't-grandkid', fields: { title: 'Grandkid', parent_id: 't-kid' } },
  ]);
  await push([{ id: 't-root', deleted: true }]);
  const trash = (await api('GET', '/api/pages?trash=1')).body.map((p) => p.id);
  assert.ok(['t-root', 't-kid', 't-grandkid'].every((id) => trash.includes(id)));

  // Restore through sync (older clients lost restores: they reappeared trashed).
  const restored = await push([{ id: 't-root', deleted: false }]);
  assert.equal(restored.body.results[0].page.is_deleted, 0);
  const live = (await api('GET', '/api/pages')).body.map((p) => p.id);
  assert.ok(['t-root', 't-kid', 't-grandkid'].every((id) => live.includes(id)));

  // Restoring a child whose parent is still trashed moves it to the top level.
  await push([{ id: 't-root', deleted: true }]);
  await push([{ id: 't-kid', deleted: false }]);
  assert.equal((await api('GET', '/api/pages/t-kid')).body.parent_id, null);

  const before = (await pull()).body.serverTime;
  await push([{ id: 't-root', purge: true }, { id: 't-kid', purge: true }]);
  const after = await pull(before);
  assert.ok(after.body.deleted.includes('t-root'));
  assert.ok(after.body.deleted.includes('t-grandkid'));
  assert.equal((await api('GET', '/api/pages/t-root')).status, 404);

  // A device that was offline can't resurrect a page deleted forever.
  const again = await push([{ id: 't-root', fields: { title: 'zombie' } }]);
  assert.equal(again.body.results[0].status, 'gone');
});

test('older app versions (legacy push format) still sync', async () => {
  const r = await api('POST', '/api/sync/push', {
    mutations: [
      { id: 'legacy1', op: 'upsert', title: 'Legacy', type: 'doc', content_json: [], ink_json: [], parent_id: null, sort_order: 1, canvas_settings: { pageSize: 'A5', pageStyle: 'lined' }, base_updated_at: new Date().toISOString() },
    ],
  });
  assert.equal(r.body.results[0].status, 'ok');
  const del = await api('POST', '/api/sync/push', { mutations: [{ id: 'legacy1', op: 'delete' }] });
  assert.equal(del.body.results[0].status, 'ok');
  assert.equal((await api('GET', '/api/pages/legacy1')).body.is_deleted, 1);
  // Legacy pull has no `deleted` key and an exclusive bound.
  const p = await api('GET', '/api/sync/pull?since=');
  assert.equal(p.body.deleted, undefined);
  // Deleting a page the server never saw must not create an "Untitled" page.
  await api('POST', '/api/sync/push', { mutations: [{ id: 'never-synced', op: 'delete' }] });
  assert.equal((await api('GET', '/api/pages/never-synced')).status, 404);
});

test('wikilinks become backlinks; search finds table text and drawing labels', async () => {
  await push([
    { id: 'target', fields: { title: 'Target' } },
    {
      id: 'linker',
      fields: {
        title: 'Linker',
        content_json: [
          { id: 'l1', type: 'paragraph', content: [{ type: 'wikilink', props: { pageId: 'target', title: 'Target' } }] },
          {
            id: 't1',
            type: 'table',
            content: { type: 'tableContent', rows: [{ cells: [[{ type: 'text', text: 'pomegranate', styles: {} }]] }] },
          },
          { id: 'l2', type: 'paragraph', content: [{ type: 'link', href: 'https://x', content: [{ type: 'text', text: 'kumquat', styles: {} }] }] },
        ],
      },
    },
    { id: 'drawing', fields: { title: 'Drawing', type: 'canvas', ink_json: { elements: [{ id: 'tx', type: 'text', text: 'mitochondria', originalText: 'mitochondria', version: 1 }] } } },
  ]);
  const back = (await api('GET', '/api/pages/target/backlinks')).body;
  assert.deepEqual(back.map((b) => b.id), ['linker']);
  for (const [q, id] of [['pomegranate', 'linker'], ['kumquat', 'linker'], ['mitochond', 'drawing']]) {
    const hits = (await api('GET', `/api/search?q=${q}`)).body.map((h) => h.id);
    assert.ok(hits.includes(id), `search "${q}" should find ${id}, got ${hits}`);
  }
});

test('favorites sync', async () => {
  await push([{ id: 'fav', fields: { title: 'Fav', is_favorite: true } }]);
  assert.equal((await api('GET', '/api/pages/fav')).body.is_favorite, 1);
  await push([{ id: 'fav', fields: { is_favorite: false } }]);
  assert.equal((await api('GET', '/api/pages/fav')).body.is_favorite, 0);
});

test("attachments are only served to the page's owner", async () => {
  await push([{ id: 'att-page', fields: { title: 'With file' } }]);
  const form = new FormData();
  form.append('file', new Blob(['hello'], { type: 'text/plain' }), '../../evil name.txt');
  const up = await fetch(`${base}/api/attachments/att-page`, { method: 'POST', headers: { Cookie: `token=${tokenA}` }, body: form });
  assert.equal(up.status, 201);
  const { url } = await up.json();
  assert.match(url, /^\/api\/attachments\/file\/[0-9a-f-]{36}\.txt$/);
  const mine = await fetch(base + url, { headers: { Cookie: `token=${tokenA}` } });
  assert.equal(mine.status, 200);
  assert.equal(await mine.text(), 'hello');
  const theirs = await fetch(base + url, { headers: { Cookie: `token=${tokenB}` } });
  assert.equal(theirs.status, 404);
});

test('an edit built on a stale version gets the server copy back', async () => {
  const c = await push([{ id: 'st', fields: { title: 'S', content_json: [] } }]);
  const baseTs = c.body.results[0].updated_at;
  await sleep(5);
  const theirs = [{ id: 'q', type: 'paragraph', content: [{ type: 'text', text: 'remote', styles: {} }] }];
  await api('POST', '/api/sync/push', { client_id: 'device-2', mutations: [{ id: 'st', base_updated_at: baseTs, fields: { content_json: theirs } }] });
  // A title-only edit from device 1 (which skipped pulling this page) brings the remote content back.
  const r = await push([{ id: 'st', base_updated_at: baseTs, fields: { title: 'S2' } }]);
  assert.deepEqual(r.body.results[0].page.content_json, theirs);
  assert.equal(r.body.results[0].page.title, 'S2');
  // Up-to-date edits don't echo the page back.
  const r2 = await push([{ id: 'st', base_updated_at: r.body.results[0].updated_at, fields: { title: 'S3' } }]);
  assert.equal(r2.body.results[0].page, undefined);
});

test('an edit built on the pre-merge drawing merges again instead of dropping strokes', async () => {
  const c = await push([{ id: 'c2', fields: { title: 'M', type: 'canvas', ink_json: { elements: [el('a', 1)] } } }]);
  const baseTs = c.body.results[0].updated_at;
  await sleep(5);
  await api('POST', '/api/sync/push', { client_id: 'device-2', mutations: [{ id: 'c2', base_updated_at: baseTs, fields: { ink_json: { elements: [el('a', 1), el('remote', 1)] } } }] });
  await push([{ id: 'c2', base_updated_at: baseTs, fields: { ink_json: { elements: [el('a', 1), el('mine1', 1)] } } }]);
  await sleep(5);
  // Second save from this device, still on its pre-merge copy.
  const r = await push([{ id: 'c2', base_updated_at: baseTs, fields: { ink_json: { elements: [el('a', 1), el('mine1', 1), el('mine2', 1)] } } }]);
  const ids = r.body.results[0].page.ink_json.elements.map((e) => e.id).sort();
  assert.deepEqual(ids, ['a', 'mine1', 'mine2', 'remote']);
});

test('search snippets are HTML-escaped (note text is never markup)', async () => {
  await push([{ id: 'xss', fields: { title: 'X', content_json: [{ id: 'z', type: 'paragraph', content: [{ type: 'text', text: 'zebra <img src=x onerror=alert(1)> stripes', styles: {} }] }] } }]);
  const hits = (await api('GET', '/api/search?q=zebra')).body;
  const hit = hits.find((h) => h.id === 'xss');
  assert.ok(hit.snippet.includes('<mark>zebra</mark>'));
  assert.ok(!hit.snippet.includes('<img'));
  assert.ok(hit.snippet.includes('&lt;img'));
});
