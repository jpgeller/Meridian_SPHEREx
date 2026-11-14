// The SPHEREx DR1 all-sky HiPS cube and the band <-> frequency fix for Aladin.
//
// Tiles are named _0.._101 in increasing wavelength. Aladin's setSliceNumber() goes
// through frequency and loads the wrong tile, so we compute the frequency that lands in
// the middle of frame k, given Aladin's own mapping (src/core/.../d3/mod.rs):
//   channel = floor((f - F_MIN) / (F_MAX - F_MIN) * depth)

export const SPHEREX_HIPS = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';

const C = 299792458; // m/s
const EM_MIN = 7.43e-7; // m, from the HiPS properties
const EM_MAX = 5.009e-6;
const DEPTH = 102;
const F_MIN = C / EM_MAX;
const F_MAX = C / EM_MIN;

export function bandToFrequency(k) {
  return F_MIN + ((k + 0.5) / DEPTH) * (F_MAX - F_MIN);
}

/** Wavelength (µm) of each cube frame, read from the HiPS properties. null if unavailable. */
export async function loadWavelengths() {
  try {
    const text = await (await fetch(`${SPHEREX_HIPS}/properties`)).text();
    const m = text.match(/data_cube_crval3_arr\s*=\s*(.+)/);
    if (!m) return null;
    const arr = m[1].trim().split(/\s+/).map(Number);
    return arr.length === DEPTH && arr.every(Number.isFinite) ? arr : null;
  } catch (err) {
    console.warn('[spherex] could not read wavelengths', err);
    return null;
  }
}

/** Resolves with the base layer once Aladin has attached it (needed before setFrequency). */
export function waitForLayer(aladin, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const layer = aladin.getBaseImageLayer();
      if (layer?.added) return resolve(layer);
      if (Date.now() - started > timeoutMs) return reject(new Error('SPHEREx layer did not load'));
      setTimeout(tick, 150);
    };
    tick();
  });
}

export function showBand(layer, band) {
  layer.setFrequency({ value: bandToFrequency(band), unit: 'Hz' });
}
