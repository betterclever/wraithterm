# Contributing to Wraith

## Development

The checked-in Wasm engine lets JavaScript work start without Rust or Zig:

```sh
npm ci
npm run build:sdk
npm run dev
```

See [README.md](README.md#build-from-source) for engine prerequisites and
`WRAITH_BUILD_DIR` when using a shared toolchain cache.

## Validation

Run checks that exercise the change. For SDK changes:

```sh
npm run build:sdk
npm run typecheck
npm test
npm run build:demo
```

For engine changes, also run `npm run build`, `npm run test:native`, and
`cargo fmt --all --check`. GPU or terminal integration changes need the relevant
browser and installed-package consumer tests with the demo server running:

```sh
npm run test:browser
npm run test:consumer
npm run test:xterm
npm run test:xterm-consumer
```

Run `npm run optimize` after an engine rebuild when shipping the optimized
Wasm artifact. Rebuild the SDK after changing generated upstream declarations.
Documentation-only changes need formatting and link review; they do not require
rerunning the GPU benchmarks.

## Commits

Commit each completed, validated milestone while working. Keep related behavior,
tests, and documentation together; separate independent changes. Use an
imperative subject such as `perf: reuse renderer staging buffers` and a body
explaining why the change matters and what was checked. Report any checks that
could not run.

Before each commit, review `git diff --cached` and `git diff --cached --stat`, then
run `git diff --cached --check`. After the commit, inspect `git status --short`.
Preserve unrelated changes and never include credentials. Pushing, publishing to
npm, and making releases require authorization.

The initial history organizes the existing implementation and its collected
evidence into focused commits. Earlier development was uncommitted; this
retrospective split does not reconstruct its chronology. Commit timestamps
reflect the split, and the original two-commit checkpoint remains on the
`backup/pre-33-commit-split` branch.

## Generated files and evidence

Track the prebuilt engine, its JavaScript bindings and declarations, fonts, and
licenses so a clean checkout can run with Node alone. Track raw benchmark JSON,
CSV summaries, validation records, and reports with their build hashes.
Preserve upstream legal notices verbatim; `.gitattributes` exempts their original
whitespace from Git's whitespace check.

Compiled SDK and demo output, dependencies, toolchain caches, CPU profiles, and
full-resolution comparison screenshots are ignored. Profiles and screenshots
remain local and can be regenerated with the scripts under `scripts/`. When
changing published documentation, keep its copy in `packages/wraith/docs` in
sync. Package contents are governed by `packages/wraith/package.json`.

Performance results must distinguish CPU usage, device-wide GPU activity,
GPU-completed throughput, and physical display presentation. Preserve raw runs
and disclose fallback renderers and measurement limits.
