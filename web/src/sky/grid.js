// Fixed sky grid for full-resolution patches (pure, no DOM; unit-tested).
export const CELL = 0.5; // degrees: grid spacing (patches are PATCH wide, so neighbours overlap)
export const PATCH = 0.6; // degrees: patch size (the API's limit; wavelength drifts across wider patches)

const rad = (d) => (d * Math.PI) / 180;

/** Grid cells (centres) whose box overlaps the view, nearest the view centre first. */
export function cellsForView(ra, dec, fov, maxCells = 9) {
  const cells = [];
  const half = fov / 2 + CELL / 2; // a cell overlaps if its centre is within half view + half cell
  const j0 = Math.round(dec / CELL);
  const span = Math.ceil(half / CELL);
  for (let j = j0 - span; j <= j0 + span; j++) {
    const cdec = j * CELL;
    if (cdec < -90 || cdec > 90 || Math.abs(cdec - dec) > half) continue;
    const step = CELL / Math.max(Math.cos(rad(cdec)), 0.05); // cells keep ~CELL width on the sky
    const i0 = Math.round(ra / step);
    const ispan = Math.ceil((half / Math.max(Math.cos(rad(dec)), 0.05)) / step) + 1;
    for (let i = i0 - ispan; i <= i0 + ispan; i++) {
      const cra = (((i * step) % 360) + 360) % 360;
      let dra = Math.abs(cra - ra);
      if (dra > 180) dra = 360 - dra;
      const dx = dra * Math.cos(rad(dec));
      const dy = Math.abs(cdec - dec);
      if (dx > half || dy > half) continue;
      cells.push({ ra: Number(cra.toFixed(5)), dec: Number(cdec.toFixed(5)), d: Math.hypot(dx, dy) });
    }
  }
  return cells.sort((a, b) => a.d - b.d).slice(0, maxCells);
}
