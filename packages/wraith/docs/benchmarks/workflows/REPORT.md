# Expanded terminal workflow study

These are measurements of the frozen production build, not a claim of 1000 physical display frames/s. Throughput drives synchronous semantic cores with precomputed input and fences every 32 GPU submissions; the public worker SDK is measured separately. Results depend on this hardware, workload, headless Chrome scheduling and uncontrolled desktop thermals. Three repetitions identify large differences but do not establish small percentage wins. Text checks certify terminal contents, while full per-cell pixel checks are limited to Pipes. Other glyph/style coverage is not certified by a checksum.

## docs/benchmarks/workflows/baseline

Source: `dfd876aabc2165ce50b5a851bd9468e478ca334a`. Apple M5 Max, 18 logical CPUs, 48 GiB RAM, darwin 27.2.0. Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36. xterm 6.0.0, WebGL addon 0.19.0. Configured throughput grid 160×50, 3 repetitions. 376 completed run sets; 0 harness errors.

[Raw data](baseline/runs.json) · [CSV](baseline/summary.csv)

### Valid completed logical updates/s

A ratio is shown only when every configured repetition passed its checks and both renderers have a coefficient of variation at most 15%. A dagger marks higher variation; inspect the detailed ranges before drawing conclusions. DOM layout timing has no GPU-completion fence and is retained separately in the detailed table. Native Unicode and bytewise fixtures contain CJK/emoji and are excluded until font coverage is certified.

| Workload / scale | xterm WebGL | Compatible | Native   | Compatible / WebGL | Native / WebGL |
| ---------------- | ----------- | ---------- | -------- | ------------------ | -------------- |
| build-log/DPR1   | 1978        | 6541       | 6442     | 3.31×              | 3.26×          |
| editor/DPR1      | 1941        | 4137       | 4842     | 2.13×              | 2.49×          |
| dashboard/DPR1   | 2281        | 10359      | 13147    | 4.54×              | 5.76×          |
| large-write/DPR1 | 719         | 869        | 3880     | 1.21×              | 5.40×          |
| unicode/DPR1     | 1008        | 2364       | excluded | 2.35×              | excluded       |
| bytewise/DPR1    | 2182        | 6936       | excluded | 3.18×              | excluded       |
| progress/DPR1    | 2320        | 12539      | 13812    | 5.40×              | 5.95×          |
| alternate/DPR1   | 1095        | 3119       | 5554     | 2.85×              | 5.07×          |
| erase/DPR1       | 1017        | 3050†      | 3448†    | noisy              | noisy          |
| links/DPR1       | 1423        | 2430†      | 3588†    | noisy              | noisy          |
| complex/DPR1     | 325†        | 1097†      | 2188     | noisy              | noisy          |
| churn/DPR1       | 309         | 1170       | 1851     | 3.78×              | 5.98×          |
| append/DPR1      | 1361        | 7877       | 5981     | 5.79×              | 4.39×          |
| showcase/DPR1    | 802         | 1782       | 2616     | 2.22×              | 3.26×          |
| pipes/DPR1       | 210†        | 487        | 782      | noisy              | noisy          |
| build-log/DPR2   | 1337        | 3422       | 2552     | 2.56×              | 1.91×          |
| editor/DPR2      | 1365        | 2361       | 2110     | 1.73×              | 1.55×          |
| dashboard/DPR2   | 1774        | 6016       | 5343     | 3.39×              | 3.01×          |
| large-write/DPR2 | 646         | 737        | 1868     | 1.14×              | 2.89×          |
| unicode/DPR2     | 719         | 1744       | excluded | 2.42×              | excluded       |
| bytewise/DPR2    | 1465        | 3296       | excluded | 2.25×              | excluded       |
| progress/DPR2    | 2197        | 6838       | 4459     | 3.11×              | 2.03×          |
| alternate/DPR2   | 657         | 1987       | 2253     | 3.03×              | 3.43×          |
| erase/DPR2       | 683         | 2746       | 2240     | 4.02×              | 3.28×          |
| links/DPR2       | 1231†       | 2583†      | 3290†    | noisy              | noisy          |
| complex/DPR2     | 480         | 1953       | 2055     | 4.07×              | 4.28×          |
| churn/DPR2       | 503         | 2074       | 1869     | 4.12×              | 3.72×          |
| append/DPR2      | 1498†       | 5074       | 5367     | noisy              | noisy          |
| showcase/DPR2    | 927         | 2700       | 2556     | 2.91×              | 2.76×          |
| pipes/DPR2       | excluded    | 681        | 753      | excluded           | excluded       |

