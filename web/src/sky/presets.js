// Places users can jump to. `target` goes through fly_to (coordinates or a name Sesame knows).
// `shortcut: false`: no button in the Places panel (only the five challenge targets have one), but
// search, the guide and its tours still know the place.

export const PRESETS = [
  { id: 'milky_way', label: 'Milky Way centre', target: '266.4168 -29.0078', fov: 30, shortcut: false,
    aliases: ['milky way', 'milky way center', 'galactic center', 'galactic centre', 'sgr a*'],
    note: 'The centre of our galaxy, behind thick dust that infrared sees through.' },
  { id: 'solar_system', label: 'Solar System', target: '270 66.5607', fov: 90, shortcut: false,
    aliases: ['solar system', 'ecliptic', 'sun'],
    note: 'Looking along the ecliptic pole. The planets move along the ecliptic; the Sun itself is never in SPHEREx images.' },
  { id: 'barnard', label: "Barnard's Star", target: "Barnard's Star", fov: 0.5, aliases: ['barnard', 'barnards star', 'gj 699'],
    note: 'The fastest-moving star on our sky, about 10.4 arcsec per year.' },
  { id: 'eps_ind_b', label: 'Epsilon Indi B', target: 'eps Ind B', fov: 0.5, aliases: ['epsilon indi b', 'eps indi b', 'ε indi b'],
    note: 'A pair of brown dwarfs orbiting a nearby star.' },
  // The challenge gives 08h55m10.831s -07d14m42.53s (an older epoch). It moves ~8″/yr, so we
  // use the catalogue name: /api/resolve applies the proper motion (≈2′ away by 2026).
  { id: 'wise_0855', label: 'WISE 0855', target: 'WISEA J085510.74-071442.5', fov: 0.5,
    aliases: ['wise 0855', 'wise0855', 'wise 0855-0714', 'wise j0855-0714', 'wise j085510.83-071442.5'],
    note: 'The coldest known brown dwarf, moving about 8 arcsec per year.' },
  { id: 'rw_aur', label: 'RW Aurigae', target: 'RW Aur', fov: 0.5,
    note: 'A young variable star whose brightness changes.' },
  { id: 'r_dra', label: 'R Draconis', target: 'R Dra', fov: 0.5,
    note: 'A Mira variable: a pulsating red giant with big brightness swings.' },
];

export const presetById = (id) => PRESETS.find((p) => p.id === id);

const norm = (t) => t.toLowerCase().replace(/[’'`]/g, '').replace(/[\s_-]+/g, ' ').trim();

/** A preset matching typed text (label, id or alias), so "wise 0855" or "sun" just work. */
export function presetForText(text) {
  const t = norm(text);
  return PRESETS.find((p) => [p.label, p.id, ...(p.aliases ?? [])].some((a) => norm(a) === t)) ?? null;
}

/**
 * A resolver label fit to show (AI guide spec 1, P1-5): Sesame calls proper names "NAME Barnard's star".
 * A known place shows its own label; else a leading "NAME " goes and each word of that name starts
 * with a capital ("Barnard's Star"). Catalogue designations ("RW Aur", "WISEA J0855…") stay as they are.
 */
export function displayName(label, target) {
  const preset = typeof target === 'string' ? (PRESETS.find((p) => p.target === target) ?? presetForText(target)) : null;
  if (preset) return preset.label;
  const text = String(label ?? target ?? '').trim();
  const m = /^NAME\s+(.+)$/i.exec(text);
  if (!m) return text;
  return m[1].replace(/(^|[\s-])([a-z])/g, (_, sep, c) => sep + c.toUpperCase());
}
