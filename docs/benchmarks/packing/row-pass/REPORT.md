# Guarded bulk row packing

Three alternating repetitions compare the unchanged optimized baseline with the
row-reader change on the same 240 by 80 dense scene, DPR 1, hardware Chrome.
The Wasm engine remains unchanged.

- Median completed pipeline updates/s: 416.26 to 459.44 (10.37% improvement).
- Median redraw CPU time: 1.20 ms to 1.00 ms.
- Pipeline CPU p95: 2.80 ms to 2.40 ms.

These are synthetic GPU-completed updates, not physical display FPS. Raw runs,
ranges, and source/binary identities are retained in optimization.json and
summary.json. Text hashes agree and each counted pipeline update submitted a
frame. This pass does not establish results on other workloads or hardware.

The reader checks the pinned xterm row layout once per row. Ordinary scalar
cells use packed words; combined text, extended attributes, invalid codepoints
and unfamiliar storage retain public getters. Twenty-two differential cases at
DPR 1 and 2 compare every GPU word, text, and renderer state. Diagnostics prove
ordinary rows perform zero public cell loads and absent, short, or mistyped
private storage takes the getter path. Selection fixtures now await their
animation-frame event before snapshotting, outside timed benchmark paths.

SDK build, type checking, all 15 Vitest tests, demo build, and all 16 xterm browser
integration checks passed. The latter cover actual pixels, addons, parser hooks,
fallbacks, transient presentation retry, and teardown.
