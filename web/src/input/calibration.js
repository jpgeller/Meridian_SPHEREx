// Eye-tracker calibration, driven from the page (gaze_tracker/meridian_live.py records and fits).
//
// When a tracker connects over ?gaze_ws, the page asks once: calibrate for much higher precision, or use it as
// it is. Calibrating runs two layers, both shown here full screen while the tracker records the model's
// predictions for each dot:
//   1. 100 dots over the whole screen (Yassin's personal calibration: gaze + head pose + light), 1.5 s each.
//      Between dots the person moves their head a little, so the layer learns the head's effect too.
//   2. a dot on every button of the current view, twice each: the leftover error measured exactly where the
//      buttons are (gaze_tracker/button_calibration.py).
// Each layer is switched on by the tracker only if it beats "without it" on dots it did not learn from; the
// result (error before -> after, in screen pixels) is shown. Afterwards eye control goes to full control (C).
//
// Commands: calibrate_eyes, calibrate_buttons, skip_calibration, stop_calibration. Keys in a run: Space pauses,
// Esc stops.

let DOT_MS = 1500; // the tracker ignores the first 0.6 s of each dot (eyes landing), records the rest
let INTRO_MS = 5000;
let RESULT_MS = 3500;
const LAYER1_DOTS = 100;
const LOOKS_PER_BUTTON = 2;

/** n dots spread over the screen (jittered grid, 4–96 %), random order: Yassin's make_cal_dots. Pure. */
export function calibrationDots(n, seed = 0) {
  let s = seed + 1;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const cols = Math.ceil(Math.sqrt(n * 1.6));
  const rows = Math.ceil(n / cols);
  const pts = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) pts.push([(c + 0.2 + 0.6 * rnd()) / cols, (r + 0.2 + 0.6 * rnd()) / rows]);
  for (let i = pts.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pts[i], pts[j]] = [pts[j], pts[i]];
  }
  return pts.slice(0, n).map(([x, y]) => [0.04 + 0.92 * x, 0.04 + 0.92 * y]);
}

/** Centres of the visible buttons (page px), one per button, each looked at `looks` times, shuffled. Pure-ish. */
export function buttonDots(buttons, looks = LOOKS_PER_BUTTON, seed = 1) {
  const centres = [];
  for (const r of buttons) {
    if (r.width < 8 || r.height < 8) continue;
    const c = [r.left + r.width / 2, r.top + r.height / 2];
    if (centres.some((q) => Math.hypot(q[0] - c[0], q[1] - c[1]) < 10)) continue;
    centres.push(c);
  }
  let s = seed + 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out = [];
  for (let look = 0; look < looks; look++) {
    const order = centres.map((c, id) => ({ id, c, look }));
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    out.push(...order);
  }
  return out;
}

