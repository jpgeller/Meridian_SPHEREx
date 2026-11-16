// Fact cards for the 7 Places (AI guide spec, "Preset fact cards"). One card per preset id in presets.js.
// The single source of facts about a place: the local tours (guide/tours.js) read it, the guide sends ONLY
// the one card of the place in view to Claude as facts.preset (guide/client.js), and the local fallbacks
// open with its hook (guide/fallback.js, guide/nudge.js).
//
// Numbers are copied exactly from the spec table (docs/fix-and-improvements-ai-guide.md, sources opened
// 15 Nov 2026). Do not add numbers that are not in a listed source. `bands.status` stays "expected" until
// the team checks each note against the real SPHEREx cutouts (then "seen").
//
//   card = { id, name, type, components[], distance: { pc, ly } | null, numbers: { term: 'value with units' },
//            hook, facts[] (3-5 short lines), bands: { status, note }, moves (″/yr) | null,
//            variable: { period, amplitude } | null, resolvable: { value, note }, look_for[],
//            summary (the tour's "what it is" step, ≤ 35 words), suggested_actions: [{ label, tour }], sources[] }
//   numbers: the first four entries are the tour's facts step, so they stay short (one line each).
//   factsFor(id) -> card | null    ('barnard', 'sky:barnard' or 'field:barnard')
//   promptCard(card) -> the card as sent to Claude (no source URLs or tour wording: they carry no facts)

const SRC = {
  barnardArchive: 'https://exoplanetarchive.ipac.caltech.edu/overview/Barnards%20star',
  barnardDlr: 'https://www.dlr.de/en/wr/about-us/departments-1/extrasolar-planets-and-atmospheres/news-from-our-department-epa/barnards-star-actually-hosts-four-planets',
  epsIndKing: 'https://arxiv.org/pdf/0911.3143',
  epsIndCardoso: 'https://arxiv.org/pdf/0811.0588',
  epsIndWiki: 'https://cliffipedia.org/content/wikipedia_en_all_maxi_2025-08/%CE%95_Ind',
  wise0855: 'https://EN.wikipedia.com/wiki/WISE_0855%E2%88%920714',
  rwAurRodriguez: 'https://arxiv.org/pdf/1512.03745',
  rwAurPetrov: 'https://www.aanda.org/articles/aa/full_html/2015/05/aa25845-15/aa25845-15.html',
  mira: 'https://en.Wikipedia.com/wiki/Mira_variable',
  sgrA: 'https://en.wikipedia.org/wiki/Sagittarius_A*',
  spherexMap: 'https://www.jpl.nasa.gov/news/nasas-spherex-observatory-completes-first-cosmic-map-like-no-other/',
  spherexPoles: 'https://universetoday.com/165825/a-new-space-telescope-will-map-the-universe-and-help-protect-the-earth-from-asteroids',
};

