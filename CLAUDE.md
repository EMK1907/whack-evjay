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
- src/scenes/: one file per scene: conveyor, inverted, quirkland, ending (game order). The conveyor exits straight
  into the inverted scene — there is no separate fall scene (src/scenes/fall.js is unused; goTo('fall') redirects to 'inverted').
  Each exports default { name, init(ctx), update(dt), dispose() }.
  ctx = { scene, camera, player, interact, dialogue, effects, audio, goTo(name), post, setEnvironment(url), assets }.
  A scene ends by calling ctx.goTo('<next scene>'). Optional transition: ctx.goTo(name, { fadeColor: '#fff', fadeOutMs: 300, fadeInMs: 400 })
  — defaults are black, 400 ms out, 400 ms in; the next scene fades in from the same colour.

## Rendering, lighting & assets (src/main.js — use these, don't build your own)
- Pipeline: ACES filmic tone mapping + sRGB output, PCF soft shadows, then post: SSAO → bloom → vignette → SMAA.
  Shadows are opt-in per object: `light.castShadow = true`, `mesh.castShadow = mesh.receiveShadow = true`.
- `ctx.post` — per-scene post settings, reset to defaults on every scene change. Set in `init()` (or animate in `update()`):
  `ctx.post.set({ bloomStrength: 0.35, bloomRadius: 0.4, bloomThreshold: 0.85, ssao: true, ssaoRadius: 0.5, vignette: 0.35, exposure: 1 })`
  (those are the defaults; single props work too: `ctx.post.ssao = false`). Dark scenes usually need `exposure` > 1 under ACES.
  SSAO skips transparent materials, sprites, points and lines; opt other objects out with `mesh.userData.noSSAO = true`.
- `await ctx.setEnvironment('assets/hdri/name.hdr', { background: false, blurriness: 0 })` — loads an .hdr (RGBELoader + PMREM),
  sets `scene.environment` (image-based lighting for all PBR materials) and optionally the background. Cached across scenes.
- `await ctx.assets.gltf('assets/models/x.glb', { shadows: true })` — GLTFLoader with Draco + Meshopt; returns the gltf
  (`gltf.scene`, `gltf.animations`); meshes cast/receive shadows unless `shadows: false`.
- `await ctx.assets.textures('assets/textures/brick', { ext: 'jpg', repeat: 4 })` — loads `color`, `normal`, `roughness`, `ao`
  files from that folder (missing ones are skipped) with correct colour spaces, repeat wrapping and anisotropy. Returns
  `{ map, normalMap, roughnessMap, aoMap }` → `new THREE.MeshStandardMaterial({ ...tex })`.
- Put assets under `assets/` (hdri/, models/, textures/). Keep files small (1k–2k HDRIs, compressed .glb).
- Custom `ShaderMaterial`s render into a linear HDR buffer: output linear colour (e.g. `pow(srgbColour, vec3(2.2))`),
  not display-space colour, or they'll look washed out.
- Quality: `?quality=low|medium|high` forces a preset (default medium; auto-drops a level if fps < 45).
  With `?debug`, press Q to cycle quality (remembered); `window.game` exposes post, assets, setEnvironment, setQuality.

## Ownership — only edit files you own
- Emir: src/main.js, src/core/player.js, src/core/interact.js, src/core/audio.js, src/scenes/inverted.js
- Varshan: src/core/dialogue.js, src/scenes/quirkland.js, src/scenes/ending.js (+ assets/audio/voice.*)
- Joshua: src/core/effects.js, src/scenes/conveyor.js
- Need a change in someone else's file? Stop and tell the user instead of editing it.

## Git
- Work on your own branch (emir/..., varshan/...). Small commits. Never commit .env or secrets.
- main must always run without errors.
