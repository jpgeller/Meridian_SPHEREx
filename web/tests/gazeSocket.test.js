import test from 'node:test';
import assert from 'node:assert/strict';
import { gazeSocketUrl, toViewport } from '../src/input/gazeSocket.js';

test('gaze socket: only ws:// on this machine', () => {
  assert.equal(gazeSocketUrl('8765'), 'ws://localhost:8765/');
  assert.equal(gazeSocketUrl('ws://127.0.0.1:9000'), 'ws://127.0.0.1:9000/');
  assert.equal(gazeSocketUrl('ws://evil.example:8765'), null);
  assert.equal(gazeSocketUrl('http://localhost:8765'), null);
  assert.equal(gazeSocketUrl(''), null);
  assert.equal(gazeSocketUrl(null), null);
});

test('gaze socket: physical screen pixels -> page pixels', () => {
  // MacBook 2560 x 1600 panel shown as 1440 x 900 ("scaled"), browser full-screen: screen_w makes it exact
  const mac = { screenW: 1440, screenH: 900, dpr: 2, left: 0, top: 0 };
  assert.deepEqual(toViewport({ x: 1280, y: 800, screen_w: 2560, screen_h: 1600 }, mac), { x: 720, y: 450 });
  // without screen_w: divide by the device pixel ratio (Windows 150 % scaling)
  const win = { screenW: 1707, screenH: 960, dpr: 1.5, left: 0, top: 0 };
  assert.deepEqual(toViewport({ x: 1500, y: 600 }, win), { x: 1000, y: 400 });
  // a window that is not full-screen: its position and the browser's toolbar are subtracted
  const windowed = { screenW: 1440, screenH: 900, dpr: 2, left: 100, top: 87 };
  assert.deepEqual(toViewport({ x: 1280, y: 800, screen_w: 2560, screen_h: 1600 }, windowed), { x: 620, y: 363 });
  // already page pixels
  assert.deepEqual(toViewport({ x: 5, y: 6, space: 'viewport' }, mac), { x: 5, y: 6 });
  assert.equal(toViewport({ x: 'a', y: 1 }, mac), null);
});