export const PRESET_FACTS = Object.freeze({
  milky_way: {
    id: 'milky_way',
    name: 'Milky Way centre',
    type: 'Galaxy core',
    components: ['Galactic centre around Sgr A*, a supermassive black hole', 'Thick dust in front of it'],
    distance: { pc: 8280, ly: 27000 },
    numbers: {
      Distance: '~27,000 light-years (8.28 kpc)',
      'Sgr A* mass': '~4.3 million Suns',
      Imaged: 'Event Horizon Telescope (2022)',
    },
    hook: 'The heart of our galaxy is hidden behind dust in visible light; infrared sees straight through.',
    facts: [
      'The galactic centre is about 27,000 light-years (8.28 kpc) away.',
      'At its middle sits Sgr A*, a supermassive black hole of about 4.3 million solar masses.',
      'The Event Horizon Telescope imaged Sgr A* in 2022.',
      'Thick dust blocks its visible light; longer infrared wavelengths pass through more of it.',
    ],
    bands: { status: 'expected', note: 'Dust lanes fade at longer wavelengths: compare D1 with D6.' },
    moves: null,
    variable: null,
    resolvable: { value: true, note: 'A wide field of stars and dust, not a single dot. Sgr A* itself is far too small to see here.' },
    look_for: ['Dark dust lanes in D1 that fade in D6, as longer infrared light gets through the dust.'],
    summary:
      'The centre of our galaxy, around Sagittarius A*, a black hole about 4.3 million times the Sun’s mass. Thick dust blocks its visible light; infrared slips through.',
    suggested_actions: [{ label: 'Compare D1 and D6', tour: 'colours' }],
    sources: [SRC.sgrA],
  },
  solar_system: {
    id: 'solar_system',
    name: 'Solar System',
    type: 'Ecliptic pole',
    components: [
      'Not an object: the view toward the north ecliptic pole (RA 270°, Dec +66.56°)',
      'The planets move along the ecliptic',
      'The Sun never appears in SPHEREx images',
    ],
    distance: null,
    numbers: {
      Pointing: 'north ecliptic pole',
      Position: 'RA 270°, Dec +66.56°',
      'All-sky map': 'every ~6 months',
      'Ecliptic poles': 'covered every orbit',
    },
    hook: 'You’re looking straight “up” out of the plane the planets orbit in, one of the spots SPHEREx watches most often.',
    facts: [
      'This is the north ecliptic pole (RA 270°, Dec +66.56°), not an object.',
      'The planets move along the ecliptic, the plane they orbit in, far from here.',
      'The Sun never appears in SPHEREx images.',
      'SPHEREx maps the whole sky every ~6 months and covers the ecliptic poles every orbit.',
    ],
    bands: { status: 'expected', note: null },
    moves: null,
    variable: null,
    resolvable: { value: true, note: 'A direction, not an object: every dot here is a star or a galaxy.' },
    look_for: ['Asteroids near the ecliptic can show up as dots that move between frames.'],
    summary:
      'Not an object: the direction straight out of the plane the planets orbit in (the ecliptic). The planets move along that plane, and the Sun never appears in SPHEREx images.',
    suggested_actions: [{ label: 'What the colours show', tour: 'colours' }],
    sources: [SRC.spherexMap, SRC.spherexPoles],
  },
  barnard: {
    id: 'barnard',
    name: "Barnard's Star",
    type: 'Red dwarf star',
    components: [
      'Single red dwarf (M3.5–4 V)',
      '4 sub-Earth planets (b, c, d, e), all in 2–7 day orbits, none in the habitable zone',
    ],
    distance: { pc: 1.83, ly: 6.0 },
    numbers: {
      Distance: '6.0 light-years (1.83 pc)',
      Motion: '10.4″ per year',
      Brightness: 'mag 9.5 (V)',
      Planets: '0.19–0.34 Earth masses',
    },
    hook: 'The fastest-moving star in our sky: it shifts a full-Moon width in about 180 years.',
    facts: [
      'It is 1.83 pc (6.0 light-years) away.',
      'It crosses the sky at 10.4″ a year (proper motion), faster than any other star.',
      'Four small planets (b, c, d, e) of 0.19–0.34 Earth masses circle it in 2–7 days.',
      'None of the planets is in the habitable zone.',
    ],
    bands: { status: 'expected', note: null },
    moves: 10.4,
    variable: null,
    resolvable: { value: false, note: 'The planets are not visible: they were found by radial velocity, not imaged.' },
    look_for: [
      'Watch it shift between the first and last SPHEREx visit.',
      'The planets are not visible: they were found from the star’s wobble (radial velocity).',
    ],
    summary:
      'A small, cool star (red dwarf, M3.5–4 V) and one of the Sun’s closest neighbours. Four planets smaller than Earth circle it in 2 to 7 days, none in the habitable zone.',
    suggested_actions: [{ label: 'Watch it move', tour: 'motion' }],
    sources: [SRC.barnardArchive, SRC.barnardDlr],
  },
  eps_ind_b: {
    id: 'eps_ind_b',
    name: 'Epsilon Indi B',
    type: 'Pair of brown dwarfs',
    components: [
      'Ba (T1–T1.5), ~47 Jupiter masses, ~1,300 K',
      'Bb (T6), ~28 Jupiter masses, ~900 K',
      'Ba and Bb orbit each other every ~15 years, ~2 AU apart',
      'Both orbit the orange star Epsilon Indi A at ~1,460 AU (projected)',
    ],
    distance: { pc: 3.62, ly: 11.8 },
    numbers: {
      Distance: '11.8 light-years (3.62 pc)',
      Masses: 'Ba ~47, Bb ~28 Jupiters',
      Temperatures: 'Ba ~1,300 K, Bb ~900 K',
      Motion: '~4.7″ per year',
      Orbit: '~15 years, ~2 AU apart',
      Separation: '0.6–0.7″',
    },
    hook: 'The closest known pair of brown dwarfs: two failed stars orbiting each other, both circling a star you can see by eye.',
    facts: [
      'It is 3.62 pc (11.8 light-years) away.',
      'Ba (~47 Jupiter masses, ~1,300 K) and Bb (~28, ~900 K) orbit each other every ~15 years.',
      'The pair circles the orange star Epsilon Indi A, ~1,460 AU away (projected).',
      'It crosses the sky at ~4.7″ a year (proper motion).',
    ],
    bands: { status: 'expected', note: 'Brighter at longer wavelengths: methane absorbs the shorter ones.' },
    moves: 4.7,
    variable: null,
    resolvable: { value: false, note: 'The pair is 0.6–0.7″ apart, far below SPHEREx resolution (6.15″ pixels), so it looks like one dot.' },
    look_for: [
      'The two brown dwarfs are 0.6–0.7″ apart, far smaller than one SPHEREx pixel, so they look like one dot.',
      'It is brighter at longer wavelengths, because methane absorbs the shorter ones.',
    ],
    summary:
      'Two brown dwarfs, Ba and Bb, orbit each other every 15 years or so, about 2 AU apart. Together they circle the orange star Epsilon Indi A, about 1,460 AU away.',
    suggested_actions: [{ label: 'Watch it move', tour: 'motion' }],
    sources: [SRC.epsIndKing, SRC.epsIndCardoso, SRC.epsIndWiki],
  },
  wise_0855: {
    id: 'wise_0855',
    name: 'WISE 0855',
    type: 'Brown dwarf',
    components: [
      'Isolated Y4 sub-brown dwarf (planetary mass), no host star',
      'Water-ice clouds suggested',
      'Challenge coordinates RA 08h55m10.831s, Dec −07°14′42.53″',
    ],
    distance: { pc: 2.28, ly: 7.4 },
    numbers: {
      Distance: '7.4 light-years (2.28 pc)',
      Temperature: '~225–285 K',
      Mass: '3–10 Jupiters',
      Motion: '~8.1″ per year',
    },
    hook: 'The coldest known brown dwarf, roughly room temperature or colder, and almost invisible except in infrared.',
    facts: [
      'It is 2.28 pc (7.4 light-years) away, the 4th-closest system to the Sun.',
      'It is ~225–285 K depending on the model (about −48 to +12 °C).',
      'It has 3–10 Jupiter masses and no host star; water-ice clouds are suggested.',
      'It crosses the sky at ~8.1″ a year, so by 2026 it is ~2′ from its J2000 position.',
    ],
    bands: { status: 'expected', note: 'Faint or absent in D1–D3, appears in D5–D6.' },
    moves: 8.1,
    variable: null,
    resolvable: { value: true, note: 'A single object with no companion: one faint dot.' },
    look_for: ['It is faint or absent in D1 to D3 and should appear in D5 and D6.'],
    summary:
      'A “failed star” (sub-brown dwarf, type Y4) of 3 to 10 Jupiter masses, alone with no host star. Catalogs suggest clouds of water ice.',
    suggested_actions: [
      { label: 'Show it in D6', tour: 'identify' },
      { label: 'Watch it move', tour: 'motion' },
    ],
    sources: [SRC.wise0855],
  },
  rw_aur: {
    id: 'rw_aur',
    name: 'RW Aurigae',
    type: 'Young variable star',
    components: [
      'RW Aur A: a young T Tauri star, accreting and driving a jet',
      'RW Aur B: a T Tauri star 1.4″ from A',
      'A past flyby of B tore A’s disk into a ~600 AU tidal arm',
    ],
    distance: { pc: 140, ly: 460 },
    numbers: {
      Distance: '~460 light-years (~140 pc)',
      Dimmings: '2010–11 and 2014–15',
      'Dimmed by': '2–4.5 mag',
      Separation: '1.4″',
    },
    hook: 'A baby star system whose disk was ripped by a close encounter; clumps of that dust periodically block the star.',
    facts: [
      'It is ~140 pc (~460 light-years) away.',
      'Two young stars (T Tauri stars), A and B, are 1.4″ apart.',
      'A past flyby of B tore A’s disk into a ~600 AU tidal arm.',
      'Deep dimmings of 2–4.5 mag came in 2010–11 and 2014–15.',
    ],
    bands: { status: 'expected', note: 'Colour change: dust dims blue light more than red.' },
    moves: null,
    variable: { period: null, amplitude: '2–4.5 mag (deep dimmings in 2010–11 and 2014–15)' },
    resolvable: { value: false, note: 'A and B are 1.4″ apart, unresolved at SPHEREx scale (6.15″ pixels): one dot.' },
    look_for: [
      'A and B are 1.4″ apart, smaller than a SPHEREx pixel, so they look like one dot.',
      'Look for brightness and colour changes between visits.',
    ],
    summary:
      'Two very young stars (T Tauri stars), A and B. A is still pulling in gas and drives a jet. A past flyby of B tore A’s disk into a long arm.',
    suggested_actions: [{ label: 'See it change', tour: 'motion' }],
    sources: [SRC.rwAurRodriguez, SRC.rwAurPetrov],
  },
  r_dra: {
    id: 'r_dra',
    name: 'R Draconis',
    type: 'Mira variable star',
    components: ['Mira variable: a pulsating red giant'],
    distance: { pc: 660, ly: 2200, note: 'Gaia DR2, uncertain' },
    numbers: {
      Period: '246 days',
      'Visible range': 'V mag 6.7–13.2',
      Distance: '~2,200 light-years (~660 pc)',
    },
    hook: 'A giant star that swells and fades every 8 months, changing brightness by more than 100× in visible light.',
    facts: [
      'It pulsates with a period of 246 days.',
      'In visible light it ranges from V mag 6.7 to 13.2.',
      'It is ~660 pc (~2,200 light-years) away (Gaia DR2, uncertain).',
      'Its infrared change is smaller than in visible light (Mira: >1 mag IR, >2.5 mag visual).',
    ],
    bands: { status: 'expected', note: 'Infrared amplitude smaller than visible.' },
    moves: null,
    variable: { period: '246 days', amplitude: 'V mag 6.7–13.2' },
    resolvable: { value: true, note: 'A single star, but it saturates every SPHEREx image, so its brightness cannot be measured here.' },
    look_for: [
      'SPHEREx visits about 6 months apart catch it at different phases.',
      'It saturates every SPHEREx image, so its exact brightness cannot be measured here.',
    ],
    summary:
      'A giant star near the end of its life (Mira variable) that swells and shrinks, brightening and fading over 246 days.',
    suggested_actions: [{ label: 'Compare two visits', tour: 'motion' }],
    sources: [SRC.mira],
  },
});

/** The card of a place: 'barnard', 'sky:barnard' or 'field:barnard' -> card, else null. */
export function factsFor(id) {
  if (typeof id !== 'string') return null;
  return PRESET_FACTS[id.replace(/^(sky|field):/, '')] ?? null;
}

// left out of what Claude sees: URLs and the tours' own wording carry no facts it needs
const PROMPT_OMIT = new Set(['sources', 'summary', 'suggested_actions']);
/** The card as sent to Claude (facts.preset). */
export function promptCard(card) {
  if (!card) return null;
  return Object.fromEntries(Object.entries(card).filter(([k]) => !PROMPT_OMIT.has(k)));
}