<details>
<summary>All repetitions, ranges and variability</summary>

| Workload / scale | Renderer          | Valid / total | Median (min–max) updates/s | CV    |
| ---------------- | ----------------- | ------------- | -------------------------- | ----- |
| build-log/DPR1   | xterm DOM         | 3/3           | 1242 (1224–1245)           | 0.8%  |
| build-log/DPR1   | xterm WebGL       | 3/3           | 1978 (1965–1998)           | 0.7%  |
| build-log/DPR1   | Wraith compatible | 3/3           | 6541 (6520–6621)           | 0.7%  |
| build-log/DPR1   | Wraith native     | 3/3           | 6442 (6403–6509)           | 0.7%  |
| editor/DPR1      | xterm DOM         | 3/3           | 812 (805–819)              | 0.7%  |
| editor/DPR1      | xterm WebGL       | 3/3           | 1941 (1927–1954)           | 0.6%  |
| editor/DPR1      | Wraith compatible | 3/3           | 4137 (3912–4143)           | 2.6%  |
| editor/DPR1      | Wraith native     | 3/3           | 4842 (4839–4885)           | 0.4%  |
| dashboard/DPR1   | xterm DOM         | 3/3           | 6211 (5437–6324)           | 6.6%  |
| dashboard/DPR1   | xterm WebGL       | 3/3           | 2281 (2123–2283)           | 3.4%  |
| dashboard/DPR1   | Wraith compatible | 3/3           | 10359 (10280–10488)        | 0.8%  |
| dashboard/DPR1   | Wraith native     | 3/3           | 13147 (12990–13239)        | 0.8%  |
| large-write/DPR1 | xterm DOM         | 3/3           | 680 (675–777)              | 6.6%  |
| large-write/DPR1 | xterm WebGL       | 3/3           | 719 (653–766)              | 6.5%  |
| large-write/DPR1 | Wraith compatible | 3/3           | 869 (815–903)              | 4.2%  |
| large-write/DPR1 | Wraith native     | 3/3           | 3880 (3864–4084)           | 2.5%  |
| unicode/DPR1     | xterm DOM         | 3/3           | 98 (96–98)                 | 1.1%  |
| unicode/DPR1     | xterm WebGL       | 3/3           | 1008 (1005–1066)           | 2.7%  |
| unicode/DPR1     | Wraith compatible | 3/3           | 2364 (2204–2446)           | 4.3%  |
| unicode/DPR1     | Wraith native     | 0/3           | excluded                   | —     |
| bytewise/DPR1    | xterm DOM         | 3/3           | 3083 (2948–3122)           | 2.5%  |
| bytewise/DPR1    | xterm WebGL       | 3/3           | 2182 (2158–2209)           | 0.9%  |
| bytewise/DPR1    | Wraith compatible | 3/3           | 6936 (6843–6965)           | 0.8%  |
| bytewise/DPR1    | Wraith native     | 0/3           | excluded                   | —     |
| progress/DPR1    | xterm DOM         | 3/3           | 23038 (21248–23553)        | 4.4%  |
| progress/DPR1    | xterm WebGL       | 3/3           | 2320 (2296–2323)           | 0.5%  |
| progress/DPR1    | Wraith compatible | 3/3           | 12539 (12515–12754)        | 0.9%  |
| progress/DPR1    | Wraith native     | 3/3           | 13812 (13670–14121)        | 1.4%  |
| alternate/DPR1   | xterm DOM         | 3/3           | 1169 (1061–1257)           | 6.9%  |
| alternate/DPR1   | xterm WebGL       | 3/3           | 1095 (1024–1111)           | 3.5%  |
| alternate/DPR1   | Wraith compatible | 3/3           | 3119 (3015–3143)           | 1.8%  |
| alternate/DPR1   | Wraith native     | 3/3           | 5554 (5443–5663)           | 1.6%  |
| erase/DPR1       | xterm DOM         | 3/3           | 758 (684–1197)             | 25.7% |
| erase/DPR1       | xterm WebGL       | 3/3           | 1017 (754–1033)            | 13.7% |
| erase/DPR1       | Wraith compatible | 3/3           | 3050 (2861–4023)           | 15.4% |
| erase/DPR1       | Wraith native     | 3/3           | 3448 (3378–5001)           | 19.0% |
| links/DPR1       | xterm DOM         | 3/3           | 1981 (1720–1983)           | 6.5%  |
| links/DPR1       | xterm WebGL       | 3/3           | 1423 (1088–1467)           | 12.8% |
| links/DPR1       | Wraith compatible | 3/3           | 2430 (1646–2483)           | 17.5% |
| links/DPR1       | Wraith native     | 3/3           | 3588 (2461–3612)           | 16.7% |
| complex/DPR1     | xterm DOM         | 3/3           | 113 (74–115)               | 19.0% |
| complex/DPR1     | xterm WebGL       | 3/3           | 325 (201–375)              | 24.3% |
| complex/DPR1     | Wraith compatible | 3/3           | 1097 (755–1189)            | 18.4% |
| complex/DPR1     | Wraith native     | 3/3           | 2188 (2182–2218)           | 0.7%  |
| churn/DPR1       | xterm DOM         | 3/3           | 97 (88–99)                 | 5.1%  |
| churn/DPR1       | xterm WebGL       | 3/3           | 309 (293–334)              | 5.4%  |
| churn/DPR1       | Wraith compatible | 3/3           | 1170 (1088–1172)           | 3.4%  |
| churn/DPR1       | Wraith native     | 3/3           | 1851 (1837–1853)           | 0.4%  |
| append/DPR1      | xterm DOM         | 3/3           | 719 (705–726)              | 1.2%  |
| append/DPR1      | xterm WebGL       | 3/3           | 1361 (1359–1361)           | 0.1%  |
| append/DPR1      | Wraith compatible | 3/3           | 7877 (7252–7913)           | 4.0%  |
| append/DPR1      | Wraith native     | 3/3           | 5981 (5953–6184)           | 1.7%  |
| showcase/DPR1    | xterm DOM         | 3/3           | 152 (151–156)              | 1.5%  |
| showcase/DPR1    | xterm WebGL       | 3/3           | 802 (777–802)              | 1.5%  |
| showcase/DPR1    | Wraith compatible | 3/3           | 1782 (1719–1791)           | 1.8%  |
| showcase/DPR1    | Wraith native     | 3/3           | 2616 (2549–2632)           | 1.4%  |
| pipes/DPR1       | xterm DOM         | 3/3           | 73 (71–73)                 | 1.1%  |
| pipes/DPR1       | xterm WebGL       | 3/3           | 210 (206–308)              | 19.6% |
| pipes/DPR1       | Wraith compatible | 3/3           | 487 (442–536)              | 7.9%  |
| pipes/DPR1       | Wraith native     | 3/3           | 782 (763–809)              | 2.4%  |
| build-log/DPR2   | xterm DOM         | 3/3           | 607 (578–1188)             | 35.5% |
| build-log/DPR2   | xterm WebGL       | 3/3           | 1337 (1321–1618)           | 9.6%  |
| build-log/DPR2   | Wraith compatible | 3/3           | 3422 (2838–3613)           | 10.0% |
| build-log/DPR2   | Wraith native     | 3/3           | 2552 (2487–2919)           | 7.2%  |
| editor/DPR2      | xterm DOM         | 3/3           | 357 (354–380)              | 3.2%  |
| editor/DPR2      | xterm WebGL       | 3/3           | 1365 (1331–1402)           | 2.1%  |
| editor/DPR2      | Wraith compatible | 3/3           | 2361 (2290–2541)           | 4.4%  |
| editor/DPR2      | Wraith native     | 3/3           | 2110 (2060–2137)           | 1.5%  |
| dashboard/DPR2   | xterm DOM         | 3/3           | 2779 (2682–3163)           | 7.2%  |
| dashboard/DPR2   | xterm WebGL       | 3/3           | 1774 (1727–1838)           | 2.6%  |
| dashboard/DPR2   | Wraith compatible | 3/3           | 6016 (5889–6197)           | 2.1%  |
| dashboard/DPR2   | Wraith native     | 3/3           | 5343 (5149–5463)           | 2.4%  |
| large-write/DPR2 | xterm DOM         | 3/3           | 591 (508–591)              | 7.0%  |
| large-write/DPR2 | xterm WebGL       | 3/3           | 646 (620–733)              | 7.2%  |
| large-write/DPR2 | Wraith compatible | 3/3           | 737 (725–890)              | 9.6%  |
| large-write/DPR2 | Wraith native     | 3/3           | 1868 (1686–1870)           | 4.8%  |
| unicode/DPR2     | xterm DOM         | 3/3           | 57 (54–58)                 | 3.3%  |
| unicode/DPR2     | xterm WebGL       | 3/3           | 719 (663–812)              | 8.4%  |
| unicode/DPR2     | Wraith compatible | 3/3           | 1744 (1685–1778)           | 2.2%  |
| unicode/DPR2     | Wraith native     | 0/3           | excluded                   | —     |
| bytewise/DPR2    | xterm DOM         | 3/3           | 1248 (1135–1365)           | 7.5%  |
| bytewise/DPR2    | xterm WebGL       | 3/3           | 1465 (1439–1553)           | 3.3%  |
| bytewise/DPR2    | Wraith compatible | 3/3           | 3296 (3291–4465)           | 15.0% |
| bytewise/DPR2    | Wraith native     | 0/3           | excluded                   | —     |
| progress/DPR2    | xterm DOM         | 3/3           | 11128 (10515–12051)        | 5.6%  |
| progress/DPR2    | xterm WebGL       | 3/3           | 2197 (2094–2201)           | 2.3%  |
| progress/DPR2    | Wraith compatible | 3/3           | 6838 (6645–7344)           | 4.2%  |
| progress/DPR2    | Wraith native     | 3/3           | 4459 (3968–4972)           | 9.2%  |
| alternate/DPR2   | xterm DOM         | 3/3           | 621 (594–663)              | 4.5%  |
| alternate/DPR2   | xterm WebGL       | 3/3           | 657 (648–673)              | 1.6%  |
| alternate/DPR2   | Wraith compatible | 3/3           | 1987 (1885–2075)           | 3.9%  |
| alternate/DPR2   | Wraith native     | 3/3           | 2253 (2250–2433)           | 3.7%  |
| erase/DPR2       | xterm DOM         | 3/3           | 700 (682–725)              | 2.5%  |
| erase/DPR2       | xterm WebGL       | 3/3           | 683 (674–744)              | 4.5%  |
| erase/DPR2       | Wraith compatible | 3/3           | 2746 (2746–2761)           | 0.3%  |
| erase/DPR2       | Wraith native     | 3/3           | 2240 (2131–2384)           | 4.6%  |
| links/DPR2       | xterm DOM         | 3/3           | 2717 (1280–2794)           | 30.8% |
| links/DPR2       | xterm WebGL       | 3/3           | 1231 (1197–2112)           | 28.0% |
| links/DPR2       | Wraith compatible | 3/3           | 2583 (2069–4402)           | 33.2% |
| links/DPR2       | Wraith native     | 3/3           | 3290 (1535–3444)           | 31.4% |
| complex/DPR2     | xterm DOM         | 3/3           | 120 (111–122)              | 3.9%  |
| complex/DPR2     | xterm WebGL       | 3/3           | 480 (446–577)              | 11.1% |
| complex/DPR2     | Wraith compatible | 3/3           | 1953 (1895–1974)           | 1.7%  |
| complex/DPR2     | Wraith native     | 3/3           | 2055 (1996–2190)           | 3.9%  |
| churn/DPR2       | xterm DOM         | 3/3           | 104 (103–107)              | 1.3%  |
| churn/DPR2       | xterm WebGL       | 3/3           | 503 (401–522)              | 11.1% |
| churn/DPR2       | Wraith compatible | 3/3           | 2074 (2064–2092)           | 0.6%  |
| churn/DPR2       | Wraith native     | 3/3           | 1869 (1844–1886)           | 0.9%  |
| append/DPR2      | xterm DOM         | 3/3           | 750 (674–785)              | 6.2%  |
| append/DPR2      | xterm WebGL       | 3/3           | 1498 (831–1636)            | 26.6% |
| append/DPR2      | Wraith compatible | 3/3           | 5074 (4995–5246)           | 2.1%  |
| append/DPR2      | Wraith native     | 3/3           | 5367 (5182–5429)           | 2.0%  |
| showcase/DPR2    | xterm DOM         | 3/3           | 148 (142–153)              | 3.2%  |
| showcase/DPR2    | xterm WebGL       | 3/3           | 927 (915–976)              | 2.8%  |
| showcase/DPR2    | Wraith compatible | 3/3           | 2700 (2151–2762)           | 10.8% |
| showcase/DPR2    | Wraith native     | 3/3           | 2556 (2501–2572)           | 1.2%  |
| pipes/DPR2       | xterm DOM         | 3/3           | 51 (47–65)                 | 14.4% |
| pipes/DPR2       | xterm WebGL       | 0/3           | excluded                   | —     |
| pipes/DPR2       | Wraith compatible | 3/3           | 681 (630–775)              | 8.6%  |
| pipes/DPR2       | Wraith native     | 3/3           | 753 (752–769)              | 1.0%  |

