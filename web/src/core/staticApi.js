// The five challenge targets ship as static files (web/public/data/api/, written by api/export_static.py),
// so they open at once with no API at all. installStaticApi() wraps window.fetch: a GET to /api/... whose
// key is in data/api/index.json ({key: [file, content type, 1 if the file starts with the API's headers]})
// is answered from its file (with the API's own headers, e.g. a cutout's X-Width/X-Height/X-Meta);
// anything else goes to the network as before. `?static=0` turns it off.

/** '/api/cutout?ra=1&id=x' -> 'cutout?id=x&ra=1'. Same rule as api_key() in api/export_static.py. */
export function apiKey(url, base = 'http://localhost/') {
  const u = new URL(url, base);
  const path = u.pathname.split('/api/')[1] ?? '';
  const params = [...u.searchParams.entries()].sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  return params.length ? `${path}?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : path;
}

const isApiGet = (url, init, origin) => {
  if (init?.method && init.method.toUpperCase() !== 'GET') return false;
  try {
    const u = new URL(url, origin);
    return u.origin === new URL(origin).origin && u.pathname.startsWith('/api/');
  } catch {
    return false;
  }
};

/**
 * Wrap `win.fetch`. Returns { ready: Promise<number of static answers>, staticUrl(url) for <img src> }.
 * dataBase: where data/api/ is served (Vite's BASE_URL, so a sub-path deploy works).
 */
export function installStaticApi({ win = globalThis, dataBase = '/data/api/', enabled = true } = {}) {
  const realFetch = win.fetch.bind(win);
  const origin = win.location?.href ?? 'http://localhost/';
  let entries = null;
  const ready = enabled
    ? realFetch(`${dataBase}index.json`)
        .then((r) => (r.ok ? r.json() : { entries: {} }))
        .catch(() => ({ entries: {} }))
        .then((idx) => {
          entries = idx.entries ?? {};
          return Object.keys(entries).length;
        })
    : Promise.resolve(0);

  async function answer(url) {
    await ready;
    const hit = entries?.[apiKey(url, origin)];
    if (!hit) return null;
    const [file, type, packed] = hit;
    const r = await realFetch(`${dataBase}${file}`).catch(() => null);
    if (!r?.ok) return null;
    let body = await r.arrayBuffer();
    let headers = {};
    if (packed === 1) {
      // the API's own headers travel in the file: 4-byte little-endian length, JSON, then the body
      const n = new DataView(body).getUint32(0, true);
      headers = JSON.parse(new TextDecoder().decode(new Uint8Array(body, 4, n)));
      body = body.slice(4 + n);
    }
    return new Response(body, { status: 200, headers: { 'Content-Type': type, ...headers } });
  }

  /** For an <img src>: the static file of an /api/ URL once the index is in, else the URL itself. */
  function staticUrl(url) {
    const hit = entries && isApiGet(url, null, origin) ? entries[apiKey(url, origin)] : null;
    return hit ? `${dataBase}${hit[0]}` : url;
  }

  if (enabled) {
    win.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      if (url && isApiGet(url, init ?? input, origin)) {
        const r = await answer(url);
        if (r) return r;
      }
      return realFetch(input, init);
    };
  }
  return { ready, staticUrl };
}
