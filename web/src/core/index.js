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

/** Start URL sync, keyboard and postMessage input. Returns { name } from the URL, if any. */
export function startCore({ allowedOrigins = [] } = {}) {
  const url = startUrlSync(store);
  startKeyboard(commands);
  startMessages(commands, { allowedOrigins });

  // Console access for debugging and for testing the eye tracker by hand.
  window.meridian = { store, commands, run };
  return { name: url.name };
}
