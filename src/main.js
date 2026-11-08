import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

import { Player } from './core/player.js';
import { Interact } from './core/interact.js';
import { Dialogue } from './core/dialogue.js';
import { Effects } from './core/effects.js';
import { AudioManager } from './core/audio.js';

import menu from './scenes/menu.js';
import conveyor from './scenes/conveyor.js';
import inverted from './scenes/inverted.js';
import quirkland from './scenes/quirkland.js';
import ending from './scenes/ending.js';

// Game flow. The conveyor exits straight into the inverted world (src/scenes/fall.js is kept but unused).
const ORDER = [menu, conveyor, inverted, quirkland, ending];
const SCENES = Object.fromEntries(ORDER.map((s) => [s.name, s]));
// Retired scene names still requested by older scene code → where they go now.
const REDIRECTS = { fall: 'inverted' };
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } },
};

// ---------- renderer / camera ----------
// Post-processing does the anti-aliasing (SMAA), so the default framebuffer needs no MSAA.
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const FOV = 75;
const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.05, 5000);

// ---------- scene manager state ----------
let current = null;
let currentScene = new THREE.Scene();
let transitioning = false;

// ---------- quality presets ----------
// pixelRatio caps devicePixelRatio; ssaoScale renders SSAO at a fraction of the frame size.
const QUALITY = {
  low: { pixelRatio: 1, ssao: false, ssaoScale: 0.5, smaa: false },
  medium: { pixelRatio: 1.25, ssao: true, ssaoScale: 0.5, smaa: true },
  high: { pixelRatio: 2, ssao: true, ssaoScale: 1, smaa: true },
};
const LEVELS = ['low', 'medium', 'high'];
const forced = params.get('quality');
let quality = QUALITY[forced] ? forced : QUALITY[store.get('loop.quality')] ? store.get('loop.quality') : 'medium';
// Auto-downgrade when frames are slow, unless the quality was chosen explicitly.
let autoQuality = !QUALITY[forced] && !QUALITY[store.get('loop.quality')];

