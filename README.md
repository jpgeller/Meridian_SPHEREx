# Meridian_SPHEREx

A sky explorer for NASA's SPHEREx mission (NASA Space Apps 2026). Fly through the whole infrared sky in 3D, zoom in to any patch (at full SPHEREx resolution once you're close), and watch the real SPHEREx images of it as a time-lapse. You can compare dates, mix the 102 infrared bands, put WISE (2010–2024) and Gaia beside it for context, and measure a spectrum. Everything is usable without a mouse (keyboard, or any external controller through the command bridge); eye-tracking control is being integrated by a partner team.

- **Project spec:** [docs/Meridian_SPHEREx_Project_Spec.pdf](docs/Meridian_SPHEREx_Project_Spec.pdf)
- **Build plan, with notes on what was learned at each step:** [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md)
- **Working notes and verified data facts:** [CLAUDE.md](CLAUDE.md)
- **Eye tracking (hand-off to the partner team):** [docs/EYE_TRACKING.md](docs/EYE_TRACKING.md)

## Quick start

```bash
# backend (Python 3.11+)
cd api
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
./.venv/bin/python -m uvicorn main:app --reload --port 8000 --timeout-graceful-shutdown 5
```

```bash
# front end (Node 20+)
cd web
npm install && npm run dev        # http://localhost:5173
```

Try these:
- `http://localhost:5173/?name=WISE%200855` flies to the coldest known brown dwarf.
- Press Enter to open the time-lapse.
- Press `s` for its spectrum.

## Tests

```bash
cd web && npm test                          # unit tests
cd web && npm run test:e2e                  # browser smoke tests (uses installed Chrome)
cd api && ./.venv/bin/python -m pytest -q   # API tests
```

## Data

| Data | Source |
| --- | --- |
| SPHEREx images | NASA/IPAC IRSA: DR1/QR3 Level 2 images and the DR1 all-sky HiPS cube |
| WISE/NEOWISE images | WiseView (Backyard Worlds) |
| Gaia DR3 | ESA Gaia archive |
| Name lookup | CDS Sesame/SIMBAD |
| Sky viewer | Aladin Lite (CDS) |

> This publication makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by the National Aeronautics and Space Administration.
