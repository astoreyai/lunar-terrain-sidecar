#!/usr/bin/env bash
# Fetch the public source data lunar-terrain-sidecar builds on:
#
#   1. JPL DE440 SPICE kernels (NAIF, ~46 MB total)
#        de440s.bsp                planetary ephemeris, 1849-2150
#        moon_pa_de440_200625.bpc  integrated lunar Principal Axis orientation
#        moon_de440_250416.tf      frames kernel with the fixed PA->ME rotation
#   2. PGDA/LOLA 5 m/px south-polar DEM, Site01 (~41 MB), the DEM the
#      shipped example site and presets reference.
#
# All URLs below were verified reachable (HTTP 200, correct content type)
# on 2026-08-03. Checksums are SHA-256 of the copies this repository was
# developed and validated against; a mismatch means the upstream file
# changed (or the download corrupted) and the script FAILS rather than
# letting a silently different dataset stand in for the validated one.
#
# Usage:
#   bash scripts/fetch-data.sh [target-dir]     # default: ./data
#
# Data credit:
#   LOLA: Smith et al. (2010); PGDA polar DEMs: Barker et al. (2021),
#   https://pgda.gsfc.nasa.gov/products/78
#   DE440: Park et al. (2021), https://naif.jpl.nasa.gov/

set -euo pipefail

DATA_DIR="${1:-data}"
SPICE_DIR="$DATA_DIR/spice_kernels"
DEM_DIR="$DATA_DIR/lola_5mpp"

NAIF_BASE="https://naif.jpl.nasa.gov/pub/naif/generic_kernels"
PGDA_BASE="https://pgda.gsfc.nasa.gov/data/LOLA_5mpp"
LOLA_GDR_BASE="https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img"

# file|url|sha256 (sha256 of the copies validated in this repo, 2026-08-03)
KERNELS=(
  "de440s.bsp|$NAIF_BASE/spk/planets/de440s.bsp|c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2"
  "moon_pa_de440_200625.bpc|$NAIF_BASE/pck/moon_pa_de440_200625.bpc|60cd55aa401ea2ea97360636f567554bfe4e37bb829f901b4460a455dfaf783f"
  "moon_de440_250416.tf|$NAIF_BASE/fk/satellites/moon_de440_250416.tf|a47c71e9c9f33796bdafb2c9d69a7ee447b6016ecad80f71cd6f3e479f9cf768"
)
DEMS=(
  "Site01_final_adj_5mpp_surf.tif|$PGDA_BASE/Site01/Site01_final_adj_5mpp_surf.tif|3ba7b97cb00a2bcf21189c3aeb535f65afc21207154ab9f0d43c5bdc1f7e747e"
)
# LOLA gridded 120 m/px polar product (75S-90S), used by the opt-in far-field
# horizon ring (ADR 0006). 116 MB image + detached label.
LDEM=(
  "ldem_75s_120m.img|$LOLA_GDR_BASE/ldem_75s_120m.img|ae3afc3c75c33d43666ca06c83ca08f0b12ef03b7d36d2d791d972730794391b"
  "ldem_75s_120m.lbl|$LOLA_GDR_BASE/ldem_75s_120m.lbl|5c59b16ec8a610792b1776fa082e409c8cc9f6743757710d14876ef366acd99a"
)

fetch() {
  local name="$1" url="$2" sha="$3" dir="$4"
  local dest="$dir/$name"
  if [ -f "$dest" ]; then
    echo "== $name already present, verifying checksum"
  else
    echo "== downloading $name"
    echo "   $url"
    curl -fL --retry 3 -o "$dest.partial" "$url"
    mv "$dest.partial" "$dest"
  fi
  local got
  got="$(sha256sum "$dest" | cut -d' ' -f1)"
  if [ "$got" != "$sha" ]; then
    echo "ERROR: checksum mismatch for $name" >&2
    echo "  expected: $sha" >&2
    echo "  got:      $got" >&2
    echo "  The file differs from the copy this repository was validated" >&2
    echo "  against. Refusing to proceed; delete $dest and investigate." >&2
    exit 1
  fi
  echo "   sha256 OK"
}

mkdir -p "$SPICE_DIR" "$DEM_DIR" "$DATA_DIR/lola_ldem"

for entry in "${KERNELS[@]}"; do
  IFS='|' read -r name url sha <<<"$entry"
  fetch "$name" "$url" "$sha" "$SPICE_DIR"
done

for entry in "${DEMS[@]}"; do
  IFS='|' read -r name url sha <<<"$entry"
  fetch "$name" "$url" "$sha" "$DEM_DIR"
done

LDEM_DIR="$DATA_DIR/lola_ldem"
for entry in "${LDEM[@]}"; do
  IFS='|' read -r name url sha <<<"$entry"
  fetch "$name" "$url" "$sha" "$LDEM_DIR"
done

ABS_SPICE="$(cd "$SPICE_DIR" && pwd)"
ABS_DEM="$(cd "$DEM_DIR" && pwd)"
ABS_LDEM="$(cd "$LDEM_DIR" && pwd)"

cat <<EOF

All files downloaded and checksum-verified.

Point the tools at them:

  1. SPICE kernels (solar mode 'ephemeris_de' and tests/lunar-solar.de.test.ts):

       export LTS_SPICE_DIR="$ABS_SPICE"

     or per-config:  "solar": { "kernelDirectory": "$ABS_SPICE", ... }

  2. PGDA DEM. The example config and UI presets reference the development
     machine's dataset store. Either edit the config's dem.path:

       "dem": { "path": "$ABS_DEM/Site01_final_adj_5mpp_surf.tif", ... }
       (examples/south_pole_site_01/config.json)

     or reproduce the expected path with a symlink:

       sudo mkdir -p /mnt/projects/datasets
       sudo ln -s "$ABS_DEM" /mnt/projects/datasets/lola_5mpp

     Note: editing dem.path changes the canonical configuration hash recorded
     in exports (the path is part of the config); the generated terrain bytes
     themselves depend only on the DEM contents, which the checksum pins.

  3. LOLA LDEM_75S (far-field horizon ring, terrain.getHorizon farField):

       export LTS_LDEM_75S="$ABS_LDEM/ldem_75s_120m.lbl"

     or per-request:  "farField": { "demPath": "$ABS_LDEM/ldem_75s_120m.lbl" }

Other PGDA 5 m/px sites (Site04, Site06, Site07, Site11, Site20, Site23,
Haworth, Shoemaker, DM2) follow the same URL pattern:
  $PGDA_BASE/<Name>/<Name>_final_adj_5mpp_surf.tif
No checksums are recorded here for those; verify against
https://pgda.gsfc.nasa.gov/products/78 yourself.
EOF