</details>

### Excluded runs

- unicode/DPR1, Wraith native, repetition 1: native CJK/emoji glyph coverage unverified
- unicode/DPR1, Wraith native, repetition 2: native CJK/emoji glyph coverage unverified
- unicode/DPR1, Wraith native, repetition 3: native CJK/emoji glyph coverage unverified
- bytewise/DPR1, Wraith native, repetition 1: native CJK/emoji glyph coverage unverified
- bytewise/DPR1, Wraith native, repetition 2: native CJK/emoji glyph coverage unverified
- bytewise/DPR1, Wraith native, repetition 3: native CJK/emoji glyph coverage unverified
- unicode/DPR2, Wraith native, repetition 1: native CJK/emoji glyph coverage unverified
- unicode/DPR2, Wraith native, repetition 2: native CJK/emoji glyph coverage unverified
- unicode/DPR2, Wraith native, repetition 3: native CJK/emoji glyph coverage unverified
- bytewise/DPR2, Wraith native, repetition 1: native CJK/emoji glyph coverage unverified
- bytewise/DPR2, Wraith native, repetition 2: native CJK/emoji glyph coverage unverified
- bytewise/DPR2, Wraith native, repetition 3: native CJK/emoji glyph coverage unverified
- pipes/DPR2, xterm WebGL, repetition 1: 1666/16000 checked pixels differ
- pipes/DPR2, xterm WebGL, repetition 2: 1666/16000 checked pixels differ
- pipes/DPR2, xterm WebGL, repetition 3: 1803/16000 checked pixels differ

