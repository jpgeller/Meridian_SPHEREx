// Context from other missions in the field view (Step 9):
//   compare = 'side'     : WISE (chosen epoch) next to SPHEREx, same patch and size
//   compare = 'timeline' : one scrubber from WISE 2010 to SPHEREx 2026
//   compare = 'blink'    : WISE W2 (4.6 µm) against the SPHEREx frame on screen
//   layer 'gaia'         : Gaia DR3 stars as circles, moved to the date of each image
// Positions use a small-field gnomonic approximation (fields are ≤ 1°).

import { renderGaia, drawGaiaPicture } from './gaiaPicture.js';

const GAIA_EPOCH_MJD = 57388.5; // 2016.0
const SPHEREX_SCALE = 6.15; // arcsec/px
const BLINK_HZ = 2;
const GAIA_MAX_MAG = 18; // fainter Gaia stars clutter a 6′ field without helping
const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
const isoToMjd = (iso) => Date.parse(iso) / 86400000 + 40587;

/** Pixel position (x right, y down, north up, east left) of a sky point in a field image. */
export function skyToPixel(ra, dec, ra0, dec0, scaleArcsec, size) {
  const c = (size - 1) / 2;
  let dra = ra - ra0;
  if (dra > 180) dra -= 360;
  if (dra < -180) dra += 360;
  const x = c - (dra * Math.cos((dec0 * Math.PI) / 180) * 3600) / scaleArcsec;
  const y = c - ((dec - dec0) * 3600) / scaleArcsec;
  return { x, y };
}

/** Move a Gaia star (2016.0) to a date given as MJD. */
export function gaiaAt(star, mjd) {
  if (star.pmra == null || star.pmdec == null) return { ra: star.ra, dec: star.dec };
  const years = (mjd - GAIA_EPOCH_MJD) / 365.25;
  const cosd = Math.max(Math.cos((star.dec * Math.PI) / 180), 1e-6);
  return { ra: star.ra + (star.pmra * years) / 3.6e6 / cosd, dec: star.dec + (star.pmdec * years) / 3.6e6 };
}

