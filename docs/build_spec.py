"""Builds docs/Meridian_SPHEREx_Project_Spec.pdf. Edit the text below and rerun:
    python docs/build_spec.py      (needs: pip install reportlab)
"""
import pathlib
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
                                Image, PageBreak, KeepTogether, Preformatted)
from reportlab.graphics.shapes import Drawing, Rect, String, Line, Polygon

HERE = pathlib.Path(__file__).parent
IMG = HERE / "img"
OUT = HERE / "Meridian_SPHEREx_Project_Spec.pdf"

F = "/System/Library/Fonts/Supplemental/"
pdfmetrics.registerFont(TTFont("Arial", F + "Arial.ttf"))
pdfmetrics.registerFont(TTFont("Arial-Bold", F + "Arial Bold.ttf"))
pdfmetrics.registerFont(TTFont("Arial-Italic", F + "Arial Italic.ttf"))
pdfmetrics.registerFontFamily("Arial", normal="Arial", bold="Arial-Bold", italic="Arial-Italic")

NIGHT = colors.HexColor("#0A0F1F"); PANEL = colors.HexColor("#121A33")
TEXT = colors.HexColor("#1B2340"); MUTED = colors.HexColor("#5B6788")
AMBER = colors.HexColor("#FFB547"); LINE = colors.HexColor("#D6DCEB"); TINT = colors.HexColor("#F3F5FA")
D = ["#6AA8FF", "#5FD0C4", "#9BE07A", "#F2D16B", "#F59A6B", "#EF7AA7"]

base = dict(fontName="Arial", textColor=TEXT, leading=14.5, fontSize=10)
s_body = ParagraphStyle("body", **base, spaceAfter=6)
s_small = ParagraphStyle("small", **{**base, "fontSize": 8.5, "leading": 11.5, "textColor": MUTED})
s_cell = ParagraphStyle("cell", **{**base, "fontSize": 8.8, "leading": 11.8})
s_cellb = ParagraphStyle("cellb", parent=s_cell, fontName="Arial-Bold")
s_h1 = ParagraphStyle("h1", **{**base, "fontName": "Arial-Bold", "fontSize": 24, "leading": 28, "textColor": NIGHT}, spaceAfter=4)
s_h2 = ParagraphStyle("h2", **{**base, "fontName": "Arial-Bold", "fontSize": 15, "leading": 19, "textColor": NIGHT}, spaceBefore=12, spaceAfter=6)
s_h3 = ParagraphStyle("h3", **{**base, "fontName": "Arial-Bold", "fontSize": 11, "leading": 15}, spaceBefore=8, spaceAfter=3)
s_sub = ParagraphStyle("sub", **{**base, "fontSize": 11.5, "leading": 15, "textColor": MUTED}, spaceAfter=10)
s_bul = ParagraphStyle("bul", parent=s_body, leftIndent=12, bulletIndent=2, spaceAfter=3)
s_code = ParagraphStyle("code", fontName="Courier", fontSize=7.8, leading=10, textColor=TEXT,
                        backColor=TINT, borderPadding=6, leftIndent=4, rightIndent=4, spaceBefore=4, spaceAfter=10)

W = A4[0] - 36 * mm


def P(t, s=s_body): return Paragraph(t, s)
def H2(t): return P(t, s_h2)
def H3(t): return P(t, s_h3)
def bullets(items): return [Paragraph(i, s_bul, bulletText="•") for i in items]
def code(t): return Preformatted(t.strip("\n"), s_code)


def table(rows, widths, header=True, zebra=True):
    data = [[P(c, s_cellb if (header and r == 0) else s_cell) if isinstance(c, str) else c for c in row]
            for r, row in enumerate(rows)]
    t = Table(data, colWidths=[W * w for w in widths], repeatRows=1 if header else 0)
    st = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -1), 0.4, LINE),
          ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]
    if header:
        st += [("BACKGROUND", (0, 0), (-1, 0), TINT), ("LINEBELOW", (0, 0), (-1, 0), 0.8, NIGHT)]
    t.setStyle(TableStyle(st))
    return t


def figure(path, caption, width=W):
    from PIL import Image as PI
    w, h = PI.open(path).size
    return KeepTogether([Image(str(path), width=width, height=width * h / w), Spacer(1, 3), P(caption, s_small), Spacer(1, 8)])