### Public SDK typing

Median of per-run p95 values, in milliseconds. Each renderer/load has 180 actual key events. Render notification observes submission, and the following rAF observes a scheduling opportunity; neither measures scanout. Worker notifications and xterm scheduler notifications have different delivery paths.

| Renderer          | Load  | Key → input | Parse ack | Render notification | Following rAF | Acknowledged flood |
| ----------------- | ----- | ----------- | --------- | ------------------- | ------------- | ------------------ |
| xterm DOM         | idle  | 0.10        | 0.20      | 32.30               | 65.60         | —                  |
| xterm DOM         | flood | 0.10        | 6.80      | 31.70               | 64.40         | 3.06 MiB/s         |
| xterm WebGL       | idle  | 0.10        | 0.30      | 32.40               | 65.50         | —                  |
| xterm WebGL       | flood | 0.10        | 6.80      | 32.70               | 65.70         | 3.16 MiB/s         |
| Wraith compatible | idle  | 0.10        | 0.20      | 32.50               | 65.60         | —                  |
| Wraith compatible | flood | 0.10        | 7.20      | 32.00               | 65.10         | 3.21 MiB/s         |
| Wraith native     | idle  | 0.30        | 0.50      | 15.60               | 32.20         | —                  |
| Wraith native     | flood | 0.30        | 0.50      | 15.60               | 31.90         | 3.81 MiB/s         |

