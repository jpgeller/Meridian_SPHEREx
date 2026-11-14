// Places users can jump to. `target` goes through fly_to (coordinates or a name Sesame knows).

export const PRESETS = [
  { id: 'milky_way', label: 'Milky Way centre', target: '266.4168 -29.0078', fov: 30,
    aliases: ['milky way', 'milky way center', 'galactic center', 'galactic centre', 'sgr a*'],
    note: 'The centre of our galaxy, behind thick dust that infrared sees through.' },
  { id: 'solar_system', label: 'Solar System', target: '270 66.5607', fov: 90, aliases: ['solar system', 'ecliptic', 'sun'],
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