def callout(text, color=AMBER):
    t = Table([[P(text, s_cell)]], colWidths=[W])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), TINT), ("LINEBEFORE", (0, 0), (0, -1), 3, color),
                           ("LEFTPADDING", (0, 0), (-1, -1), 10), ("TOPPADDING", (0, 0), (-1, -1), 7),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), 7)]))
    return t


def ribbon():
    d = Drawing(W, 30)
    bands = [("D1", "0.75-1.09 µm"), ("D2", "1.09-1.62"), ("D3", "1.62-2.41"),
             ("D4", "2.41-3.82"), ("D5", "3.82-4.41"), ("D6", "4.41-5.00 µm")]
    w = W / 6
    for i, (n, r) in enumerate(bands):
        d.add(Rect(i * w, 14, w - 2, 12, fillColor=colors.HexColor(D[i]), strokeColor=None))
        d.add(String(i * w + 3, 17, n, fontName="Arial-Bold", fontSize=7.5, fillColor=NIGHT))
        d.add(String(i * w + 2, 3, r, fontName="Arial", fontSize=7, fillColor=MUTED))
    return d


def architecture():
    h = 250
    d = Drawing(W, h)

    def box(x, y, w, hh, title, lines, fill=TINT, edge=NIGHT):
        d.add(Rect(x, y, w, hh, rx=6, ry=6, fillColor=fill, strokeColor=edge, strokeWidth=0.8))
        d.add(String(x + 8, y + hh - 15, title, fontName="Arial-Bold", fontSize=9, fillColor=NIGHT))
        for i, ln in enumerate(lines):
            d.add(String(x + 8, y + hh - 28 - i * 11, ln, fontName="Arial", fontSize=7.6, fillColor=TEXT))

    def arrow(x1, y1, x2, y2, label=""):
        d.add(Line(x1, y1, x2, y2, strokeColor=MUTED, strokeWidth=1))
        import math
        a = math.atan2(y2 - y1, x2 - x1); s = 5
        d.add(Polygon([x2, y2, x2 - s * math.cos(a - .4), y2 - s * math.sin(a - .4),
                       x2 - s * math.cos(a + .4), y2 - s * math.sin(a + .4)], fillColor=MUTED, strokeColor=None))
        if label:
            d.add(String((x1 + x2) / 2 + 3, (y1 + y2) / 2 + 3, label, fontName="Arial-Italic", fontSize=7, fillColor=MUTED))

    cw = (W - 30) / 3
    # Row 1: inputs
    box(0, 190, cw, 58, "Input layer", ["Eye tracker (gaze + dwell)", "Keyboard  ·  mouse  ·  touch", "Voice / chat guide"],
        fill=colors.HexColor("#FFF4E0"), edge=AMBER)
    box(cw + 15, 190, cw, 58, "Command bus (browser)", ["One list of actions:", "pan, zoom, fly_to, set_band,", "play, compare, select …"])
    box(2 * cw + 30, 190, cw, 58, "AI guide (LLM + tools)", ["Turns words into commands", "fly_to, open_field, set_bands", "explain, start_tour"])
    arrow(cw, 219, cw + 15, 219)
    arrow(2 * cw + 30, 219, 2 * cw + 15, 219)
    # Row 2: frontend views
    box(0, 100, cw * 1.5 + 7, 72, "3D sky view (Aladin Lite v3)", ["SPHEREx DR1 all-sky HiPS cube, 102 bands",
        "3D sphere  ·  whole-sky Gaia-style (AIT, galactic)", "Overlays: Gaia DR3, WISE, SIMBAD, footprints",
        "Fly-to on search, URL state"])
    box(cw * 1.5 + 23, 100, cw * 1.5 + 7, 72, "2D field view (time-lapse)", ["Real SPHEREx images of one patch over time",
        "Play · blink · add · subtract", "Bands · WISE + Gaia context side by side",
        "Spectrum on click · flags panel"])
    arrow(cw * 1.5 + 15, 190, cw * 0.75, 172, "commands")
    arrow(cw * 1.5 + 15, 190, cw * 2.25 + 15, 172)
    arrow(cw * 1.5 + 7, 136, cw * 1.5 + 23, 136)
    # Row 3: backend + data
    box(0, 5, cw * 1.5 + 7, 78, "Python backend (FastAPI)", ["/api/frames  list images + dates for ra/dec",
        "/api/cutout  aligned PNG/FITS per epoch & band", "/api/spectrum  forced photometry",
        "/api/resolve  name -> coordinates", "Cache on disk; one ingest command"])
    box(cw * 1.5 + 23, 5, cw * 1.5 + 7, 78, "Public data (no keys needed)", ["IRSA SIA: spherex_dr1 / qr3 (+ _deep)",
        "IRSA HiPS: spherex_allsky_cube (tiles)", "IRSA cutout service (small FITS)",
        "CDS: Sesame, SIMBAD, Gaia & WISE HiPS", "WiseView (WISE frames) · MAST (Gaia DR3)"],
        fill=colors.HexColor("#EAF3FF"), edge=colors.HexColor(D[0]))
    arrow(cw * 2.25 + 15, 100, cw * 0.9, 83, "JSON / images")
    arrow(cw * 1.5 + 7, 44, cw * 1.5 + 23, 44)
    arrow(cw * 0.6, 100, cw * 1.95, 83, "HiPS tiles")
    return d