### Public SDK operations

Median of per-run medians (ms), except pastes, which have one sample per size per run. Search is cold searches of 9,000 lines. Native search/selection includes worker IPC. Native search completes a full match count, whereas this undecorated xterm findNext call may stop at the next match; the search columns are public API response times for different amounts of work. API and completed resize are separate. Completed resize includes settling and is not a CPU-only speed metric.

| Renderer          | Search | Select history | Resize API | Resize complete | 64 KiB paste parse | 1 MiB paste parse |
| ----------------- | ------ | -------------- | ---------- | --------------- | ------------------ | ----------------- |
| xterm DOM         | 0.90   | 6.10           | 0.30       | 66.60           | 5.40               | 31.90             |
| xterm WebGL       | 0.70   | 3.80           | 2.00       | 66.50           | 4.10               | 31.90             |
| Wraith compatible | 0.90   | 6.10           | 0.30       | 66.60           | 5.10               | 43.20             |
| Wraith native     | 82.80  | 3.10           | 0.20       | 1.30            | 0.50               | 4.40              |

### Eight-terminal sustained sessions

One 60-second observation per renderer. Target 30 batches/s. The harness waits for completion between batches. Compare CPU efficiency only when achieved rates match; the 30-batch/s study did not meet that condition. 100% core means one logical CPU; machine capacity divides by 18. Heap/RSS columns show before / loaded / disposed, MiB. Main-page JS excludes worker heaps and most Wasm/GPU memory; summed RSS can count shared mappings more than once. GPU is device-wide idle / loaded range, includes other apps, and cannot be attributed to Wraith.

