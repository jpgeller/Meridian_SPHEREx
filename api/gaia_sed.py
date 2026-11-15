"""Gaia DR3 side of a spectral energy distribution (SED): the Gaia star at a position, with its G/BP/RP
photometry, its GSP-Phot temperature, and its BP/RP ("XP") sampled spectrum when Gaia published one.

Everything is returned as lambda * F_lambda in W/m^2 against wavelength in um, the unit the browser plots
SPHEREx in too (web/src/field/sed.js converts SPHEREx mJy to it).

Sources: VizieR's copy of Gaia DR3 (I/355/gaiadr3 for the star, I/355/xpsample for the spectrum: 343
samples, 336-1020 nm, W m^-2 nm^-1), CfA mirror first (same mirrors as context._gaia_cone).
"""

from __future__ import annotations

import math

import httpx

import cache
from context import GAIA_EPOCH_MJD, GAIA_TIMEOUT, GAIA_VIZIER, _num

# G, BP, RP as photometric points (used when a star has no XP spectrum, and drawn as three markers):
# pivot wavelength (um) and the flux of a 0-magnitude (Vega) star, F_lambda in W m^-2 nm^-1.
# Values for the Gaia DR3 passbands from the SVO Filter Profile Service (GAIA/GAIA3.G, .Gbp, .Grp);
# checked against XP spectra of real stars in api/tests (synthetic photometry agrees to ~10%).
PASSBANDS = {
    "BP": {"um": 0.5110, "zp": 4.08e-11},
    "G": {"um": 0.6218, "zp": 2.50e-11},
    "RP": {"um": 0.7769, "zp": 1.27e-11},
}
MATCH_ARCSEC = 5.0  # the point is in the target's frame (coordinates at 2026.0); its Gaia star sits within ~1-2"


def mag_to_lfl(mag: float, band: str) -> float:
    """Vega magnitude in a Gaia passband -> lambda F_lambda (W/m^2) at the pivot wavelength."""
    p = PASSBANDS[band]
    return p["zp"] * 10 ** (-0.4 * mag) * p["um"] * 1000.0


def _tsv(url: str, params: dict) -> list[dict]:
    r = httpx.get(url, params=params, timeout=GAIA_TIMEOUT)
    r.raise_for_status()
    lines = [ln for ln in r.text.splitlines() if ln.strip() and not ln.startswith("#")]
    if not lines:
        return []
    head = lines[0].split("\t")
    return [dict(zip(head, (v.strip() for v in ln.split("\t")))) for ln in lines[3:]]


def _vizier(params: dict) -> list[dict]:
    last = None
    for url in GAIA_VIZIER:
        try:
            return _tsv(url, params)
        except (httpx.HTTPError, ValueError) as err:
            last = err
    raise RuntimeError(f"Gaia archives unavailable ({type(last).__name__})")


def _stars_near(ra: float, dec: float, radius_arcsec: float) -> list[dict]:
    key = f"sedcone3|{ra:.5f},{dec:.5f}|{radius_arcsec:.1f}"
    hit = cache.get_json("gaia", key)
    if hit is not None:
        return hit
    rows = _vizier({
        "-source": "I/355/gaiadr3",
        "-c": f"{ra:.6f} {dec:+.6f}",
        "-c.rs": f"{radius_arcsec:.1f}",
        "-out": "Source,RA_ICRS,DE_ICRS,pmRA,pmDE,Plx,Gmag,e_Gmag,BPmag,e_BPmag,RPmag,e_RPmag,Teff,XPsamp",
        "-out.add": "_r",
        "-sort": "_r",  # nearest first: without it the 50 kept were in catalogue order (RW Aur was missed)
        "-out.max": "3000",  # every star in the radius: fast movers sit far from the target's 2016 spot
    })
    stars = []
    for r in rows:
        if not r.get("RA_ICRS"):
            continue
        stars.append({
            "source_id": r["Source"], "ra": float(r["RA_ICRS"]), "dec": float(r["DE_ICRS"]),
            "pmra": _num(r.get("pmRA")), "pmdec": _num(r.get("pmDE")), "parallax": _num(r.get("Plx")),
            "g": _num(r.get("Gmag")), "e_g": _num(r.get("e_Gmag")),
            "bp": _num(r.get("BPmag")), "e_bp": _num(r.get("e_BPmag")),
            "rp": _num(r.get("RPmag")), "e_rp": _num(r.get("e_RPmag")),
            "teff": _num(r.get("Teff")), "has_xp": r.get("XPsamp") == "1",
        })
    cache.put_json("gaia", key, stars)
    return stars


