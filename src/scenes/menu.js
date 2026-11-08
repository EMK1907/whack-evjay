import * as THREE from 'three';
import { buildVoid, VOID_LOOK } from './void.js';

// Main menu (Varshan). The backdrop is the ending's bird's-eye view of the void — every speck a world,
// the icy vortex below — so the game starts where it ends. One button: Play → the conveyor.

const NAME = 'menu';
const FIRST = 'conveyor';

let ctx = null;
let time = 0;
let uniforms = null, world = null, beacon = null, base = null;
let ui = null, startEl = null, leaving = false;

const MENU_CSS = `
.menu { position: fixed; inset: 0; z-index: 30; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 34px; color: #fff; font-family: "Helvetica Neue", system-ui, sans-serif; opacity: 0; transition: opacity 1.2s ease; pointer-events: none; }
.menu.on { opacity: 1; }
.menu.on .menu-play { pointer-events: auto; }
.menu h1 { margin: 0; font-weight: 200; font-size: clamp(56px, 9vw, 132px); letter-spacing: 0.42em; padding-left: 0.42em;
  text-shadow: 0 0 40px rgba(120, 180, 255, 0.45), 0 0 2px rgba(255, 255, 255, 0.6); }
.menu-play { font: 500 15px "Helvetica Neue", system-ui, sans-serif; letter-spacing: 0.5em; padding: 16px 44px 16px 52px; color: #fff;
  background: rgba(8, 16, 32, 0.35); border: 1px solid rgba(255, 255, 255, 0.55); border-radius: 999px; cursor: pointer;
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); transition: background 0.3s, border-color 0.3s, box-shadow 0.3s, transform 0.3s; }
.menu-play:hover { background: rgba(180, 0, 20, 0.35); border-color: #ff3344; box-shadow: 0 0 28px rgba(255, 30, 50, 0.55); transform: scale(1.04); }
.menu-hint { position: absolute; bottom: 28px; font-size: 12px; letter-spacing: 0.18em; opacity: 0.55; }
`;

function radialTex() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(255,255,255,0.45)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function play() {
  if (!ctx || leaving) return;
  leaving = true;
  ctx.audio.unlock?.();
  try { document.getElementById('game')?.requestPointerLock?.()?.catch?.(() => {}); } catch {} // if it fails, the usual 'Click to play' overlay covers it
  ui.classList.remove('on');
  ctx.audio.tone(55, 2.5, { type: 'sine', volume: 0.12 });
  ctx.goTo(FIRST, { fadeOutMs: 900, fadeInMs: 600 });
}

export default {
  name: NAME,

  init(c) {
    ctx = c;
    time = 0; leaving = false;
    const { scene, camera, player } = ctx;
    scene.background = new THREE.Color(0x000000);
    player.enabled = false; // the menu drives the camera
    camera.fov = 58;
    camera.updateProjectionMatrix();
    ctx.post?.set({ exposure: 0.9, bloomStrength: 0.55, bloomRadius: 0.7, bloomThreshold: 1.0, ssao: false, vignette: 0.6 });

    uniforms = { uTime: { value: 0 }, uScale: { value: 700 } };
    world = buildVoid(scene, uniforms);
    base = world.path.getPointAt(1, new THREE.Vector3());
    // The ruby, a small red speck at the centre of it all.
    beacon = new THREE.Sprite(new THREE.SpriteMaterial({
      map: radialTex(), color: new THREE.Color(1, 0.02, 0.05).multiplyScalar(2.5), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    scene.add(beacon);

    // The page's own "Click to play" overlay would sit on top of the menu — hide it while we're here.
    startEl = document.getElementById('start');
    if (startEl) startEl.style.display = 'none';

    ui = document.createElement('div');
    ui.className = 'menu';
    ui.innerHTML = `<style>${MENU_CSS}</style><h1>LOOP</h1><button class="menu-play" type="button">PLAY</button>
      <div class="menu-hint">WASD move · Mouse look · SPACE jump · E interact</div>`;
    ui.querySelector('.menu-play').addEventListener('click', play);
    document.body.appendChild(ui);
    requestAnimationFrame(() => ui?.classList.add('on'));
  },

  update(dt) {
    if (!ctx || !uniforms) return;
    time += dt;
    const { camera } = ctx;
    uniforms.uTime.value = time;
    uniforms.uScale.value = window.innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    world.field.rotation.y = time * 0.0022;
    world.vortex.rotation.z = time * 0.01;
    // A slow, endless drift over the void.
    camera.position.set(base.x + Math.sin(time * 0.05) * 40, base.y + Math.sin(time * 0.037) * 12, base.z + Math.cos(time * 0.043) * 25);
    camera.lookAt(VOID_LOOK);
    beacon.scale.setScalar(camera.position.length() * 0.022);
  },

  dispose() {
    if (startEl) startEl.style.display = '';
    startEl = null;
    ui?.remove();
    ui = null;
    uniforms = world = beacon = base = null;
    ctx = null;
  },
};
