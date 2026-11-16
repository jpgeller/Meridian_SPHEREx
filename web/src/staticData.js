// Imported first in main.js, before anything fetches: the five challenge targets answer from static files
// (core/staticApi.js). ?static=0 turns it off (e.g. to compare with a freshly processed API answer).
// Outside a browser (node unit tests importing a module that uses staticUrl) it does nothing.
import { installStaticApi } from './core/staticApi.js';

const inBrowser = typeof window !== 'undefined' && typeof window.fetch === 'function';
const enabled = inBrowser && new URLSearchParams(window.location.search).get('static') !== '0';
export const staticData = inBrowser
  ? installStaticApi({ win: window, dataBase: `${import.meta.env?.BASE_URL ?? '/'}data/api/`, enabled })
  : { ready: Promise.resolve(0), staticUrl: (url) => url };
export const staticUrl = (url) => staticData.staticUrl(url);
