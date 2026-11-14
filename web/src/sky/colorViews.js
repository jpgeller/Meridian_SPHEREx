// Colour views of the full map.
//
// SPHEREx sees 0.75–5 µm, which has no visible colour. The map can show:
//   grey   – one band as brightness (the most literal view)
//   tint   – one band coloured like its detector on the ribbon (blue = short … rose = long),
//            so moving the band slider visibly changes the map
//   ir / dust / ice / custom – false-colour mixes: three bands painted red, green, blue
//            (longest wavelength in red), like Hubble/JWST colour images. Built on the server
//            (/api/hips/mix/R-G-B) from IRSA's band tiles.
import { SPHEREX_HIPS, waitForLayer, showBand } from './spherexCube.js';
import { detectorOf } from '../core/bands.js';

export const DETECTOR_COLOURS = ['#6aa8ff', '#5fd0c4', '#9be07a', '#f2d16b', '#f59a6b', '#ef7aa7'];

export const COLOR_PRESETS = {
  ir: {
    label: 'Infrared colour',
    bands: [87, 42, 22], // 4.50, 2.00, 1.25 µm (1.0 µm has tile gaps near the Galactic centre)
    note: 'Red 4.5 µm · green 2.0 µm · blue 1.25 µm: hot stars look blue-white, cool and dusty things red.',
  },
  dust: {
    label: 'Dust glow',
    bands: [62, 46, 22], // 3.29 (PAH dust emission), 2.19, 1.25 µm
    note: 'Red 3.29 µm, where interstellar dust glows: dust clouds come out orange and red.',
  },
  ice: {
    label: 'Ices',
    bands: [65, 59, 52], // 3.57, 3.03 (water-ice absorption), 2.51 µm
    note: 'Green 3.03 µm, where water ice absorbs: icy clouds lose green and look purple.',
  },
};

export const mixBands = (s) => (s.color === 'custom' ? s.mix : COLOR_PRESETS[s.color]?.bands ?? null);
export const tintColormap = (band) => `meridian-d${detectorOf(band).detector}`;

export function createColorViews(aladin, sky, { store, onStatus = () => {} }) {
  // Lowercase names: Aladin lowercases a colormap name when applying it, but not when registering it.
  DETECTOR_COLOURS.forEach((c, i) => aladin.addColormap(`meridian-d${i + 1}`, ['black', c]));

  let shownMix = ''; // '62-46-22' when a mix is the base layer, '' for the band cube
  let token = 0;

  async function apply(s) {
    const my = ++token;
    const bands = mixBands(s);
    if (bands) {
      const key = bands.join('-');
      if (shownMix !== key) {
        shownMix = key;
        sky.layer = null; // the band cube is not on screen: band changes do nothing
        aladin.setBaseImageLayer(aladin.newImageSurvey(`${location.origin}/api/hips/mix/${key}`, { name: `SPHEREx colour mix ${key}` }));
      }
      const preset = COLOR_PRESETS[s.color];
      onStatus(preset ? `${preset.label}: ${preset.note}` : `Your colour mix: red band ${bands[0]}, green ${bands[1]}, blue ${bands[2]}`);
      return;
    }
    if (shownMix) {
      shownMix = '';
      aladin.setBaseImageLayer(aladin.newImageSurvey(SPHEREX_HIPS));
      sky.layer = null;
      try {
        const layer = await waitForLayer(aladin);
        if (my !== token) return;
        sky.layer = layer;
        showBand(layer, store.get().band);
      } catch (err) {
        onStatus(`Sky failed to load: ${err.message}`);
        return;
      }
    }
    const layer = sky.layer ?? aladin.getBaseImageLayer();
    layer?.setColormap?.(s.color === 'tint' ? tintColormap(s.band) : 'grey');
    onStatus('');
  }

  store.subscribe((s, changed) => {
    if (changed.includes('color') || changed.includes('mix') || (changed.includes('band') && s.color === 'tint')) apply(s);
  });
  return { apply, get mix() { return shownMix; } };
}
