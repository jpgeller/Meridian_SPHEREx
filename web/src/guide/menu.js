// What is in the middle of the view, for the guide's "What am I looking at?" (wireframe v4).
//
//   centreTarget(items, centre, r) -> { id, name? } | null
//        The sky object nearest the middle of the view, within r px. items = registry.list().
//        A named place (sky:barnard) beats sky:target (the last fly_to), which sits on the same spot.
// Pure: index.js passes the registry's list.

import { presetById } from '../sky/presets.js';


/** A display name for a sky/field id: the preset's label, else the registry's label. */
function nameOf(item) {
  const preset = /^(sky|field):/.test(item.id) ? presetById(item.id.split(':')[1]) : null;
  return preset?.label || (typeof item.label === 'string' && item.label.trim()) || null;
}

export function centreTarget(items, centre, r) {
  let best = null;
  for (const it of items ?? []) {
    if (!/^sky:/.test(it?.id ?? '') || it.rect || !Number.isFinite(it.x) || !Number.isFinite(it.y)) continue;
    const d = Math.hypot(it.x - centre.x, it.y - centre.y);
    if (d > r) continue;
    // a named place first, then the nearest
    const rank = it.id === 'sky:target' ? 1 : 0;
    if (!best || rank < best.rank || (rank === best.rank && d < best.d)) best = { rank, d, it };
  }
  if (!best) return null;
  const name = nameOf(best.it);
  return { id: best.it.id, ...(name ? { name } : {}) };
}