export function createContext(player, { store, commands }) {
  const { view: viewEl, canvasWrap, canvas, bar } = player.elements;

  // --- DOM ---------------------------------------------------------------------------
  // The WISE / Gaia buttons are in the player's single "What to show" list. The timeline and the
  // WISE-blink modes have no button any more (the change video covers them) but still work from
  // links and commands (set_compare).
  const side = document.createElement('div');
  side.className = 'canvas-wrap ctx-wrap';
  side.hidden = true;
  side.innerHTML = `
    <img id="wise-img" alt="" />
    <canvas id="gaia-canvas" role="img" hidden></canvas>
    <svg class="overlay" id="wise-overlay" aria-hidden="true"></svg>
    <p class="ctx-label" id="wise-label"></p>`;
  viewEl.append(side);
  const sxOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  sxOverlay.setAttribute('class', 'overlay');
  sxOverlay.setAttribute('aria-hidden', 'true');
  canvasWrap.append(sxOverlay);

  const timeline = document.createElement('div');
  timeline.className = 'player-bar ctx-timeline';
  timeline.hidden = true;
  timeline.innerHTML = `
    <label for="ctx-scrub" class="inline">Timeline</label>
    <input type="range" id="ctx-scrub" min="0" max="0" value="0" />
    <span id="ctx-when" class="muted"></span>`;
  bar.after(timeline);

  const wiseImg = side.querySelector('#wise-img');
  const wiseOverlay = side.querySelector('#wise-overlay');
  const wiseLabel = side.querySelector('#wise-label');
  const gaiaCanvas = side.querySelector('#gaia-canvas');
  let gaiaPicKey = '';
  const scrubEl = timeline.querySelector('#ctx-scrub');
  const whenEl = timeline.querySelector('#ctx-when');

  // --- data --------------------------------------------------------------------------
  let wise = null; // { frames: [{index, mjd, date_iso, url}] }
  let gaia = null; // { sources: [...] } at 2016.0
  let fieldKey = '';
  let tlIndex = 0;
  let blinkTimer = null;
  let blinkPhase = 0;
  let wiseEpoch = -1; // -1 = latest

  // WISE and Gaia are both fetched as soon as the 2D view opens (each is one small, cached request), so
  // "Side by side with WISE / Gaia" is ready when pressed instead of starting its download then.
  let wiseStatus = 'idle'; // idle | loading | ok | error
  let gaiaStatus = 'idle';
  async function loadContext(s) {
    const key = `${s.ra.toFixed(5)},${s.dec.toFixed(5)}|${s.ffov}`;
    if (key === fieldKey) return;
    fieldKey = key;
    wise = null;
    gaia = null;
    wiseStatus = gaiaStatus = 'loading';
    const q = `ra=${s.ra.toFixed(5)}&dec=${s.dec.toFixed(5)}&fov=${s.ffov}`;
    const get = (url) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
    get(`/api/context/wise?${q}&band=2`)
      .then((d) => {
        if (key !== fieldKey) return;
        wise = d;
        wiseStatus = 'ok';
        render();
      })
      .catch((err) => {
        console.error('[context] WISE', err);
        if (key !== fieldKey) return;
        wiseStatus = 'error';
        render();
      });
    get(`/api/context/gaia?${q}`)
      .then((d) => {
        if (key !== fieldKey) return;
        gaia = d;
        gaiaStatus = 'ok';
        render();
      })
      .catch((err) => {
        console.error('[context] Gaia', err);
        if (key !== fieldKey) return;
        gaiaStatus = 'error';
        render();
      });
  }

  // --- drawing -------------------------------------------------------------------------
  function drawGaia(svg, s, mjd, scale, size) {
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    if (!gaia || !s.layers.includes('gaia') || !size) {
      svg.innerHTML = '';
      return;
    }
    const parts = [];
    for (const star of gaia.sources) {
      if (star.g_mag == null || star.g_mag > GAIA_MAX_MAG) continue;
      const p = gaiaAt(star, mjd);
      const { x, y } = skyToPixel(p.ra, p.dec, s.ra, s.dec, scale, size);
      if (x < -2 || y < -2 || x > size + 1 || y > size + 1) continue;
      const r = Math.max(0.9, (GAIA_MAX_MAG + 1 - star.g_mag) * 0.18) * (6.15 / scale);
      // +0.5: pixel centres sit at integer + 0.5 in SVG coordinates
      parts.push(`<circle cx="${(x + 0.5).toFixed(2)}" cy="${(y + 0.5).toFixed(2)}" r="${r.toFixed(2)}"><title>Gaia DR3 ${star.source_id}, G=${star.g_mag.toFixed(1)}</title></circle>`);
    }
    svg.innerHTML = parts.join('');
  }

  function wiseFrame(i) {
    if (!wise?.frames.length) return null;
    const k = i < 0 ? wise.frames.length - 1 : Math.min(i, wise.frames.length - 1);
    return wise.frames[k];
  }

  function showWise(frame, s) {
    if (!frame) {
      wiseLabel.textContent =
        wiseStatus === 'error' ? 'WISE images are not available right now.' : wiseStatus === 'ok' ? 'No WISE images of this patch.' : 'Loading WISE images…';
      return;
    }
    if (wiseImg.dataset.src !== frame.url) {
      wiseImg.dataset.src = frame.url;
      wiseImg.src = frame.url;
    }
    wiseImg.alt = `WISE W2 (4.6 µm) image of this patch, ${fmtDate(frame.date_iso)}`;
    wiseLabel.textContent = `WISE W2 · 4.6 µm · ${fmtDate(frame.date_iso)}`;
    const size = Math.round((s.ffov * 3600) / 2.75) | 1;
    drawGaia(wiseOverlay, s, frame.mjd, 2.75, size);
  }

  // A picture of the patch drawn from the Gaia catalogue, at the date of the SPHEREx image on screen.
  function showGaiaPicture(s, mjd) {
    wiseImg.hidden = true;
    wiseOverlay.hidden = true;
    gaiaCanvas.hidden = false;
    if (!gaia) {
      wiseLabel.textContent =
        gaiaStatus === 'error' ? 'Gaia stars are not available right now (the star archives did not answer). Try again later.' : 'Loading Gaia stars…';
      return;
    }
    const size = Math.round((s.ffov * 3600) / 2.75) | 1; // same 2.75" grid as WISE
    const key = `${fieldKey}|${Math.round(mjd)}|${size}`;
    if (key !== gaiaPicKey) {
      gaiaPicKey = key;
      const pic = renderGaia(gaia.sources, { ra0: s.ra, dec0: s.dec, mjd, size, scale: 2.75 });
      drawGaiaPicture(gaiaCanvas, pic);
      gaiaCanvas.dataset.drawn = String(pic.drawn);
    }
    const when = fmtDate(new Date((mjd - 40587) * 864e5).toISOString());
    const capped = gaia.sources.length >= 3000 ? ' (the 3,000 brightest)' : '';
    wiseLabel.textContent = `Gaia DR3 · drawn from the catalogue, not a photograph · visible light 0.33–1.05 µm · ${gaiaCanvas.dataset.drawn} stars${capped} at ${when}`;
    gaiaCanvas.setAttribute(
      'aria-label',
      `Picture of this patch drawn from the Gaia DR3 star catalogue: ${gaiaCanvas.dataset.drawn} stars placed where they were on ${when}, ` +
        'each painted with its measured brightness and colour. Gaia measures stars; it does not take pictures.',
    );
  }

  function timelineItems() {
    const seq = player.getSequence();
    const items = (wise?.frames ?? []).map((f) => ({ kind: 'wise', frame: f, mjd: f.mjd, date_iso: f.date_iso }));
    seq.forEach((f, i) => items.push({ kind: 'spherex', index: i, mjd: f.meta.mjd, date_iso: f.meta.date_iso }));
    return items.sort((a, b) => a.mjd - b.mjd);
  }

  function render() {
    const s = store.get();
    if (s.view !== 'field') return;
    viewEl.classList.toggle('compare-side', s.compare === 'side' || s.compare === 'gaia');
    side.hidden = !['side', 'timeline', 'blink', 'gaia'].includes(s.compare);
    if (s.compare !== 'gaia') {
      wiseImg.hidden = false;
      wiseOverlay.hidden = false;
      gaiaCanvas.hidden = true;
    }
    timeline.hidden = s.compare !== 'timeline';

    const seq = player.getSequence();
    const shown = player.getShownFrame();
    const sxSize = shown?.w ?? 0;
    const sxMjd = shown?.meta?.mjd ?? GAIA_EPOCH_MJD;
    drawGaia(sxOverlay, s, Number.isFinite(sxMjd) ? sxMjd : GAIA_EPOCH_MJD, SPHEREX_SCALE, sxSize);

    if (s.compare === 'gaia') {
      canvasWrap.hidden = false;
      showGaiaPicture(s, Number.isFinite(sxMjd) ? sxMjd : GAIA_EPOCH_MJD);
    } else if (s.compare === 'side') {
      canvasWrap.hidden = false;
      showWise(wiseFrame(wiseEpoch), s);
    } else if (s.compare === 'timeline') {
      const items = timelineItems();
      scrubEl.max = String(Math.max(0, items.length - 1));
      tlIndex = Math.min(tlIndex, items.length - 1);
      scrubEl.value = String(tlIndex);
      const it = items[tlIndex];
      if (it?.kind === 'wise') {
        canvasWrap.hidden = true;
        side.hidden = false;
        showWise(it.frame, s);
      } else if (it) {
        canvasWrap.hidden = false;
        side.hidden = true;
        if (store.get().frameIndex !== it.index) store.set({ frameIndex: it.index, playing: false }, 'context');
      }
      const label = it ? `${it.kind === 'wise' ? 'WISE W2 4.6 µm' : 'SPHEREx'} · ${fmtDate(it.date_iso)} (${tlIndex + 1} of ${items.length})` : '';
      whenEl.textContent = label;
      scrubEl.setAttribute('aria-valuetext', label);
    } else if (s.compare === 'blink') {
      const f = wiseFrame(-1);
      canvasWrap.hidden = blinkPhase === 1;
      side.hidden = blinkPhase === 0;
      if (f) showWise(f, s);
      wiseLabel.textContent = f ? `Blink: WISE W2 · ${fmtDate(f.date_iso)} ↔ SPHEREx` : wiseLabel.textContent;
    } else {
      canvasWrap.hidden = false;
      side.hidden = true;
    }
    syncBlink(s);
    void seq;
  }

  function syncBlink(s) {
    const want = s.view === 'field' && s.compare === 'blink';
    if (want && !blinkTimer) {
      blinkTimer = setInterval(() => {
        blinkPhase ^= 1;
        render();
      }, 1000 / BLINK_HZ);
    } else if (!want && blinkTimer) {
      clearInterval(blinkTimer);
      blinkTimer = null;
      blinkPhase = 0;
    }
  }

  // --- controls -> commands --------------------------------------------------------
  scrubEl.addEventListener('input', () => {
    tlIndex = Number(scrubEl.value);
    render();
  });
  wiseImg.addEventListener('error', () => (wiseLabel.textContent = 'This WISE image could not be loaded.'));

  // --- state -> context ------------------------------------------------------------
  store.subscribe((s, changed) => {
    if (s.view !== 'field') {
      syncBlink(s);
      return;
    }
    if (['ra', 'dec', 'ffov', 'view'].some((k) => changed.includes(k))) fieldKey = '';
    loadContext(s);
    render();
  });
  player.onShow(() => render());
  if (store.get().view === 'field') {
    loadContext(store.get());
    render();
  }
}
