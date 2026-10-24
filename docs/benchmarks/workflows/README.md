# Broader workload benchmark

Frozen build `dfd876aabc2165ce50b5a851bd9468e478ca334a` on an Apple M5 Max, 18 logical CPUs, 48 GiB RAM, Chrome 155. Three repetitions, four renderers, fifteen workloads at DPR 1 and 2, plus a 240×80 stress matrix. Public SDK typing, history, search, resize, paste and eight-terminal sustained sessions are measured separately.

Representative 160×50 DPR1 **completed logical updates/s** (medians):

| Workload    | xterm WebGL | Wraith compatible | Wraith native |
| ----------- | ----------- | ----------------- | ------------- |
| build-log   | 1,978       | 6,541             | 6,442         |
| editor      | 1,941       | 4,137             | 4,842         |
| dashboard   | 2,281       | 10,359            | 13,147        |
| large-write | 719         | 869               | 3,880         |
| complex     | 325         | 1,097             | 2,188         |
| pipes       | 210         | 487               | 782           |

These medians are point estimates; dense/Pipes samples have substantial variation, flagged in the full report. These numbers are not physical display FPS. New workflow cases run for at least one second and 512 updates; the older dense/Pipes fixtures use fixed 512-update batches. Completion fences occur every 32 GPU submissions. This measures warm throughput, not cold startup or typical application frame rate. The editor fixture is synthetic, not a captured Neovim session.

The broader tests also expose gaps:

- This frozen build’s native search takes **82.8 ms** over 9,000 retained lines. The later [native search optimization](../native-search/REPORT.md) removes timer clamping and reuses encoded history: its counted-search medians are **0.5 ms** over 9,000 short lines and **4.0 ms** over 90,000. The historical xterm call below seeks the next match without counting all results; the new report separates counted searches, first queries and next-only calls.
- A 1 MiB public paste plus parsed echo takes **43.2 ms** on compatible, versus **31.9 ms** on upstream xterm and **4.4 ms** on native. Three samples per renderer establish a follow-up target, not a precise regression percentage.
- At the same 0.473 MiB/s across eight terminals, compatible uses 34.0% of one CPU core, native 29.3%, and WebGL 22.7%. That is about 1.89%, 1.63%, and 1.26% of this machine’s total CPU capacity. Each is one 30-second observation; resource sharing remains a clear target.
- Native CJK/emoji glyph coverage is unverified. Unicode and bytewise fixtures containing those glyphs are excluded from native speed claims.
- The DPR2 WebGL Pipes runs have **1,666 incorrect samples out of 16,000 cell halves** per run. All compatible/native Pipes samples pass. Those faulty WebGL runs are excluded from ratios.

[Full methodology, ranges, exclusions, operations and CPU/memory tables](REPORT.md), [baseline raw data](baseline/runs.json), [larger-grid raw data](stress/runs.json).
