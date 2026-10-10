# CPU and GPU utilization: dense terminal scene

Measured 2026-10-10 on the Apple M5 Max machine with 18 logical CPUs, Chrome 155, headless, DPR 1. The same 240×80 scene used in [the speed comparison](REPORT.md) changes all 19,200 cells, with about 4,800 SGR changes and 210 KiB of UTF-8 input per update. Each renderer has 2 repetitions per rate, 8 seconds of load, and 3 seconds of idle sampling before and after. Order rotates between repetitions. Scene text hashes and canvas sizes match; WebGPU/WebGL modes and browser errors are checked.

**CPU percentages measure all processes in the dedicated benchmark Chrome instance. 100% is one fully occupied logical core, so values can exceed 100%.** The machine-capacity column divides that number by 18; it is the share of nominal CPU scheduling capacity, not the OS's overall CPU usage, power or equal-speed core capacity. Measurements include browser rendering, raster and GPU-process CPU work. An unrelated application is excluded from this Chrome CPU total, although shared-machine contention can affect results.

**GPU percentages are whole-device driver counters, including other applications.** The paired idle baseline is substantial and fluctuates. These readings cannot establish Wraith's own GPU utilization or a GPU-efficiency ranking. The GPU-process CPU column in the detailed data is CPU usage, not GPU activity. No per-process GPU percentage is claimed. The nonprivileged counters are Device/Renderer/Tiler Utilization % from IORegistry; the driver's averaging window is undocumented. Privileged powermetrics is unavailable in this session.

The baseline windows stop issuing terminal updates. The DOM renderer still has queued raster work after load: its post-load Chrome CPU remains around 97% in the 30-update/s runs. Those post-load windows are a cooldown observation, not a fully settled DOM baseline. GPU paths have less than 1% mean Chrome CPU in their before/after windows. A zero device-GPU sample in a Wraith 120-target run is retained; the device-counter ranges are in the raw summary. Background activity and counter variability prevent app-specific GPU conclusions.

## Target: 30 logical updates/s

| Renderer                   | Achieved updates/s | Chrome CPU % | Machine CPU capacity % | GPU total % | GPU idle baseline % |
| -------------------------- | -----------------: | -----------: | ---------------------: | ----------: | ------------------: |
| xterm DOM                  |               23.1 |        231.7 |                  12.87 |        91.8 |                76.3 |
| xterm + WebGL              |               30.0 |         29.4 |                   1.63 |        75.8 |                76.0 |
| Wraith compatible Terminal |               30.0 |         22.9 |                   1.27 |        77.4 |                77.8 |
| Wraith libghostty core     |               30.0 |         18.5 |                   1.03 |        78.2 |                79.4 |

Compare achieved rates before interpreting CPU usage as an equal-work comparison. The DOM path can fall below the requested rate; GPU paths are checked by their measured rate rather than assumed to keep up.

## Target: 120 logical updates/s

| Renderer                   | Achieved updates/s | Chrome CPU % | Machine CPU capacity % | GPU total % | GPU idle baseline % |
| -------------------------- | -----------------: | -----------: | ---------------------: | ----------: | ------------------: |
| xterm + WebGL              |               84.7 |         66.9 |                   3.72 |        72.6 |                73.1 |
| Wraith compatible Terminal |              111.6 |         77.1 |                   4.28 |        66.6 |                69.0 |
| Wraith libghostty core     |              119.8 |         61.8 |                   3.43 |        71.0 |                69.6 |

This exercises the raw parsing/rendering pipeline with a manually controlled scheduler. It does **not** certify 120 display FPS or public-API frame pacing. The libghostty core is run directly on the main thread without SDK worker/transport overhead.

The fixed-rate harness uses nested setTimeout calls, which include browser timer delays/clamping and GPU-fence waits. Its achieved rate is the result of the renderer and this scheduler together, not a renderer-only capacity ceiling. The unpaced mode below exercises a different schedule. The sample does not establish consistent 120 Hz presentation for the compatible API.