| Renderer          | MiB/s | Batches/s | CPU core | CPU machine | JS heap MiB      | Chrome RSS MiB         | Device GPU idle / load |
| ----------------- | ----- | --------- | -------- | ----------- | ---------------- | ---------------------- | ---------------------- |
| xterm DOM         | 0.56  | 14.1      | 20.5%    | 1.14%       | 4.6 / 28.6 / 5.9 | 901.8 / 975.3 / 875.0  | 11–11 / 0–26%          |
| xterm WebGL       | 0.57  | 14.4      | 17.8%    | 0.99%       | 5.7 / 40.6 / 6.4 | 942.0 / 993.7 / 913.0  | 28–28 / 0–33%          |
| Wraith compatible | 0.58  | 14.6      | 34.6%    | 1.92%       | 5.2 / 25.9 / 6.5 | 950.8 / 1015.0 / 947.0 | 14–14 / 15–27%         |
| Wraith native     | 1.19  | 30.0      | 57.1%    | 3.17%       | 3.4 / 11.0 / 3.4 | 857.3 / 1065.8 / 953.2 | 21–21 / 19–51%         |

## docs/benchmarks/workflows/stress

Source: `dfd876aabc2165ce50b5a851bd9468e478ca334a`. Apple M5 Max, 18 logical CPUs, 48 GiB RAM, darwin 27.2.0. Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36. xterm 6.0.0, WebGL addon 0.19.0. Configured throughput grid 240×80, 3 repetitions. 72 completed run sets; 0 harness errors.

[Raw data](stress/runs.json) · [CSV](stress/summary.csv)

### Valid completed logical updates/s

A ratio is shown only when every configured repetition passed its checks and both renderers have a coefficient of variation at most 15%. A dagger marks higher variation; inspect the detailed ranges before drawing conclusions. DOM layout timing has no GPU-completion fence and is retained separately in the detailed table. Native Unicode and bytewise fixtures contain CJK/emoji and are excluded until font coverage is certified.

| Workload / scale | xterm WebGL | Compatible | Native   | Compatible / WebGL | Native / WebGL |
| ---------------- | ----------- | ---------- | -------- | ------------------ | -------------- |
| complex/DPR1     | 84          | 395        | 426      | 4.72×              | 5.09×          |
| churn/DPR1       | 102         | 424        | 265†     | 4.16×              | noisy          |
| pipes/DPR1       | 104         | 230        | 139      | 2.21×              | 1.33×          |
| editor/DPR1      | 801         | 1437       | 1045     | 1.79×              | 1.30×          |
| build-log/DPR1   | 795         | 2028       | 1632     | 2.55×              | 2.05×          |
| unicode/DPR1     | 301         | 752        | excluded | 2.50×              | excluded       |

<details>
<summary>All repetitions, ranges and variability</summary>

