// Spectrum panel (Step 10). `select_point` (click on the image, or `s` for the target)
// measures that point in every SPHEREx frame of the field; the API works in rounds, so the
// plot fills in as frames are downloaded. Plain SVG; a data table for screen readers.

import { buildSed, buildSedSvg, describeSed } from './sed.js';

const DET_COLOURS = ['#6aa8ff', '#5fd0c4', '#9be07a', '#f2d16b', '#f59a6b', '#ef7aa7']; // D1..D6, as the ribbon
const W = 520;
const H = 260;
const M = { l: 52, r: 12, t: 14, b: 36 };
const ROUND_NEW = 40;

const nice = (v) => {
  const p = 10 ** Math.floor(Math.log10(Math.abs(v) || 1));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
};

export function createSpectrum(player, { store, commands }) {
  const panel = document.createElement('section');
  panel.className = 'spectrum';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Spectrum');
  panel.innerHTML = `
    <header class="row">
      <h3 id="spec-title">Spectrum</h3>
      <div role="radiogroup" aria-label="Graph" class="row spec-views">
        <button type="button" role="radio" data-spec-view="spectrum" aria-checked="true">SPHEREx spectrum</button>
        <button type="button" role="radio" data-spec-view="sed" aria-checked="false">SED with Gaia <kbd>e</kbd></button>
      </div>
      <span id="spec-status" class="muted" role="status" aria-live="polite"></span>
      <button type="button" id="spec-close" class="spec-close">Close</button>
    </header>
    <svg id="spec-svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="spec-title spec-summary"></svg>
    <p id="spec-summary" class="muted spec-note"></p>
    <details><summary>Show values as a table</summary><div id="spec-table"></div></details>`;
  player.elements.view.after(panel);
  const svg = panel.querySelector('#spec-svg');
  const statusEl = panel.querySelector('#spec-status');
  const summaryEl = panel.querySelector('#spec-summary');
  const tableEl = panel.querySelector('#spec-table');
  panel.querySelector('#spec-close').addEventListener('click', () => {
    token++;
    panel.hidden = true;
  });

  let token = 0;
  let last = null; // the last spectrum drawn (the guide reads its blends, UI plan U7)
  // The SED view (sed.js): SPHEREx and Gaia on one graph. Gaia is fetched once per measured point.
  let view = 'spectrum';
  let point = null; // { ra, dec } being measured
  const gaia = { key: '', data: null, error: '', loading: false };
  panel.querySelectorAll('[data-spec-view]').forEach((b) =>
    b.addEventListener('click', () => commands.run('set_spectrum_view', { view: b.dataset.specView }, 'ui')),
  );

  function wantGaia() {
    if (!point) return null;
    const key = `${point.ra.toFixed(6)},${point.dec.toFixed(6)}`;
    if (gaia.key !== key) Object.assign(gaia, { key, data: null, error: '', loading: false });
    if (!gaia.data && !gaia.error && !gaia.loading) {
      gaia.loading = true;
      // the point is in the target's frame, whose coordinates are for 2026.0 (resolve.py)
      fetch(`/api/context/gaia_sed?ra=${point.ra.toFixed(6)}&dec=${point.dec.toFixed(6)}&mjd=61041`)
        .then(async (r) => {
          const body = await r.json();
          if (!r.ok) throw new Error(body.detail ?? `Gaia unavailable (${r.status})`);
          if (gaia.key === key) gaia.data = body;
        })
        .catch((err) => (gaia.key === key ? (gaia.error = err.message) : null))
        .finally(() => {
          if (gaia.key !== key) return;
          gaia.loading = false;
          if (view === 'sed') redraw();
        });
    }
    return gaia.data;
  }

  function redraw() {
    panel.querySelectorAll('[data-spec-view]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.specView === view)));
    panel.querySelector('#spec-title').textContent = view === 'sed' ? 'Energy distribution (SED)' : 'Spectrum';
    if (view === 'sed') drawSed();
    else if (last) draw(last);
  }

  function drawSed() {
    const g = wantGaia();
    if (!g) {
      svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="axis">${
        gaia.error ? 'Gaia is not available right now' : 'Looking up this point in Gaia DR3…'
      }</text>`;
      summaryEl.textContent = gaia.error ? `Gaia: ${gaia.error}.` : '';
      return;
    }
    const sed = buildSed(g, last);
    const { svg: body, ok } = buildSedSvg(sed, { W, H });
    svg.innerHTML = ok ? body : `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="axis">Nothing to plot yet</text>`;
    summaryEl.textContent = describeSed(sed);
    lastSed = sed;
  }
  let lastSed = null;

  async function measure(ra, dec) {
    const s = store.get();
    const my = ++token;
    point = { ra, dec };
    panel.hidden = false;
    svg.innerHTML = '';
    tableEl.innerHTML = '';
    summaryEl.textContent = '';
    statusEl.textContent = 'Measuring…';
    const q = `ra=${ra.toFixed(6)}&dec=${dec.toFixed(6)}&ra0=${s.ra.toFixed(5)}&dec0=${s.dec.toFixed(5)}&fov=${s.ffov}`;
    let maxNew = 0; // first round: only frames already downloaded, so something shows at once
    for (let round = 0; round < 20 && my === token; round++) {
      let data;
      try {
        const r = await fetch(`/api/spectrum?${q}&max_new=${maxNew}`);
        data = await r.json();
        if (!r.ok) throw new Error(data.detail ?? `spectrum failed (${r.status})`);
      } catch (err) {
        if (my === token) statusEl.textContent = err.message.includes('edge') ? 'Pick a point further from the edge.' : 'Could not measure the spectrum.';
        console.error('[spectrum]', err);
        return;
      }
      if (my !== token) return;
      last = data;
      if (view === 'sed') drawSed();
      else draw(data);
      statusEl.textContent = data.complete
        ? `${data.points.length} measurements from ${data.n_frames} images${data.n_saturated ? ` (${data.n_saturated} too bright to measure)` : ''}`
        : `${data.points.length} measurements so far · loading images ${data.n_done}/${data.n_frames}…`;
      if (data.complete) return;
      maxNew = ROUND_NEW;
    }
  }

  function draw(data) {
    const pts = data.points.filter((p) => Number.isFinite(p.flux_mjy) && Number.isFinite(p.wavelength_um));
    if (!pts.length) {
      const tooBright = data.n_saturated > 0 && data.n_saturated >= data.n_done / 2;
      svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="axis">${
        tooBright ? 'Too bright for SPHEREx: saturated in every image' : 'No measurements yet'
      }</text>`;
      summaryEl.textContent = tooBright
        ? `This object saturates the SPHEREx detectors in ${data.n_saturated} of ${data.n_done} images: the centre of its ` +
          'image is clipped, so its brightness (and its spectrum) cannot be measured. Fainter objects nearby can be: click one.'
        : '';
      tableEl.innerHTML = '';
      return;
    }
    const xMin = 0.7, xMax = 5.05;
    const fl = pts.map((p) => p.flux_mjy).sort((a, b) => a - b);
    const lo = Math.min(0, fl[Math.floor(fl.length * 0.02)]);
    const hi = fl[Math.floor(fl.length * 0.98)] * 1.15 || 1;
    const X = (v) => M.l + ((v - xMin) / (xMax - xMin)) * (W - M.l - M.r);
    const Y = (v) => H - M.b - ((v - lo) / (hi - lo)) * (H - M.t - M.b);
    const parts = [];
    // axes and grid
    const step = nice((hi - lo) / 4);
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      parts.push(`<line x1="${M.l}" x2="${W - M.r}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/>`);
      parts.push(`<text x="${M.l - 6}" y="${Y(v) + 4}" text-anchor="end" class="axis">${+v.toPrecision(3)}</text>`);
    }
    for (let v = 1; v <= 5; v++) {
      parts.push(`<line x1="${X(v)}" x2="${X(v)}" y1="${M.t}" y2="${H - M.b}" class="grid"/>`);
      parts.push(`<text x="${X(v)}" y="${H - M.b + 16}" text-anchor="middle" class="axis">${v}</text>`);
    }
    parts.push(`<text x="${(M.l + W - M.r) / 2}" y="${H - 4}" text-anchor="middle" class="axis">Wavelength (µm)</text>`);
    parts.push(`<text x="12" y="${(M.t + H - M.b) / 2}" text-anchor="middle" class="axis" transform="rotate(-90 12 ${(M.t + H - M.b) / 2})">Brightness (mJy)</text>`);
    // detector ribbon under the axis
    const edges = [0.75, 1.09, 1.62, 2.41, 3.82, 4.41, 5.0];
    for (let d = 0; d < 6; d++) {
      parts.push(`<rect x="${X(edges[d])}" y="${H - M.b + 1}" width="${X(edges[d + 1]) - X(edges[d])}" height="3" fill="${DET_COLOURS[d]}"/>`);
    }
    // points with error bars; shape by flag (never colour alone)
    for (const p of pts) {
      const x = X(p.wavelength_um), y = Y(p.flux_mjy);
      const c = DET_COLOURS[(p.detector ?? 1) - 1];
      const e1 = Y(p.flux_mjy - p.err_mjy), e2 = Y(p.flux_mjy + p.err_mjy);
      parts.push(`<line x1="${x}" x2="${x}" y1="${e1}" y2="${e2}" stroke="${c}" stroke-opacity="0.5"/>`);
      if (p.flag === 'saturated') {
        parts.push(`<rect x="${x - 3}" y="${y - 3}" width="6" height="6" fill="none" stroke="${c}"><title>saturated: lower limit</title></rect>`);
      } else {
        parts.push(`<circle cx="${x}" cy="${y}" r="2.6" fill="${c}"><title>${p.wavelength_um.toFixed(3)} µm: ${p.flux_mjy.toFixed(3)} ± ${p.err_mjy.toFixed(3)} mJy (D${p.detector})</title></circle>`);
      }
    }
    svg.innerHTML = parts.join('');

    // plain-language summary + table
    const byDet = {};
    for (const p of pts) (byDet[p.detector] ??= []).push(p.flux_mjy);
    const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
    const dets = Object.keys(byDet).sort();
    const desc = dets.map((d) => `D${d} ${med(byDet[d]).toFixed(2)}`).join(', ');
    const nSat = pts.filter((p) => p.flag === 'saturated').length;
    const blends = (data.blends ?? []).map((b) => `G=${b.g_mag} at ${b.sep_arcsec}″`);
    const blendNote = blends.length
      ? `Warning: ${blends.length === 1 ? 'a Gaia star is' : `${blends.length} Gaia stars are`} inside the measuring circle (${blends.join(', ')}); its light is mixed in, mostly at short wavelengths. `
      : '';
    summaryEl.textContent =
      `${blendNote}Median brightness per detector (mJy): ${desc}. Bands are measured on different dates, so variable objects can look jagged. ` +
      `${nSat ? `${nSat} saturated points (squares) are lower limits. ` : ''}Fluxes have no aperture correction (about 10–20% low for point sources).`;
    tableEl.innerHTML = `<table><thead><tr><th>λ (µm)</th><th>mJy</th><th>±</th><th>Detector</th><th>Date (MJD)</th><th>Note</th></tr></thead><tbody>${pts
      .map((p) => `<tr><td>${p.wavelength_um.toFixed(3)}</td><td>${p.flux_mjy.toFixed(3)}</td><td>${p.err_mjy.toFixed(3)}</td><td>D${p.detector}</td><td>${p.mjd.toFixed(2)}</td><td>${p.flag}</td></tr>`)
      .join('')}</tbody></table>`;
  }

  // --- command: select_point -------------------------------------------------------
  commands.register(
    'select_point',
    ({ ra, dec } = {}) => {
      const s = store.get();
      if (s.view !== 'field') throw new Error('Open the time-lapse first to measure a spectrum');
      measure(ra ?? s.ra, dec ?? s.dec);
    },
    { label: 'Spectrum here', keys: ['s'], args: { ra: 'deg (default: target)', dec: 'deg (default: target)' } },
  );

  commands.register(
    'set_spectrum_view',
    ({ view: v } = {}) => {
      if (!['spectrum', 'sed'].includes(v)) throw new Error('view must be spectrum or sed');
      view = v;
      if (panel.hidden) {
        const s = store.get();
        if (s.view !== 'field') throw new Error('Open the time-lapse first');
        measure(s.ra, s.dec); // the target
      }
      redraw();
      return view;
    },
    { label: 'Spectrum graph: SPHEREx spectrum or SED with Gaia', args: { view: 'spectrum | sed' } },
  );
  commands.register('show_sed', () => commands.run('set_spectrum_view', { view: 'sed' }), {
    label: 'SED: Gaia and SPHEREx on one graph, with a temperature',
    keys: ['e'],
  });

  // Click on the SPHEREx image -> spectrum of that pixel.
  player.elements.canvas.addEventListener('click', (e) => {
    const s = store.get();
    const cv = player.elements.canvas;
    const rect = cv.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * cv.width - 0.5;
    const py = ((e.clientY - rect.top) / rect.height) * cv.height - 0.5;
    const c = (cv.width - 1) / 2;
    const scale = 6.15 / 3600;
    const dec = s.dec + (c - py) * scale;
    const ra = s.ra + ((c - px) * scale) / Math.cos((s.dec * Math.PI) / 180);
    commands.run('select_point', { ra: (ra + 360) % 360, dec }, 'pointer');
  });
  player.elements.canvas.style.cursor = 'crosshair';
  // For the AI guide (UI plan U7): the spectrum on screen, or null when the panel is closed.
  return { getLast: () => (panel.hidden ? null : last), getSed: () => (panel.hidden || view !== 'sed' ? null : lastSed) };
}
