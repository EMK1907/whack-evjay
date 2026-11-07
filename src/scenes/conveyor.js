import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EYE_HEIGHT } from '../core/player.js';

// Opening scene (docs/GAME.md §2). Owner: Joshua.
//
// A sterile white processing hall. The player rides a rubber conveyor belt (no walking or jumping,
// mouse look only) behind a queue of live babies that pass one by one through heavy lead-strip
// X-ray curtains. An illuminated sign above the scanner reads BACK TO REAL WORLD. When the player
// reaches the curtains it's their turn and the system malfunctions: the sign glitches to a red
// DLROW, the hall turns red, any baby still on the belt turns to stare, ERROR! everywhere → cut to
// black → goTo('fall').
//
// Rendering: neutral clinical HDRI for image-based light + one shadow-casting key light whose
// frustum follows the player along the belt; PBR texture sets from assets/ (see CREDITS.md). Static
// geometry is merged per material; wall panels, bolts and rollers are instanced. Each baby is an
// invisible skeleton of Object3D joints; every body-part type (heads, eyes, lids, finger segments…)
// is one InstancedMesh shared by all babies, its instance matrices copied from the joints each frame.

const NAME = 'conveyor';
const NEXT = 'fall';

// ---------- layout (metres; the belt carries the player towards -z) ----------
const ROOM_W = 12, ROOM_H = 6, ROOM_BACK = 11, ROOM_FRONT = -30;
const ROOM_L = ROOM_BACK - ROOM_FRONT, ROOM_MID = (ROOM_BACK + ROOM_FRONT) / 2;
const BELT_Y = 0.5;               // top of the belt
const BELT_W = 1.6;
const FRAME_HALF = 0.95;          // side channels of the conveyor frame
const BELT_BACK = 10, BELT_FRONT = -22.6;
const BELT_LEN = BELT_BACK - BELT_FRONT, BELT_MID = (BELT_BACK + BELT_FRONT) / 2;
const BELT_SPEED = 1.4;           // m/s
const BELT_TILE = 0.8;            // metres per repeat of the rubber texture
const ROLLER_R = 0.045, ROLLER_GAP = 0.42;
const CURTAIN_Z = -20;
const CURTAIN2_Z = CURTAIN_Z - 0.9;
const OPENING_W = 2.0, OPENING_TOP = 2.4;
const SCAN_W = 3.2, SCAN_H = 3.0, SCAN_D = 2.7;
const VOID_Z = CURTAIN_Z - 2.3;   // babies vanish into the dark tunnel here
const TRIGGER_Z = CURTAIN_Z + 2.0;
const SPAWN_Z = 7.5;
const SIGN_POS = new THREE.Vector3(0, 3.78, CURTAIN_Z + 0.35);
const SIGN_W = 3.6;

const BABY_SCALE = 1.3;
const BABY_POSES = ['sit', 'lie', 'sit', 'lie', 'sit', 'sit', 'lie'];
const SKIN_TONES = ['#f4cdb4', '#d79e7c', '#8a5a3e', '#efc0a0', '#b97a58', '#f7d6c2', '#6f4430'];
const HAIR_COLORS = ['#3a2618', '#24170f', '#6b4a2c', '#a8845a', '#2e2018'];

const ASSET_ROOT = 'assets';
const HDRI = `${ASSET_ROOT}/hdri/white_studio_05_1k.hdr`;
const POST = { exposure: 0.8, bloomStrength: 0.3, bloomRadius: 0.55, bloomThreshold: 0.92, ssao: true, ssaoRadius: 0.35, vignette: 0.28 };

const TAU = Math.PI * 2;
const V3 = THREE.Vector3;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let ctx = null;
let alive = false;
let phase = 'belt';               // 'belt' → 'error'
let time = 0;
let tickTimer = 0;
let beltZ = SPAWN_Z;              // where the belt has carried the player
let s = null;                     // everything built for this run (see init)
let redT = 0, redTarget = 0;
let lookQ = null;
let camBase = null;

// ---------- helpers ----------

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Matrix from position + rotation (yaw about Y, then pitch about X, then roll about Z) + scale. */
function mat(x, y, z, pitch = 0, yaw = 0, roll = 0, sx = 1, sy = sx, sz = sx) {
  return new THREE.Matrix4().compose(
    new V3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ')),
    new V3(sx, sy, sz),
  );
}

function canvas(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw?.(c.getContext('2d'), w, h);
  return c;
}

function canvasTexture(c, { repeat = [1, 1], clamp = false } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  t.repeat.set(...repeat);
  t.anisotropy = 8;
  return t;
}

/** Box whose UVs tile every [tw, th] metres, so textures keep a real-world scale. */
function boxGeometry(w, h, d, [tw, th] = [1, 1]) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  const faceW = [d, d, w, w, w, w];
  const faceH = [h, h, d, d, h, h];
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, (uv.getX(k) * faceW[f]) / tw, (uv.getY(k) * faceH[f]) / th);
    }
  }
  return geo;
}

/** Collects geometry for one material and merges it into a single mesh (one draw call). */
class Batch {
  constructor(material, { vertexColors = false, cast = true, receive = true } = {}) {
    Object.assign(this, { material, vertexColors, cast, receive, parts: [] });
  }

  add(geometry, matrix, color = null) {
    const g = geometry.clone();
    g.applyMatrix4(matrix);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    const n = g.attributes.position.count;
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
    if (!g.index) g.setIndex([...Array(n).keys()]);
    if (this.vertexColors) {
      const c = color || new THREE.Color(1, 1, 1);
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    }
    this.parts.push(g);
  }

  build(parent) {
    if (!this.parts.length) return null;
    const geo = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.castShadow = this.cast;
    mesh.receiveShadow = this.receive;
    parent.add(mesh);
    return mesh;
  }
}

/** Invisible collision box (visuals are merged meshes; raycasts stay cheap). */
function collider(w, h, d, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial());
  m.position.set(x, y, z);
  m.visible = false;
  ctx.scene.add(m);
  ctx.player.colliders.push(m);
  return m;
}

/** Instanced copies of one geometry. */
function instanced(geo, material, matrices, { cast = true, receive = true, colors = null } = {}) {
  const m = new THREE.InstancedMesh(geo, material, matrices.length);
  matrices.forEach((mx, i) => m.setMatrixAt(i, mx));
  if (colors) colors.forEach((c, i) => m.setColorAt(i, c));
  m.castShadow = cast;
  m.receiveShadow = receive;
  ctx.scene.add(m);
  return m;
}

// ---------- red malfunction tinting ----------

function tint(color, redHex) {
  s.tints.push({ color, base: color.clone(), red: new THREE.Color(redHex) });
}

function applyRed(t) {
  for (const { color, base, red } of s.tints) color.lerpColors(base, red, t);
  // The clinical HDRI keeps everything white; drain it so the red light takes over.
  for (const { m, base } of s.envMats) m.envMapIntensity = base * (1 - 0.85 * t);
  ctx.post?.set({ vignette: POST.vignette + 0.3 * t, bloomStrength: POST.bloomStrength + 0.35 * t });
}

// ---------- textures ----------

async function loadTextures() {
  if (!ctx.assets) return {};
  const load = (folder, repeat) => ctx.assets.textures(`${ASSET_ROOT}/textures/${folder}`, { repeat }).catch(() => ({}));
  const [floor, wall, belt, plate] = await Promise.all([
    load('interior_tiles', [ROOM_W / 2.4, ROOM_L / 2.4]),
    load('white_plaster_02', 1),
    load('rubberized_track', [BELT_W / BELT_TILE, BELT_LEN / BELT_TILE]),
    load('metal_plate', 1),
  ]);
  return { floor, wall, belt, plate };
}

function scuffTexture(rand) {
  const c = canvas(1024, 1024, (g, w, h) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 140; i++) { // faint shoe / trolley scuffs
      const x = rand() * w, y = rand() * h, len = 20 + rand() * 120, a = rand() * TAU;
      g.strokeStyle = `rgba(110,110,115,${0.04 + rand() * 0.08})`;
      g.lineWidth = 1 + rand() * 3;
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + Math.cos(a + 0.4) * len * 0.5, y + Math.sin(a + 0.4) * len * 0.5, x + Math.cos(a) * len, y + Math.sin(a) * len);
      g.stroke();
    }
    for (let i = 0; i < 30; i++) { // soft grime patches
      const x = rand() * w, y = rand() * h, r = 30 + rand() * 90;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(150,150,145,0.07)');
      grad.addColorStop(1, 'rgba(150,150,145,0)');
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
  return canvasTexture(c, { repeat: [ROOM_W / 6, ROOM_L / 6] });
}

function ceilingTexture() {
  const c = canvas(256, 256, (g, w, h) => {
    g.fillStyle = '#f7f8f8';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#c9cdd0';
    g.fillRect(0, 0, w, 3);
    g.fillRect(0, 0, 3, h);
  });
  return canvasTexture(c, { repeat: [1 / 1.2, 1 / 1.2] }); // 1.2 m ceiling tiles (UVs are in metres)
}

function rollerTexture() {
  const c = canvas(256, 16, (g, w, h) => {
    g.fillStyle = '#e6e8ea';
    g.fillRect(0, 0, w, h);
    for (const x of [0, 85, 171]) { g.fillStyle = '#8d9398'; g.fillRect(x, 0, 6, h); }
    g.fillStyle = '#b8bdc1';
    g.fillRect(40, 0, 3, h);
  });
  return canvasTexture(c);
}

/** Hair-cap alpha: dense at the crown, breaking into fine wisps at the edge (v: 1 = crown). */
function hairAlpha(rand) {
  const c = canvas(512, 64, (g, w, h) => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h * 0.4);
    g.strokeStyle = '#fff';
    g.lineWidth = 1.1;
    for (let x = 0; x < w; x += 0.7) {
      const len = h * (0.55 + rand() * 0.45);
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x + (rand() - 0.5) * 6, len);
      g.stroke();
    }
  });
  const t = canvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

