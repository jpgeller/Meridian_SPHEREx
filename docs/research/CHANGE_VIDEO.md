# Research: turning the changes between sky visits into a video

Question (15 Nov 2026): can the few SPHEREx visits of a patch, plus the WISE images from 2010–2024, play
as a smooth video that shows what moved or changed? Is it worth it, and what's the cheapest good way?
**Built: option D (motion trail, Step 15) and option C (change video, Step 16 in BUILD_PLAN).**

## What we have to work with
| Source | Dates per patch | Pixel | Wavelengths |
|---|---|---|---|
| SPHEREx (our cutouts) | 4–19 visits over ~1–1.5 years (2025–26) | 6.15″ | 102 bands; D6 ≈ WISE W2 |
| WISE/NEOWISE (WiseView, unWISE coadds) | ~13–16 yearly-ish epochs, 2010–2024 | 2.75″ | W1 3.4 µm, W2 4.6 µm |
| Gaia DR3 | positions + motions (epoch 2016.0) | n/a | n/a |

Combining WISE and SPHEREx gives a **~16-year baseline**. That's what makes motion obvious: Barnard's Star moves
~166″ (~60 WISE pixels), and WISE 0855 ~110″. SPHEREx alone gives only ~1–2 pixels of motion for these.

## Options

### A. Crossfade between dates
Each date fades into the next.
- Cost: trivial, done in the browser.
- Problem: a moving star *fades out in one place and fades in at another*. That reads as blinking, not motion,
  whenever it moves more than about one star-width between dates.
- Good for brightness changes (variable stars).

### B. AI / optical-flow frame interpolation (RIFE, FILM, Farnebäck)
These are made for everyday video.
- Small objects are hard for optical-flow methods, and typical artefacts are ghosting, blur and lost detail.
- Our frames add more difficulty: mostly noise and point sources, different blur (PSF) and wavelengths on each date,
  and two missions with different pixel sizes.
- Needs a Python model and ideally a GPU.
- Worst problem: it **invents** in-between images. For a science tool that's misleading.
- **Not recommended.**

### C. Model-based interpolation ("physics video"), recommended for the video
Build the in-between frames from a simple, honest model instead of guessing pixels:
1. **Background:** the median of all dates on the common grid. Static stars cancel out.
2. **What changes:**
   - Movers come from difference images (already built: `differenceSignificance`) and from catalogue motions:
     Gaia DR3, plus **CatWISE2020** for cold brown dwarfs Gaia can't see (WISE 0855 is one). CatWISE2020 has ~2.2 billion
     sources with motions from 3.4/4.6 µm data, aimed at ultracool dwarfs, and is served by IRSA.
   - Variable stars come from per-date brightness (already measured: spectrum/photometry code).
3. **Rendering:** each mover is a small stamp of its own image (its PSF), slid along its fitted straight-line path. A
   variable's brightness is interpolated between measured dates. Frames are drawn in the browser at 30 fps (tiny arrays).
4. **Honesty in the UI:**
   - Real dates are marked: frame flashes, date label.
   - In-between frames are labelled "interpolated (model)".
   - The mission name is shown; at the WISE → SPHEREx switch, the brightness scale is reset per mission.
- **Across missions:**
  - **Grid:** reproject WISE onto the SPHEREx grid, or the reverse for sharper motion.
  - **Bands:** use W2 with SPHEREx D6 (both ≈ 4.6 µm) so colours match.
  - **Proper motions:** unTimely (Meisner et al. 2023) adds proper motions for the WISE side. It is a full-sky catalogue of
    detections in ~16 biannual coadds per location, built for finding faint, fast-moving objects such as Y dwarfs.
- **Cost:** about 1 day to build. Computing cost is negligible. One new data source (a CatWISE2020 query) and no GPU.

### D. Time-coloured "motion trail" image, recommended first
One still picture: each date tinted from blue (oldest) to red (newest) and stacked.
- Static stars come out white. **Moving objects become a rainbow streak** whose direction and length show the motion.
- Variable stars get a coloured fringe.
- **Cost:** ~1–2 hours, browser only.
- Very readable for non-experts, and it works as a slide in the demo. It's also a still image, which helps
  accessibility, because nothing has to be followed in motion.

## Recommendation
**Worth it.**
- **D first:** cheapest, highest impact.
- **Then C:** the honest "video", WISE 2010 → SPHEREx 2026.
- **Skip B:** unreliable and it fabricates frames.
- **Keep A:** only as a fallback, and for brightness-only changes.

The biggest visual payoff comes from the **16-year WISE + SPHEREx timeline**. SPHEREx alone barely shows motion yet.

## Sources
- [The CatWISE2020 Catalog (Marocco et al., arXiv)](https://arxiv.org/pdf/2012.13084), [IRSA README](https://irsa.ipac.caltech.edu/data/WISE/CatWISE/gator_docs/CatWISE2020README_IRSA.txt)
- [unTimely: a Full-sky, Time-Domain unWISE Catalog (arXiv)](https://arxiv.org/pdf/2209.14327), [AJ 2023 summary](https://doaj.org/article/c52d918321d846bd9e860498a0a147c8), [IRSA DOI](https://www.ipac.caltech.edu/doi/10.26131/IRSA580)
- [Time-resolved WISE/NEOWISE Coadds](https://arxiv.org/pdf/1710.02526); moving-object searches with unTimely: [arXiv 2408.15067](https://arxiv.org/html/2408.15067v1), [A&A](https://www.aanda.org/10.1051/0004-6361/202452011)
- Frame interpolation background: [Task-specific optical flow for satellite imagery](https://arxiv.org/pdf/1907.12013), [frame interpolation without optical flow](https://arxiv.org/pdf/2311.11602), [artefacts patent](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10489897), [generative interpolation in microscopy](https://www.themoonlight.io/review/biorxiv/generative-frame-interpolation-enhances-tracking-of-biological-objects-in-time-lapse-microscopy)