story = []

# ---------------------------------------------------------------- page 1
story += [
    P("Meridian", s_h1),
    P("An accessible 3D sky for SPHEREx. Project structure for the team. NASA Space Apps 2026. "
      "This replaces the first draft of the spec: same idea and same look, now built on SPHEREx's own all-sky "
      "images and designed to be used without a mouse.", s_sub),
    figure(IMG / "allsky_gaia_style.jpg",
           "Figure 1. Working prototype (prototype/index.html). The whole sky in the same layout as ESA's Gaia map, "
           "but every pixel is real SPHEREx DR1 data, here band 40 at 1.905 µm. The band slider walks through all 102 infrared colours."),
    H2("The idea in one minute"),
    P("Anyone can open the site and see the entire infrared sky from SPHEREx, as a 3D sphere or as a flat "
      "whole-sky map like Gaia's. They type a name or coordinates (Milky Way centre, a brown dwarf, Barnard's Star, "
      "or a pasted RA/Dec) or ask the guide, and the view flies there. Once zoomed in, the site switches to "
      "the real SPHEREx images of that patch, played in date order like a short video, so moving and "
      "changing objects stand out. Then the user picks one infrared band, overlays several, or mixes their own combination."),
    P("Everything can be done without hands. Every action is a named command, and an eye tracker (built by a "
      "teammate), the keyboard, the mouse, or the chat guide can trigger any of them."),
]
story.append(PageBreak())

