// Places users can jump to. `target` goes through fly_to (coordinates or a name Sesame knows).

export const PRESETS = [
  { id: 'milky_way', label: 'Milky Way centre', target: '266.4168 -29.0078', fov: 30,
    note: 'The centre of our galaxy, behind thick dust that infrared sees through.' },
  { id: 'solar_system', label: 'Solar System', target: '270 66.5607', fov: 90,
    note: 'Looking along the ecliptic pole. The planets move along the ecliptic; the Sun itself is never in SPHEREx images.' },
  { id: 'barnard', label: "Barnard's Star", target: "Barnard's Star", fov: 0.5,
    note: 'The fastest-moving star on our sky, about 10.4 arcsec per year.' },
  { id: 'eps_ind_b', label: 'Epsilon Indi B', target: 'eps Ind B', fov: 0.5,
    note: 'A pair of brown dwarfs orbiting a nearby star.' },
  { id: 'wise_0855', label: 'WISE 0855', target: '08h55m10.831s -07d14m42.53s', fov: 0.5,
    note: 'The coldest known brown dwarf, moving about 8 arcsec per year.' },
  { id: 'rw_aur', label: 'RW Aurigae', target: 'RW Aur', fov: 0.5,
    note: 'A young variable star whose brightness changes.' },
  { id: 'r_dra', label: 'R Draconis', target: 'R Dra', fov: 0.5,
    note: 'A Mira variable: a pulsating red giant with big brightness swings.' },
];

export const presetById = (id) => PRESETS.find((p) => p.id === id);