def _xp_spectrum(source_id: str, ra: float, dec: float) -> list[dict]:
    """The XP sampled spectrum of one star. Looked up by its catalogue (2016.0) position: a `Source=`
    constraint is ignored by this table and returned another star's spectrum (16 Nov 2026)."""
    key = f"xp2|{source_id}"
    hit = cache.get_json("gaia", key)
    if hit is not None:
        return hit
    rows = _vizier({"-source": "I/355/xpsample", "-c": f"{ra:.7f} {dec:+.7f}", "-c.rs": "1",
                    "-out": "Source,lambda,Flux,e_Flux", "-out.max": "2000"})
    out = []
    for r in rows:
        if r.get("Source") != source_id:
            continue
        nm, f, e = _num(r.get("lambda")), _num(r.get("Flux")), _num(r.get("e_Flux"))
        if nm and f is not None:
            # W m^-2 nm^-1 -> lambda F_lambda (W m^-2)
            out.append({"um": nm / 1000.0, "lfl": f * nm, "err": (e or 0.0) * nm})
    out.sort(key=lambda p: p["um"])
    cache.put_json("gaia", key, out)
    return out


def gaia_sed(ra: float, dec: float, mjd: float = 61041.0) -> dict:
    """The Gaia star at (ra, dec) at date `mjd` (positions moved from 2016.0), with its SED points."""
    years = (mjd - GAIA_EPOCH_MJD) / 365.25
    # search wide enough for fast stars (Barnard's Star moved ~100" since 2016), then move each to `mjd`
    stars = _stars_near(round(ra, 5), round(dec, 5), 150.0)
    best, best_sep = None, None
    for s in stars:
        sra, sdec = s["ra"], s["dec"]
        if s["pmra"] is not None and s["pmdec"] is not None:
            cosd = max(math.cos(math.radians(sdec)), 1e-6)
            sra += s["pmra"] * years / 3.6e6 / cosd
            sdec += s["pmdec"] * years / 3.6e6
        sep = math.hypot((sra - ra) * math.cos(math.radians(dec)), sdec - dec) * 3600
        if sep <= MATCH_ARCSEC and (best is None or sep < best_sep):
            best, best_sep = s, sep
    if best is None:
        return {"found": False, "match_arcsec": MATCH_ARCSEC,
                "note": f"No Gaia DR3 star within {MATCH_ARCSEC:.0f}\" of this point."}
    phot = []
    for band, mag, err in (("BP", best["bp"], best["e_bp"]), ("G", best["g"], best["e_g"]), ("RP", best["rp"], best["e_rp"])):
        if mag is None:
            continue
        lfl = mag_to_lfl(mag, band)
        phot.append({"band": band, "um": PASSBANDS[band]["um"], "mag": mag, "lfl": lfl,
                     "err": lfl * 0.4 * math.log(10) * max(err or 0.0, 0.01)})
    xp = []
    if best["has_xp"]:
        try:
            xp = _xp_spectrum(best["source_id"], best["ra"], best["dec"])
        except Exception:  # the photometry alone still makes an SED
            xp = []
    dist_pc = 1000.0 / best["parallax"] if best["parallax"] and best["parallax"] > 0 else None
    return {
        "found": True, "source_id": best["source_id"], "sep_arcsec": round(best_sep, 2),
        "g": best["g"], "bp": best["bp"], "rp": best["rp"], "teff_gspphot": best["teff"],
        "distance_pc": round(dist_pc, 2) if dist_pc else None,
        "photometry": phot, "xp": xp, "xp_note": None if xp else "Gaia published no BP/RP spectrum for this star",
        "catalog": "Gaia DR3 (VizieR I/355)", "units": "lambda F_lambda in W/m^2; wavelength in um",
    }
