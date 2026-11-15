# Meridian — one image, one service, one URL.
# Stage 1 builds the front end; stage 2 runs the FastAPI app and serves that build at /.
#
#   docker build -t meridian .
#   docker run -p 8000:8000 --env-file api/.env -v meridian-cache:/app/api/cache meridian
#
# Deploy notes (Render / Fly / Railway / Cloud Run): docs/DEPLOY.md

FROM node:20-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build


FROM python:3.13-slim
WORKDIR /app

# astropy/reproject/numpy ship wheels, so no compiler is needed; curl is for the health check.
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY api/requirements.txt ./api/requirements.txt
RUN pip install --no-cache-dir -r api/requirements.txt

COPY api/ ./api/
COPY --from=web /web/dist ./web/dist

# Cutouts, frame lists and WISE/Gaia context are cached here. Mount a volume on it: IRSA is
# slow and goes down (see CLAUDE.md), and a cold cache means a slow or broken demo.
RUN mkdir -p /app/api/cache
ENV WEB_DIST=/app/web/dist \
    PYTHONUNBUFFERED=1 \
    PORT=8000

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD curl -fsS "http://localhost:${PORT}/api/health" || exit 1

WORKDIR /app/api
# --timeout-graceful-shutdown 5: without it a long request (spectra) blocks shutdown (CLAUDE.md).
CMD ["sh", "-c", "python -m uvicorn main:app --host 0.0.0.0 --port ${PORT} --timeout-graceful-shutdown 5"]