# ---------------------------------------------------------------- feasibility
story += [
    H2("Can we do it? Yes. Both questions were checked with working code."),
    H3("1. Turning the Aladin folder into the Gaia-map style"),
    P("The folder <b>aladin-lite-master</b> is Aladin Lite v3 (CDS Strasbourg, version 3.9.0-beta in the source). "
      "It is not a 3D mesh. It is a WebGL viewer that draws the sky on the inside of a sphere from "
      "<b>HiPS</b> tiles (Hierarchical Progressive Surveys, small image tiles at increasing zoom levels). "
      "ESA's Gaia page is a deep-zoom picture of one flat whole-sky image (a .micrio file) in an "
      "Aitoff-style projection with the Milky Way across the middle."),
    P("Aladin Lite already does both: projection <b>SIN</b> gives the 3D sphere, and projection <b>AIT</b> in the "
      "<b>galactic</b> frame at a 360° field gives the Gaia layout. You switch with one call each "
      "(setProjection, setFrame). We do not need to convert any model. We should not rebuild Aladin from source either "
      "(that needs Rust and wasm-pack); we load the published package <b>aladin-lite@3.8.2</b> from the jsDelivr CDN."),
    H3("2. Replacing Aladin's images with SPHEREx images"),
    P("IRSA publishes a <b>SPHEREx DR1 all-sky HiPS cube</b>, built with Aladin's own HipsGen tool, so Aladin "
      "loads it directly:"),
    code("https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube\n"
         "  102 frames (one per band), 512-px PNG tiles, deepest order 5 (~13 arcsec/px), whole sky, released 2026-11-01"),
    P("Figures 1 to 3 are screenshots from our prototype showing exactly this."),
    callout("<b>Gotcha we already solved.</b> The tile files are named _0 to _101 in increasing wavelength, but Aladin's "
            "setSliceNumber() picks the tile from frequency, so band 40 loads tile _19. Use "
            "setFrequency({value: F_MIN + (k + 0.5)/102 x (F_MAX - F_MIN), unit: 'Hz'}) where F = c / wavelength "
            "(F_MIN uses 5.009 µm, F_MAX uses 0.743 µm). Frames 0, 50 and 51 are blank on IRSA; skip them. "
            "The prototype implements this."),
    Spacer(1, 8),
    callout("<b>What the HiPS cube cannot do.</b> It is one combined mosaic per band, so it shows no change over time. "
            "The time-lapse in the 2D field view must use the individual SPHEREx images (Level 2 spectral images) "
            "from the IRSA SIA service, one per visit. That is what the backend is for.", colors.HexColor(D[0])),
    Spacer(1, 10),
    figure(IMG / "sphere_milkyway.jpg", "Figure 2. The 3D sphere view centred on the Milky Way's centre, SPHEREx band 40 (1.905 µm).", W * 0.6),
]
story += [
    figure(IMG / "wise0855.jpg", "Figure 3. After clicking the WISE 0855 preset, the view flies to 08h55m10.8s −07°14′43″ "
           "and zooms to 2°. This is still the combined mosaic; the next step opens the per-date images.", W * 0.6),
    H2("How someone uses it"),
    table([
        ["Step", "What the user sees", "What runs underneath"],
        ["1. Arrive", "The whole sky in SPHEREx infrared, Gaia-style or as a 3D sphere. The band ribbon is at the bottom.",
         "Aladin Lite + SPHEREx HiPS cube. URL parameters can open any view directly."],
        ["2. Choose a place", "Type a name or RA/Dec, pick a preset (Milky Way, Solar System, brown dwarfs, challenge targets), or say it.",
         "Sesame/SIMBAD resolves names. Solar System flies to the ecliptic (the Sun itself is never in SPHEREx images)."],
        ["3. Fly in", "Smooth zoom to the spot. Below about 3° the 'Open time-lapse' action appears.",
         "aladin.gotoRaDec + setFoV. The zoomChanged event opens the 2D view."],
        ["4. Time-lapse", "Real images of that patch, in date order, as a video. Controls: play, step, blink two dates, add, subtract.",
         "Backend /api/frames then /api/cutout per visit. Images are aligned to one sky grid."],
        ["5. Explore bands", "One band; one detector summed (17 bands); overlay several as red, green and blue; or a custom formula.",
         "Combination done in the browser (WebGL or canvas) from per-band cutouts, or by the backend for big fields."],
        ["5b. Add context", "A strip under the player: the same patch from WISE (2010 to 2024) and Gaia star positions. Compare side by side, or scroll one timeline across missions.",
         "WiseView image API for WISE frames; Gaia DR3 from MAST or ESA, moved to each image's date using proper motion."],
        ["6. Look closer", "Click or dwell on a source to get its spectrum across the 102 bands, flags, and Gaia/WISE matches.",
         "/api/spectrum: forced photometry. Catalog overlays come from CDS."],
        ["7. Nearby", "Arrows move to neighbouring patches; 'Same spot' lists every date available.",
         "Re-query /api/frames for the new centre."],
    ], [0.14, 0.43, 0.43]),
]
story.append(PageBreak())