## Unpaced throughput

| Renderer                   | Achieved updates/s | Chrome CPU % | Machine CPU capacity % | GPU total % | GPU idle baseline % |
| -------------------------- | -----------------: | -----------: | ---------------------: | ----------: | ------------------: |
| xterm DOM                  |               45.4 |        150.8 |                   8.38 |        76.5 |                65.0 |
| xterm + WebGL              |              152.4 |         93.3 |                   5.18 |        71.1 |                72.6 |
| Wraith compatible Terminal |              280.3 |        114.0 |                   6.33 |        76.6 |                69.4 |
| Wraith libghostty core     |              360.6 |        115.0 |                   6.39 |        76.1 |                68.9 |

This mode yields to the browser every 8 updates and waits for GPU completion every 32 updates. DOM painting can coalesce updates. Rates include the sampling harness and browser paint work, so they are separate measurements from the earlier short speed benchmark. Higher CPU usage here can accompany more completed work; it is not by itself a regression.

## CPU detail and variability

| Target  | Renderer                   | Renderer-process CPU % | GPU-process CPU % | CPU range between repetitions % | Aggregate CPU ms/update |
| ------- | -------------------------- | ---------------------: | ----------------: | ------------------------------: | ----------------------: |
| 30      | xterm DOM                  |                  125.6 |             105.9 |                     229.6–233.9 |                  110.19 |
| 30      | xterm + WebGL              |                   25.6 |               3.5 |                       25.9–32.9 |                    9.81 |
| 30      | Wraith compatible Terminal |                   17.6 |               5.2 |                       22.1–23.8 |                    7.65 |
| 30      | Wraith libghostty core     |                   13.1 |               5.2 |                       17.3–19.6 |                    6.16 |
| unpaced | xterm DOM                  |                  126.1 |              24.5 |                     150.4–151.3 |                   33.25 |
| unpaced | xterm + WebGL              |                   90.4 |               2.8 |                       93.1–93.5 |                    6.12 |
| unpaced | Wraith compatible Terminal |                  101.0 |              12.8 |                     113.9–114.1 |                    4.08 |
| unpaced | Wraith libghostty core     |                  100.0 |              14.8 |                     114.0–116.0 |                    3.19 |
| 120     | xterm + WebGL              |                   61.6 |               5.2 |                       65.2–68.6 |                    7.92 |
| 120     | Wraith compatible Terminal |                   62.7 |              14.2 |                       73.5–80.8 |                    6.92 |
| 120     | Wraith libghostty core     |                   47.2 |              14.4 |                       52.5–71.0 |                    5.16 |

Aggregate CPU ms/update sums time across threads/processes and can exceed elapsed latency. Two repetitions on one busy machine are exploratory, not a cross-device or sustained-power guarantee. All observed repetitions remain in the raw report. No idle-baseline subtraction is presented as app-specific GPU usage.

## Reproduce

Start the local demo with npm run dev, then:

```sh
WRAITH_USAGE_MS=8000 WRAITH_IDLE_MS=3000 npm run benchmark:usage
node scripts/summarize-utilization.mjs
```

GPU collection currently requires macOS with exposed IOAccelerator PerformanceStatistics. The command reads counters and launches a separate Chrome instance; it does not need sudo. WRAITH_USAGE_RATES, WRAITH_REPETITIONS, WRAITH_REPORT_DIR and CHROME_PATH configure the runs. The CPU calculation is 100 × delta cumulative process CPU seconds / delta wall seconds, using Chrome's [SystemInfo.getProcessInfo](https://chromedevtools.github.io/devtools-protocol/tot/SystemInfo/#method-getProcessInfo), whose counter includes every thread in a process.

Raw samples and cumulative CPU counters: [utilization.json](utilization.json). Aggregates and ranges: [utilization-summary.json](utilization-summary.json), [utilization-summary.csv](utilization-summary.csv). Wasm SHA-256: 503e77c9985a695c94c413d97598a461689a783582c333c7dd2d4df610506969.
