#!/bin/bash
# Build doomterm from a doomgeneric checkout with the repository's pinned Zig:
#   video/capture/doomterm/build.sh <doomgeneric/doomgeneric source dir> <output binary>
set -e
R="$1"; OUT="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
Z="${ZIG:-$(ls -d "$ROOT"/.cache/zig-*/zig | head -1)}"
SRC=$(grep "^SRC_DOOM" "$R/Makefile" | sed 's/SRC_DOOM = //; s/doomgeneric_xlib.o//; s/\.o/.c/g')
FILES=()
for f in $SRC; do FILES+=("$R/$f"); done
ZIG_GLOBAL_CACHE_DIR="$ROOT/.cache/zig-global" "$Z" cc -O2 -w -D_DEFAULT_SOURCE -DNORMALUNIX \
  -I"$R" -o "$OUT" "${FILES[@]}" "$HERE/doomgeneric_term.c"