# ---------------------------------------------------------------- bands
story += [
    H2("The 102 infrared bands"),
    P("SPHEREx has six detectors (D1 to D6). Each covers part of 0.75 to 5.0 µm in 17 channels, for 102 bands in total. "
      "Colour always means wavelength, short (blue) to long (rose), and the ribbon appears on every screen."),
    ribbon(),
    table([
        ["Mode", "What it does", "Why it helps"],
        ["Single band", "Show one of the 102 bands. Keys [ and ], a slider, or gaze on the ribbon.", "Shows exactly what SPHEREx saw at one wavelength."],
        ["Detector sum", "Add the 17 bands of one detector.", "About 4x better signal-to-noise, so faint movers appear (the challenge suggests this)."],
        ["Overlay (RGB)", "Choose 3 bands or detectors for red, green and blue.", "Cool brown dwarfs look very different from stars in a 3-colour mix."],
        ["Custom mix", "A simple formula, e.g. D6 - D1, or (b88 + b89) / b40.", "Lets power users highlight ices, dust, or methane-rich objects."],
        ["Spectrum", "A click or dwell plots brightness against wavelength.", "The challenge gives extra credit for spectra made on the fly."],
    ], [0.17, 0.45, 0.38]),
    H2("Context from WISE and Gaia"),
    P("The 2D view never shows SPHEREx alone. Next to every SPHEREx field the user can bring in the <b>same patch "
      "from WISE</b> and <b>Gaia</b>, to check what is new, what moved and what is already known. Both sources were tested "
      "on 14 Nov 2026 and work from the browser."),
    figure(IMG / "wise0855_wise_2010_2023.png",
           "Figure 4. The WISE 0855 field from the WiseView image API (W2 band, 4.6 µm, 8 arcmin): the first and last of 13 "
           "yearly frames, 2010 to 2023. SPHEREx adds 2025 and 2026, so one scrolling timeline covers about 16 years.", W * 0.8),
    table([
        ["Source", "What it gives", "How we get it"],
        ["WISE / NEOWISE (via WiseView)", "Real images of the patch, about one per 6 months from 2010 to 2024, in W1 (3.4 µm) and W2 (4.6 µm). Pixels are 2.75″ (SPHEREx: 6.15″).",
         "GET moo23y1au0.execute-api.us-west-2.amazonaws.com/default/png-animation?ra&dec&band&size&… returns PNG frames + dates (MJD). Open to other sites (CORS *). Same parameters as the byw.tools/wiseview URL."],
        ["Gaia DR3 (MAST or ESA)", "No pictures: Gaia measures stars. It gives position, motion, parallax and brightness for every star down to G about 21, at epoch 2016.0.",
         "astroquery Catalogs.query_region(catalog='Gaia', version=3) at MAST, or ESA's TAP service. Drawn as circles on any frame. For a background image, use the CDS Gaia DR3 colour HiPS."],
    ], [0.2, 0.4, 0.4]),
    H3("Compare modes in the 2D view"),
] + bullets([
    "<b>Side by side:</b> SPHEREx (chosen band) | WISE W2 | Gaia map, all locked to the same centre, field of view and north-up orientation. Pan or zoom one and the others follow.",
    "<b>One timeline:</b> a single scrubber with dates from all missions in order (WISE 2010 to 2024, then SPHEREx 2025 to 2026). Scrolling or gazing along it steps through the years; the mission name and date are always shown.",
    "<b>Blink across missions:</b> flip between WISE W2 and SPHEREx at about 4.6 µm (detector D6), which see similar light, so movers over a 16-year baseline jump out.",
    "<b>Gaia framing:</b> Gaia stars drawn as circles, each moved to the date of the frame on screen using its proper motion. Something that moves but has no Gaia circle is interesting. "
    "Very red brown dwarfs such as WISE 0855 are often missing from Gaia, which is a useful teaching point.",
]) + [
    callout("<b>Two gotchas found while testing.</b> (1) WiseView's API is a community service run by Backyard Worlds, not an official NASA API. "
            "Cache the frames for the showcase fields, and keep IRSA's WISE cutouts as a fallback. (2) Gaia positions are for 2016.0. "
            "Barnard's Star has moved about 2.8 arcmin since 2000, so a search at its old position misses it. Always apply proper motion to the frame date."),
    Spacer(1, 6),
    H2("Built for eye tracking first"),
    P("The core design rule: <b>nothing requires a mouse</b>. The app listens to one <b>command bus</b>. "
      "Keyboard shortcuts, buttons, the chat guide and the eye tracker all send the same commands, so each feature "
      "only has to be built once and works with every input."),
    H3("Contract between the eye-tracking module and the app"),
    P("Your friend's module can send either raw gaze points (the app handles dwell) or finished commands. Both use "
      "window.postMessage, so the tracker can run in another tab or iframe, or as a local WebSocket bridge."),
    code("""
// raw gaze, 30-60 per second; coordinates in CSS pixels of the viewport
{ "type": "gaze",    "x": 512, "y": 300, "confidence": 0.93, "t": 1731590000123 }
// a finished intent (after dwell, blink, or gesture)
{ "type": "command", "name": "zoom_in" }
{ "type": "command", "name": "set_band", "args": { "band": 72 } }
{ "type": "command", "name": "fly_to",   "args": { "target": "WISE 0855" } }
// app -> tracker: where the dwell targets are, so it can snap to them
{ "type": "targets", "items": [ { "id": "play", "x": 40, "y": 520, "w": 72, "h": 72 } ] }"""),
    table([
        ["Command", "Default keyboard", "Gaze default"],
        ["pan_left / right / up / down", "Arrow keys", "Look at the screen edge for 600 ms; speed grows with time"],
        ["zoom_in / zoom_out", "+ and -", "Dwell on the zoom buttons (72 px targets)"],
        ["set_band, next_band, prev_band", "[ and ]", "Dwell on a ribbon segment"],
        ["fly_to(target)", "/ then type", "Preset tiles, or speak to the guide"],
        ["play / pause / step / blink", "Space, comma, period, B", "Large transport buttons"],
        ["select (spectrum, info)", "Enter on the focused source", "Dwell 800 ms on a source; a ring fills while waiting"],
        ["rest", "Esc", "Look at the 'rest' corner. Gaze is ignored until the user looks back at it"],
    ], [0.36, 0.24, 0.40]),
    Spacer(1, 6),
    P("<b>Gaze design rules.</b> Targets at least 64 px and spaced apart. Dwell time adjustable (400 to 1500 ms). "
      "Visible dwell progress. Nothing happens because of a quick glance. Never put a button on top of the sky "
      "where people look to explore. Keep a rest zone so users can read without triggering anything. Motion is slow and "
      "can be turned off. Every feature is also reachable by keyboard and screen reader (WCAG 2.2 AA)."),
]