export function createCalibration({ store, commands, socket, doc = document, win = window }) {
  const root = doc.createElement('div');
  root.className = 'calib';
  root.hidden = true;
  root.innerHTML = `
    <div class="calib-ask" role="dialog" aria-modal="true" aria-labelledby="calib-ask-title" hidden>
      <h2 id="calib-ask-title">Eye tracker connected</h2>
      <p id="calib-ask-text">Calibrate it to you for much higher precision? About 4 minutes: 100 dots across the screen, then a dot on each button. Or use it as it is (less precise).</p>
      <div class="row">
        <button type="button" data-calib="calibrate" class="primary">Calibrate (about 4 min)</button>
        <button type="button" data-calib="skip">Use it as it is</button>
      </div>
    </div>
    <div class="calib-run" hidden>
      <div class="calib-dot" aria-hidden="true"><span class="calib-ring"></span><span class="calib-core"></span></div>
      <p class="calib-count" aria-live="polite"></p>
      <div class="calib-msg" role="status" aria-live="polite"></div>
      <button type="button" class="calib-stop" data-calib="stop">Stop calibration <kbd>Esc</kbd></button>
    </div>`;
  doc.body.append(root);
  const ask = root.querySelector('.calib-ask');
  const run = root.querySelector('.calib-run');
  const dotEl = root.querySelector('.calib-dot');
  const countEl = root.querySelector('.calib-count');
  const msgEl = root.querySelector('.calib-msg');
  root.querySelector('[data-calib="calibrate"]').addEventListener('click', () => commands.run('calibrate_eyes', {}, 'ui'));
  root.querySelector('[data-calib="skip"]').addEventListener('click', () => commands.run('skip_calibration', {}, 'ui'));
  root.querySelector('[data-calib="stop"]').addEventListener('click', () => commands.run('stop_calibration', {}, 'ui'));

  let asked = false;
  let job = null; // { layer, dots, i, paused, timer, resolve }
  let lastResult = {};
  let waitingFor = null; // layer whose calib_result is awaited

  const send = (m) => socket.send({ type: 'calib', ...m });
  const fmt = (r) =>
    r?.error
      ? r.error
      : r
        ? `error ${Math.round(r.error_without_px)} → ${Math.round(r.error_with_px)} px on dots it did not learn from${r.enabled ? '' : ' (no better: left off)'}`
        : '';

  win.addEventListener('meridian:tracker', (e) => {
    const m = e.detail;
    if (m.type === 'tracker' && !asked && !job) {
      asked = true;
      const c = m.calibration ?? {};
      if (c.stabiliser) {
        root.querySelector('#calib-ask-text').textContent =
          'A saved calibration is loaded. Calibrate again for this session (about 4 minutes: 100 dots, then a dot on each button), or use it as it is?';
      }
      openAsk();
    }
    if (m.type === 'calib_result' && waitingFor === m.layer) {
      lastResult[m.layer] = m.report;
      waitingFor = null;
      resultWaiter?.(m.report);
    }
  });
  let resultWaiter = null;

  function openAsk() {
    root.hidden = false;
    ask.hidden = false;
    run.hidden = true;
    ask.querySelector('button').focus();
  }
  function close() {
    root.hidden = true;
    ask.hidden = true;
    run.hidden = true;
    root.classList.remove('calib-buttons');
  }

  function showDot(x, y, n, total) {
    dotEl.hidden = false;
    dotEl.style.left = `${x}px`;
    dotEl.style.top = `${y}px`;
    dotEl.classList.remove('go');
    void dotEl.offsetWidth; // restart the shrinking ring
    dotEl.classList.add('go');
    countEl.textContent = `${n} / ${total}`;
    countEl.style.left = `${x + 26}px`;
    countEl.style.top = `${y - 30}px`;
  }

  const wait = (ms) => new Promise((r) => win.setTimeout(r, ms));

  /** Show the dots of one layer; resolves with the tracker's report, or null if stopped. */
  async function runLayer(layer, dots, intro) {
    job = { layer, stopped: false, paused: false };
    root.hidden = false;
    ask.hidden = true;
    run.hidden = false;
    root.classList.toggle('calib-buttons', layer === 'buttons');
    dotEl.hidden = true;
    countEl.textContent = '';
    msgEl.textContent = intro;
    await wait(INTRO_MS);
    if (job.stopped) return null;
    msgEl.textContent = '';
    send({ action: 'start', layer });
    for (let i = 0; i < dots.length; i++) {
      while (job.paused && !job.stopped) await wait(100);
      if (job.stopped) return null;
      const d = dots[i];
      showDot(d.x, d.y, i + 1, dots.length);
      send({ action: 'dot', id: d.id, look: d.look ?? 0, x: d.x, y: d.y });
      await wait(DOT_MS);
    }
    dotEl.hidden = true;
    countEl.textContent = '';
    msgEl.textContent = 'Fitting…';
    waitingFor = layer;
    send({ action: 'end', layer });
    const report = await Promise.race([new Promise((r) => (resultWaiter = r)), wait(20000).then(() => ({ error: 'the tracker did not answer' }))]);
    resultWaiter = null;
    return report;
  }

  async function calibrateAll() {
    const W = win.innerWidth;
    const H = win.innerHeight;
    const dots1 = calibrationDots(LAYER1_DOTS).map(([x, y], id) => ({ id, x: x * W, y: y * H }));
    let r1 = await runLayer(
      'stabiliser',
      dots1,
      'Calibration 1 of 2: 100 dots, one at a time (about 2.5 minutes). Look straight at each dot. ' +
        'Between dots, move your head a little: turn, tilt, lean, closer or farther. Space pauses, Esc stops.',
    );
    if (!r1) return finish('Calibration stopped.');
    msgEl.textContent = `Layer 1 (whole screen): ${fmt(r1)}`;
    await wait(RESULT_MS);
    const r2 = await calibrateButtons(true);
    if (r2 === null) return finish('Calibration stopped.');
    finish(`Calibrated. Whole screen: ${fmt(r1)}. On the buttons: ${fmt(r2)}.`);
  }

  async function calibrateButtons(partOfFull = false) {
    // the buttons of the view on screen now (the calibration's own controls excluded)
    const rects = [...doc.querySelectorAll('button')]
      .filter((b) => !root.contains(b) && b.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }))
      .map((b) => b.getBoundingClientRect())
      .filter((r) => r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth);
    const dots = buttonDots(rects).map((d) => ({ id: d.id, look: d.look, x: d.c[0], y: d.c[1] }));
    const n = new Set(dots.map((d) => d.id)).size;
    const r = await runLayer(
      'buttons',
      dots,
      `${partOfFull ? 'Calibration 2 of 2' : 'Button calibration'}: a dot on each of the ${n} buttons, twice (about ${Math.round((dots.length * DOT_MS) / 60000 + 0.4)} min). Look at the dot on each button.`,
    );
    if (!partOfFull) finish(r ? `Buttons calibrated: ${fmt(r)}.` : 'Calibration stopped.');
    return r;
  }

  function finish(text) {
    const stopped = job?.stopped;
    job = null;
    root.classList.remove('calib-buttons');
    dotEl.hidden = true;
    countEl.textContent = '';
    msgEl.textContent = text;
    if (!stopped) commands.run('set_input_mode', { mode: 'gaze' }, 'calibration'); // full eye control
    win.setTimeout(() => !job && close(), RESULT_MS);
  }

  commands.register('calibrate_eyes', () => {
    if (job) return false;
    ask.hidden = true;
    calibrateAll();
    return true;
  }, { label: 'Calibrate the eye tracker (100 dots, then the buttons)' });
  commands.register('calibrate_buttons', () => {
    if (job) return false;
    calibrateButtons(false);
    return true;
  }, { label: 'Calibrate the eye tracker on the buttons of this view' });
  commands.register('skip_calibration', () => {
    close();
    commands.run('set_input_mode', { mode: 'gaze' }, 'calibration');
    return true;
  }, { label: 'Use the eye tracker without calibrating' });
  commands.register('stop_calibration', () => {
    if (!job) return close() ?? false;
    job.stopped = true;
    send({ action: 'cancel' });
    finish('Calibration stopped: nothing changed.');
    return true;
  }, { label: 'Stop the calibration' });

  win.addEventListener(
    'keydown',
    (e) => {
      if (!job) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        commands.run('stop_calibration', {}, 'key');
      } else if (e.key === ' ') {
        e.preventDefault();
        e.stopImmediatePropagation();
        job.paused = !job.paused;
        send({ action: job.paused ? 'pause' : 'resume' });
        msgEl.textContent = job.paused ? 'Paused: rest your eyes. Space continues.' : '';
      }
    },
    true,
  );

  return {
    results: () => lastResult,
    busy: () => Boolean(job),
    element: root,
    /** Tests: shorter dots / pauses (the tracker still skips the first 0.6 s of each dot). */
    setTiming({ dotMs = DOT_MS, introMs = INTRO_MS, resultMs = RESULT_MS } = {}) {
      DOT_MS = dotMs;
      INTRO_MS = introMs;
      RESULT_MS = resultMs;
      dotEl.style.setProperty('--calib-dot-ms', `${dotMs}ms`);
    },
  };
}
