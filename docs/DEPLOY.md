# Deploying Meridian

The app ships as **one service**: `Dockerfile` builds the front end, then runs the FastAPI app,
which serves that build at `/` and the API at `/api/*`. Same origin, so there is no CORS to
configure and no second URL to keep in step.

Once the repo is connected to a host, **every push to `main` rebuilds and redeploys automatically**.
Edit files locally, commit, push — the live URL updates in a few minutes and never changes.

## Before the first deploy

1. `ANTHROPIC_API_KEY` — set it as a secret in the host's dashboard, never in the repo.
   Without it the AI guide still works: it falls back to the fixed scripts in
   `web/src/guide/fallback.js`.
2. **Warm the cache.** This is the one that bites. `api/cache/` is git-ignored and IRSA is slow
   and does go down (see CLAUDE.md, 15 Nov 2026). A fresh container starts with an empty cache,
   so the first visitor triggers hour-long upstream fetches.

   ```bash
   cd api && ./.venv/bin/python -m ingest --targets showcase   # ~1 h, locally, once
   tar czf cache.tgz -C api cache                              # ship this, do not commit it
   ```

   Attach a **persistent volume** mounted at `/app/api/cache` and unpack `cache.tgz` into it, or
   bake it into a private image. Without this the demo depends on IRSA being up at that moment.

## Hosts

A persistent volume and ~2 GB RAM are the requirements (astropy + reproject + image work).

| Host | Notes |
| --- | --- |
| **Render** | Web Service → Docker. Add a Disk mounted at `/app/api/cache`. Free tier sleeps after 15 min — a cold start is slow, so use a paid instance for judging day, or hit the URL shortly before. |
| **Fly.io** | `fly launch` reads the Dockerfile. `fly volumes create cache -s 3` then mount it at `/app/api/cache` in `fly.toml`. Scale to 1 shared-cpu-2x. |
| **Railway** | Detects the Dockerfile. Add a Volume at `/app/api/cache`. |
| **Cloud Run** | Works, but the filesystem is ephemeral and instances scale to zero — the cache dies with them. Use a mounted GCS bucket or prefer one of the above. |

`PORT` is read from the environment, so hosts that inject their own port work unchanged.

## Split deployment (only if you must)

If the front end goes on a static host (Netlify, Pages) and the API elsewhere, set `CORS_ORIGINS`
on the API to the front end's origin (comma-separated, or `*`), and point the front end's `/api`
calls at the API URL. `POST` and `OPTIONS` are allowed for the guide endpoint. The single-service
setup above avoids all of this.

## Verify a deploy

```bash
curl https://YOUR_URL/api/health                 # {"ok":true}
curl -s https://YOUR_URL/ | head -5              # the page
curl -o /dev/null -w "%{http_code}\n" https://YOUR_URL/api/nope   # 404, not the page
open "https://YOUR_URL/?name=WISE%200855"        # flies to the brown dwarf
```

Then walk the demo path once on the live URL: search → Enter for the time-lapse → `s` for the
spectrum. Keyboard-only, in case the partner team's gaze layer is not wired up on the day.

## Local equivalent

```bash
docker build -t meridian .
docker run -p 8000:8000 --env-file api/.env -v meridian-cache:/app/api/cache meridian
# http://localhost:8000
```

Development is unchanged: `npm run dev` on :5173 proxying to `uvicorn` on :8000. The static mount
only activates when `web/dist/` exists.
