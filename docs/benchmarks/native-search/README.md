# Native search

Counted-search API medians on Apple M5 Max / Chrome 155:

| History                     | xterm WebGL | Wraith native |
| --------------------------- | ----------: | ------------: |
| 9,000 short lines           |      0.9 ms |        0.5 ms |
| 9,000 wrapped Unicode lines |     25.5 ms |        2.0 ms |
| 90,000 short lines          |      7.8 ms |        4.0 ms |

Native improves from 76.4 to 0.5 ms on the short 9,000-line baseline and from
993 to 4.0 ms on 90,000 lines. First queries after writing also improve, but still
encode the history: 3.4 / 12.5 / 32.1 ms for these three cases.

Xterm counted calls include match decorations; native returns full counts and
selects a match. Xterm remains faster on short-line next-only calls that do not
count all matches. These are API timings, not display latency. All final counts
and selections pass. The prior wrapped baseline had duplicate counts and is
excluded from before/after speed ratios.

With xterm’s decoration/selection work removed in a separate counting diagnostic,
plain logs are roughly tied and wrapped-line counting is **6.8× faster** on native.
The first 90,000-line count takes 34.5 ms on both paths in that diagnostic.

[Methodology, ranges, first queries, limitations and raw data](REPORT.md).