| Workload / scale | Renderer          | Valid / total | Median (min–max) updates/s | CV    |
| ---------------- | ----------------- | ------------- | -------------------------- | ----- |
| complex/DPR1     | xterm DOM         | 3/3           | 26 (25–26)                 | 2.8%  |
| complex/DPR1     | xterm WebGL       | 3/3           | 84 (81–89)                 | 3.9%  |
| complex/DPR1     | Wraith compatible | 3/3           | 395 (383–446)              | 6.7%  |
| complex/DPR1     | Wraith native     | 3/3           | 426 (405–474)              | 6.6%  |
| churn/DPR1       | xterm DOM         | 3/3           | 19 (19–24)                 | 10.5% |
| churn/DPR1       | xterm WebGL       | 3/3           | 102 (76–103)               | 13.2% |
| churn/DPR1       | Wraith compatible | 3/3           | 424 (368–438)              | 7.3%  |
| churn/DPR1       | Wraith native     | 3/3           | 265 (103–274)              | 36.9% |
| pipes/DPR1       | xterm DOM         | 3/3           | 18 (17–18)                 | 0.5%  |
| pipes/DPR1       | xterm WebGL       | 3/3           | 104 (97–107)               | 3.8%  |
| pipes/DPR1       | Wraith compatible | 3/3           | 230 (226–230)              | 0.9%  |
| pipes/DPR1       | Wraith native     | 3/3           | 139 (132–141)              | 2.8%  |
| editor/DPR1      | xterm DOM         | 3/3           | 234 (233–243)              | 2.0%  |
| editor/DPR1      | xterm WebGL       | 3/3           | 801 (791–814)              | 1.2%  |
| editor/DPR1      | Wraith compatible | 3/3           | 1437 (1430–1550)           | 3.7%  |
| editor/DPR1      | Wraith native     | 3/3           | 1045 (1043–1054)           | 0.5%  |
| build-log/DPR1   | xterm DOM         | 3/3           | 362 (361–370)              | 1.2%  |
| build-log/DPR1   | xterm WebGL       | 3/3           | 795 (766–806)              | 2.2%  |
| build-log/DPR1   | Wraith compatible | 3/3           | 2028 (2005–2058)           | 1.1%  |
| build-log/DPR1   | Wraith native     | 3/3           | 1632 (1590–1662)           | 1.8%  |
| unicode/DPR1     | xterm DOM         | 3/3           | 21 (20–21)                 | 1.6%  |
| unicode/DPR1     | xterm WebGL       | 3/3           | 301 (299–301)              | 0.3%  |
| unicode/DPR1     | Wraith compatible | 3/3           | 752 (735–758)              | 1.3%  |
| unicode/DPR1     | Wraith native     | 0/3           | excluded                   | —     |

</details>

### Excluded runs

- unicode/DPR1, Wraith native, repetition 1: native CJK/emoji glyph coverage unverified
- unicode/DPR1, Wraith native, repetition 2: native CJK/emoji glyph coverage unverified
- unicode/DPR1, Wraith native, repetition 3: native CJK/emoji glyph coverage unverified

## docs/benchmarks/workflows/equal-rate

Source: `dfd876aabc2165ce50b5a851bd9468e478ca334a`. Apple M5 Max, 18 logical CPUs, 48 GiB RAM, darwin 27.2.0. Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36. xterm 6.0.0, WebGL addon 0.19.0. Configured throughput grid 160×50, 1 repetitions. 4 completed run sets; 0 harness errors.

[Raw data](equal-rate/runs.json) · [CSV](equal-rate/summary.csv)

### Eight-terminal sustained sessions

One 30-second observation per renderer. Target 12 batches/s. The harness waits for completion between batches. Compare CPU efficiency only when achieved rates match; the 30-batch/s study did not meet that condition. 100% core means one logical CPU; machine capacity divides by 18. Heap/RSS columns show before / loaded / disposed, MiB. Main-page JS excludes worker heaps and most Wasm/GPU memory; summed RSS can count shared mappings more than once. GPU is device-wide idle / loaded range, includes other apps, and cannot be attributed to Wraith.

| Renderer          | MiB/s | Batches/s | CPU core | CPU machine | JS heap MiB      | Chrome RSS MiB          | Device GPU idle / load |
| ----------------- | ----- | --------- | -------- | ----------- | ---------------- | ----------------------- | ---------------------- |
| xterm DOM         | 0.47  | 12.0      | 19.8%    | 1.10%       | 4.7 / 28.9 / 5.9 | 1042.6 / 1117.0 / 980.7 | 42–42 / 34–43%         |
| xterm WebGL       | 0.47  | 12.0      | 22.7%    | 1.26%       | 5.6 / 46.1 / 6.5 | 1031.0 / 1027.3 / 980.0 | 35–35 / 0–39%          |
| Wraith compatible | 0.47  | 12.0      | 34.0%    | 1.89%       | 5.2 / 38.1 / 6.6 | 1028.0 / 1076.3 / 997.7 | 35–35 / 33–41%         |
| Wraith native     | 0.47  | 12.0      | 29.3%    | 1.63%       | 3.4 / 3.6 / 3.4  | 943.8 / 1040.3 / 947.0  | 0–0 / 32–39%           |
