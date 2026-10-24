# Workspace scene

A realistic developer workspace in one 200×60 terminal, laid out like tmux: an AI
coding-agent session, a live latency chart sent as a PNG via Kitty graphics every
frame, a live 640×360 preview of the site streamed as Kitty RGBA, an htop-style
table and a test runner. Frames are built in the page (`work-scene.js`) before timing.

Kitty graphics need the `feat/kitty-graphics` engine (#26): run these with that
branch's SDK built (`npm run build:sdk`) and the demo server on 5199.

```sh
node video/capture/work-scene/site-shot.mjs        # preview input: .cache/scene/site.png
SCENE=video/capture/work-scene/work-scene.js ROUNDS=5 \
  node video/capture/work-scene/scene-bench.mjs    # headed; uses the real display rate
node video/capture/work-scene/scene-stills.mjs     # 60 fps footage of Wraith's own frames
```