# ---------------------------------------------------------------- architecture
story += [
    KeepTogether([H2("How it fits together"), Spacer(1, 4), architecture()]),
    P("Figure 5. The browser does all the drawing. The backend finds, cuts and aligns the per-date images and caches them. "
      "No accounts or API keys are needed for any data source.", s_small),
    H2("Data sources"),
    table([
        ["Need", "Source", "Notes"],
        ["Whole-sky 3D map, 102 bands", "IRSA HiPS: data/hips/SPHEREx/spherex_allsky_cube", "Loads directly in Aladin. PNG tiles, display only."],
        ["Images of one patch over time", "IRSA SIA, collections spherex_dr1, spherex_qr3 (+ _deep)", "astroquery Irsa.query_sia(pos, collection). Each row has a date (t_min), band and access_url."],
        ["Small cutouts, not 65 MB files", "IRSA cutout service on access_url", "Request only the field of view the user chose."],
        ["Spectra and mosaics", "IRSA SPHEREx Spectrophotometry and Mosaic tools; photutils", "Or our own forced photometry on cutouts."],
        ["Names to coordinates", "CDS Sesame / SIMBAD", "Aladin's gotoObject already uses it."],
        ["Overlays", "CDS HiPS: Gaia DR3, AllWISE; SIMBAD catalogue", "aladin.setOverlayImageLayer or A.catalogFromSimbad."],
        ["WISE images over time", "WiseView png-animation API (byw.tools)", "Yearly W1/W2 frames, 2010 to 2024. Unofficial, so cache them."],
        ["Gaia stars for framing", "MAST (astroquery.mast Catalogs) or ESA Gaia TAP", "Gaia DR3 at epoch 2016.0. Apply proper motion to each frame's date."],
        ["New data", "IRSA adds SPHEREx data weekly", "Search queries see new data within about a day. The HiPS cube changes only with each Data Release."],
    ], [0.24, 0.38, 0.38]),
    H2("Contracts"),
    H3("URL parameters (shareable and embeddable)"),
    code("/?ra=266.4168&dec=-29.0078&fov=2&band=40&proj=AIT&mode=blink&t=1,3&layers=gaia,wise&embed=1\n"
         "/?name=WISE%200855&view=field&bands=88,72,40          (RGB overlay)"),
    H3("Backend endpoints"),
    code("""
GET /api/frames?ra=..&dec=..&fov=..           -> [{ id, date, band, detector, wavelength_um, url, flags_pct }]
GET /api/cutout?id=..&ra=..&dec=..&fov=..&fmt=png|fits  -> aligned image (cached)
GET /api/stack?ra=..&dec=..&fov=..&bands=D3&dates=..&op=add|subtract -> image
GET /api/spectrum?ra=..&dec=..&date=..        -> { lambda_um[], flux[], err[], flag[] }
GET /api/resolve?name=..                      -> { ra, dec, kind }
GET /api/context/wise?ra=..&dec=..&fov=..&band=1|2 -> [{ date, mjd, png_url }]   (proxied + cached)
GET /api/context/gaia?ra=..&dec=..&fov=..&date=.. -> [{ source_id, ra, dec, g_mag, pmra, pmdec }]
GET /api/timeline?ra=..&dec=..&fov=..         -> SPHEREx + WISE frames merged, sorted by date"""),
]

