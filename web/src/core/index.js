// The app-wide core: one store, one command bus, and the input sources that feed it.
import { store } from './state.js';
import { createCommands } from './commands.js';
import { registerDefaultCommands } from './defaultCommands.js';
import { startUrlSync } from './url.js';
import { startKeyboard } from './keys.js';
import { startMessages } from './messages.js';

export { store };
export const commands = createCommands();
export const run = commands.run;

registerDefaultCommands(commands, store);

// Sky <-> screen positions (sky/skyCoords.js). Set once the sky exists; null before that.
const skyCoords = { world2pix: () => null, pix2world: () => null };
export function setSkyCoords(c) {
  Object.assign(skyCoords, c);
}
const world2pix = (ra, dec) => skyCoords.world2pix(ra, dec);
const pix2world = (x, y) => skyCoords.pix2world(x, y);

/** Start URL sync, keyboard and postMessage input. Returns { name } from the URL, if any. */
export function startCore({ allowedOrigins = [] } = {}) {
  const url = startUrlSync(store);
  startKeyboard(commands);
  startMessages(commands, { allowedOrigins, world2pix, pix2world, getState: () => store.get() });

  // For overlays in the page, the console, and testing the eye tracker by hand.
  window.meridian = { store, commands, run, world2pix, pix2world };
  return { name: url.name };
}
