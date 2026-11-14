"""Name -> coordinates via CDS Sesame, moved to a chosen epoch with the proper motion.

Sesame gives ICRS positions at epoch J2000. Fast stars move a lot since then
(Barnard's Star: ~4.5 arcmin by 2026), so SPHEREx-era views must use the moved position.
astroquery's SIMBAD TAP endpoint returned 404 on 14 Nov 2026; Sesame XML works and
includes proper motion. cds.unistra.fr redirects to a mirror, so follow redirects.
"""
from __future__ import annotations

import math
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from functools import lru_cache
from urllib.parse import quote

import httpx

SESAME_URL = "https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?"
J2000 = 2000.0


class NotFound(Exception):
    pass


def current_epoch() -> float:
    now = datetime.now(timezone.utc)
    start = datetime(now.year, 1, 1, tzinfo=timezone.utc)
    end = datetime(now.year + 1, 1, 1, tzinfo=timezone.utc)
    return now.year + (now - start) / (end - start)


def propagate(ra: float, dec: float, pmra_mas: float, pmdec_mas: float, years: float) -> tuple[float, float]:
    """Linear proper-motion propagation. pmra is mu_alpha* (already times cos dec), mas/yr.
    Accurate to well under a SPHEREx pixel for decades, except right at the poles."""
    cos_dec = max(math.cos(math.radians(dec)), 1e-6)
    ra2 = ra + (pmra_mas * years) / 3.6e6 / cos_dec
    dec2 = dec + (pmdec_mas * years) / 3.6e6
    return ra2 % 360.0, max(-90.0, min(90.0, dec2))


def _text(el: ET.Element, tag: str) -> str | None:
    found = el.find(tag)
    return found.text.strip() if found is not None and found.text else None


def parse_sesame(xml_text: str) -> dict:
    root = ET.fromstring(xml_text)
    for resolver in root.iter("Resolver"):
        ra, dec = _text(resolver, "jradeg"), _text(resolver, "jdedeg")
        if ra is None or dec is None:
            continue
        pm = resolver.find("pm")
        pmra = pmdec = 0.0
        if pm is not None:
            pmra = float(_text(pm, "pmRA") or 0.0)
            pmdec = float(_text(pm, "pmDE") or 0.0)
        else:  # some Sesame versions put pmRA/pmDE directly under the resolver
            pmra = float(_text(resolver, "pmRA") or 0.0)
            pmdec = float(_text(resolver, "pmDE") or 0.0)
        return {
            "name": _text(resolver, "oname"),
            "otype": _text(resolver, "otype"),
            "ra_j2000": float(ra),
            "dec_j2000": float(dec),
            "pmra": pmra,
            "pmdec": pmdec,
        }
    raise NotFound("nothing found")


@lru_cache(maxsize=512)
def _lookup(name: str) -> dict:
    url = SESAME_URL + quote(name)
    last_err: Exception | None = None
    for attempt in range(2):
        try:
            r = httpx.get(url, follow_redirects=True, timeout=10.0)
            r.raise_for_status()
            return parse_sesame(r.text)
        except NotFound:
            raise
        except (httpx.HTTPError, ET.ParseError) as err:
            last_err = err
            time.sleep(1.0)
    raise RuntimeError(f"Sesame unavailable: {last_err}")


def resolve(name: str, epoch: float | None = None) -> dict:
    name = name.strip()
    if not name or len(name) > 100:
        raise NotFound("empty or too long name")
    base = _lookup(name)
    epoch = current_epoch() if epoch is None else epoch
    ra, dec = propagate(base["ra_j2000"], base["dec_j2000"], base["pmra"], base["pmdec"], epoch - J2000)
    return {**base, "ra": ra, "dec": dec, "epoch": round(epoch, 3)}
