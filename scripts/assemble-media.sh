#!/usr/bin/env bash
# Assemble docs/media/ and paper/figures/ from the frames captured by
# scripts/capture-media.ts. Requires ffmpeg and ImageMagick (montage/convert).
#
# Every input frame is a real render: headless Chromium over terrain generated
# from the real LOLA/PGDA Site01 DEM, lit by the real ephemeris at the epochs
# recorded in the capture log. This script only resizes, tiles, and encodes.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$REPO/.test-artifacts/media"
MEDIA="$REPO/docs/media"
FIGS="$REPO/paper/figures"

for tool in ffmpeg montage convert; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done
[ -d "$WORK/stills" ] || { echo "no capture output at $WORK — run capture-media.ts first" >&2; exit 1; }

mkdir -p "$MEDIA" "$FIGS"

# ---- stills ----------------------------------------------------------------
convert "$WORK/stills/hero-lit.png" -resize 1200x "$MEDIA/hero-lit.png"
convert "$WORK/stills/authoring-ui.png" -resize 1400x "$MEDIA/authoring-ui.png"
convert "$WORK/stills/topdown-elevation.png" -resize 1200x "$MEDIA/topdown-elevation.png"
convert "$WORK/stills/construction-ui.png" -resize 1400x "$MEDIA/construction-ui.png"

montage \
  -label "elevation" "$WORK/stills/overlay-elevation.png" \
  -label "slope" "$WORK/stills/overlay-slope.png" \
  -label "semantic classes" "$WORK/stills/overlay-semantic.png" \
  -label "traversability (heuristic overlay)" "$WORK/stills/overlay-traversability.png" \
  -tile 2x2 -geometry +4+4 -background '#111318' -fill '#d8dce5' -pointsize 28 \
  "$MEDIA/overlays.png"

# ---- solar sweep GIF (30 frames, 2025-12-20 .. 2026-01-19) -----------------
ffmpeg -y -loglevel error -framerate 7 -i "$WORK/sweep/sweep-%02d.png" \
  -vf "scale=800:-1:flags=lanczos,palettegen=stats_mode=diff" "$WORK/sweep-palette.png"
ffmpeg -y -loglevel error -framerate 7 -i "$WORK/sweep/sweep-%02d.png" -i "$WORK/sweep-palette.png" \
  -lavfi "scale=800:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4" \
  -loop 0 "$MEDIA/solar-sweep.gif"

# ---- construction GIF ------------------------------------------------------
ffmpeg -y -loglevel error -framerate 1 -i "$WORK/construction/c-%02d.png" \
  -vf "scale=800:-1:flags=lanczos,palettegen" "$WORK/construction-palette.png"
ffmpeg -y -loglevel error -framerate 1 -i "$WORK/construction/c-%02d.png" -i "$WORK/construction-palette.png" \
  -lavfi "scale=800:-1:flags=lanczos [x]; [x][1:v] paletteuse" \
  -loop 0 "$MEDIA/construction.gif"

# ---- paper figure: four epochs from the sweep ------------------------------
# Frames 2 / 9 / 16 / 23 span ~one lunar day of azimuth: the epochs and angles
# below are the capture log's own values for those frames.
montage \
  -label "2025-12-22 02:29 UTC — el 1.68°, az 290°" "$WORK/sweep/sweep-02.png" \
  -label "2025-12-29 11:10 UTC — el 0.88°, az 201°" "$WORK/sweep/sweep-09.png" \
  -label "2026-01-05 19:52 UTC — el 1.07°, az 111°" "$WORK/sweep/sweep-16.png" \
  -label "2026-01-13 04:33 UTC — el 1.66°, az 22°"  "$WORK/sweep/sweep-23.png" \
  -tile 2x2 -geometry +4+4 -background '#111318' -fill '#d8dce5' -pointsize 30 \
  "$WORK/solar-sweep-montage.png"
convert "$WORK/solar-sweep-montage.png" -resize 1600x "$FIGS/solar-sweep.png"

echo "--- outputs"
ls -la "$MEDIA" "$FIGS"
