// Static answers for the five challenge targets (src/core/staticApi.js). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apiKey, installStaticApi } from '../src/core/staticApi.js';

test('apiKey: path after /api/, parameters decoded and sorted (same rule as api/export_static.py)', () => {
  assert.equal(apiKey('/api/cutout?id=a_D1&ra=1.00000&dec=-2.00000&fov=0.1&ext=image&v=5'), 'cutout?dec=-2.00000&ext=image&fov=0.1&id=a_D1&ra=1.00000&v=5');
  assert.equal(apiKey("/api/resolve?name=Barnard's%20Star"), "resolve?name=Barnard's Star");
  assert.equal(apiKey('/api/resolve?name=Barnard%27s%20Star'), "resolve?name=Barnard's Star");
  assert.equal(apiKey('http://x.test/api/context/wise?fov=0.1&band=2&ra=1&dec=2'), 'context/wise?band=2&dec=2&fov=0.1&ra=1');
  assert.equal(apiKey('/api/health'), 'health');
});

function fakeWindow(files) {
  const calls = [];
  const win = {
    location: { href: 'http://site.test/app/' },
    fetch: async (url) => {
      calls.push(String(url));
      const body = files[String(url)];
      return body === undefined ? new Response('nope', { status: 404 }) : new Response(body, { status: 200 });
    },
  };
  return { win, calls };
}

test('installStaticApi: a known GET answers from its file with the API headers; anything else goes to the network', async () => {
  const index = { entries: { 'cutout?id=x&ra=1': ['abc.f32', 'application/octet-stream', 1] } };
  const head = new TextEncoder().encode(JSON.stringify({ 'X-Width': '2' }));
  const packed = new Uint8Array(4 + head.length + 6);
  new DataView(packed.buffer).setUint32(0, head.length, true);
  packed.set(head, 4);
  packed.set(new TextEncoder().encode('PIXELS'), 4 + head.length);
  const { win, calls } = fakeWindow({ '/d/index.json': JSON.stringify(index), '/d/abc.f32': packed });
  const { ready, staticUrl } = installStaticApi({ win, dataBase: '/d/' });
  assert.equal(await ready, 1);
  const r = await win.fetch('/api/cutout?ra=1&id=x');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('X-Width'), '2');
  assert.equal(r.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(await r.text(), 'PIXELS');
  assert.equal(staticUrl('/api/cutout?id=x&ra=1'), '/d/abc.f32');
  assert.equal(staticUrl('/api/cutout?id=y&ra=1'), '/api/cutout?id=y&ra=1');
  // unknown key, a POST, and a non-API URL all reach the real fetch
  assert.equal((await win.fetch('/api/cutout?id=y&ra=1')).status, 404);
  await win.fetch('/api/cutout?ra=1&id=x', { method: 'POST' });
  await win.fetch('/other');
  assert.deepEqual(calls.slice(2), ['/api/cutout?id=y&ra=1', '/api/cutout?ra=1&id=x', '/other']);
});

test('installStaticApi: no index (or ?static=0) leaves fetch alone', async () => {
  const { win } = fakeWindow({});
  const real = win.fetch;
  assert.equal(await installStaticApi({ win, dataBase: '/d/' }).ready, 0);
  assert.equal((await win.fetch('/api/health')).status, 404);
  const other = fakeWindow({});
  installStaticApi({ win: other.win, enabled: false });
  assert.equal(typeof real, 'function');
  assert.equal(other.calls.length, 0);
});
