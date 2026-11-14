"""Meridian API. Routes are added step by step (see docs/BUILD_PLAN.md).

Run:  uvicorn main:app --reload --port 8000   (from meridian/api)
"""
import json

import numpy as np
from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware

import resolve as resolver
import cutouts
import spherex

app = FastAPI(title="Meridian API", version="0.0.1")

# The Vite dev server proxies /api, but allow direct calls from it too.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET"],
    allow_headers=["*"],
    expose_headers=["X-Width", "X-Height", "X-Meta"],
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


@app.get("/api/frames")
async def frames(
    ra: float = Query(..., ge=0, lt=360),
    dec: float = Query(..., ge=-90, le=90),
    fov: float = Query(0.1, gt=0, le=2, description="field size (deg); frames are those covering the centre"),
    refresh: bool = Query(False, description="ignore the 24 h cache"),
) -> dict:
    """Every SPHEREx Level 2 image covering (ra, dec), sorted by date, grouped into visits."""
    try:
        result = await run_in_threadpool(spherex.frames_at, ra, dec, refresh)
    except Exception as err:  # IRSA hiccups: tell the client, don't crash
        raise HTTPException(status_code=503, detail=f"IRSA search failed: {err}")
    return {**result, "fov": fov}


@app.get("/api/frames/meta")
async def frames_meta(
    ra: float = Query(..., ge=0, lt=360),
    dec: float = Query(..., ge=-90, le=90),
    refresh: bool = False,
) -> dict:
    """Like /api/frames, plus the wavelength and nearest cube band each frame saw at (ra, dec)."""
    try:
        return await run_in_threadpool(spherex.frames_with_meta, ra, dec, refresh)
    except Exception as err:
        raise HTTPException(status_code=503, detail=f"frame metadata failed: {err}")


@app.get("/api/field")
async def field(
    ra: float = Query(..., ge=0, lt=360),
    dec: float = Query(..., ge=-90, le=90),
    band: int = Query(..., ge=0, le=101),
    fov: float = Query(0.1, gt=0, le=2),
) -> dict:
    """Frames that saw (ra, dec) in cube band `band`, in date order (the time-lapse list)."""
    try:
        result = await run_in_threadpool(spherex.field_frames, ra, dec, band)
    except Exception as err:
        raise HTTPException(status_code=503, detail=f"field lookup failed: {err}")
    return {**result, "fov": fov}


@app.get("/api/cutout")
async def cutout(
    id: str = Query(..., min_length=3, max_length=80),
    ra: float = Query(..., ge=0, lt=360),
    dec: float = Query(..., ge=-90, le=90),
    fov: float = Query(0.1, ge=0.02, le=1.0),
    fmt: str = Query("f32", pattern="^(f32|png)$"),
    ext: str = Query("image", pattern="^(image|variance)$"),
):
    """One frame, background-subtracted, masked and reprojected onto the common grid.

    fmt=f32: raw little-endian float32, row 0 = south (FITS order), NaN = no data.
             Shape in X-Width / X-Height; everything else in X-Meta (JSON).
    fmt=png: quick-look image, north up.
    """
    frame = spherex.lookup(id)
    if frame is None:
        raise HTTPException(status_code=404, detail="unknown frame id; call /api/frames first")
    try:
        result = await run_in_threadpool(cutouts.process, frame, ra, dec, fov)
    except Exception as err:
        raise HTTPException(status_code=503, detail=f"cutout failed: {err}")
    arr = result[ext]
    headers = {
        "X-Width": str(arr.shape[1]),
        "X-Height": str(arr.shape[0]),
        "X-Meta": json.dumps(result["meta"], separators=(",", ":")),
        "Cache-Control": "public, max-age=86400",
    }
    if fmt == "png":
        return Response(cutouts.to_png(arr), media_type="image/png", headers=headers)
    return Response(np.ascontiguousarray(arr, dtype="<f4").tobytes(), media_type="application/octet-stream", headers=headers)
