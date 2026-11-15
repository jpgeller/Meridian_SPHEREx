// Bottom-right readout: where the view is pointing (RA / Dec of the centre, ICRS) and how wide it is.
// The only sky numbers on screen: Aladin's own widgets (frame menu, coordinates, zoom, logo) are off,
// since the app is about reaching SPHEREx images, not about Aladin's tools. Reads state only.
import { formatRaDec, formatFov } from '../core/coords.js';

export function createReadout(root, { store }) {
  root.innerHTML = `
    <dl class="readout-grid" aria-label="View centre">
      <div><dt>RA</dt><dd id="ro-ra"></dd></div>
      <div><dt>Dec</dt><dd id="ro-dec"></dd></div>
      <div><dt>Field</dt><dd id="ro-fov"></dd></div>
    </dl>`;
  const $ = (id) => root.querySelector(id);
  const render = (s) => {
    const { ra, dec } = formatRaDec(s.ra, s.dec);
    $('#ro-ra').textContent = ra;
    $('#ro-dec').textContent = dec;
    $('#ro-fov').textContent = formatFov(s.fov);
  };
  store.subscribe((s, changed) => {
    if (!changed || changed.some((k) => k === 'ra' || k === 'dec' || k === 'fov')) render(s);
  });
  render(store.get());
}