// ---------- post-processing ----------
// RenderPass (HDR, linear) → SSAO → bloom → OutputPass (ACES + sRGB) → vignette → SMAA.
const VignetteShader = {
  uniforms: { tDiffuse: { value: null }, darkness: { value: 0.35 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float darkness;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float d = length(vUv - 0.5) * 1.4142;
      c.rgb *= 1.0 - darkness * smoothstep(0.45, 1.0, d);
      gl_FragColor = c;
    }`,
};

const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(currentScene, camera);
const ssaoPass = new SSAOPass(currentScene, camera, window.innerWidth, window.innerHeight);
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.35, 0.4, 0.85);
const outputPass = new OutputPass();
const vignettePass = new ShaderPass(VignetteShader);
const smaaPass = new SMAAPass(window.innerWidth, window.innerHeight);
for (const pass of [renderPass, ssaoPass, bloomPass, outputPass, vignettePass, smaaPass]) composer.addPass(pass);

// SSAO at a fraction of the resolution (blurred + upsampled when composited).
const ssaoSetSize = ssaoPass.setSize.bind(ssaoPass);
ssaoPass.setSize = (w, h) => {
  const k = QUALITY[quality].ssaoScale;
  ssaoSetSize(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
};
// Keep transparent shells, sprites, particles and opted-out objects out of the AO depth/normal pass.
ssaoPass.overrideVisibility = function overrideVisibility() {
  const cache = this._visibilityCache;
  this.scene.traverse((o) => {
    cache.set(o, o.visible);
    const m = o.material;
    const transparent = Array.isArray(m) ? m.some((x) => x.transparent) : m?.transparent;
    if (o.isPoints || o.isLine || o.isSprite || transparent || o.userData.noSSAO) o.visible = false;
  });
};

// Distances in metres for SSAO (the pass itself wants fractions of camera far − near).
const SSAO_MIN_M = 0.004;
const SSAO_MAX_M = 0.6;
function syncSSAOCamera() {
  const range = camera.far - camera.near;
  ssaoPass.minDistance = SSAO_MIN_M / range;
  ssaoPass.maxDistance = SSAO_MAX_M / range;
  // SSAOPass only copies these on resize; cutscenes change fov, so refresh every frame.
  const u = ssaoPass.ssaoMaterial.uniforms;
  u.cameraProjectionMatrix.value.copy(camera.projectionMatrix);
  u.cameraInverseProjectionMatrix.value.copy(camera.projectionMatrixInverse);
  u.cameraNear.value = camera.near;
  u.cameraFar.value = camera.far;
}

// ---------- ctx.post: per-scene post-processing controls (reset on every goTo) ----------
const POST_DEFAULTS = {
  bloomStrength: 0.35,   // UnrealBloom strength
  bloomRadius: 0.4,      // 0..1 spread
  bloomThreshold: 0.85,  // HDR luminance above which pixels bloom
  ssao: true,            // ambient occlusion on/off (also off on the 'low' quality preset)
  ssaoRadius: 0.5,       // AO sample radius in metres
  vignette: 0.35,        // 0 = none, 1 = strong
  exposure: 1,           // tone-mapping exposure
};
const postState = { ...POST_DEFAULTS };
function applyPost() {
  bloomPass.strength = postState.bloomStrength;
  bloomPass.radius = postState.bloomRadius;
  bloomPass.threshold = postState.bloomThreshold;
  ssaoPass.enabled = postState.ssao && QUALITY[quality].ssao;
  ssaoPass.kernelRadius = postState.ssaoRadius;
  vignettePass.uniforms.darkness.value = postState.vignette;
  vignettePass.enabled = postState.vignette > 0;
  renderer.toneMappingExposure = postState.exposure;
  smaaPass.enabled = QUALITY[quality].smaa;
}
const post = {
  /** Set several values at once: ctx.post.set({ bloomStrength: 0.8, ssao: false }). */
  set(values) { Object.assign(postState, values); applyPost(); return post; },
  reset() { Object.assign(postState, POST_DEFAULTS); applyPost(); return post; },
  get quality() { return quality; },
};
for (const key of Object.keys(POST_DEFAULTS)) {
  Object.defineProperty(post, key, {
    get: () => postState[key],
    set: (v) => { postState[key] = v; applyPost(); },
    enumerable: true,
  });
}

// ---------- resize / quality ----------
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  const pr = Math.min(window.devicePixelRatio || 1, QUALITY[quality].pixelRatio);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h);
  composer.setPixelRatio(pr);
  composer.setSize(w, h);
}
window.addEventListener('resize', resize);

function setQuality(level, { remember = true } = {}) {
  if (!QUALITY[level]) return;
  quality = level;
  if (remember) { store.set('loop.quality', level); autoQuality = false; }
  resize();
  applyPost();
  updateHud();
}

resize();
applyPost();

// ---------- ctx.setEnvironment: HDRI image-based lighting ----------
const pmrem = new THREE.PMREMGenerator(renderer);
const envCache = new Map(); // url -> Promise<{ equirect, envMap }>
function loadEnvironment(url) {
  if (!envCache.has(url)) {
    envCache.set(url, new RGBELoader().loadAsync(url).then((equirect) => {
      equirect.mapping = THREE.EquirectangularReflectionMapping;
      return { equirect, envMap: pmrem.fromEquirectangular(equirect).texture };
    }).catch((e) => {
      envCache.delete(url);
      throw e;
    }));
  }
  return envCache.get(url);
}
/** Bound to one scene, so a load that finishes after a scene change doesn't touch the next scene. */
const environmentSetter = (scene) => async (url, { background = false, blurriness = 0 } = {}) => {
  const env = await loadEnvironment(url);
  if (scene !== currentScene) return env.envMap;
  scene.environment = env.envMap;
  if (background) {
    scene.background = env.equirect;
    scene.backgroundBlurriness = blurriness;
  }
  return env.envMap;
};

// ---------- ctx.assets: shared loaders ----------
const draco = new DRACOLoader().setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/');
const gltfLoader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
const textureLoader = new THREE.TextureLoader();
const PBR_FILES = { map: 'color', normalMap: 'normal', roughnessMap: 'roughness', aoMap: 'ao' };
const assets = {
  /** Load a .glb/.gltf (Draco + Meshopt supported). Meshes cast/receive shadows unless shadows: false. */
  async gltf(url, { shadows = true } = {}) {
    const gltf = await gltfLoader.loadAsync(url);
    if (shadows) gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return gltf;
  },
  /**
   * Load a PBR texture set from a folder: color, normal, roughness, ao (missing files are skipped).
   * Returns { map, normalMap, roughnessMap, aoMap } ready to spread into MeshStandardMaterial.
   */
  async textures(basePath, { ext = 'jpg', repeat = 1, names = {} } = {}) {
    const files = { ...PBR_FILES, ...names };
    const [rx, ry] = Array.isArray(repeat) ? repeat : [repeat, repeat];
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    const loaded = await Promise.all(Object.entries(files).map(async ([slot, name]) => {
      const url = `${basePath.replace(/\/$/, '')}/${name}.${ext}`;
      try {
        const t = await textureLoader.loadAsync(url);
        t.colorSpace = slot === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace; // data maps stay linear
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(rx, ry);
        t.anisotropy = maxAniso;
        return [slot, t];
      } catch {
        console.warn(`assets.textures: missing ${url}`);
        return null;
      }
    }));
    return Object.fromEntries(loaded.filter(Boolean));
  },
};

// ---------- shared systems ----------
const player = new Player(camera, canvas);
const dialogue = new Dialogue();
const effects = new Effects(canvas);
const audio = new AudioManager();
const interact = new Interact(camera, {
  isBlocked: () => dialogue.active || transitioning,
  getOccluders: () => player.colliders,
});

/**
 * Switch scene. Options: fadeColor (CSS colour of the transition, default black), fadeOutMs / fadeInMs
 * (default 400 each). E.g. ctx.goTo('quirkland', { fadeColor: '#fff', fadeOutMs: 300 }) for a white flash.
 */
async function goTo(name, { fadeColor = '#000', fadeOutMs = 400, fadeInMs = 400 } = {}) {
  if (REDIRECTS[name]) name = REDIRECTS[name];
  if (!SCENES[name]) {
    console.error(`goTo: unknown scene "${name}". Valid: ${Object.keys(SCENES).join(', ')}`);
    return;
  }
  if (transitioning) return;
  transitioning = true;
  try {
    if (current) {
      await effects.fadeOut(fadeOutMs, fadeColor);
      try { current.dispose?.(); } catch (e) { console.error(e); }
    }
    current = null;
    disposeScene(currentScene);

    player.reset();
    player.hideCrosshair = false; // a scene can hide it for its own cutscene (e.g. the conveyor intro)
    interact.clear();
    dialogue.clear();
    effects.clear();
    audio.stopAll();
    post.reset();
    camera.fov = FOV;
    camera.updateProjectionMatrix();
    camera.up.set(0, 1, 0);

    currentScene = new THREE.Scene();
    renderPass.scene = currentScene;
    ssaoPass.scene = currentScene;
    const ctx = {
      scene: currentScene, camera, player, interact, dialogue, effects, audio, goTo,
      post, assets, setEnvironment: environmentSetter(currentScene),
    };
    const next = SCENES[name];
    await next.init(ctx);
    current = next;
  } catch (e) {
    console.error(`goTo("${name}") failed`, e);
  } finally {
    transitioning = false;
    perf.settle = 1; // don't judge performance on the frames around a scene change
  }
  effects.fadeIn(fadeInMs); // fades in from whatever colour we faded out to
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
  scene.clear(); // scene.environment/background (HDRIs) are cached and shared, so not disposed
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

// ---------- performance tracking / auto quality ----------
const perf = { frames: 0, time: 0, fps: 0, settle: 1 };
function trackPerf(rawDt) {
  perf.frames++;
  perf.time += rawDt;
  if (perf.time < 2) return;
  perf.fps = perf.frames / perf.time;
  perf.frames = 0;
  perf.time = 0;
  if (perf.settle > 0) {
    perf.settle--;
  } else if (autoQuality && !transitioning && perf.fps < 45 && quality !== 'low') {
    const lower = LEVELS[LEVELS.indexOf(quality) - 1];
    console.info(`Loop: ${perf.fps.toFixed(0)} fps — lowering quality ${quality} → ${lower}`);
    setQuality(lower, { remember: false });
    perf.settle = 1;
  }
  updateHud();
}

// ---------- debug: ?debug → G flips gravity, N next scene, Q cycles quality ----------
let hud = null;
function updateHud() {
  if (!hud) return;
  hud.textContent = `quality: ${quality}${autoQuality ? ' (auto)' : ''} · Q to change · ${perf.fps ? perf.fps.toFixed(0) : '…'} fps`;
}
if (DEBUG) {
  hud = document.createElement('div');
  Object.assign(hud.style, {
    position: 'fixed', left: '8px', top: '8px', padding: '4px 8px', borderRadius: '4px', zIndex: '45',
    background: 'rgba(0,0,0,0.55)', color: '#fff', font: '12px ui-monospace, monospace', pointerEvents: 'none',
  });
  document.body.appendChild(hud);
  updateHud();
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyG') player.flipGravity();
    if (e.code === 'KeyN' && current) {
      const i = ORDER.indexOf(current);
      goTo(ORDER[(i + 1) % ORDER.length].name);
    }
    if (e.code === 'KeyQ') setQuality(LEVELS[(LEVELS.indexOf(quality) + 1) % LEVELS.length]);
  });
  window.game = {
    goTo, player, interact, dialogue, effects, audio, camera, renderer, composer, post, assets, setQuality,
    setEnvironment: (...args) => environmentSetter(currentScene)(...args),
    get scene() { return currentScene; },
  };
}

// ---------- game loop ----------
const clock = new THREE.Clock();
const crosshair = document.getElementById('crosshair');
renderer.setAnimationLoop(() => {
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.05);
  try {
    player.update(dt);
    interact.update();
    current?.update?.(dt);
  } catch (e) {
    console.error(e);
  }
  crosshair.style.visibility = player.enabled && !player.hideCrosshair ? 'visible' : 'hidden'; // hidden during cutscenes
  if (ssaoPass.enabled) syncSSAOCamera();
  composer.render(dt);
  trackPerf(rawDt);
});

// ---------- start ----------
const requested = REDIRECTS[params.get('scene')] || params.get('scene');
if (requested && !SCENES[requested]) console.warn(`?scene=${requested} unknown, starting at the menu`);
effects.setFade(1);
goTo(SCENES[requested] ? requested : 'menu');
