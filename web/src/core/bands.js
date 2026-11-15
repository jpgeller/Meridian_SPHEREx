// SPHEREx band helpers shared by commands, the sky and the field view. Pure: no DOM.
// The HiPS cube has frames 0..101 in increasing wavelength; 0, 50 and 51 are blank on IRSA.

export const BAND_MIN = 1;
export const BAND_MAX = 101;
export const BLANK = new Set([0, 50, 51]);
export const DETECTORS = 6;
export const CHANNELS_PER_DETECTOR = 17;

/** Detector (1-6) and channel (1-17) for a cube frame index. */
export function detectorOf(band) {
  return {
    detector: Math.floor(band / CHANNELS_PER_DETECTOR) + 1,
    channel: (band % CHANNELS_PER_DETECTOR) + 1,
  };
}

/** Clamp to the valid range and step off blank frames in direction `dir` (+1/-1). */
export function normalizeBand(band, dir = 1) {
  let b = Math.round(Number(band));
  if (!Number.isFinite(b)) return null;
  b = Math.min(BAND_MAX, Math.max(BAND_MIN, b));
  const step = dir < 0 ? -1 : 1;
  while (BLANK.has(b)) {
    b += step;
    if (b > BAND_MAX || b < BAND_MIN) {
      // Ran off the end: search the other way.
      return normalizeBand(band, -step);
    }
  }
  return b;
}

/** The middle band of detector d (1-6): what a detector button shows. */
export function middleBand(d) {
  return normalizeBand((d - 1) * CHANNELS_PER_DETECTOR + Math.floor(CHANNELS_PER_DETECTOR / 2));
}

/** Next valid band from `band` in direction `dir`, staying put at the ends. */
export function stepBand(band, dir) {
  const target = band + (dir < 0 ? -1 : 1);
  if (target > BAND_MAX || target < BAND_MIN) return band;
  return normalizeBand(target, dir);
}