function eyeTexture() {
  // Equirectangular: the iris sits at u = 0.25, v = 0.5, which is the +z (front) of a SphereGeometry.
  const c = canvas(512, 256, (g, w, h) => {
    g.fillStyle = '#e4e2e0';
    g.fillRect(0, 0, w, h);
    const cx = w * 0.25, cy = h / 2, r = 66;
    const iris = g.createRadialGradient(cx, cy, 8, cx, cy, r);
    iris.addColorStop(0, '#1d1714');
    iris.addColorStop(0.35, '#3a3c48');
    iris.addColorStop(0.8, '#4b5466');
    iris.addColorStop(1, '#1b1d24');
    g.fillStyle = iris;
    g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(160,170,190,0.35)';
    g.lineWidth = 1;
    for (let i = 0; i < 48; i++) { // iris fibres
      const a = (i / 48) * TAU;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * 20, cy + Math.sin(a) * 20);
      g.lineTo(cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4));
      g.stroke();
    }
    g.fillStyle = '#050505';
    g.beginPath(); g.arc(cx, cy, 27, 0, TAU); g.fill();
  });
  return canvasTexture(c, { clamp: true });
}

/** Atlas of 8 signs/labels, 2 columns × 4 rows of 1024×256. Returns [texture, uvRect(index)]. */
function labelAtlas(rand) {
  const CW = 1024, CH = 256;
  const c = canvas(CW * 2, CH * 4);
  const g = c.getContext('2d');
  const cell = (i, draw) => {
    g.save();
    g.translate((i % 2) * CW, Math.floor(i / 2) * CH);
    g.beginPath();
    g.rect(0, 0, CW, CH);
    g.clip();
    draw();
    for (let k = 0; k < 220; k++) { // wear speckle
      g.fillStyle = `rgba(${rand() < 0.5 ? '255,255,255' : '60,60,60'},${rand() * 0.12})`;
      g.fillRect(rand() * CW, rand() * CH, 1 + rand() * 3, 1 + rand() * 3);
    }
    g.restore();
  };
  const text = (str, x, y, size, color, weight = 800, align = 'center') => {
    g.fillStyle = color;
    g.font = `${weight} ${size}px "Helvetica Neue", Arial, sans-serif`;
    g.textAlign = align;
    g.textBaseline = 'middle';
    g.fillText(str, x, y);
  };
  const trefoil = (cx, cy, r) => {
    g.fillStyle = '#111';
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + (i * TAU) / 3;
      g.beginPath();
      g.moveTo(cx, cy);
      g.arc(cx, cy, r, a - Math.PI / 6, a + Math.PI / 6);
      g.closePath();
      g.fill();
    }
    g.fillStyle = '#ffd200';
    g.beginPath(); g.arc(cx, cy, r * 0.3, 0, TAU); g.fill();
    g.fillStyle = '#111';
    g.beginPath(); g.arc(cx, cy, r * 0.2, 0, TAU); g.fill();
  };
  cell(0, () => { // X-ray caution
    g.fillStyle = '#ffd200'; g.fillRect(0, 0, CW, CH);
    g.fillStyle = '#111'; g.fillRect(14, 14, CW - 28, CH - 28);
    g.fillStyle = '#ffd200'; g.fillRect(24, 24, CW - 48, CH - 48);
    trefoil(140, CH / 2, 82);
    text('CAUTION', 600, 88, 84, '#111', 900);
    text('X-RAY IN USE', 600, 176, 64, '#111', 700);
  });
  cell(1, () => {
    g.fillStyle = '#f6f6f4'; g.fillRect(0, 0, CW, CH);
    g.fillStyle = '#c4161c'; g.fillRect(0, 0, CW, 92);
    text('NO ENTRY', CW / 2, 48, 64, '#fff', 900);
    text('AUTHORISED PERSONNEL ONLY', CW / 2, 172, 56, '#1a1a1a', 800);
  });
  cell(2, () => {
    g.fillStyle = '#123a63'; g.fillRect(0, 0, CW, CH);
    text('LINE 03', 40, 86, 96, '#fff', 900, 'left');
    text('RETURN PROCESSING', 40, 188, 60, '#bcd3ea', 700, 'left');
    g.fillStyle = '#fff'; g.fillRect(CW - 220, 40, 6, CH - 80);
    text('→', CW - 110, CH / 2, 140, '#fff', 400);
  });
  cell(3, () => {
    g.fillStyle = '#ffd200'; g.fillRect(0, 0, CW, CH);
    text('KEEP HANDS CLEAR', CW / 2, 92, 82, '#111', 900);
    text('OF MOVING PARTS', CW / 2, 182, 64, '#111', 700);
  });
  cell(4, () => {
    g.fillStyle = '#c4161c'; g.fillRect(0, 0, CW, CH);
    text('DO NOT STOP THE LINE', CW / 2, CH / 2, 84, '#fff', 900);
  });
  cell(5, () => { // hazard stripes
    g.fillStyle = '#ffd200'; g.fillRect(0, 0, CW, CH);
    g.fillStyle = '#121212';
    for (let x = -CH; x < CW + CH; x += 128) {
      g.beginPath();
      g.moveTo(x, CH); g.lineTo(x + 64, CH); g.lineTo(x + 64 + CH, 0); g.lineTo(x + CH, 0);
      g.closePath(); g.fill();
    }
  });
  cell(6, () => {
    g.fillStyle = '#ffd200'; g.fillRect(0, 0, CW, CH);
    text('EMERGENCY', CW / 2, 90, 92, '#c4161c', 900);
    text('STOP', CW / 2, 186, 92, '#c4161c', 900);
  });
  cell(7, () => {
    g.fillStyle = '#e9ecee'; g.fillRect(0, 0, CW, CH);
    text('AIR EXTRACT', CW / 2, 96, 72, '#30363b', 800);
    text('DO NOT OBSTRUCT', CW / 2, 180, 54, '#5a6268', 700);
  });
  const rect = (i) => [(i % 2) / 2, 1 - (Math.floor(i / 2) + 1) / 4, 1 / 2, 1 / 4];
  return [canvasTexture(c, { clamp: true }), rect];
}

// ---------- materials ----------

