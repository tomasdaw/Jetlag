# Jet Lag Companion — Phase 1 (single device)

A map helper for the at-home edition of *Jet Lag: The Game*. Seekers ask radar
and thermometer questions, the hider taps the answer, and the app shades out the
places where the hider can no longer be.

## Run it

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Then open http://localhost:8080. No build step, and no Node or Python needed.

## Files

| File | What it does |
|---|---|
| `config/game-config.js` | **All game rules**: radar and thermometer options (metric and imperial editions), game sizes, repeat costs, play-area presets, map and transit styling. |
| `js/geometry.js` | Pure geometry engine (Turf.js): circles, bisector half-planes, station-buffer play areas, replaying the log into a region. No DOM. |
| `js/app.js` | Map, UI, question flow, log/undo, GPS and manual position, local save. |
| `data/montreal-transit.geojson` | STM métro and REM lines and stations (OpenStreetMap). |
| `data/montreal-island.geojson` | Island of Montréal boundary (OpenStreetMap relation 3430571, simplified). |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA: installable to the home screen, works offline for the app shell. |
| `serve.ps1` | Local test server (Windows PowerShell). Not needed on GitHub Pages. |

## How it works

- **The log is the source of truth.** Each question is stored as
  `{type, params, answer}`. The "possible hider region" is never saved. It is
  rebuilt by starting from the play area and applying each answered question
  in order, so undo is just "edit the log, recompute".
- **Radar**: a 128-sided circle around the seeker position. *Yes* intersects the
  region with the circle; *No* subtracts it.
- **Thermometer**: the half-plane of points closer to B than to A (or the
  reverse), bounded by the perpendicular bisector. It is computed in a local
  flat projection centred on the midpoint, which is accurate at city scale.
- **Undo** acts on the newest question: it either retracts the answer (the
  question goes back to "waiting") or withdraws an unanswered question.
- The game is saved to `localStorage` on this device, so a page reload keeps it.

## Changing rules

1. Distances, costs and prompts live in `config/game-config.js`. Check them
   against your printed rulebook.
2. For a new question type, add a config entry and a handler in
   `Geo.handlers` (`apply` + `overlay`), then a form in `renderAsk()`.

## Hosting

The app is static files, so GitHub Pages serves it as-is at
`https://<username>.github.io/<repository>/`. HTTPS is needed on phones for GPS
and for installing to the home screen.

## Known limits

- GPS may pause when the phone is locked or the browser is in the background.
  Use "Tap map" (or the pin button) to place the seekers' position by hand.
- Single device for now: each phone keeps its own game. Shared games between
  phones are planned (phase 2).
