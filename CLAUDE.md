# Loop — WHACK 2026 (theme: New Worlds)
First-person 3D browser game in Three.js. Full spec: docs/GAME.md — follow it exactly, never change the story.

## Tech
- Plain ES modules, Three.js from CDN via import map in index.html. No build step, no frameworks.
- Run locally: python3 -m http.server 8000 → http://localhost:8000

## Architecture (do not deviate)
- src/main.js: renderer, game loop, scene manager. `?scene=<name>` in the URL jumps to any scene.
- src/core/: shared systems — player.js (WASD, mouse look, SPACE jump, gravity direction + flipGravity()),
  interact.js (E key + "Press E to interact" prompt via raycast), dialogue.js (subtitle box),
  effects.js (red ERROR! bubble-text glitch, fades), audio.js
- src/scenes/: one file per scene: conveyor, fall, inverted, quirkland, ending.
  Each exports default { name, init(ctx), update(dt), dispose() }.
  ctx = { scene, camera, player, interact, dialogue, effects, audio, goTo(name) }.
  A scene ends by calling ctx.goTo('<next scene>').

## Ownership — only edit files you own
- Emir: src/main.js, src/core/player.js, src/core/interact.js, src/scenes/inverted.js
- Varshan: src/core/dialogue.js, src/scenes/quirkland.js
- Joshua: src/core/effects.js, src/scenes/conveyor.js, fall.js, ending.js
- Need a change in someone else's file? Stop and tell the user instead of editing it.

## Git
- Work on your own branch (emir/..., varshan/...). Small commits. Never commit .env or secrets.
- main must always run without errors.
