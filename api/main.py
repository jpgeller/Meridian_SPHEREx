"""Meridian API. Routes are added step by step (see docs/BUILD_PLAN.md).

Run:  uvicorn main:app --reload --port 8000   (from meridian/api)
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Meridian API", version="0.0.1")

# The Vite dev server proxies /api, but allow direct calls from it too.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET"],
    allow_headers=["*"],
    expose_headers=["X-Width", "X-Height", "X-Wavelength", "X-MJD", "X-Flags-Pct"],
)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}