function makeMaterials(tex, rand) {
  const envMats = [];
  const track = (m) => { envMats.push({ m, base: m.envMapIntensity }); return m; };
  const std = (o) => track(new THREE.MeshStandardMaterial({ envMapIntensity: 0.6, ...o }));
  const phys = (o) => track(new THREE.MeshPhysicalMaterial({ envMapIntensity: 0.6, ...o }));
  const { floor = {}, wall = {}, belt = {}, plate = {} } = tex;

  const M = {
    envMats,
    floor: std({
      color: 0xd6dadd, map: scuffTexture(rand), normalMap: floor.normalMap, roughnessMap: floor.roughnessMap,
      aoMap: floor.aoMap, roughness: 0.3, metalness: 0, normalScale: new THREE.Vector2(0.6, 0.6), envMapIntensity: 0.45,
    }),
    // Glossy enamelled wall panels: plaster normal/roughness gives the subtle wear and orange-peel.
    panel: std({
      color: 0xf6f7f8, normalMap: wall.normalMap, roughnessMap: wall.roughnessMap, roughness: 0.32,
      normalScale: new THREE.Vector2(0.18, 0.18), envMapIntensity: 0.4,
    }),
    seam: std({ color: 0x4d5257, roughness: 0.7, envMapIntensity: 0.4 }),
    ceiling: std({ color: 0xffffff, map: ceilingTexture(), roughness: 0.6, envMapIntensity: 0.6 }),
    steel: std({ color: 0xd4d8dc, metalness: 1, roughness: 0.3, envMapIntensity: 1.1 }),
    brushed: std({ color: 0xb9bfc5, metalness: 1, roughness: 0.42, envMapIntensity: 1 }),
    paint: std({ color: 0xe9ecee, metalness: 0.1, roughness: 0.38 }),
    machine: std({ color: 0xf2f4f5, metalness: 0.05, roughness: 0.28 }),
    accent: std({ color: 0x8e9ba6, metalness: 0.2, roughness: 0.45 }),
    dark: std({ color: 0x23272b, metalness: 0.4, roughness: 0.5, envMapIntensity: 0.5 }),
    tunnel: std({ color: 0x4a5056, metalness: 0.3, roughness: 0.55, envMapIntensity: 0.4 }),
    rubber: std({ color: 0x191b1d, roughness: 0.8, envMapIntensity: 0.4 }),
    cables: std({ vertexColors: true, roughness: 0.55, envMapIntensity: 0.5 }),
    belt: std({
      color: 0x2b2d30, normalMap: belt.normalMap, roughnessMap: belt.roughnessMap, aoMap: belt.aoMap,
      roughness: 0.85, normalScale: new THREE.Vector2(0.8, 0.8), envMapIntensity: 0.5,
    }),
    roller: std({ color: 0xffffff, map: rollerTexture(), metalness: 1, roughness: 0.28, envMapIntensity: 1.1 }),
    plate: std({
      color: 0xc3c8cd, normalMap: plate.normalMap, roughnessMap: plate.roughnessMap, metalness: 0.9, roughness: 0.5,
    }),
    glass: std({ color: 0xe6f3ff, transparent: true, opacity: 0.1, roughness: 0.04, depthWrite: false, envMapIntensity: 1.4 }),
    window: std({ color: 0x07090b, metalness: 0.6, roughness: 0.04, envMapIntensity: 1.2 }),
    void: new THREE.MeshBasicMaterial({ color: 0x000000 }),
    // Recessed ceiling light diffusers: emissive above the bloom threshold.
    diffuser: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf1f6ff, emissiveIntensity: 3.2, roughness: 1 }),
    // Heavy leaded-vinyl X-ray strips: amber-grey, translucent, slightly glossy.
    curtain: std({
      color: 0x77705f, transparent: true, opacity: 0.66, roughness: 0.16, side: THREE.DoubleSide, depthWrite: false,
      envMapIntensity: 1.6,
    }),
  };

  // Babies. Skin: sheen for the soft velvety rim, a little warm emissive so shadows never go grey.
  M.skin = phys({
    color: 0xffffff, vertexColors: true, roughness: 0.52, sheen: 0.7, sheenRoughness: 0.45,
    sheenColor: new THREE.Color(0xffa58c), emissive: 0x160604, envMapIntensity: 0.7, clearcoat: 0.08, clearcoatRoughness: 0.5,
  });
  // Fake subsurface: a warm red bleed around the light terminator.
  M.skin.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      {
        float wrapN = dot(normal, normalize(vec3(0.2, 1.0, 0.3)));
        float sss = smoothstep(-0.6, 0.4, wrapN) * (1.0 - smoothstep(0.4, 1.0, wrapN));
        reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(0.55, 0.16, 0.10) * sss * 0.35;
      }`,
    );
  };
  M.eye = phys({ map: eyeTexture(), roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.2 });
  M.mouth = std({ color: 0x4a1418, roughness: 0.55, envMapIntensity: 0.3 });
  M.nappy = std({ color: 0xffffff, roughness: 0.92, envMapIntensity: 0.6 });
  M.tape = std({ color: 0xffffff, roughness: 0.6 });
  M.hair = std({ color: 0xffffff, roughness: 0.75, envMapIntensity: 0.4, alphaMap: hairAlpha(rand), alphaTest: 0.5, side: THREE.DoubleSide });
  return M;
}

// ---------- the room ----------

function buildRoom(M, rand) {
  const { scene } = ctx;
  // Nothing in the room shell casts: it all sits outside the key light's shadow frustum (the belt).
  const nc = { cast: false };
  const B = {
    steel: new Batch(M.steel, nc), brushed: new Batch(M.brushed, nc), paint: new Batch(M.paint, nc), seam: new Batch(M.seam, nc),
    ceiling: new Batch(M.ceiling, nc), dark: new Batch(M.dark, nc), cables: new Batch(M.cables, { vertexColors: true, cast: false }),
    diffuser: new Batch(M.diffuser, { cast: false, receive: false }), window: new Batch(M.window, nc),
  };

  // Labels (one atlas, one merged mesh; built at the end of init so every builder can add to it).
  const [atlas, rect] = labelAtlas(rand);
  const labelMat = new THREE.MeshStandardMaterial({
    map: atlas, roughness: 0.45, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  s.envMats.push({ m: labelMat, base: 1 });
  s.labelBatch = new Batch(labelMat, { cast: false });
  s.label = (i, w, matrix) => {
    const g = new THREE.PlaneGeometry(w, w / 4);
    const [u0, v0, du, dv] = rect(i);
    const uv = g.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, u0 + uv.getX(k) * du, v0 + uv.getY(k) * dv);
    s.labelBatch.add(g, matrix);
  };

  // Floor (polished tiles + scuffs) and its collider.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_L), M.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = ROOM_MID;
  floor.receiveShadow = true;
  scene.add(floor);
  collider(ROOM_W, 0.5, ROOM_L, 0, -0.25, ROOM_MID);

  // Walls: dark backing (shows through the panel seams), then glossy panels with corner bolts.
  const W2 = ROOM_W / 2;
  B.seam.add(new THREE.BoxGeometry(0.1, ROOM_H, ROOM_L), mat(-W2 - 0.05, ROOM_H / 2, ROOM_MID));
  B.seam.add(new THREE.BoxGeometry(0.1, ROOM_H, ROOM_L), mat(W2 + 0.05, ROOM_H / 2, ROOM_MID));
  B.seam.add(new THREE.BoxGeometry(ROOM_W, ROOM_H, 0.1), mat(0, ROOM_H / 2, ROOM_BACK + 0.05));
  B.seam.add(new THREE.BoxGeometry(ROOM_W, ROOM_H, 0.1), mat(0, ROOM_H / 2, ROOM_FRONT - 0.05));

  const PANEL_T = 0.035, SKIRT = 0.16, ROWS = 3, GAP = 0.014;
  const PH = (ROOM_H - SKIRT - 0.08) / ROWS;
  const SIDE_COLS = 32, PW = ROOM_L / SIDE_COLS;
  const END_COLS = 10, EPW = ROOM_W / END_COLS;
  const snap = (z) => ROOM_FRONT + Math.round((z - ROOM_FRONT) / PW) * PW;
  const windows = [[-1, snap(-1.6)], [-1, snap(-11.2)]]; // [wall side, z centre]: 2 panels wide, middle row
  const panelSets = new Map(); // panel width → { mx, col }
  const boltMx = [];
  const Y = new V3(0, 1, 0);
  const addPanel = (cx, cy, cz, pw, yaw) => {
    if (!panelSets.has(pw)) panelSets.set(pw, { mx: [], col: [] });
    const set = panelSets.get(pw);
    set.mx.push(mat(cx, cy, cz, 0, yaw));
    const w = 0.94 + rand() * 0.06; // slightly uneven enamel
    set.col.push(new THREE.Color(w, w, w * (0.985 + rand() * 0.015)));
    const n = new V3(Math.sin(yaw), 0, Math.cos(yaw)), t = new V3(Math.cos(yaw), 0, -Math.sin(yaw));
    const q = new THREE.Quaternion().setFromUnitVectors(Y, n);
    for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const p = new V3(cx, cy + b * (PH / 2 - 0.06), cz).addScaledVector(t, a * (pw / 2 - 0.06)).addScaledVector(n, PANEL_T / 2);
      boltMx.push(new THREE.Matrix4().compose(p, q, new V3(1, 1, 1)));
    }
  };
  for (const side of [-1, 1]) {
    const x = side * (W2 - PANEL_T / 2);
    for (let c = 0; c < SIDE_COLS; c++) {
      const z = ROOM_FRONT + (c + 0.5) * PW;
      for (let r = 0; r < ROWS; r++) {
        const inWindow = r === 1 && windows.some(([ws, wz]) => ws === side && Math.abs(z - wz) < PW);
        if (!inWindow) addPanel(x, SKIRT + (r + 0.5) * PH, z, PW, -side * Math.PI / 2);
      }
    }
  }
  for (const [zEnd, yaw] of [[ROOM_BACK - PANEL_T / 2, Math.PI], [ROOM_FRONT + PANEL_T / 2, 0]]) {
    for (let c = 0; c < END_COLS; c++) {
      for (let r = 0; r < ROWS; r++) addPanel(-W2 + (c + 0.5) * EPW, SKIRT + (r + 0.5) * PH, zEnd, EPW, yaw);
    }
  }
  for (const [pw, { mx, col }] of panelSets) {
    instanced(new RoundedBoxGeometry(pw - GAP, PH - GAP, PANEL_T, 2, 0.01), M.panel, mx, { cast: false, colors: col });
  }
  instanced(new THREE.CylinderGeometry(0.009, 0.009, 0.008, 8, 1, false), M.steel, boltMx, { cast: false });

  // Stainless skirting all round.
  for (const side of [-1, 1]) B.brushed.add(boxGeometry(0.02, SKIRT, ROOM_L), mat(side * (W2 - 0.03), SKIRT / 2, ROOM_MID));
  for (const z of [ROOM_BACK - 0.03, ROOM_FRONT + 0.03]) B.brushed.add(boxGeometry(ROOM_W, SKIRT, 0.02), mat(0, SKIRT / 2, z));

  // Observation windows: black glass with stainless frames (someone is watching).
  for (const [side, z] of windows) {
    const x = side * (W2 - 0.06);
    const w = PW * 2 - 0.1, h = PH - 0.1, y = SKIRT + 1.5 * PH;
    B.window.add(new THREE.BoxGeometry(0.02, h, w), mat(x - side * 0.04, y, z));
    for (const dy of [-1, 1]) B.steel.add(new THREE.BoxGeometry(0.1, 0.06, w + 0.12), mat(x, y + dy * (h / 2 + 0.03), z));
    for (const dz of [-1, 1]) B.steel.add(new THREE.BoxGeometry(0.1, h + 0.12, 0.06), mat(x, y, z + dz * (w / 2 + 0.03)));
    B.steel.add(new THREE.BoxGeometry(0.06, 0.03, w), mat(x, y, z)); // transom bar
  }
  s.label(1, 1.2, mat(-W2 + 0.03, 2.0, windows[0][1] + PW + 0.8, 0, Math.PI / 2));

  // Ceiling: tiled strips between three rows of recessed light troughs.
  const TROUGHS = [-3, 0, 3], TW = 0.34, TD = 0.14;
  const edges = [-W2, ...TROUGHS.flatMap((t) => [t - TW / 2, t + TW / 2]), W2];
  for (let i = 0; i < edges.length; i += 2) {
    const a = edges[i], b = edges[i + 1];
    B.ceiling.add(boxGeometry(b - a, 0.1, ROOM_L, [1, 1]), mat((a + b) / 2, ROOM_H + 0.05, ROOM_MID));
  }
  for (const tx of TROUGHS) {
    for (const dx of [-1, 1]) B.paint.add(new THREE.BoxGeometry(0.01, TD, ROOM_L), mat(tx + dx * TW / 2, ROOM_H + TD / 2, ROOM_MID));
    B.dark.add(new THREE.BoxGeometry(TW, 0.02, ROOM_L), mat(tx, ROOM_H + TD + 0.01, ROOM_MID));
    for (let z = ROOM_BACK - 0.3; z > ROOM_FRONT + 1; z -= 3.6) { // fixtures, dark gaps between
      const len = 3.3;
      B.diffuser.add(new THREE.PlaneGeometry(TW - 0.04, len), mat(tx, ROOM_H + TD - 0.01, z - len / 2, Math.PI / 2));
    }
  }
  // Square ceiling air diffusers.
  for (const [x, z] of [[-4.5, 4], [4.5, -4], [-4.5, -14], [4.5, -24], [4.5, 8]]) {
    B.paint.add(new THREE.BoxGeometry(0.62, 0.02, 0.62), mat(x, ROOM_H - 0.01, z));
    for (let k = 1; k <= 3; k++) {
      const r = 0.31 - k * 0.07;
      B.dark.add(new THREE.BoxGeometry(r * 2, 0.012, r * 2), mat(x, ROOM_H - 0.025 - k * 0.006, z));
      B.paint.add(new THREE.BoxGeometry(r * 2 - 0.03, 0.014, r * 2 - 0.03), mat(x, ROOM_H - 0.03 - k * 0.006, z));
    }
  }

  // Wall vent grilles (low and high), louvred.
  const vent = (side, y, z, w = 0.7, h = 0.34) => {
    const x = side * (W2 - 0.04);
    B.dark.add(new THREE.BoxGeometry(0.02, h, w), mat(x + side * 0.012, y, z));
    for (const dy of [-1, 1]) B.paint.add(new THREE.BoxGeometry(0.04, 0.03, w + 0.06), mat(x, y + dy * h / 2, z));
    for (const dz of [-1, 1]) B.paint.add(new THREE.BoxGeometry(0.04, h + 0.06, 0.03), mat(x, y, z + dz * w / 2));
    for (let k = 1; k < 7; k++) B.paint.add(new THREE.BoxGeometry(0.035, 0.008, w), mat(x, y - h / 2 + (k * h) / 7, z, 0, 0, side * 0.6));
    if (y < 1) s.label(7, 0.5, mat(side * (W2 - 0.025), y + 0.32, z, 0, -side * Math.PI / 2));
  };
  for (const [side, z, high] of [[1, 3, false], [1, -9, false], [-1, -5, false], [-1, 6, false], [1, -15, true], [-1, -19, true], [1, 7, true]]) {
    vent(side, high ? 4.9 : 0.42, z);
  }

  // Cable trays along both walls near the ceiling: ladder tray, brackets, bundled cables.
  const TRAY_Y = 5.25;
  const cableColors = ['#202326', '#2b2f33', '#2a4d7a', '#5b6066', '#c8cbcd', '#7a1f1f'].map((c) => new THREE.Color(c));
  for (const side of [-1, 1]) {
    const tx = side * (W2 - 0.32);
    for (const dx of [-1, 1]) B.steel.add(boxGeometry(0.012, 0.09, ROOM_L - 0.2), mat(tx + dx * 0.2, TRAY_Y, ROOM_MID));
    const rung = new THREE.BoxGeometry(0.4, 0.012, 0.03);
    for (let z = ROOM_FRONT + 0.3; z < ROOM_BACK - 0.2; z += 0.35) B.steel.add(rung, mat(tx, TRAY_Y - 0.035, z));
    for (let z = ROOM_FRONT + 1; z < ROOM_BACK; z += 2.4) {
      B.brushed.add(new THREE.BoxGeometry(0.5, 0.025, 0.05), mat(tx + side * 0.05, TRAY_Y - 0.06, z));
      B.brushed.add(new THREE.BoxGeometry(0.025, 0.45, 0.05), mat(side * (W2 - 0.05), TRAY_Y + 0.15, z));
    }
    for (let k = 0; k < 7; k++) {
      const r = 0.01 + rand() * 0.012;
      const cx = tx - 0.15 + k * 0.05, cy = TRAY_Y - 0.028 + r + (k % 2) * 0.012;
      B.cables.add(new THREE.CylinderGeometry(r, r, ROOM_L - 0.3, 8), mat(cx, cy, ROOM_MID, Math.PI / 2), cableColors[(k + (side > 0 ? 2 : 0)) % cableColors.length]);
    }
  }

  // Wall signage.
  s.label(2, 2.8, mat(W2 - 0.03, 3.9, -6, 0, -Math.PI / 2));     // LINE 03 — RETURN PROCESSING
  s.label(2, 2.8, mat(-W2 + 0.03, 3.9, 2, 0, Math.PI / 2));
  s.label(4, 2.0, mat(0, 4.4, ROOM_BACK - 0.03, 0, Math.PI));     // behind the player
  s.label(1, 1.4, mat(0, 4.2, ROOM_FRONT + 0.03));

  // CCTV camera in the far corner, panning to follow the player.
  s.cctv = buildCCTV(M, new V3(W2 - 0.12, 5.0, ROOM_FRONT + 6.5));

  for (const b of Object.values(B)) b.build(scene);
}

function buildCCTV(M, at) {
  const root = new THREE.Group();
  root.position.copy(at);
  const add = (geo, m, p, r = [0, 0, 0], parent = root) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(...p);
    mesh.rotation.set(...r);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  add(new THREE.BoxGeometry(0.04, 0.22, 0.16), M.paint, [0.08, 0, 0]);                                  // wall plate
  add(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 12), M.paint, [-0.07, 0, 0], [0, 0, Math.PI / 2]); // arm
  const pan = new THREE.Group();
  pan.position.set(-0.24, -0.02, 0);
  root.add(pan);
  add(new THREE.CylinderGeometry(0.035, 0.035, 0.06, 12), M.dark, [0, 0.03, 0], [0, 0, 0], pan);
  const tilt = new THREE.Group();
  pan.add(tilt);
  add(new RoundedBoxGeometry(0.13, 0.12, 0.34, 3, 0.03), M.machine, [0, -0.06, 0.06], [0, 0, 0], tilt); // housing
  add(new THREE.BoxGeometry(0.17, 0.012, 0.4), M.paint, [0, 0.007, 0.08], [0, 0, 0], tilt);             // sunshield
  add(new THREE.CylinderGeometry(0.042, 0.042, 0.02, 24), M.dark, [0, -0.06, 0.23], [Math.PI / 2, 0, 0], tilt);
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.012, 24), M.window, [0, -0.06, 0.242], [Math.PI / 2, 0, 0], tilt);
  const ledMat = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff1a10, emissiveIntensity: 4 });
  add(new THREE.SphereGeometry(0.008, 10, 8), ledMat, [0.045, -0.015, 0.235], [0, 0, 0], tilt);
  ctx.scene.add(root);
  return { root, pan, tilt, ledMat };
}

// ---------- the conveyor ----------

function buildConveyor(M) {
  const { scene } = ctx;
  const B = {
    steel: new Batch(M.steel), brushed: new Batch(M.brushed), dark: new Batch(M.dark), rubber: new Batch(M.rubber),
    machine: new Batch(M.machine), accent: new Batch(M.accent), plate: new Batch(M.plate, { cast: false }),
    glass: new Batch(M.glass, { cast: false, receive: false }),
  };

  // Rubber belt (top run) — its maps scroll with the belt speed.
  const belt = new THREE.Mesh(new THREE.PlaneGeometry(BELT_W, BELT_LEN), M.belt);
  belt.rotation.x = -Math.PI / 2;
  belt.position.set(0, BELT_Y, BELT_MID);
  belt.receiveShadow = true;
  scene.add(belt);
  s.beltMaps = [M.belt.normalMap, M.belt.roughnessMap, M.belt.aoMap].filter(Boolean);
  for (const side of [-1, 1]) B.rubber.add(new THREE.BoxGeometry(0.012, 0.014, BELT_LEN), mat(side * (BELT_W / 2), BELT_Y - 0.007, BELT_MID));
  B.rubber.add(new THREE.BoxGeometry(BELT_W, 0.01, BELT_LEN), mat(0, 0.2, BELT_MID)); // return run
  collider(BELT_W + 0.2, 0.1, BELT_LEN, 0, BELT_Y - 0.05, BELT_MID);

  // Carrying rollers: longer than the belt so their ends show; the striped map turns with the belt.
  const rollerMx = [];
  for (let z = BELT_BACK - 0.25; z > BELT_FRONT + 0.1; z -= ROLLER_GAP) rollerMx.push(mat(0, BELT_Y - 0.008 - ROLLER_R, z, 0, 0, Math.PI / 2));
  instanced(new THREE.CylinderGeometry(ROLLER_R, ROLLER_R, FRAME_HALF * 2 - 0.04, 24, 1), M.roller, rollerMx);
  s.rollerMap = M.roller.map;
  const axleMx = [];
  for (const m of rollerMx) {
    const p = new V3().setFromMatrixPosition(m);
    for (const side of [-1, 1]) axleMx.push(mat(side * (FRAME_HALF + 0.012), p.y, p.z, 0, 0, Math.PI / 2));
  }
  instanced(new THREE.CylinderGeometry(0.012, 0.012, 0.03, 6), M.dark, axleMx, { cast: false });
  for (const z of [BELT_BACK, BELT_FRONT]) { // end drums
    B.brushed.add(new THREE.CylinderGeometry(0.07, 0.07, BELT_W + 0.06, 32), mat(0, BELT_Y - 0.075, z, 0, 0, Math.PI / 2));
  }

  // Side channels (C-profile), stainless, with bolt heads.
  for (const side of [-1, 1]) {
    const x = side * FRAME_HALF;
    B.steel.add(boxGeometry(0.012, 0.2, BELT_LEN + 0.3), mat(x, BELT_Y - 0.15, BELT_MID));
    for (const dy of [-0.1, 0.1]) B.steel.add(boxGeometry(0.06, 0.01, BELT_LEN + 0.3), mat(x - side * 0.024, BELT_Y - 0.15 + dy, BELT_MID));
    for (let z = BELT_BACK - 0.6; z > BELT_FRONT; z -= 1.2) {
      B.dark.add(new THREE.CylinderGeometry(0.008, 0.008, 0.012, 6), mat(x + side * 0.006, BELT_Y - 0.15, z, 0, 0, Math.PI / 2));
    }
    s.label(3, 0.72, mat(x + side * 0.008, BELT_Y - 0.15, 4, 0, side * Math.PI / 2));
    s.label(3, 0.72, mat(x + side * 0.008, BELT_Y - 0.15, -9, 0, side * Math.PI / 2));
  }
  // Legs, braces, levelling feet.
  for (let z = BELT_BACK - 0.3; z > BELT_FRONT; z -= 2.2) {
    for (const side of [-1, 1]) {
      const x = side * (FRAME_HALF - 0.04);
      B.steel.add(boxGeometry(0.05, 0.25, 0.05), mat(x, 0.205, z));
      B.dark.add(new THREE.CylinderGeometry(0.01, 0.01, 0.06, 8), mat(x, 0.05, z));
      B.dark.add(new THREE.CylinderGeometry(0.035, 0.04, 0.02, 16), mat(x, 0.01, z));
    }
    B.steel.add(boxGeometry(FRAME_HALF * 2 - 0.08, 0.04, 0.04), mat(0, 0.12, z));
  }
  // Diamond-plate kick strips on the floor either side of the line.
  for (const side of [-1, 1]) {
    const g = new THREE.PlaneGeometry(0.6, BELT_LEN);
    const uv = g.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * 0.6 / 0.8, uv.getY(k) * BELT_LEN / 0.8);
    B.plate.add(g, mat(side * (FRAME_HALF + 0.38), 0.004, BELT_MID, -Math.PI / 2));
  }

  // Guard: stainless posts and rails with glass infill, up to the scanner.
  const guardBack = BELT_BACK - 0.1, guardFront = CURTAIN_Z + 0.2;
  const gLen = guardBack - guardFront, gMid = (guardBack + guardFront) / 2;
  for (const side of [-1, 1]) {
    const x = side * (FRAME_HALF + 0.02);
    for (const y of [1.95, 1.2]) B.steel.add(new THREE.CylinderGeometry(0.022, 0.022, gLen, 16), mat(x, y, gMid, Math.PI / 2));
    for (let i = 0; i <= 12; i++) {
      const z = guardBack - (i * gLen) / 12;
      B.steel.add(new THREE.CylinderGeometry(0.025, 0.025, 1.5, 16), mat(x, BELT_Y + 0.71, z));
      B.dark.add(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 16), mat(x, BELT_Y - 0.04, z));
    }
    B.glass.add(new THREE.BoxGeometry(0.012, 1.3, gLen), mat(x, BELT_Y + 0.75, gMid));
  }

  // Drive: gearbox + finned motor beside the tail drum, behind the player.
  const mx = FRAME_HALF + 0.42, mz = BELT_BACK - 0.35;
  B.machine.add(new RoundedBoxGeometry(0.42, 0.42, 0.5, 3, 0.04), mat(mx, 0.38, mz));
  B.accent.add(new RoundedBoxGeometry(0.46, 0.06, 0.54, 2, 0.02), mat(mx, 0.14, mz));
  B.steel.add(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 16), mat(mx - 0.3, BELT_Y - 0.075, BELT_BACK, 0, 0, Math.PI / 2));
  B.machine.add(new THREE.CylinderGeometry(0.15, 0.15, 0.42, 32), mat(mx + 0.05, 0.4, mz - 0.45, Math.PI / 2));
  for (let k = 0; k < 9; k++) B.accent.add(new THREE.CylinderGeometry(0.165, 0.165, 0.012, 32), mat(mx + 0.05, 0.4, mz - 0.3 - k * 0.035, Math.PI / 2));
  B.dark.add(new THREE.CylinderGeometry(0.155, 0.14, 0.06, 32), mat(mx + 0.05, 0.4, mz - 0.69, Math.PI / 2)); // fan cowl
  B.plate.add(new THREE.BoxGeometry(0.9, 0.02, 1.4), mat(mx + 0.05, 0.01, mz - 0.3));

  // Control pedestal (right of the belt, angled towards the rider): status LEDs, e-stop, label.
  const px = FRAME_HALF + 0.55, pz = 5.4;
  B.steel.add(new THREE.CylinderGeometry(0.035, 0.035, 1.1, 16), mat(px, 0.55, pz));
  B.dark.add(new THREE.CylinderGeometry(0.12, 0.14, 0.03, 24), mat(px, 0.015, pz));
  B.steel.add(new THREE.CylinderGeometry(0.02, 0.02, ROOM_H - 1.35, 10), mat(px + 0.06, (ROOM_H + 1.35) / 2, pz - 0.06)); // conduit
  const box = new THREE.Group();
  box.position.set(px, 1.22, pz);
  box.rotation.set(-0.5, -0.9, 0, 'YXZ');
  scene.add(box);
  const boxMesh = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.26, 0.16, 3, 0.02), M.machine);
  boxMesh.castShadow = boxMesh.receiveShadow = true;
  box.add(boxMesh);
  s.leds = {};
  const ledGeo = new THREE.SphereGeometry(0.013, 16, 12);
  [['run', 0x22ff66], ['power', 0xffaa22], ['fault', 0xff2222]].forEach(([k, c], i) => {
    const m = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: c, emissiveIntensity: 0, roughness: 0.2 });
    const led = new THREE.Mesh(ledGeo, m);
    led.position.set(-0.12 + i * 0.05, 0.07, 0.08);
    box.add(led);
    s.leds[k] = m;
  });
  s.leds.power.emissiveIntensity = 2;
  const stop = new THREE.Mesh(new THREE.SphereGeometry(0.04, 24, 12, 0, TAU, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xc81010, roughness: 0.35 }));
  stop.position.set(0.1, 0.03, 0.08);
  stop.rotation.x = Math.PI / 2;
  stop.castShadow = true;
  box.add(stop);
  box.updateMatrixWorld(true);
  s.label(6, 0.2, new THREE.Matrix4().multiplyMatrices(box.matrixWorld, mat(-0.06, -0.05, 0.081)));

  for (const b of Object.values(B)) b.build(scene);
}

// ---------- the X-ray scanner, curtains, sign ----------

function buildScanner(M) {
  const { scene } = ctx;
  const B = { machine: new Batch(M.machine), accent: new Batch(M.accent), tunnel: new Batch(M.tunnel), dark: new Batch(M.dark), steel: new Batch(M.steel) };
  const zc = CURTAIN_Z - SCAN_D / 2 + 0.1;
  const sideW = (SCAN_W - OPENING_W) / 2;
  for (const side of [-1, 1]) {
    const x = side * (OPENING_W / 2 + sideW / 2);
    B.machine.add(new RoundedBoxGeometry(sideW, SCAN_H, SCAN_D, 4, 0.06), mat(x, SCAN_H / 2, zc));
    B.accent.add(new RoundedBoxGeometry(sideW + 0.02, 0.12, SCAN_D + 0.02, 2, 0.03), mat(x, 0.9, zc)); // accent band
    B.dark.add(new RoundedBoxGeometry(sideW + 0.02, 0.1, SCAN_D + 0.02, 2, 0.02), mat(x, 0.05, zc));    // plinth
    collider(sideW, SCAN_H, SCAN_D, x, SCAN_H / 2, zc);
  }
  B.machine.add(new RoundedBoxGeometry(OPENING_W + 0.1, SCAN_H - OPENING_TOP, SCAN_D, 4, 0.06), mat(0, (SCAN_H + OPENING_TOP) / 2, zc));
  B.accent.add(new RoundedBoxGeometry(OPENING_W + 0.12, 0.12, SCAN_D + 0.02, 2, 0.03), mat(0, OPENING_TOP + 0.25, zc));
  // Lead-lined tunnel interior, and darkness at the end.
  for (const side of [-1, 1]) B.tunnel.add(new THREE.BoxGeometry(0.02, OPENING_TOP, SCAN_D - 0.05), mat(side * (OPENING_W / 2 - 0.01), OPENING_TOP / 2, zc));
  B.tunnel.add(new THREE.BoxGeometry(OPENING_W, 0.02, SCAN_D - 0.05), mat(0, OPENING_TOP - 0.01, zc));
  const voidPlane = new THREE.Mesh(new THREE.PlaneGeometry(OPENING_W, OPENING_TOP), M.void);
  voidPlane.position.set(0, OPENING_TOP / 2, VOID_Z - 0.2);
  scene.add(voidPlane);
  for (const z of [CURTAIN_Z, CURTAIN2_Z]) B.steel.add(new THREE.BoxGeometry(OPENING_W, 0.05, 0.05), mat(0, OPENING_TOP - 0.03, z)); // curtain rails

  // Status beacon bar on top.
  s.beacon = new THREE.MeshStandardMaterial({ color: 0x0a1a10, emissive: 0x18ff60, emissiveIntensity: 3, roughness: 0.3 });
  const beacon = new THREE.Mesh(new RoundedBoxGeometry(1.2, 0.08, 0.12, 2, 0.03), s.beacon);
  beacon.position.set(0, SCAN_H + 0.04, CURTAIN_Z - 0.15);
  scene.add(beacon);

  // Warning labels on the scanner face, hazard stripes on its plinth and the floor around it.
  const fz = CURTAIN_Z + 0.105, px = OPENING_W / 2 + sideW / 2;
  for (const side of [-1, 1]) {
    s.label(0, 0.56, mat(side * px, 1.75, fz));
    s.label(5, 0.56, mat(side * px, 0.32, fz));
    s.label(5, 2.6, mat(side * (SCAN_W / 2 + 0.2), 0.003, zc, -Math.PI / 2, Math.PI / 2));
  }

  // Monitor on an arm: a counter of everything processed.
  const mon = new THREE.Group();
  mon.position.set(-SCAN_W / 2 - 0.15, 2.05, CURTAIN_Z + 0.55);
  mon.rotation.y = 0.45;
  const screenCanvas = canvas(512, 320);
  const screenTex = canvasTexture(screenCanvas, { clamp: true });
  const body = new THREE.Mesh(new RoundedBoxGeometry(0.62, 0.42, 0.05, 2, 0.015), M.dark);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.35),
    new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: screenTex, emissiveIntensity: 1.3, roughness: 0.15 }));
  screen.position.z = 0.026;
  body.castShadow = true;
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.5, 10), M.steel);
  arm.rotation.z = Math.PI / 2;
  arm.position.set(0.3, 0, -0.08);
  mon.add(body, screen, arm);
  scene.add(mon);
  s.screen = { canvas: screenCanvas, tex: screenTex, count: 4127 };
  drawScreen('ok');

  // Lead-vinyl strips (two rows), each a damped pendulum pushed open by whatever passes through.
  const N = 10, SW = OPENING_W / N, L = OPENING_TOP - BELT_Y - 0.06;
  const stripGeo = new THREE.BoxGeometry(SW * 0.97, L, 0.008, 1, 6, 1);
  stripGeo.translate(0, -L / 2, 0);
  s.strips = [];
  for (const z of [CURTAIN_Z, CURTAIN2_Z]) {
    for (let i = 0; i < N; i++) {
      const pivot = new THREE.Group();
      pivot.position.set(-OPENING_W / 2 + SW * (i + 0.5), OPENING_TOP - 0.05, z + (i % 2 ? 0.006 : -0.006));
      const strip = new THREE.Mesh(stripGeo, M.curtain);
      strip.castShadow = true;
      pivot.add(strip);
      scene.add(pivot);
      s.strips.push({ pivot, z, a: 0, w: 0, twist: 0, len: L, half: SW / 2 });
    }
  }

  // Illuminated sign box hanging from the ceiling.
  const c = canvas(2048, 440);
  const tex = canvasTexture(c, { clamp: true });
  tex.anisotropy = 16;
  const SH = SIGN_W * c.height / c.width;
  const signMat = new THREE.MeshBasicMaterial({ map: tex, fog: false }); // backlit: unlit, slightly over 1 so it blooms
  s.sign = { canvas: c, tex, mat: signMat };
  drawSign('BACK TO REAL WORLD', false);
  const frame = new THREE.Mesh(new RoundedBoxGeometry(SIGN_W + 0.14, SH + 0.14, 0.18, 3, 0.03), M.brushed);
  frame.position.copy(SIGN_POS).add(new V3(0, 0, -0.08));
  frame.castShadow = true;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(SIGN_W, SH), signMat);
  face.position.copy(SIGN_POS).add(new V3(0, 0, 0.012));
  scene.add(frame, face);
  const cableLen = ROOM_H - SIGN_POS.y - SH / 2 - 0.07;
  for (const x of [-SIGN_W / 2 + 0.3, SIGN_W / 2 - 0.3]) {
    B.steel.add(new THREE.CylinderGeometry(0.005, 0.005, cableLen, 6), mat(x, ROOM_H - cableLen / 2, SIGN_POS.z - 0.08));
  }
  // The sign throws a little cool light down onto the scanner face.
  const signLight = new THREE.PointLight(0xeaf3ff, 2.5, 5, 2);
  signLight.position.copy(SIGN_POS).add(new V3(0, -0.5, 0.4));
  scene.add(signLight);
  tint(signLight.color, 0xff2010);

  for (const b of Object.values(B)) b.build(scene);
}

function drawSign(text, red) {
  const { canvas: c, tex, mat: m } = s.sign;
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  // Backlit acrylic: bright panel, slightly brighter in the middle, dark lettering.
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, red ? '#ff2a1a' : '#eef5fb');
  grad.addColorStop(0.5, red ? '#ff4a32' : '#ffffff');
  grad.addColorStop(1, red ? '#e01a10' : '#e8f0f7');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  g.fillStyle = red ? '#3a0000' : '#1a2530';
  g.fillRect(0, H - 40, W, 40);
  g.fillRect(0, 0, W, 16);
  g.fillStyle = red ? '#1a0000' : '#18222b';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = 230;
  const font = (sz) => `800 ${sz}px "Helvetica Neue", Arial, sans-serif`;
  g.font = font(size);
  if ('letterSpacing' in g) g.letterSpacing = '14px';
  while (g.measureText(text).width > W - 200) g.font = font(--size);
  g.fillText(text, W / 2, H / 2 - 8);
  tex.needsUpdate = true;
  m.color.setScalar(red ? 1.5 : 1.0);
}

function drawScreen(state) {
  const { canvas: c, tex, count } = s.screen;
  const g = c.getContext('2d');
  const bad = state === 'error';
  g.fillStyle = '#05080a';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = bad ? '#ff2a20' : '#5dffa0';
  g.font = '700 30px ui-monospace, Menlo, monospace';
  g.textAlign = 'left';
  g.textBaseline = 'top';
  g.fillText('LINE 03  ·  RETURN', 28, 24);
  g.fillStyle = bad ? '#ff6a5a' : '#c8f5da';
  g.font = '400 24px ui-monospace, Menlo, monospace';
  g.fillText(`PROCESSED   ${String(count).padStart(6, '0')}`, 28, 96);
  g.fillText(`DESTINATION ${bad ? 'DLROW' : 'REAL WORLD'}`, 28, 136);
  g.fillText(`STATUS      ${bad ? 'FAULT' : 'NOMINAL'}`, 28, 176);
  g.fillStyle = bad ? '#ff2a20' : '#5dffa0';
  g.fillRect(28, 240, bad ? 456 : 120 + (count % 7) * 48, 16);
  g.strokeStyle = bad ? '#ff2a20' : '#2f8f5a';
  g.strokeRect(28, 240, 456, 16);
  tex.needsUpdate = true;
}

// ---------- babies ----------

/** White vertex colours (the skin material multiplies them), or a flat tint. */
function colored(geo, rgb = [1, 1, 1]) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set(rgb, i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Chubby limb hanging along -y from its joint: rounded ends, slight mid bulge. */
function limbGeometry(len, r0, r1, bulge = 0.12) {
  const pts = [];
  for (let i = 0; i <= 6; i++) { // bottom cap, from the tip up
    const a = (i / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r1 * Math.sin(a), -len - r1 * 0.85 * Math.cos(a)));
  }
  for (let i = 13; i >= 1; i--) {
    const t = i / 14;
    pts.push(new THREE.Vector2((r0 + (r1 - r0) * t) * (1 + bulge * Math.sin(Math.PI * t)), -len * t));
  }
  for (let i = 6; i >= 0; i--) { // top cap
    const a = (i / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r0 * Math.sin(a), r0 * 0.85 * Math.cos(a)));
  }
  return colored(new THREE.LatheGeometry(pts, 20));
}

function phalanx(r, len) {
  const g = new THREE.CapsuleGeometry(r, len, 4, 8);
  g.translate(0, -len / 2, 0);
  return colored(g);
}

/** Baby head: bigger cranium, narrow chin, flat face, chubby rosy cheeks (vertex colours). */
function shapeHead(geo, r, withColor) {
  const p = geo.attributes.position;
  const colors = new Float32Array(p.count * 3);
  const v = new V3(), n = new V3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    n.copy(v).normalize();
    let sx = 1, sz = 1.04;
    const sy = 1.04;
    if (n.y < 0) { sx *= 1 - 0.16 * n.y * n.y; sz *= 1 + 0.05 * n.y; }
    if (n.z > 0) sz *= 1 - 0.07 * n.z * n.z;
    if (n.z < 0 && n.y > -0.3) sz *= 1 + 0.07 * -n.z;
    v.set(v.x * sx, v.y * sy, v.z * sz);
    let pink = 0;
    for (const side of [-1, 1]) {
      const d2 = (n.x - 0.5 * side) ** 2 + (n.y + 0.3) ** 2 + (n.z - 0.74) ** 2;
      v.addScaledVector(n, r * 0.07 * Math.exp(-d2 / 0.05));
      pink += Math.exp(-d2 / 0.03);
    }
    pink = Math.min(1, pink) * 0.6;
    colors.set([1, 1 - pink * 0.6, 1 - pink * 0.58], i * 3);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  if (withColor) geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

function torsoGeometry() {
  const geo = new THREE.SphereGeometry(1, 40, 30);
  const p = geo.attributes.position;
  const v = new V3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    if (v.z > 0 && v.y < 0.4) v.z *= 1 + 0.18 * (0.4 - v.y) * v.z; // round belly
    if (v.y > 0.6) { v.x *= 1 - 0.25 * (v.y - 0.6); v.z *= 1 - 0.2 * (v.y - 0.6); }
    p.setXYZ(i, v.x * 0.09, v.y * 0.115 + 0.11, v.z * 0.078);
  }
  geo.computeVertexNormals();
  return colored(geo);
}

function nappyGeometry() {
  const geo = new THREE.SphereGeometry(1, 36, 24);
  const p = geo.attributes.position;
  const v = new V3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    if (v.y > 0.3) v.y = 0.3 + (v.y - 0.3) * 0.5; // flatter top under the waistband
    v.x *= 1 + 0.08 * Math.sin(v.y * 3);          // soft puffiness
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

function babyKit(M) {
  const head = shapeHead(new THREE.SphereGeometry(0.068, 64, 48), 0.068, true);
  const hair = shapeHead(new THREE.SphereGeometry(0.0695, 48, 16, 0, TAU, 0, Math.PI * 0.4), 0.0695, false);
  return {
    head: [head, M.skin],
    hair: [hair, M.hair],
    torso: [torsoGeometry(), M.skin],
    blob: [colored(new THREE.SphereGeometry(1, 24, 18)), M.skin],
    toe: [colored(new THREE.SphereGeometry(1, 10, 8)), M.skin],
    eye: [new THREE.SphereGeometry(0.0123, 24, 18), M.eye],
    lidUp: [colored(new THREE.SphereGeometry(0.0138, 24, 10, 0, TAU, 0, Math.PI * 0.5)), M.skin],
    lidLow: [colored(new THREE.SphereGeometry(0.0136, 24, 6, 0, TAU, Math.PI * 0.66, Math.PI * 0.34)), M.skin],
    lips: [colored(new THREE.TorusGeometry(0.0092, 0.0021, 8, 24), [1, 0.74, 0.72]), M.skin],
    mouth: [new THREE.SphereGeometry(1, 16, 10), M.mouth],
    upperArm: [limbGeometry(0.07, 0.026, 0.021), M.skin],
    forearm: [limbGeometry(0.06, 0.021, 0.017), M.skin],
    thigh: [limbGeometry(0.078, 0.035, 0.026, 0.16), M.skin],
    calf: [limbGeometry(0.068, 0.026, 0.018), M.skin],
    prox: [phalanx(0.0047, 0.0085), M.skin],
    dist: [phalanx(0.0042, 0.0068), M.skin],
    nappy: [nappyGeometry(), M.nappy],
    band: [new THREE.TorusGeometry(1, 0.075, 12, 48), M.nappy],
    tape: [new RoundedBoxGeometry(0.03, 0.024, 0.006, 2, 0.0025), M.tape],
  };
}

/** One baby: an invisible joint hierarchy; each visual part registers itself for instancing. */
function buildBaby(rig, parts, pose, i, rand) {
  const tone = new THREE.Color(SKIN_TONES[i % SKIN_TONES.length]);
  const white = new THREE.Color(1, 1, 1);
  const nappyTint = new THREE.Color().setHSL(rand(), 0.45, 0.94);
  const tapeTint = new THREE.Color().setHSL(rand(), 0.55, 0.7);
  const hairColor = new THREE.Color(HAIR_COLORS[Math.floor(rand() * HAIR_COLORS.length)]);
  const lie = pose === 'lie';

  const node = (parent, p = [0, 0, 0], r = [0, 0, 0]) => {
    const o = new THREE.Object3D();
    o.position.set(...p);
    o.rotation.set(...r);
    parent.add(o);
    return o;
  };
  const add = (parent, type, p, r, sc, color = tone) => {
    const o = node(parent, p, r);
    if (sc) o.scale.set(...sc);
    parts[type].push({ node: o, color });
    return o;
  };

  const root = node(rig);
  root.scale.setScalar(BABY_SCALE);
  const body = node(root);
  if (lie) {
    root.rotation.y = Math.PI + (rand() - 0.5) * 0.35; // on its back, head towards the player
    body.rotation.x = -Math.PI / 2;
    body.position.y = 0.074;
  } else {
    root.rotation.y = (rand() - 0.5) * 0.5;            // sitting up, facing the player
  }

  const pelvis = node(body);
  add(pelvis, 'nappy', [0, 0.066, 0.004], [0, 0, 0], [0.1, 0.07, 0.088], nappyTint);
  add(pelvis, 'band', [0, 0.1, 0.004], [Math.PI / 2, 0, 0], [0.094, 0.084, 0.1], nappyTint);
  for (const side of [-1, 1]) add(pelvis, 'tape', [side * 0.068, 0.088, 0.058], [0, side * 0.78, 0], null, tapeTint);

  const spine = node(pelvis, [0, 0.068, -0.004], [lie ? 0 : 0.1, 0, 0]);
  const torso = add(spine, 'torso', [0, 0, 0], [0, 0, 0]);
  const upper = node(spine, [0, 0.185, 0]);
  const headPivot = node(upper, [0, 0.032, 0.008]);
  const headC = node(headPivot, [0, 0.062, 0.008]);
  add(headC, 'head');
  if (rand() < 0.75) add(headC, 'hair', [0, 0.002, -0.002], [-0.42, 0, 0], null, hairColor);

  const eyes = [], lids = [];
  const openAngle = -Math.PI * (0.06 + rand() * 0.07);
  for (const side of [-1, 1]) {
    const p = [side * 0.026, 0.003, 0.0518];
    eyes.push(add(headC, 'eye', p, [0, 0, 0], null, white));
    lids.push(add(headC, 'lidUp', p, [openAngle, 0, 0]));
    add(headC, 'lidLow', p, [-0.05 * Math.PI, 0, 0]);
    add(headC, 'blob', [side * 0.0665, -0.004, -0.006], [0, side * 0.35, 0], [0.0065, 0.019, 0.0135]); // ear
  }
  add(headC, 'blob', [0, -0.016, 0.0606], [0.25, 0, 0], [0.0068, 0.0052, 0.0058]);                       // nose
  const mouth = add(headC, 'mouth', [0, -0.035, 0.0555], [0.15, 0, 0], [0.0098, 0.002, 0.0055], white);
  const lips = add(headC, 'lips', [0, -0.035, 0.0575], [0.15, 0, 0], [1, 0.5, 0.7]);

  const arms = [];
  for (const side of [-1, 1]) {
    const sh = node(upper, [side * 0.071, -0.01, 0]);
    add(sh, 'upperArm');
    const el = node(sh, [0, -0.07, 0]);
    add(el, 'forearm');
    const wr = node(el, [0, -0.06, 0]);
    const hand = node(wr, [0, -0.004, 0], [0, -side * Math.PI / 2, 0]);
    add(hand, 'blob', [0, -0.018, 0], [0, 0, 0], [0.0185, 0.022, 0.0115]); // palm
    const fingers = [];
    for (let k = 0; k < 4; k++) {
      const f = node(hand, [(k - 1.5) * 0.0074, -0.036 + Math.abs(k - 1.5) * 0.002, 0.001]);
      add(f, 'prox');
      const d = node(f, [0, -0.0085, 0]);
      add(d, 'dist');
      fingers.push([f, d]);
    }
    const th = node(hand, [side * 0.013, -0.012, 0.007], [0, 0, side * 0.9]);
    add(th, 'prox');
    const td = node(th, [0, -0.0085, 0]);
    add(td, 'dist');
    fingers.push([th, td]);
    arms.push({ sh, el, wr, fingers, side });
  }

  const legs = [];
  for (const side of [-1, 1]) {
    const hip = node(pelvis, [side * 0.048, 0.05, 0.02]);
    add(hip, 'thigh');
    const knee = node(hip, [0, -0.078, 0]);
    add(knee, 'calf');
    const ankle = node(knee, [0, -0.068, 0]);
    add(ankle, 'blob', [0, -0.012, 0.02], [0, 0, 0], [0.021, 0.017, 0.04]); // foot
    for (let k = 0; k < 5; k++) {
      const r = 0.0062 - k * 0.0007;
      add(ankle, 'toe', [side * (-0.012 + k * 0.0062), -0.011 + k * 0.0006, 0.056 - k * 0.0028], [0, 0, 0], [r, r, r * 1.1]);
    }
    legs.push({ hip, knee, ankle, side });
  }

  const R = (a, b) => a + rand() * (b - a);
  return {
    root, pose, torso, upper, headPivot, eyes, lids, mouth, lips, arms, legs,
    openAngle, closedAngle: Math.PI * 0.47,
    breathHz: R(0.55, 0.85), speed: R(0.7, 1.3), p: [...Array(12)].map(() => rand() * TAU),
    blinkIn: R(0.5, 4), blinkT: -1, blinkDur: R(0.16, 0.24), drowsy: rand() < 0.3,
    gaze: new V3(), gazeTarget: new V3(), gazeIn: R(0.3, 2),
    kick: 0, grip: [0, 0], stare: 0, stareDelay: R(0, 0.6),
    // Rough size for the curtain physics (world units).
    halfLen: (lie ? 0.27 : 0.14) * BABY_SCALE, halfW: 0.16 * BABY_SCALE, top: (lie ? 0.24 : 0.43) * BABY_SCALE,
    beeped: false,
  };
}

function buildBabies(M, rand) {
  const kit = babyKit(M);
  const parts = Object.fromEntries(Object.keys(kit).map((k) => [k, []]));
  const rig = new THREE.Group();
  ctx.scene.add(rig);
  const babies = BABY_POSES.map((pose, i) => {
    const b = buildBaby(rig, parts, pose, i, rand);
    b.root.position.set(0, BELT_Y, SPAWN_Z - 3 - i * 3);
    return b;
  });
  const meshes = [];
  for (const [type, list] of Object.entries(parts)) {
    if (!list.length) continue;
    const [geo, material] = kit[type];
    const m = new THREE.InstancedMesh(geo, material, list.length);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    list.forEach((p, i) => m.setColorAt(i, p.color));
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false; // instances travel the whole belt
    ctx.scene.add(m);
    meshes.push({ mesh: m, nodes: list.map((p) => p.node) });
  }
  return { rig, babies, meshes };
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new V3();
const _m = new THREE.Matrix4();
const FWD = new V3(0, 0, 1);

function animateBaby(b, dt, t, camPos) {
  const p = b.p, k = t * b.speed;
  const lie = b.pose === 'lie';
  const wob = (f, ph) => Math.sin(k * f + ph);

  // Breathing: belly and chest rise and fall, shoulders lift a touch.
  const br = Math.sin(TAU * b.breathHz * t + p[0]);
  b.torso.scale.set(1 + 0.022 * br, 1 + 0.01 * br, 1 + 0.06 * br);
  b.upper.position.y = 0.185 + 0.0025 * br;

  // Head: slow wandering turns, nods and tilts.
  _e.set((lie ? -0.1 : 0.05) + 0.1 * wob(0.53, p[3]), 0.38 * wob(0.37, p[1]) + 0.14 * wob(1.07, p[2]), 0.1 * wob(0.41, p[4]));
  b.headPivot.quaternion.setFromEuler(_e);
  if (b.stare > 0) { // malfunction: every baby turns to look at the player
    b.headPivot.parent.updateWorldMatrix(true, false);
    _v.copy(camPos).applyMatrix4(_m.copy(b.headPivot.parent.matrixWorld).invert()).sub(b.headPivot.position).normalize();
    _q.setFromUnitVectors(FWD, _v);
    b.headPivot.quaternion.slerp(_q, Math.min(1, b.stare) * 0.9);
  }

  // Eyes: little saccades between points of interest.
  b.gazeIn -= dt;
  if (b.gazeIn <= 0) {
    b.gazeTarget.set((Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.2, 0);
    b.gazeIn = 0.4 + Math.random() * 2.2;
  }
  if (b.stare > 0) b.gazeTarget.set(0, 0.1, 0);
  b.gaze.lerp(b.gazeTarget, Math.min(1, dt * 18));
  for (const e of b.eyes) e.rotation.set(-b.gaze.y, b.gaze.x, 0);

  // Blinks at random natural intervals (fast close, slower open); drowsy babies linger.
  let closed = 0;
  if (b.blinkT >= 0) {
    b.blinkT += dt / (b.drowsy ? b.blinkDur * 2.2 : b.blinkDur);
    const x = b.blinkT;
    closed = x < 0.35 ? x / 0.35 : x < 0.5 ? 1 : Math.max(0, 1 - (x - 0.5) / 0.5);
    if (x >= 1) { b.blinkT = -1; b.blinkIn = Math.random() < 0.15 ? 0.25 : 1.8 + Math.random() * 4.5; }
  } else if (b.stare < 0.3) {
    b.blinkIn -= dt;
    if (b.blinkIn <= 0) b.blinkT = 0;
  }
  const open = b.stare > 0.3 ? -Math.PI * 0.15 : b.openAngle + (b.drowsy ? 0.12 : 0) - b.gaze.y * 0.3;
  for (const l of b.lids) l.rotation.x = open + (b.closedAngle - open) * closed;

  // Mouth: suckling and little "o" shapes; a slack gape while staring.
  const suck = Math.max(0, Math.sin(k * 2.3 + p[5] + Math.sin(k * 0.6 + p[6]) * 2));
  const o = b.stare > 0 ? 0.9 * Math.min(1, b.stare) : 0.06 + 0.3 * suck * (0.5 + 0.5 * wob(0.21, p[7]));
  b.mouth.scale.set(0.0115 * (1 - 0.2 * o), 0.0012 + 0.0055 * o, 0.0055);
  b.lips.scale.set(1.15 - 0.25 * o, 0.38 + 0.5 * o, 0.7);

  // Arms wave, wrists turn, fingers curl and grip — every hand on its own clock.
  for (const a of b.arms) {
    const q = p[8] + a.side * 1.7;
    const sx = lie ? -1.0 : -0.55, sz = a.side * (lie ? 0.55 : 0.32);
    a.sh.rotation.set(sx + 0.28 * Math.sin(k * 1.3 + q) + 0.1 * Math.sin(k * 3.1 + q * 2), 0.2 * Math.sin(k * 0.9 + q), sz + a.side * 0.18 * Math.sin(k * 1.1 + q * 1.3));
    a.el.rotation.set((lie ? -1.25 : -1.15) + 0.3 * Math.sin(k * 1.7 + q * 0.7), 0, 0);
    a.wr.rotation.set(0.25 * Math.sin(k * 2.1 + q), 0.3 * Math.sin(k * 1.4 + q), 0);
    const gi = a.side < 0 ? 0 : 1;
    b.grip[gi] += ((Math.sin(k * 0.45 + q * 3) > 0.6 ? 1 : 0) - b.grip[gi]) * Math.min(1, dt * 3);
    const curl = 0.35 + 0.25 * Math.sin(k * 1.9 + q) + 0.45 * b.grip[gi];
    a.fingers.forEach(([f, d], fi) => {
      const c = curl + 0.08 * Math.sin(k * 2.6 + fi);
      f.rotation.x = -c * (fi === 4 ? 0.6 : 1.1);
      d.rotation.x = -c * (fi === 4 ? 0.7 : 1.3);
    });
  }

  // Legs: little wiggles sitting; proper bicycle kicks lying down.
  b.kick += ((Math.sin(k * 0.3 + p[9]) > 0.2 ? 1 : 0.25) - b.kick) * Math.min(1, dt * 1.5);
  for (const l of b.legs) {
    const q = p[10] + (l.side > 0 ? Math.PI : 0);
    const amp = lie ? 0.4 * b.kick : 0.1;
    const f = lie ? 2.6 : 1.2;
    l.hip.rotation.set((lie ? -1.45 : -1.6) + amp * Math.sin(k * f + q), 0, l.side * 0.5 + 0.06 * Math.sin(k * 0.8 + q));
    l.knee.rotation.set((lie ? 1.35 : 0.35) + amp * 1.2 * Math.sin(k * f + q + 0.9), 0, 0);
    l.ankle.rotation.set((lie ? -0.25 : -0.55) + 0.2 * Math.sin(k * 1.5 + q), 0, 0.15 * Math.sin(k * 1.1 + q));
  }
}

// ---------- lighting ----------

function buildLights() {
  const { scene } = ctx;
  scene.background = new THREE.Color(0xeef2f4);
  scene.fog = new THREE.FogExp2(0xeef2f4, 0.006);
  tint(scene.background, 0x4a0000);
  tint(scene.fog.color, 0x5a0000);

  const hemi = new THREE.HemisphereLight(0xf2f6fa, 0xd8dcde, 0.3);
  // Key light from the ceiling troughs; its shadow frustum follows the player along the belt.
  const key = new THREE.DirectionalLight(0xf6f9ff, 1.5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.up.set(0, 0, -1);
  Object.assign(key.shadow.camera, { left: -2.6, right: 2.6, top: 13, bottom: -5, near: 1, far: 20 });
  key.shadow.bias = -0.0003;
  key.shadow.normalBias = 0.02;
  scene.add(hemi, key, key.target);
  tint(hemi.color, 0xff1a10);
  tint(hemi.groundColor, 0x3a0000);
  tint(key.color, 0xff2414);
  s.key = key;
}

function placeKey() {
  const z = beltZ - 4;
  s.key.target.position.set(0, 0, z);
  s.key.position.set(0.8, 12, z + 1.6);
}

// ---------- malfunction ----------

async function malfunction() {
  const { player, camera, audio, effects } = ctx;
  phase = 'error';
  audio.tone(55, 0.5, { type: 'square', volume: 0.2 }); // belt clunks to a stop

  // Freeze the player and turn their head up to the sign.
  player.enabled = false;
  camBase = camera.position.clone();
  // Matrix4.lookAt uses the camera convention (looks down -z), unlike Object3D.lookAt.
  const m = new THREE.Matrix4().lookAt(camBase, SIGN_POS, new V3(0, 1, 0));
  lookQ = new THREE.Quaternion().setFromRotationMatrix(m);

  await wait(700);
  if (!alive) return;

  // Lights stutter while the sign glitches between states.
  const frames = ['BACK TO REAL WORLD', 'BACK TO REAL DLROW', 'BACK TO REAL WORLD', 'DLROW', 'BACK TO REAL DLROW', 'DLROW'];
  for (let i = 0; i < frames.length; i++) {
    const on = i % 2 === 1;
    drawSign(frames[i], on);
    redT = on ? 1 : 0.15;
    applyRed(redT);
    audio.tone(200 + Math.random() * 600, 0.07, { type: 'square', volume: 0.08 });
    await wait(80 + Math.random() * 90);
    if (!alive) return;
  }
  drawSign('DLROW', true);
  s.beacon.emissive.set(0xff1010);
  drawScreen('error');
  redTarget = 1;

  await effects.error({ duration: 3200, audio });
  if (!alive) return;
  effects.setFade(1); // the crash cuts straight to black
  ctx.goTo(NEXT);
}

// ---------- curtains ----------

/** Lead strips: damped physical pendulums, pushed open by the babies and settling after they pass. */
function updateCurtains(dt, pushers) {
  const G = 9.81;
  for (const st of s.strips) {
    const Py = st.pivot.position.y;
    let req = 0, side = 0;
    for (const o of pushers) {
      const dx = o.x - st.pivot.position.x;
      if (Math.abs(dx) > o.halfW + st.half) continue;
      const H = Py - o.top;
      if (H >= st.len) continue;
      const front = o.z - o.halfLen, rear = o.z + o.halfLen;
      const dPast = st.z - front;            // how far the leading edge is through the curtain plane
      if (dPast <= 0) continue;
      const slide = Math.acos(H / st.len);   // angle at which the strip tip rides on top of the baby
      if (st.z - rear > st.len * Math.sin(slide)) continue; // already past the strip's tip
      const a = Math.min(slide, Math.atan2(dPast, H));
      if (a > req) { req = a; side = Math.sign(-dx) || 1; }
    }
    // Physical pendulum (uniform strip: ω² = 3g / 2L) with heavy damping.
    st.w += (-(3 * G) / (2 * st.len) * Math.sin(st.a) - 1.7 * st.w) * dt;
    st.a += st.w * dt;
    if (st.a < req) { st.w = Math.max(st.w, (req - st.a) / Math.max(dt, 1e-3)); st.a = req; }
    st.twist += ((req > 0.05 ? side * 0.22 * (req / 0.7) : 0) - st.twist) * Math.min(1, dt * 4);
    st.pivot.rotation.set(st.a, st.twist * 0.5, st.twist);
  }
}

// ---------- scene ----------

export default {
  name: NAME,

  async init(c) {
    ctx = c;
    alive = true;
    phase = 'belt';
    time = 0; tickTimer = 0; beltZ = SPAWN_Z;
    redT = 0; redTarget = 0;
    lookQ = null; camBase = null;
    s = { tints: [], envMats: [] };
    ctx.post?.set(POST);

    const [tex] = await Promise.all([
      loadTextures(),
      ctx.setEnvironment ? ctx.setEnvironment(HDRI).catch((e) => console.warn('conveyor: HDRI failed to load', e)) : null,
    ]);
    if (ctx !== c || !alive) return; // left the scene while loading

    const rand = rng(4127);
    const M = makeMaterials(tex, rand);
    s.envMats.push(...M.envMats);
    tint(M.diffuser.emissive, 0xff1a10);

    buildLights();
    buildRoom(M, rand);
    buildConveyor(M);
    buildScanner(M);
    s.labelBatch.build(ctx.scene);
    Object.assign(s, buildBabies(M, rand));
    placeKey();

    ctx.player.spawn(new V3(0, BELT_Y, SPAWN_Z), 0);
  },

  update(dt) {
    if (!ctx || !s?.babies) return;
    const { player, camera, audio } = ctx;
    time += dt;

    // The belt only runs while the game has the pointer (not behind the start overlay).
    const v = phase === 'belt' && player.locked ? BELT_SPEED : 0;
    if (v) {
      beltZ -= v * dt;
      for (const m of s.beltMaps) m.offset.y -= (v * dt) / BELT_TILE;
      s.rollerMap.offset.x -= (v * dt) / (TAU * ROLLER_R);
      tickTimer += dt;
      if (tickTimer > 0.75) {
        tickTimer = 0;
        audio.tone(160, 0.04, { type: 'square', volume: 0.012 });
      }
    }

    // No walking or jumping: the belt owns the player's position. player.update() has already run
    // this frame, so undo whatever WASD/SPACE did and re-place the camera; mouse look is untouched.
    if (phase === 'belt') {
      player.position.set(0, BELT_Y, beltZ);
      player.velocity.set(0, 0, 0);
      player.grounded = true;
      camera.position.set(0, BELT_Y + EYE_HEIGHT, beltZ);
    }
    placeKey();

    // Babies ride the belt, live, and vanish into the dark tunnel.
    const pushers = [];
    for (const b of s.babies) {
      const p = b.root.position;
      p.z -= v * dt;
      if (!b.beeped && p.z < CURTAIN_Z) {
        b.beeped = true;
        audio.tone(1046, 0.15, { volume: 0.06 });
        setTimeout(() => alive && audio.tone(784, 0.25, { volume: 0.06 }), 150);
        s.screen.count++;
        drawScreen('ok');
      }
      const gone = p.z < VOID_Z;
      b.root.scale.setScalar(gone ? 1e-4 : BABY_SCALE);
      if (gone) continue;
      if (phase === 'error' && redT > 0.5) {
        b.stareDelay -= dt;
        if (b.stareDelay <= 0) b.stare = Math.min(1.2, b.stare + dt * 1.6);
      }
      animateBaby(b, dt, time, camera.position);
      pushers.push({ x: p.x, z: p.z, halfLen: b.halfLen, halfW: b.halfW, top: BELT_Y + b.top });
    }
    s.rig.updateMatrixWorld(true);
    for (const { mesh, nodes } of s.meshes) {
      for (let i = 0; i < nodes.length; i++) mesh.setMatrixAt(i, nodes[i].matrixWorld);
      mesh.instanceMatrix.needsUpdate = true;
    }
    updateCurtains(dt, pushers);

    // Status LEDs; the CCTV camera pans to follow the player.
    s.leds.run.emissiveIntensity = phase === 'belt' ? (Math.sin(time * 4) > 0 ? 3 : 0.4) : 0;
    s.leds.fault.emissiveIntensity = phase === 'error' ? (Math.sin(time * 18) > 0 ? 4 : 0) : 0;
    const cc = s.cctv;
    cc.root.updateWorldMatrix(true, false);
    const local = cc.root.worldToLocal(_v.copy(camera.position)).sub(cc.pan.position);
    cc.pan.rotation.y += (Math.atan2(local.x, local.z) - cc.pan.rotation.y) * Math.min(1, dt * 1.5);
    cc.tilt.rotation.x += (-Math.atan2(local.y, Math.hypot(local.x, local.z)) - cc.tilt.rotation.x) * Math.min(1, dt * 1.5);
    cc.ledMat.emissiveIntensity = Math.sin(time * 3) > 0.7 || phase === 'error' ? 4 : 0.2;

    if (phase === 'belt' && player.position.z <= TRIGGER_Z) malfunction();

    if (phase === 'error') {
      if (redTarget > redT) {
        redT = Math.min(redTarget, redT + dt * 2);
        applyRed(redT);
      }
      if (lookQ) camera.quaternion.slerp(lookQ, 1 - Math.exp(-dt * 3));
      if (camBase) {
        const shake = 0.04 * redT;
        camera.position.copy(camBase).add(new V3(
          (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake));
      }
    }
  },

  dispose() {
    alive = false;
    ctx = null;
    s = null;
  },
};
