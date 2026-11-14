"""Meridian API. Routes are added step by step (see docs/BUILD_PLAN.md).

Run:  uvicorn main:app --reload --port 8000   (from meridian/api)
"""
from fastapi import FastAPI, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware

import resolve as resolver

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


@app.get("/api/resolve")
async def resolve_name(
    name: str = Query(..., min_length=1, max_length=100),
    epoch: float | None = Query(None, ge=1900, le=2100, description="decimal year; default: now"),
) -> dict:
    """Object name -> position at `epoch` (proper motion applied), via CDS Sesame."""
    try:
        return await run_in_threadpool(resolver.resolve, name, epoch)
    except resolver.NotFound:
        raise HTTPException(status_code=404, detail=f"No object found for '{name}'")
    except RuntimeError as err:
        raise HTTPException(status_code=503, detail=str(err))
