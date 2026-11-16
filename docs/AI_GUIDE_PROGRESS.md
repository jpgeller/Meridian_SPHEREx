# AI Guide — progress

Implementing [fix-and-improvements-ai-guide.md](fix-and-improvements-ai-guide.md) on branch `ai-guide-improvements`.

Decisions (Nov 15, 2026):
- The 7 Places keep their local tours (zero tokens), made richer from the fact cards. Other objects ask Claude.
- B5: only the guide's own labels move; the sky hand-off button (`sky/handoff.js`) is not touched.
- One indicator per spot: guide code only; `input/gaze.js` is not touched.
- Budgets as in the spec (40 per visit, 15 s); the dynamic pill menu shares that budget.

## P0 bug fixes
- [x] B1 — Colours flow content
- [x] B2 — Last step label
- [x] B3 — Clear overlays on end
- [x] B4 — Stable card layout (body sized for title + ~5 lines so no current step scrolls)
- [x] B5 — Hint placement
- [x] B7 — Object explanations via Claude (non-Place objects)

## P0 guide presence
- [x] Remove idle arrow; orb docks in pill

## P0 preset fact cards
- [x] Fact cards for the 7 Places, sent as `facts.preset`; richer local Place tours

## P1
- [x] Insight-first copy
- [x] New budgets + 5-min "Not now" + teaser auto-collapse
- [x] Pill states (teaser = compact offer card; Muted look + popup.setMuted, control is P2)
- [x] Dynamic pill menu (via /api/guide/nudge moment "menu"; fixed three as fallback)
- [ ] Arrival trigger
