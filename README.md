# Loop

A first-person 3D puzzle game that runs in the browser. Built in 24 hours at WHACK 2026 (University of Warwick) for the theme **"New Worlds"**.

**[Play it here](https://emk1907.github.io/whack-evjay/)**

![Three.js](https://img.shields.io/badge/Three.js-black?logo=three.js) ![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)

## The game

You are trying to get back to the real world. Every time you escape one world, you end up stuck in another, and the loop continues. Each world has one thing that is different from normal. Find it and escape.

Controls: **WASD** move · **Mouse** look · **Space** jump · **E** interact

## How it's built

- Plain ES modules and [Three.js](https://threejs.org/) loaded from a CDN. No build step or framework.
- `src/main.js` runs the renderer, game loop and a scene manager. Each world is its own module in `src/scenes/` with `init`, `update` and `dispose`, so three of us could build scenes in parallel.
- Shared systems live in `src/core/`: player controller (with gravity flipping), interaction raycasts, dialogue, glitch effects and audio.
- Rendering uses ACES tone mapping, soft shadows, and a post-processing chain of SSAO, bloom, vignette and SMAA. Quality drops automatically if the frame rate falls below 45 fps.

## Run it locally

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Add `?scene=<name>` to the URL to jump straight to a scene.

## Team

- **Emir Kandemir** ([@EMK1907](https://github.com/EMK1907)): game loop and scene manager, player controller, interaction system, audio, the conveyor and inverted worlds, Git workflow and deployment
- **Varshan** ([@varshansasikumar73](https://github.com/varshansasikumar73)): dialogue system, Quirkland and the ending
- **Joshua** ([@TsoJoshua](https://github.com/TsoJoshua)): glitch and fade effects

## Ideas for next time

More worlds, each A/B tested for how long players stay, keeping only the best ones.

## Credits

Textures and HDRIs from [Poly Haven](https://polyhaven.com) (CC0). Full list in [assets/CREDITS.md](assets/CREDITS.md).