# ---------------------------------------------------------------- repo, targets, scope
story += [
    H2("Repository structure to start from"),
    code("""
meridian/
  web/                       front end (plain JS + Vite, or React)
    index.html               starts from prototype/index.html
    src/sky/                 Aladin setup, SPHEREx cube, band<->frequency helper, overlays
    src/field/               2D time-lapse player, blink/add/subtract, band mixer (WebGL)
    src/field/context/       WISE frames, Gaia circles, side-by-side + cross-mission timeline
    src/input/               command bus, keyboard map, gaze adapter (postMessage), dwell logic
    src/guide/               chat panel, tool calls -> commands
    src/ui/                  ribbon, panels, accessibility toolbar, URL state
  api/                       Python 3.11 + FastAPI
    main.py                  routes listed in Contracts
    spherex.py               SIA queries, cutouts, alignment (astropy reproject), cache
    spectra.py               forced photometry (photutils)
    ingest.py                one command: refresh index + precompute showcase fields
  eye-tracking/              teammate's module + the message contract
  docs/                      this spec and its build script
  data/cache/                gitignored"""),
    H2("Challenge test targets: data available today"),
    P("Checked on 14 Nov 2026 with IRSA SIA, using spherex_dr1, spherex_qr3 and the deep collections. A 'visit' means images "
      "taken within 5 days of each other. SPHEREx pixels are 6.15 arcsec."),
    table([
        ["Target", "Images", "Visits", "Dates", "What to show"],
        ["Barnard's Star", "363", "7", "Aug 2025 to Sep 2026", "Moves about 10.4″/yr, about 1.7 px/yr. Blink the first and last visits."],
        ["Epsilon Indi B (brown-dwarf pair)", "465", "7", "Apr 2025 to Oct 2026", "Moves about 4.7″/yr. The pair is unresolved; very red in long bands."],
        ["WISE 0855 (08h55m10.831s −07°14′42.53″)", "258", "4", "May 2025 to May 2026", "Moves about 8″/yr. Very faint: use detector sums and long bands (D5, D6)."],
        ["RW Aurigae (variable)", "335", "6", "Sep 2025 to Sep 2026", "Brightness changes between visits; show a light curve."],
        ["R Draconis (Mira variable)", "2493", "19", "Apr 2025 to Sep 2026", "Large brightness swings, near the ecliptic pole, so many visits."],
    ], [0.27, 0.09, 0.08, 0.2, 0.36]),
    H2("Scope: build in this order"),
    table([
        ["Must have", "Should have", "Could have"],
        ["• SPHEREx 3D sky + Gaia-style view (done in prototype)<br/>• Search, presets, fly-to, URL state<br/>"
         "• Command bus + keyboard map<br/>• Gaze adapter with dwell + rest zone<br/>• 2D time-lapse for one field (play, blink)<br/>"
         "• Single band and detector sum<br/>• WISE + Gaia context: side by side and one timeline<br/>• Five challenge targets precomputed",
         "• Add / subtract dates<br/>• RGB overlay of 3 bands<br/>• Spectrum on click/dwell<br/>• Blink SPHEREx vs WISE<br/>"
         "• Flags panel<br/>• AI guide with tool calls<br/>• Embed mode",
         "• Custom band formula<br/>• Neighbouring patches<br/>• Known-asteroid overlay (JPL)<br/>• Light curves for variables<br/>"
         "• Guided tour<br/>• Phone layout"],
    ], [0.36, 0.32, 0.32]),
]
story.append(PageBreak())
story += [
    H2("Who does what"),
    table([
        ["Role", "Owns", "Done when"],
        ["1. Sky & UI", "web/src/sky, ui: Aladin, SPHEREx cube, views, ribbon, URL state, look", "Search, fly and band switching work end to end"],
        ["2. Field viewer", "web/src/field: time-lapse player, blink/add/subtract, band mixer, WISE/Gaia context panel", "WISE 0855 plays from 2010 (WISE) to 2026 (SPHEREx) with Gaia circles"],
        ["3. Data backend", "api/: SIA, cutouts, alignment, cache, ingest, spectra, WISE + Gaia context", "/api/frames and /api/cutout return aligned images for all 5 targets"],
        ["4. Guide & AI", "web/src/guide + LLM tool calls mapped to commands", "'Show me Barnard's Star in D6' runs without touching the mouse"],
        ["5. Eye tracking", "eye-tracking/ + web/src/input gaze adapter", "Full demo: fly, zoom, play, change band using only gaze"],
    ], [0.17, 0.5, 0.33]),
    H2("Timeline (hackathon weekend)"),
    table([
        ["When", "Goal"],
        ["Saturday morning", "Repo from this structure. Prototype deployed. Agree on the command list and gaze message format."],
        ["Saturday afternoon", "Backend frames + cutouts for the 5 targets. Field viewer plays one time-lapse. Gaze can pan and zoom."],
        ["Saturday evening", "Bands: single, detector sum, RGB. Blink/subtract. Guide can fly_to and set_band."],
        ["Sunday morning", "Spectrum, overlays, flags. Accessibility pass: keyboard, screen reader, contrast, dwell settings."],
        ["Sunday midday", "Feature freeze. Record a demo done only with eye tracking."],
        ["Sunday afternoon", "Write-up and submission, with time to spare."],
    ], [0.22, 0.78]),
    H2("Notes and limits to say out loud"),
] + bullets([
    "The 3D view is the sky as seen from Earth (a sphere), not a 3D map of space. SPHEREx images do not give distances.",
    "WISE, Gaia and SPHEREx have different pixel sizes and wavelengths, so cross-mission blinks are for spotting, not measuring.",
    "The HiPS cube is display data (stretched PNG). Measurements such as spectra and brightness must come from the FITS images.",
    "The 102 bands are not taken at the same moment, because each detector sees a band at a different spot on the sky. "
    "A spectrum mixes dates; the site should say which.",
    "Keep the Aladin logo and link visible (Aladin Lite licence, LGPL-3.0) and add the SPHEREx acknowledgement from the IRSA page.",
    "Level 2 images are about 65 MB each. Always request cutouts, and precompute the showcase fields.",
]) + [
    Spacer(1, 10),
    P("Files in the project folder: prototype/index.html (working 3D/Gaia-style SPHEREx viewer, run with "
      "<i>python3 -m http.server 8765 --directory prototype</i>), spherex_fetch.py (download and preview one SPHEREx "
      "image), docs/build_spec.py (regenerates this PDF).", s_small),
]


def on_page(c, doc):
    c.saveState()
    c.setFillColor(NIGHT); c.rect(0, A4[1] - 8 * mm, A4[0], 8 * mm, stroke=0, fill=1)
    for i, col in enumerate(D):
        c.setFillColor(colors.HexColor(col)); c.rect(i * A4[0] / 6, A4[1] - 9.2 * mm, A4[0] / 6, 1.2 * mm, stroke=0, fill=1)
    c.setFont("Arial", 7.5); c.setFillColor(MUTED)
    c.drawString(18 * mm, 10 * mm, "Meridian · SPHEREx accessible sky · project structure")
    c.drawRightString(A4[0] - 18 * mm, 10 * mm, f"Page {doc.page}")
    c.restoreState()


SimpleDocTemplate(str(OUT), pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm,
                  bottomMargin=18 * mm, title="Meridian: SPHEREx accessible sky. Project structure",
                  author="Meridian team").build(story, onFirstPage=on_page, onLaterPages=on_page)
print("wrote", OUT)
