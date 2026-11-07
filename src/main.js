import * as THREE from 'three';
import { Player } from './core/player.js';
import { Interact } from './core/interact.js';
import { Dialogue } from './core/dialogue.js';
import { Effects } from './core/effects.js';
import { AudioManager } from './core/audio.js';

import conveyor from './scenes/conveyor.js';
import fall from './scenes/fall.js';
import inverted from './scenes/inverted.js';
import quirkland from './scenes/quirkland.js';
import ending from './scenes/ending.js';

const ORDER = [conveyor, fall, inverted, quirkland, ending];
const SCENES = Object.fromEntries(ORDER.map((s) => [s.name, s]));
const params = new URLSearchParams(location.search);

// ---------- renderer / camera ----------
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const FOV = 75;
const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.05, 5000);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- scene manager state ----------
let current = null;
let currentScene = new THREE.Scene();
let transitioning = false;

// ---------- shared systems ----------
const player = new Player(camera, canvas);
const dialogue = new Dialogue();
const effects = new Effects(canvas);
const audio = new AudioManager();
const interact = new Interact(camera, {
  isBlocked: () => dialogue.active || transitioning,
  getOccluders: () => player.colliders,
});

async function goTo(name) {
  if (!SCENES[name]) {
    console.error(`goTo: unknown scene "${name}". Valid: ${Object.keys(SCENES).join(', ')}`);
    return;
  }
  if (transitioning) return;
  transitioning = true;
  try {
    if (current) {
      await effects.fadeOut(400);
      try { current.dispose?.(); } catch (e) { console.error(e); }
    }
    current = null;
    disposeScene(currentScene);

    player.reset();
    interact.clear();
    dialogue.clear();
    effects.clear();
    audio.stopAll();
    camera.fov = FOV;
    camera.updateProjectionMatrix();
    camera.up.set(0, 1, 0);

    currentScene = new THREE.Scene();
    const ctx = { scene: currentScene, camera, player, interact, dialogue, effects, audio, goTo };
    const next = SCENES[name];
    await next.init(ctx);
    current = next;
  } catch (e) {
    console.error(`goTo("${name}") failed`, e);
  } finally {
    transitioning = false;
  }
  effects.fadeIn(400);
}

function disposeScene(scene) {
  scene.traverse((obj) => {
    obj.geometry?.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      m.dispose();
    }
  });
  scene.clear();
}

// ---------- start overlay / pointer lock ----------
const startEl = document.getElementById('start');
startEl.addEventListener('click', () => {
  audio.unlock();
  canvas.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  startEl.hidden = document.pointerLockElement === canvas;
});

// ---------- debug: ?debug → G flips gravity, N jumps to next scene ----------
if (params.has('debug')) {
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyG') player.flipGravity();
    if (e.code === 'KeyN' && current) {
      const i = ORDER.indexOf(current);
      goTo(ORDER[(i + 1) % ORDER.length].name);
    }
  });
  window.game = { goTo, player, interact, dialogue, effects, audio, camera, get scene() { return currentScene; } };
}

// ---------- game loop ----------
const clock = new THREE.Clock();
const crosshair = document.getElementById('crosshair');
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  try {
    player.update(dt);
    interact.update();
    current?.update?.(dt);
  } catch (e) {
    console.error(e);
  }
  crosshair.style.visibility = player.enabled ? 'visible' : 'hidden'; // hidden during cutscenes
  renderer.render(currentScene, camera);
});

// ---------- start ----------
const requested = params.get('scene');
if (requested && !SCENES[requested]) console.warn(`?scene=${requested} unknown, starting at conveyor`);
effects.setFade(1);
goTo(SCENES[requested] ? requested : 'conveyor');
