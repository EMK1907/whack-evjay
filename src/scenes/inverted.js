import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Inverted world — docs/GAME.md §4–6. Owner: Emir.
//
// World layout (world Y axis): normal ground at y=0, the world's "ceiling" at y=CEIL.
// The player arrives with flipped gravity and lands on the ceiling, so a dark, wet, red-lit old
// European city (all buildings stand on the ground, none higher than MAX_TOP) hangs upside down
// above them. Blocks of 2–4 storey brick/plaster houses with tiled roofs, modern towers at the edge,
// flagstone pavements, asphalt roads with puddles, cast-iron street lamps with red glass.
// The pressure plate is a swirling golden particle portal on the GROUND (plaza at PLATE). Standing
// on the ceiling directly vertically opposite it and jumping (SPACE) flips gravity and drops the
// player onto it; jumping on it flips back.
//
// §6: a holographic Earth globe stands in another plaza on the ground. E on it → ERROR! glitch →
// it becomes a miniature Quirkland (candy-strewn hills under a dome of grinning mouths) with a small
// friendly fire hydrant on it → the whole dark world (everything in the `world` group) is pulled
// into the globe → the camera dollies in until the globe fills the view, holds → white flash →
// goTo('quirkland') fading in from white. No text; ~7.3s.
//
// Assets (assets/CREDITS.md) load through ctx.assets / ctx.setEnvironment; without them (e.g. in
// Node tests) everything falls back to plain materials.

const CEIL = 30;
const MAX_TOP = CEIL - 6;      // nothing on the ground may rise above this (≥6m gap to the ceiling)
const HALF = 56;               // half-size of the playable area
const LOTS = [-40, -24, -8, 8, 24, 40];
const LOT_HALF = 6;            // each block is 12×12 m; 4 m roads between blocks
const SIDEWALK = 1.5;          // pavement ring around the buildings of a block
const BUILD_HALF = LOT_HALF - SIDEWALK;
const KERB_H = 0.15;           // pavement height above the road
const FLOOR_H = 3.1;           // storey height
const PLATE = new THREE.Vector2(8, -8); // pressure-plate portal centre (x, z) — plaza lot
const ZONE_R = 1.2;            // horizontal tolerance for "directly opposite" the portal
const FLIP_DELAY = 0.18;       // seconds into the jump before gravity flips
const SPAWN = new THREE.Vector3(0, 4, 6);
const HYDRANT_PROP = new THREE.Vector3(2.75, KERB_H, 5.2); // weathered hydrant on the pavement near the start

const GLOBE = new THREE.Vector3(-24, 2.4, 24); // globe centre — plaza lot (-24, 24), on the ground
const GLOBE_R = 1.1;
const GLOBE_REACH = 4.5;       // interact distance

const ASSET_ROOT = 'assets';
const TEXTURE_SETS = {
  brick: 'red_brick_03', plaster: 'peeling_painted_wall', pavers: 'stone_pavers', asphalt: 'asphalt_02',
  roof: 'clay_roof_tiles_02', metal: 'rusty_metal_02', shutter: 'rusted_shutter', wood: 'wood_peeling_paint_weathered',
};
const HDRI = `${ASSET_ROOT}/hdri/cobblestone_street_night_1k.hdr`;
const FOG = { color: 0x1c0907, density: 0.03 };

// Globe sequence timeline (seconds after pressing E). goTo at 7.0s, Quirkland visible ~7.4s.
const T = {
  error: 1.4,      // ERROR! effect; the hologram glitches
  morph: 1.0,      // hologram starts cross-fading into the mini world…
  morphEnd: 2.2,   // …fully transformed
  pull: 3.2,       // the dark world starts being pulled into the globe…
  pullEnd: 5.0,    // …and is gone; the camera pushes in
  settle: 6.3,     // camera has eased to a stop with the globe filling the view (holds)
  flash: 6.6,      // white flash (0.3s) → goTo('quirkland'), which fades in from white
};

// Post-processing looks: the dark night city needs an exposure lift under ACES and bloom on the
// lamps; the bright mini world after E needs both back down (blended during the reveal).
const POST_DARK = { exposure: 1.2, bloomStrength: 0.6, bloomThreshold: 1.0 };
const POST_MINI = { exposure: 0.95, bloomStrength: 0.22, bloomThreshold: 1.1 };

let ctx = null;
let s = null;   // per-run state
let seq = null; // globe sequence state (null until E is pressed)

// ---------- helpers ----------

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const TAU = Math.PI * 2;
const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toTexture(canvas, repeat = 1) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function radialTexture(stops) {
  const c = makeCanvas(128, 128), g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [at, col] of stops) grad.addColorStop(at, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return toTexture(c, 1);
}

const glowTexture = () => radialTexture([[0, 'rgba(255,220,120,1)'], [0.35, 'rgba(255,170,40,0.45)'], [1, 'rgba(255,140,0,0)']]);

function inZone(pos) {
  return Math.hypot(pos.x - PLATE.x, pos.z - PLATE.y) < ZONE_R;
}

/** Box with UVs in tiles of [tw, th] metres on every face, so tiling PBR textures keep a real-world scale. */
function boxGeometry(w, h, d, [tw, th] = [1, 1]) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  const faceW = [d, d, w, w, w, w]; // +x -x +y -y +z -z
  const faceH = [h, h, d, d, h, h];
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, (uv.getX(k) * faceW[f]) / tw, (uv.getY(k) * faceH[f]) / th);
    }
  }
  return geo;
}

/** Matrix from position + yaw (about Y) + optional roll (about Z) and pitch (about X). */
function mat(x, y, z, yaw = 0, roll = 0, pitch = 0) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ')),
    new THREE.Vector3(1, 1, 1),
  );
}

/**
 * Collects geometry for one material and merges it into a single mesh (one draw call). Keeps only
 * position/normal/uv (+ colour when vertexColors), so any indexed geometry can be added.
 */
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

/** Invisible collision box (the detailed visuals are merged meshes; raycasts stay cheap). */
function colliderBox(parent, colliders, w, h, d, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial());
  m.position.set(x, y, z);
  m.visible = false;
  m.userData.isCollider = true;
  parent.add(m);
  colliders.push(m);
  return m;
}

// ---------- materials ----------

async function loadTextures() {
  if (!ctx.assets) return {};
  const sets = await Promise.all(Object.entries(TEXTURE_SETS).map(async ([key, folder]) => {
    try { return [key, await ctx.assets.textures(`${ASSET_ROOT}/textures/${folder}`)]; } catch { return [key, {}]; }
  }));
  return Object.fromEntries(sets);
}

/** Dark curtain-wall glass with mullions and random lit offices (tile 8m × 16m). Returns [map, emissiveMap]. */
function modernFacade(rand) {
  const W = 256, H = 512, cols = 8, rows = 16;
  const c = makeCanvas(W, H), e = makeCanvas(W, H);
  const g = c.getContext('2d'), ge = e.getContext('2d');
  g.fillStyle = '#16181c';
  g.fillRect(0, 0, W, H);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, W, H);
  const cw = W / cols, ch = H / rows;
  for (let r = 0; r < rows; r++) {
    const floorLit = rand() < 0.35; // whole floors tend to be lit together
    for (let col = 0; col < cols; col++) {
      const lit = rand() < (floorLit ? 0.6 : 0.08);
      const x = col * cw + 2, y = r * ch + 3, w = cw - 4, h = ch - 7;
      const glass = g.createLinearGradient(x, y, x + w, y + h);
      glass.addColorStop(0, '#20262e');
      glass.addColorStop(1, '#0c0e12');
      g.fillStyle = glass;
      g.fillRect(x, y, w, h);
      if (lit) {
        const warm = rand() < 0.7;
        const col2 = warm ? `rgb(255,${190 + rand() * 40 | 0},${120 + rand() * 50 | 0})` : `rgb(${170 + rand() * 40 | 0},${200 + rand() * 30 | 0},255)`;
        g.fillStyle = col2;
        g.fillRect(x, y, w, h);
        ge.fillStyle = col2;
        ge.globalAlpha = 0.55 + rand() * 0.45;
        ge.fillRect(x, y, w, h);
        ge.globalAlpha = 1;
      }
    }
    g.fillStyle = '#2a2c30'; // spandrel / floor slab
    g.fillRect(0, r * ch + ch - 4, W, 4);
  }
  return [toTexture(c), toTexture(e)];
}

/** Soft irregular puddle shapes, 2×2 atlas (alpha in grey). */
function puddleAtlas(rand) {
  const S = 512, c = makeCanvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  for (let q = 0; q < 4; q++) {
    const ox = (q % 2) * 256, oy = Math.floor(q / 2) * 256;
    g.save();
    g.beginPath();
    g.rect(ox, oy, 256, 256);
    g.clip();
    for (let i = 0; i < 14; i++) {
      const x = ox + 128 + (rand() - 0.5) * 120, y = oy + 128 + (rand() - 0.5) * 80, r = 25 + rand() * 45;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.7, 'rgba(255,255,255,0.9)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
    }
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

function makeMaterials(tex, rand) {
  // envMapIntensity: the night HDRI only adds a hint of reflection; the red lamps should dominate.
  const std = (maps, o) => new THREE.MeshStandardMaterial({ envMapIntensity: 0.3, ...(maps || {}), ...o });
  const [skyMap, skyEmissive] = modernFacade(rand);
  const [skyMap2, skyEmissive2] = modernFacade(rand);
  const M = {
    brick: std(tex.brick, { color: 0xa8968c, roughness: 1 }),
    plaster: ['#c8b496', '#b99c8a', '#a6a496', '#c09c80'].map((c) => std(tex.plaster, { color: c, roughness: 1 })),
    stone: std(tex.pavers, { color: 0xb3a99c, roughness: 1 }),
    roof: std(tex.roof, { color: 0x9c8078, roughness: 1 }),
    wood: std(tex.wood, { color: 0x7a6a5c, roughness: 1 }),
    shutter: std(tex.shutter, { color: 0x9a8c80, roughness: 1 }),
    iron: std(tex.metal, { color: 0x34302e, metalness: 0.55, roughness: 0.85 }),
    hydrant: std(tex.metal, { color: 0xc23a2a, metalness: 0.35, roughness: 0.9 }),
    paint: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65, envMapIntensity: 0.3 }),
    carPaint: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 0.35, envMapIntensity: 0.35 }),
    // Low env reflection: the HDRI's own (bright) street lamps would otherwise glare in every pane.
    glass: new THREE.MeshStandardMaterial({ color: 0x0b0e13, roughness: 0.2, metalness: 0.2, envMapIntensity: 0.22 }),
    glassLit: new THREE.MeshBasicMaterial({ vertexColors: true }),
    pavement: std(tex.pavers, { color: 0x8c847c, roughness: 0.85 }),
    asphalt: std(tex.asphalt, { color: 0x6e6864, roughness: 0.8 }),
    ceiling: std(tex.pavers, { color: 0xd0a69c, roughness: 0.95 }),
    tower: [
      new THREE.MeshStandardMaterial({ map: skyMap, emissiveMap: skyEmissive, emissive: 0xffffff, emissiveIntensity: 0.8, roughness: 0.25, metalness: 0.6, envMapIntensity: 0.6 }),
      new THREE.MeshStandardMaterial({ map: skyMap2, emissiveMap: skyEmissive2, emissive: 0xffffff, emissiveIntensity: 0.8, roughness: 0.25, metalness: 0.6, envMapIntensity: 0.6 }),
    ],
    concrete: new THREE.MeshStandardMaterial({ color: 0x3a3836, roughness: 0.9 }),
    // Georgian white stucco: smooth painted render (only a hint of the plaster relief, no peeling colour map).
    stucco: new THREE.MeshStandardMaterial({ color: 0xf2ede2, roughness: 0.85, envMapIntensity: 0.3, normalMap: tex.plaster?.normalMap || null, normalScale: new THREE.Vector2(0.25, 0.25) }),
    sandstone: std(tex.pavers, { color: 0xd8bd86, roughness: 1 }),      // Elizabeth Tower
    gold: new THREE.MeshStandardMaterial({ color: 0xc9a13a, metalness: 1, roughness: 0.3, envMapIntensity: 0.5 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x111112, roughness: 0.9 }),
    signs: new THREE.MeshStandardMaterial({ map: streetSignAtlas(), roughness: 0.6, envMapIntensity: 0.3, emissive: 0xffffff, emissiveIntensity: 0.12 }),
    puddle: new THREE.MeshStandardMaterial({
      // The scene's lamps give the puddles their highlights; no HDRI reflection (its own lamps are far too bright).
      color: 0x050303, roughness: 0.1, metalness: 0, envMapIntensity: 0, alphaMap: puddleAtlas(rand),
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
  };
  M.signs.emissiveMap = M.signs.map; // street plates catch a little light at night
  return M;
}

// ---------- old houses ----------

const FRAME_COLORS = ['#e8e2d4', '#2f4a3a', '#5a3a2a', '#7a1f1f', '#3a3e44'].map((c) => new THREE.Color(c));
const LIT_COLORS = [[1.0, 0.62, 0.28], [1.0, 0.5, 0.22], [1.0, 0.72, 0.42], [0.55, 0.62, 0.95]];

function houseKit(B, rand) {
  // Shared unit geometries for window parts (cloned per use by Batch.add).
  const G = {
    glass: new THREE.BoxGeometry(0.9, 1.45, 0.02),
    frameH: new THREE.BoxGeometry(1.05, 0.08, 0.12),
    frameV: new THREE.BoxGeometry(0.08, 1.53, 0.12),
    mullion: new THREE.BoxGeometry(0.05, 1.45, 0.06),
    transom: new THREE.BoxGeometry(0.9, 0.05, 0.06),
    sill: boxGeometry(1.25, 0.07, 0.24, [2, 2]),
    lintel: boxGeometry(1.25, 0.18, 0.08, [2, 2]),
    shutter: boxGeometry(0.48, 1.5, 0.04, [1.2, 1.2]),
    door: boxGeometry(1.05, 2.2, 0.08, [1.2, 2.4]),
    jamb: boxGeometry(0.16, 2.4, 0.14, [2, 2]),
    head: boxGeometry(1.4, 0.2, 0.16, [2, 2]),
    step: boxGeometry(1.4, 0.14, 0.4, [2, 2]),
    garage: boxGeometry(2.6, 2.4, 0.06, [2.6, 2.4]),
    garageHead: boxGeometry(3.0, 0.22, 0.14, [2, 2]),
  };

  /** Window centred at face-local (x, y) on a face whose matrix maps local +Z to the outward normal. */
  function windowAt(face, x, y, litChance, frameColor = null) {
    const at = (gx, gy, gz) => face.clone().multiply(mat(x + gx, y + gy, gz));
    const frame = frameColor || pick(rand, FRAME_COLORS);
    if (rand() < litChance) B.glassLit.add(G.glass, at(0, 0, 0.0), new THREE.Color(...pick(rand, LIT_COLORS)).multiplyScalar(0.35 + rand() * 0.5));
    else B.glass.add(G.glass, at(0, 0, 0.0));
    B.paint.add(G.frameH, at(0, 0.765, 0.04), frame);
    B.paint.add(G.frameH, at(0, -0.765, 0.04), frame);
    B.paint.add(G.frameV, at(-0.485, 0, 0.04), frame);
    B.paint.add(G.frameV, at(0.485, 0, 0.04), frame);
    B.paint.add(G.mullion, at(0, 0, 0.02), frame);
    B.paint.add(G.transom, at(0, 0.35, 0.02), frame);
    B.stone.add(G.sill, at(0, -0.83, 0.1));
    B.stone.add(G.lintel, at(0, 0.88, 0.03));
    if (rand() < 0.3) { // wooden shutters, folded open
      B.wood.add(G.shutter, at(-0.78, 0, 0.04));
      B.wood.add(G.shutter, at(0.78, 0, 0.04));
    }
  }

  function doorAt(face, x, base) {
    const at = (gx, gy, gz) => face.clone().multiply(mat(x + gx, base + gy, gz));
    B.wood.add(G.door, at(0, 1.1, -0.02));
    B.stone.add(G.jamb, at(-0.6, 1.2, 0.03));
    B.stone.add(G.jamb, at(0.6, 1.2, 0.03));
    B.stone.add(G.head, at(0, 2.45, 0.04));
    B.stone.add(G.step, at(0, 0.07, 0.2));
  }

  function garageAt(face, x, base) {
    const at = (gx, gy, gz) => face.clone().multiply(mat(x + gx, base + gy, gz));
    B.shutter.add(G.garage, at(0, 1.2, -0.01));
    B.stone.add(G.garageHead, at(0, 2.5, 0.04));
  }

  return { windowAt, doorAt, garageAt };
}

/** Gable roof (ridge along local Z) with tiled slopes, eaves overhang and wall-material gable ends. */
function addRoof(B, wallBatch, M0, span, len, rh) {
  const o = 0.35, t = 0.14;
  const ang = Math.atan2(rh, span / 2);
  const L = (span / 2 + o) / Math.cos(ang);
  const slope = boxGeometry(L, t, len + 2 * o, [2, 2]);
  for (const side of [-1, 1]) {
    // From the eave (±(span/2+o), -o·tan) to the ridge (0, rh); lift by half the thickness along the normal.
    const ex = side * (span / 2 + o), ey = -o * Math.tan(ang);
    const cx = ex / 2, cy = (ey + rh) / 2;
    const nx = side * Math.sin(ang), ny = Math.cos(ang);
    B.roof.add(slope, M0.clone().multiply(mat(cx + nx * t / 2, cy + ny * t / 2, 0, 0, -side * ang)));
  }
  const tri = new THREE.BufferGeometry();
  const hw = span / 2;
  for (const zs of [-1, 1]) {
    const z = zs * len / 2;
    const pos = zs > 0 ? [-hw, 0, z, hw, 0, z, 0, rh, z] : [hw, 0, z, -hw, 0, z, 0, rh, z];
    const g = tri.clone();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, zs, 0, 0, zs, 0, 0, zs], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([pos[0] / 2, 0, pos[3] / 2, 0, 0, rh / 2], 2));
    g.setIndex([0, 1, 2]);
    wallBatch.add(g, M0);
  }
}

/**
 * One house: walls, plinth, cornice, roof, chimneys, windows/doors on street faces.
 * style 'old': 2–4 storey brick/plaster with a tiled gable roof. style 'georgian': London white-stucco
 * terrace house, 3–4 storeys, flat roof behind a parapet, columned porch, railings, white sash frames.
 */
function addHouse(B, kit, rand, parent, colliders, cx, cz, w, d, lotX, lotZ, style = 'old') {
  const base = KERB_H;
  const georgian = style === 'georgian';
  const floors = georgian ? 3 + (rand() < 0.5 ? 1 : 0) : 2 + Math.floor(rand() * 3);
  const wallH = 0.6 + floors * FLOOR_H;
  const brick = rand() < 0.4;
  const wallBatch = georgian ? B.stucco : brick ? B.brick : pick(rand, B.plaster);
  const wallTile = brick && !georgian ? [2, 2] : [2.5, 2.5];
  const frameColor = georgian ? new THREE.Color('#f2efe6') : null;

  wallBatch.add(boxGeometry(w, wallH, d, wallTile), mat(cx, base + wallH / 2, cz));
  B.stone.add(boxGeometry(w + 0.08, 0.6, d + 0.08, [2, 2]), mat(cx, base + 0.3, cz));                      // plinth
  B.stone.add(boxGeometry(w + 0.1, 0.12, d + 0.1, [2, 2]), mat(cx, base + 0.6 + FLOOR_H, cz));              // string course
  B.stone.add(boxGeometry(w + 0.3, 0.22, d + 0.3, [2, 2]), mat(cx, base + wallH - 0.05, cz));               // cornice

  let rh;
  if (georgian) {
    // Flat roof hidden behind a stucco parapet, with a brick chimney stack and pots on the party wall.
    rh = 0.8;
    B.stucco.add(boxGeometry(w + 0.02, 0.8, d + 0.02, [2.5, 2.5]), mat(cx, base + wallH + 0.4, cz));
    B.stone.add(boxGeometry(w + 0.12, 0.1, d + 0.12, [2, 2]), mat(cx, base + wallH + 0.85, cz));
    const sx = cx + (w <= d ? w / 2 - 0.3 : 0), sz = cz + (w <= d ? 0 : d / 2 - 0.3);
    B.brick.add(boxGeometry(w <= d ? 0.5 : 1.4, 1.3, w <= d ? 1.4 : 0.5, [2, 2]), mat(sx, base + wallH + 1.45, sz));
    for (const k of [-0.4, 0, 0.4]) B.roof.add(new THREE.CylinderGeometry(0.1, 0.12, 0.4, 8), mat(sx + (w <= d ? 0 : k), base + wallH + 2.3, sz + (w <= d ? k : 0)));
  } else {
    // Roof: ridge along the longer side; keep everything under MAX_TOP.
    const alongZ = d >= w;
    const span = alongZ ? w : d, len = alongZ ? d : w;
    const roofBase = base + wallH + 0.06;
    rh = Math.min((span / 2) * Math.tan(0.6 + rand() * 0.25), MAX_TOP - 2 - roofBase);
    const M0 = mat(cx, roofBase, cz, alongZ ? 0 : Math.PI / 2);
    addRoof(B, wallBatch, M0, span, len, rh);
    for (let i = 0; i < 1 + (rand() < 0.5 ? 1 : 0); i++) { // chimneys poke through the slope
      const lx = (rand() < 0.5 ? -1 : 1) * span * 0.18, lz = (rand() - 0.5) * len * 0.6;
      const h = rh + 0.6 + rand() * 0.8;
      B.brick.add(boxGeometry(0.55, h, 0.55, [2, 2]), M0.clone().multiply(mat(lx, h / 2, lz)));
      B.stone.add(boxGeometry(0.7, 0.1, 0.7, [2, 2]), M0.clone().multiply(mat(lx, h + 0.05, lz)));
    }
  }
  colliderBox(parent, colliders, w, wallH + rh, d, cx, base + (wallH + rh) / 2, cz);

  // Street-facing facades: those on the block's outer edge.
  const faces = [
    { n: [1, 0], at: cx + w / 2, edge: lotX + BUILD_HALF, width: d, ox: cx + w / 2, oz: cz },
    { n: [-1, 0], at: cx - w / 2, edge: lotX - BUILD_HALF, width: d, ox: cx - w / 2, oz: cz },
    { n: [0, 1], at: cz + d / 2, edge: lotZ + BUILD_HALF, width: w, ox: cx, oz: cz + d / 2 },
    { n: [0, -1], at: cz - d / 2, edge: lotZ - BUILD_HALF, width: w, ox: cx, oz: cz - d / 2 },
  ].filter((f) => Math.abs(f.at - f.edge) < 0.01);
  if (georgian) faces.sort((a, b) => a.width - b.width); // front door on the narrow terrace front
  let doorDone = false;
  for (const f of faces) {
    const face = mat(f.ox, 0, f.oz, Math.atan2(f.n[0], f.n[1]));
    const slots = Math.max(1, Math.floor((f.width - 0.6) / 1.75));
    const xs = Array.from({ length: slots }, (_, i) => (i + 0.5) * (f.width / slots) - f.width / 2);
    // Ground floor: a door (one per house), sometimes a garage shutter, otherwise windows.
    let used = [];
    if (!doorDone && georgian) {
      const dx = xs[Math.floor(slots / 2)];
      georgianDoor(B, face, dx, base);
      railings(B, face, f.width, dx, base);
      used = [[dx - 0.9, dx + 0.9]];
      doorDone = true;
    } else if (!doorDone) {
      if (f.width >= 4 && rand() < 0.3) {
        kit.garageAt(face, -f.width / 2 + 1.7, base);
        kit.doorAt(face, f.width / 2 - 0.9, base);
        used = [[-f.width / 2 + 0.2, -f.width / 2 + 3.2], [f.width / 2 - 1.6, f.width / 2]];
      } else {
        const dx = xs[Math.floor(slots / 2)];
        kit.doorAt(face, dx, base);
        used = [[dx - 0.9, dx + 0.9]];
      }
      doorDone = true;
    }
    for (const x of xs) {
      if (!used.some(([a, b]) => x + 0.6 > a && x - 0.6 < b)) kit.windowAt(face, x, base + 0.6 + 1.55, 0.18, frameColor);
    }
    for (let fl = 1; fl < floors; fl++) {
      for (const x of xs) kit.windowAt(face, x, base + 0.6 + fl * FLOOR_H + 1.55, 0.3, frameColor);
    }
  }
}

const BLOCK_LAYOUTS = [
  [[-2.25, 0, 4.5, 9], [2.25, 0, 4.5, 9]],
  [[0, -2.25, 9, 4.5], [0, 2.25, 9, 4.5]],
  [[-3, 0, 3, 9], [0, 0, 3, 9], [3, 0, 3, 9]],
  [[-2.25, -2.25, 4.5, 4.5], [2.25, -2.25, 4.5, 4.5], [-2.25, 2.25, 4.5, 4.5], [2.25, 2.25, 4.5, 4.5]],
  [[0, -3, 9, 3], [0, 0, 9, 3], [0, 3, 9, 3]],
];

/** Keep only the faces of an indexed BoxGeometry whose material group passes `keep` (0..5 = +x −x +y −y +z −z). */
function boxFaces(geo, keep) {
  const idx = [];
  for (const g of geo.groups) if (keep(g.materialIndex)) for (let i = g.start; i < g.start + g.count; i++) idx.push(geo.index.getX(i));
  const out = geo.clone();
  out.setIndex(idx);
  out.clearGroups();
  return out;
}
const SIDES = (m) => m !== 2 && m !== 3;
const CAPS = (m) => m === 2 || m === 3;

/** Modern tower (background ring): dark curtain wall with lit offices, setback crown, antenna. Batched. */
function addTower(TB, rand, parent, colliders, lx, lz) {
  const w = 8 + rand(), d = 8 + rand();
  const h1 = 15 + rand() * 4;
  const facade = pick(rand, TB.facades);
  const h2 = 2.5 + rand() * 2;
  for (const [bw, bh, bd, y] of [[w, h1, d, KERB_H + h1 / 2], [w * 0.7, h2, d * 0.7, KERB_H + h1 + h2 / 2]]) {
    const box = boxGeometry(bw, bh, bd, [8, 16]);
    facade.add(boxFaces(box, SIDES), mat(lx, y, lz));
    TB.concrete.add(boxFaces(box, CAPS), mat(lx, y, lz));
  }
  const ah = Math.min(2 + rand() * 4, MAX_TOP - (KERB_H + h1 + h2));
  if (ah > 0.5) TB.metal.add(new THREE.CylinderGeometry(0.06, 0.08, ah, 6), mat(lx, KERB_H + h1 + h2 + ah / 2, lz));
  colliderBox(parent, colliders, w, h1 + h2, d, lx, KERB_H + (h1 + h2) / 2, lz);
}

// ---------- street furniture ----------

/** Ornate cast-iron street lamp: fluted post, scroll arm, hexagonal lantern. Returns { iron, glass, head }. */
function lampGeometry() {
  const iron = [], glass = [];
  const lathe = (pts, segs = 12) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), segs);
  iron.push(lathe([[0, 0], [0.24, 0], [0.24, 0.12], [0.2, 0.16], [0.17, 0.4], [0.2, 0.46], [0.13, 0.55], [0.1, 0.6],
    [0.075, 0.7], [0.07, 3.3], [0.1, 3.36], [0.1, 3.42], [0.06, 3.5], [0.05, 3.62], [0.08, 3.68], [0, 3.8]], 12));
  // Arm: rises and curls out to +X, ending in a hanger above the lantern.
  const arm = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 3.3, 0), new THREE.Vector3(0.25, 3.55, 0), new THREE.Vector3(0.6, 3.7, 0),
    new THREE.Vector3(0.85, 3.62, 0), new THREE.Vector3(0.92, 3.48, 0),
  ]);
  iron.push(new THREE.TubeGeometry(arm, 24, 0.028, 6, false));
  const scroll = new THREE.TorusGeometry(0.12, 0.018, 6, 16, Math.PI * 1.5);
  scroll.translate(0.22, 3.38, 0);
  iron.push(scroll);
  // Lantern (hangs at the arm end).
  const hx = 0.92, top = 3.45;
  const cap = new THREE.ConeGeometry(0.2, 0.18, 6);
  cap.translate(hx, top + 0.02, 0);
  const finial = new THREE.SphereGeometry(0.035, 8, 6);
  finial.translate(hx, top + 0.14, 0);
  const ring = new THREE.CylinderGeometry(0.17, 0.17, 0.04, 6);
  ring.translate(hx, top - 0.08, 0);
  const bottom = new THREE.CylinderGeometry(0.13, 0.06, 0.12, 6);
  bottom.translate(hx, top - 0.5, 0);
  iron.push(cap, finial, ring, bottom);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    const bar = new THREE.BoxGeometry(0.018, 0.38, 0.018);
    bar.translate(hx + Math.cos(a) * 0.155, top - 0.29, Math.sin(a) * 0.155);
    iron.push(bar);
  }
  const pane = new THREE.CylinderGeometry(0.15, 0.12, 0.38, 6, 1, true);
  pane.translate(hx, top - 0.29, 0);
  const bulb = new THREE.SphereGeometry(0.06, 10, 8);
  bulb.translate(hx, top - 0.3, 0);
  glass.push(pane, bulb);
  const clean = (list) => mergeGeometries(list.map((g) => {
    const c = g.index ? g : g.toNonIndexed();
    for (const k of Object.keys(c.attributes)) if (!['position', 'normal', 'uv'].includes(k)) c.deleteAttribute(k);
    return c.index ? c : (c.setIndex([...Array(c.attributes.position.count).keys()]), c);
  }), false);
  return { iron: clean(iron), glass: clean(glass), head: new THREE.Vector3(hx, top - 0.3, 0) };
}

/** Weathered cast-iron fire hydrant (realistic proportions, ~0.8 m). */
function makeHydrantProp(M) {
  const g = new THREE.Group();
  const lathe = new THREE.LatheGeometry([
    [0, 0], [0.17, 0], [0.17, 0.05], [0.13, 0.07], [0.12, 0.1], [0.12, 0.56], [0.145, 0.58], [0.145, 0.63],
    [0.12, 0.65], [0.11, 0.7], [0.07, 0.75], [0.04, 0.76], [0.04, 0.8], [0, 0.82],
  ].map(([r, y]) => new THREE.Vector2(r, y)), 20);
  const body = new THREE.Mesh(lathe, M.hydrant);
  g.add(body);
  const nozzle = (r, len, y, yaw) => {
    const n = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 14), M.hydrant);
    n.rotation.set(0, yaw, Math.PI / 2);
    const dir = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    n.position.copy(dir.clone().multiplyScalar(0.12 + len / 2)).setY(y);
    const capM = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.2, r * 1.2, 0.03, 6), M.iron);
    capM.rotation.copy(n.rotation);
    capM.position.copy(dir.clone().multiplyScalar(0.12 + len + 0.015)).setY(y);
    g.add(n, capM);
  };
  nozzle(0.05, 0.08, 0.44, Math.PI / 2);
  nozzle(0.05, 0.08, 0.44, -Math.PI / 2);
  nozzle(0.07, 0.07, 0.38, 0);
  const nut = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.05, 5), M.iron);
  nut.position.y = 0.8;
  g.add(nut);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

// ---------- London ----------
//
// Landmarks (scaled to fit under MAX_TOP) sit on their own lots; street details are merged into the
// shared batches. Text is drawn crisply on canvases and made HDR-bright so it blooms softly.

const LANDMARKS = {
  marshallWace: [-8, -8],   // right in front of the start view
  shard: [24, -24],
  gherkin: [-24, -40],
  bigBen: [-40, 8],
  londonEye: [40, 40],
};
const landmarkAt = (lx, lz) => Object.keys(LANDMARKS).find((k) => LANDMARKS[k][0] === lx && LANDMARKS[k][1] === lz);
const LONDON_RED = new THREE.Color('#c8102e');
const TAXI_BLACK = new THREE.Color('#0b0b0d');
const lit = (r, g, b) => new THREE.Color(r, g, b); // HDR colours for the unlit glow batch

function textTexture(text, { w = 2048, h = 256, size = 168, weight = 700, color = '#ffffff', spacing = 16 } = {}) {
  const c = makeCanvas(w, h), g = c.getContext('2d');
  g.font = `${weight} ${size}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = color;
  if ('letterSpacing' in g) g.letterSpacing = `${spacing}px`;
  g.fillText(text, w / 2, h / 2 + size * 0.04);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Cylinder between two points (for frames, legs, spokes). */
function cylinderBetween(a, b, r, segs = 8) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const geo = new THREE.CylinderGeometry(r, r, dir.length(), segs);
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()));
  geo.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return geo;
}

// ----- Marshall Wace: modern glass office with illuminated lettering -----

function addMarshallWace(B, TB, parent, colliders, lx, lz) {
  const w = 9, d = 9, h = 19.5, y0 = KERB_H;
  const body = boxGeometry(w, h, d, [8, 16]);
  TB.facades[0].add(boxFaces(body, SIDES), mat(lx, y0 + h / 2, lz));
  TB.concrete.add(boxFaces(body, CAPS), mat(lx, y0 + h / 2, lz));
  // Double-height lit lobby and a canopy on the two street fronts.
  B.glassLit.add(new THREE.BoxGeometry(w - 0.6, 3.4, 0.04), mat(lx, y0 + 1.9, lz + d / 2 + 0.03), lit(0.17, 0.14, 0.1));
  B.glassLit.add(new THREE.BoxGeometry(0.04, 3.4, d - 0.6), mat(lx + w / 2 + 0.03, y0 + 1.9, lz), lit(0.17, 0.14, 0.1));
  TB.concrete.add(boxGeometry(w + 0.6, 0.2, 1.4, [4, 4]), mat(lx, y0 + 3.8, lz + d / 2 + 0.6));
  TB.concrete.add(boxGeometry(4, 1.2, 3, [4, 4]), mat(lx - 1.5, y0 + h + 0.6, lz - 2));        // rooftop plant
  // Dark sign bands behind the lettering, for contrast.
  TB.concrete.add(boxGeometry(8.8, 1.5, 0.12, [4, 4]), mat(lx, y0 + h - 1.7, lz + d / 2 + 0.06));
  TB.concrete.add(boxGeometry(0.12, 1.5, 8.8, [4, 4]), mat(lx + w / 2 + 0.06, y0 + h - 1.7, lz));
  TB.concrete.add(boxGeometry(9, 0.1, 1.6, [4, 4]), mat(lx, y0 + h + 0.05, lz + 1.6));

  const signMat = new THREE.MeshBasicMaterial({
    map: textTexture('MARSHALL WACE'), color: new THREE.Color(2.4, 2.3, 2.15), transparent: true, depthWrite: false,
  });
  const sign = (width, x, y, z, rx, ry, order = 'XYZ') => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(width, width / 8), signMat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0, order);
    m.renderOrder = 3;
    m.userData.noSSAO = true;
    parent.add(m);
  };
  sign(8.2, lx, y0 + h - 1.7, lz + d / 2 + 0.13, 0, 0);                  // faces +z, the street toward the start
  sign(8.2, lx + w / 2 + 0.13, y0 + h - 1.7, lz, 0, Math.PI / 2);        // faces +x
  // On the roof, facing the ceiling: oriented so it reads the right way round for the upside-down player
  // (their screen-right is world −x and screen-up world +z when facing the start direction).
  sign(8.6, lx, y0 + h + 0.12, lz + 1.6, -Math.PI / 2, Math.PI, 'YXZ');
  colliderBox(parent, colliders, w, h, d, lx, y0 + h / 2, lz);
}

// ----- The Shard: tapering faceted glass pyramid with splinters at the top -----

function shardTextures(rand) {
  const W = 256, H = 1024, c = makeCanvas(W, H), e = makeCanvas(W, H);
  const g = c.getContext('2d'), ge = e.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#9fb0c2');
  grad.addColorStop(1, '#5b6a7a');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y += 12) {
    g.fillStyle = 'rgba(30,40,52,0.6)';
    g.fillRect(0, y, W, 2);
    for (let x = 0; x < W; x += 8) {
      if (rand() < 0.12) {
        const col = rand() < 0.75 ? '#ffd9a0' : '#cfe0ff';
        g.fillStyle = col;
        g.fillRect(x + 1, y + 3, 6, 7);
        ge.fillStyle = col;
        ge.fillRect(x + 1, y + 3, 6, 7);
      }
    }
  }
  const t1 = toTexture(c), t2 = toTexture(e);
  t1.repeat.set(4, 1);
  t2.repeat.set(4, 1);
  return [t1, t2];
}

function addShard(parent, colliders, lx, lz, rand) {
  const y0 = KERB_H, H = MAX_TOP - y0 - 1.5;
  const [map, emissiveMap] = shardTextures(rand);
  const glass = new THREE.MeshStandardMaterial({
    map, emissiveMap, emissive: 0xffffff, emissiveIntensity: 0.9, color: 0xb0bcc8, metalness: 0.85, roughness: 0.12, envMapIntensity: 0.7,
  });
  const geo = new THREE.CylinderGeometry(0.4, 4.4, H, 8, 1, false);
  geo.translate(0, H / 2, 0);
  const body = new THREE.Mesh(geo, glass);
  body.position.set(lx, y0, lz);
  body.rotation.y = Math.PI / 8;
  body.castShadow = body.receiveShadow = true;
  parent.add(body);
  // Splinters: the glass "shards" that run past the summit without meeting.
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.3;
    const p = new THREE.BoxGeometry(1.0, 2.0, 0.05);
    p.rotateX(-0.12);
    p.rotateY(-a + Math.PI / 2);
    p.translate(Math.cos(a) * 0.35, H + 0.25, Math.sin(a) * 0.35);
    parts.push(p);
  }
  const splinters = new THREE.Mesh(mergeGeometries(parts), glass);
  splinters.position.set(lx, y0, lz);
  parent.add(splinters);
  colliderBox(parent, colliders, 7, 6, 7, lx, y0 + 3, lz);
  colliderBox(parent, colliders, 4, H - 6, 4, lx, y0 + 6 + (H - 6) / 2, lz);
}

// ----- The Gherkin: curved bullet with a diagonal diagrid and dark spiral bands -----

function gherkinTextures(rand) {
  const W = 512, H = 1024, c = makeCanvas(W, H), e = makeCanvas(W, H);
  const g = c.getContext('2d'), ge = e.getContext('2d');
  g.fillStyle = '#2b4450';
  g.fillRect(0, 0, W, H);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, W, H);
  const step = W / 16;
  const diag = (ctx, x0, dir, width, style) => {
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    for (const off of [-W, 0, W]) {
      ctx.beginPath();
      ctx.moveTo(x0 + off, H);
      ctx.lineTo(x0 + off + dir * H * 0.9, 0);
      ctx.stroke();
    }
  };
  for (let i = 0; i < 6; i++) diag(g, (i / 6) * W, 1, step * 0.9, '#13232b');           // dark spiral bands
  for (let x = 0; x < W; x += step) { diag(g, x, 1, 2, '#9fb3bb'); diag(g, x, -1, 2, '#9fb3bb'); } // diagrid
  for (let i = 0; i < 260; i++) { // lit panes
    const x = rand() * W, y = rand() * H;
    ge.fillStyle = g.fillStyle = rand() < 0.8 ? '#ffd7a0' : '#d8e8ff';
    g.fillRect(x, y, 5, 4);
    ge.fillRect(x, y, 5, 4);
  }
  return [toTexture(c), toTexture(e)];
}

function addGherkin(parent, colliders, lx, lz, rand) {
  const H = 17, y0 = KERB_H;
  const pts = [];
  for (let i = 0; i <= 32; i++) {
    const t = i / 32;
    pts.push(new THREE.Vector2(Math.max(0.02, 4.1 * Math.pow(Math.sin(Math.PI * (0.22 + 0.78 * t)), 0.72)), t * H));
  }
  const [map, emissiveMap] = gherkinTextures(rand);
  const glass = new THREE.MeshStandardMaterial({
    map, emissiveMap, emissive: 0xffffff, emissiveIntensity: 0.8, metalness: 0.6, roughness: 0.22, envMapIntensity: 0.3,
  });
  const body = new THREE.Mesh(new THREE.LatheGeometry(pts, 64), glass);
  body.position.set(lx, y0, lz);
  body.castShadow = body.receiveShadow = true;
  parent.add(body);
  colliderBox(parent, colliders, 6, H, 6, lx, y0 + H / 2, lz);
}

// ----- Elizabeth Tower (Big Ben): gothic stone tower, lit clock faces, spire -----

function clockTexture() {
  const S = 512, c = makeCanvas(S, S), g = c.getContext('2d'), r = S / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, '#fff8e6');
  grad.addColorStop(1, '#f1ddb0');
  g.fillStyle = grad;
  g.beginPath(); g.arc(r, r, r - 4, 0, TAU); g.fill();
  g.strokeStyle = '#1a1410';
  g.lineWidth = 10;
  g.beginPath(); g.arc(r, r, r - 10, 0, TAU); g.stroke();
  g.fillStyle = '#1a1410';
  g.font = '700 46px Georgia, "Times New Roman", serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const numerals = ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * TAU - Math.PI / 2, big = i % 5 === 0;
    g.lineWidth = big ? 6 : 2;
    g.beginPath();
    g.moveTo(r + Math.cos(a) * (r - 22), r + Math.sin(a) * (r - 22));
    g.lineTo(r + Math.cos(a) * (r - (big ? 44 : 32)), r + Math.sin(a) * (r - (big ? 44 : 32)));
    g.stroke();
    if (big) g.fillText(numerals[i / 5], r + Math.cos(a) * (r - 84), r + Math.sin(a) * (r - 84));
  }
  const hand = (frac, len, width) => {
    const a = frac * TAU - Math.PI / 2;
    g.lineWidth = width;
    g.lineCap = 'round';
    g.beginPath(); g.moveTo(r, r); g.lineTo(r + Math.cos(a) * len, r + Math.sin(a) * len); g.stroke();
  };
  hand(10.15 / 12, r * 0.5, 14); // ~10:10
  hand(10 / 60, r * 0.78, 9);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function addBigBen(B, parent, colliders, lx, lz) {
  const y0 = KERB_H;
  const add = (batch, geo, x, y, z, yaw = 0, color) => batch.add(geo, mat(lx + x, y0 + y, lz + z, yaw), color);
  // Shaft with corner buttresses, recessed lancet windows (some lit).
  add(B.sandstone, boxGeometry(3.2, 11, 3.2, [2, 2]), 0, 5.5, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(B.sandstone, boxGeometry(0.4, 11.2, 0.4, [2, 2]), sx * 1.6, 5.6, sz * 1.6);
  for (let k = 0; k < 4; k++) {
    const yaw = (k * Math.PI) / 2, nx = Math.sin(yaw), nz = Math.cos(yaw);
    for (let lvl = 0; lvl < 4; lvl++) {
      for (const off of [-0.6, 0, 0.6]) {
        const x = nx * 1.61 + Math.cos(yaw) * off, z = nz * 1.61 - Math.sin(yaw) * off;
        if ((lvl + k) % 3 === 0) add(B.glassLit, new THREE.BoxGeometry(0.22, 1.3, 0.02), x, 2.5 + lvl * 2.2, z, yaw, lit(1.3, 0.85, 0.4));
        else add(B.glass, new THREE.BoxGeometry(0.22, 1.3, 0.02), x, 2.5 + lvl * 2.2, z, yaw);
      }
    }
  }
  // Clock stage with four lit faces and gilded surrounds.
  add(B.sandstone, boxGeometry(3.9, 3.8, 3.9, [2, 2]), 0, 12.9, 0);
  const faceMat = new THREE.MeshBasicMaterial({ map: clockTexture(), color: new THREE.Color(1.9, 1.75, 1.4) });
  const faceGeo = new THREE.CircleGeometry(1.5, 48);
  for (let k = 0; k < 4; k++) {
    const yaw = (k * Math.PI) / 2, nx = Math.sin(yaw), nz = Math.cos(yaw);
    const f = new THREE.Mesh(faceGeo, faceMat);
    f.position.set(lx + nx * 1.97, y0 + 12.9, lz + nz * 1.97);
    f.rotation.y = yaw;
    f.userData.noSSAO = true;
    parent.add(f);
    add(B.gold, new THREE.TorusGeometry(1.55, 0.08, 8, 48), nx * 1.98, 12.9, nz * 1.98, yaw);
    add(B.gold, boxGeometry(3.4, 0.16, 0.1, [1, 1]), nx * 1.99, 14.65, nz * 1.99, yaw);
  }
  // Belfry with dark arches, then the steep pyramidal roof, pinnacles and spire.
  add(B.sandstone, boxGeometry(3.4, 2.4, 3.4, [2, 2]), 0, 16.0, 0);
  for (let k = 0; k < 4; k++) {
    const yaw = (k * Math.PI) / 2;
    for (const off of [-0.8, 0, 0.8]) add(B.glass, new THREE.BoxGeometry(0.45, 1.6, 0.02), Math.sin(yaw) * 1.71 + Math.cos(yaw) * off, 16, Math.cos(yaw) * 1.71 - Math.sin(yaw) * off, yaw);
  }
  const roof = new THREE.ConeGeometry(2.5, 5.2, 4);
  add(B.iron, roof, 0, 17.2 + 2.6, 0, Math.PI / 4);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(B.gold, new THREE.ConeGeometry(0.22, 1.5, 4), sx * 1.85, 15.55, sz * 1.85);
  add(B.gold, new THREE.CylinderGeometry(0.04, 0.16, 1.4, 8), 0, 17.2 + 5.2 + 0.6, 0); // tip at 23.85 m (< MAX_TOP)
  colliderBox(parent, colliders, 4, 23, 4, lx, y0 + 11.5, lz);
}

// ----- The London Eye: slowly turning wheel with LED rim and upright pods -----

function addLondonEye(parent, colliders, lx, lz) {
  const R = 9.6, cy = KERB_H + 12.8, N = 32;
  const steel = new THREE.MeshStandardMaterial({ color: 0xdfe4ea, metalness: 0.7, roughness: 0.35, envMapIntensity: 0.6 });
  const wheel = new THREE.Group();
  wheel.position.set(lx, cy, lz);
  const parts = [];
  for (const [r, t] of [[R, 0.13], [R - 0.9, 0.08]]) {
    const ring = new THREE.TorusGeometry(r, t, 8, 128);
    ring.rotateY(Math.PI / 2); // wheel turns in the z–y plane
    parts.push(ring);
  }
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU;
    const tip = new THREE.Vector3(0, Math.sin(a) * (R - 0.9), Math.cos(a) * (R - 0.9));
    parts.push(cylinderBetween(new THREE.Vector3(0.6 * Math.sign(i % 2 - 0.5), 0, 0), tip, 0.035, 5));
    const a2 = ((i + 0.5) / N) * TAU; // truss between the rims
    parts.push(cylinderBetween(tip, new THREE.Vector3(0, Math.sin(a2) * R, Math.cos(a2) * R), 0.03, 4));
  }
  const hub = new THREE.CylinderGeometry(0.6, 0.6, 1.4, 16);
  hub.rotateZ(Math.PI / 2);
  parts.push(hub);
  const frame = new THREE.Mesh(mergeGeometries(parts.map((p) => { for (const k of Object.keys(p.attributes)) if (!['position', 'normal', 'uv'].includes(k)) p.deleteAttribute(k); return p; })), steel);
  frame.castShadow = true;
  const led = new THREE.Mesh(new THREE.TorusGeometry(R + 0.05, 0.05, 6, 192), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.7, 0.55, 2.6) }));
  led.rotation.y = Math.PI / 2;
  led.userData.noSSAO = true;
  wheel.add(frame, led);
  parent.add(wheel);

  // A-frame legs on the +x side, leaning in to the hub.
  const legs = [];
  for (const sz of [-1, 1]) legs.push(cylinderBetween(new THREE.Vector3(lx + 5.4, KERB_H, lz + sz * 4.6), new THREE.Vector3(lx + 0.8, cy, lz), 0.32, 10));
  legs.push(cylinderBetween(new THREE.Vector3(lx + 4.4, KERB_H + 3, lz - 3.7), new THREE.Vector3(lx + 4.4, KERB_H + 3, lz + 3.7), 0.18, 8));
  const legMesh = new THREE.Mesh(mergeGeometries(legs), steel);
  legMesh.castShadow = legMesh.receiveShadow = true;
  parent.add(legMesh);
  for (const sz of [-1, 1]) colliderBox(parent, colliders, 1, 2.5, 1, lx + 5.2, KERB_H + 1.25, lz + sz * 4.4);

  // Pods (instanced) hang on the outside of the rim and stay upright as the wheel turns.
  const podGeo = new THREE.CapsuleGeometry(0.42, 0.9, 6, 12);
  podGeo.rotateZ(Math.PI / 2);
  const pods = new THREE.InstancedMesh(podGeo, new THREE.MeshStandardMaterial({
    color: 0x9fb6c8, emissive: 0x9ec8ff, emissiveIntensity: 1.2, metalness: 0.3, roughness: 0.15, envMapIntensity: 0.6,
  }), N);
  pods.frustumCulled = false;
  pods.castShadow = true;
  parent.add(pods);
  const dummy = new THREE.Object3D();
  const place = () => {
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU + wheel.rotation.x;
      dummy.position.set(lx, cy + Math.sin(a) * (R + 0.7), lz + Math.cos(a) * (R + 0.7));
      dummy.updateMatrix();
      pods.setMatrixAt(i, dummy.matrix);
    }
    pods.instanceMatrix.needsUpdate = true;
  };
  place();
  return {
    update(dt) {
      wheel.rotation.x += dt * 0.025; // ~4 minutes per turn: majestic, like the real thing
      place();
    },
  };
}

// ----- Street furniture (merged into batches) -----

function addPhoneBox(B, colliders, parent, x, z, yaw) {
  const M0 = mat(x, KERB_H, z, yaw);
  const at = (gx, gy, gz, ry = 0) => M0.clone().multiply(mat(gx, gy, gz, ry));
  B.paint.add(new THREE.BoxGeometry(1.0, 0.12, 1.0), at(0, 0.06, 0), LONDON_RED);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.paint.add(new THREE.BoxGeometry(0.1, 2.3, 0.1), at(sx * 0.46, 1.27, sz * 0.46), LONDON_RED);
  B.paint.add(new THREE.BoxGeometry(1.04, 0.32, 1.04), at(0, 2.56, 0), LONDON_RED);
  B.paint.add(new THREE.CylinderGeometry(0.34, 0.66, 0.22, 4), at(0, 2.83, 0, Math.PI / 4), LONDON_RED);
  for (let k = 0; k < 4; k++) {
    const ry = (k * Math.PI) / 2, nx = Math.sin(ry), nz = Math.cos(ry);
    B.glassLit.add(new THREE.BoxGeometry(0.8, 1.75, 0.02), at(nx * 0.44, 1.2, nz * 0.44, ry), lit(0.2, 0.15, 0.09));
    for (const gy of [0.6, 1.05, 1.5, 1.9]) B.paint.add(new THREE.BoxGeometry(0.82, 0.04, 0.05), at(nx * 0.46, gy, nz * 0.46, ry), LONDON_RED);
    for (const gx of [-0.27, 0.27]) B.paint.add(new THREE.BoxGeometry(0.04, 1.75, 0.05), at(nx * 0.46 + Math.cos(ry) * gx, 1.2, nz * 0.46 - Math.sin(ry) * gx, ry), LONDON_RED);
    B.glassLit.add(new THREE.BoxGeometry(0.7, 0.14, 0.02), at(nx * 0.53, 2.56, nz * 0.53, ry), lit(1.1, 1.05, 0.95)); // sign strip
  }
  colliderBox(parent, colliders, 1.0, 2.9, 1.0, x, KERB_H + 1.45, z);
}

function addWheels(B, M0, xs, zs, r, w) {
  const wheel = new THREE.CylinderGeometry(r, r, w, 16);
  wheel.rotateX(Math.PI / 2);
  for (const x of xs) for (const z of zs) B.rubber.add(wheel, M0.clone().multiply(mat(x, r, z)));
}

function addBus(B, colliders, parent, x, z, yaw) {
  const L = 10.2, W = 2.5;
  const M0 = mat(x, 0, z, yaw);
  const at = (gx, gy, gz) => M0.clone().multiply(mat(gx, gy, gz));
  B.carPaint.add(new THREE.BoxGeometry(L, 3.6, W), at(0, 2.25, 0), LONDON_RED);
  B.carPaint.add(new THREE.BoxGeometry(L - 0.25, 0.18, W - 0.12), at(0, 4.13, 0), LONDON_RED);
  B.rubber.add(new THREE.BoxGeometry(L + 0.02, 0.4, W + 0.02), at(0, 0.62, 0));
  for (const s of [-1, 1]) {
    B.glassLit.add(new THREE.BoxGeometry(L - 2.4, 0.85, 0.02), at(-0.6, 1.95, s * (W / 2 + 0.01)), lit(0.75, 0.62, 0.42));
    B.glassLit.add(new THREE.BoxGeometry(L - 0.8, 0.8, 0.02), at(0, 3.4, s * (W / 2 + 0.01)), lit(0.85, 0.7, 0.45));
  }
  B.glass.add(new THREE.BoxGeometry(0.02, 1.1, W - 0.3), at(L / 2 + 0.01, 1.95, 0));
  B.glassLit.add(new THREE.BoxGeometry(0.02, 0.8, W - 0.3), at(L / 2 + 0.01, 3.4, 0), lit(0.8, 0.66, 0.44));
  B.glassLit.add(new THREE.BoxGeometry(0.03, 0.3, 1.6), at(L / 2 + 0.02, 2.75, 0), lit(2.0, 1.25, 0.2));   // destination blind
  for (const s of [-1, 1]) {
    B.glassLit.add(new THREE.BoxGeometry(0.03, 0.18, 0.3), at(L / 2 + 0.02, 0.95, s * 0.9), lit(2.2, 2.1, 1.8));  // headlights
    B.glassLit.add(new THREE.BoxGeometry(0.03, 0.25, 0.18), at(-L / 2 - 0.02, 1.0, s * 1.0), lit(1.8, 0.1, 0.05)); // tail lights
  }
  addWheels(B, M0, [-3.4, 3.4], [-(W / 2 - 0.2), W / 2 - 0.2], 0.5, 0.32);
  const c = colliderBox(parent, colliders, L, 4.2, W, x, 2.1, z);
  c.rotation.y = yaw;
}

function addTaxi(B, colliders, parent, x, z, yaw) {
  const M0 = mat(x, 0, z, yaw);
  const at = (gx, gy, gz) => M0.clone().multiply(mat(gx, gy, gz));
  B.carPaint.add(new THREE.BoxGeometry(4.5, 0.78, 1.8), at(0, 0.72, 0), TAXI_BLACK);
  B.carPaint.add(new THREE.BoxGeometry(2.7, 0.72, 1.7), at(-0.25, 1.46, 0), TAXI_BLACK);
  B.carPaint.add(new THREE.BoxGeometry(2.6, 0.06, 1.62), at(-0.25, 1.84, 0), TAXI_BLACK);
  for (const s of [-1, 1]) B.glass.add(new THREE.BoxGeometry(2.35, 0.48, 0.02), at(-0.25, 1.5, s * 0.86));
  B.glass.add(new THREE.BoxGeometry(0.02, 0.5, 1.52), at(1.11, 1.5, 0));
  B.glassLit.add(new THREE.BoxGeometry(0.5, 0.14, 0.22), at(0.25, 1.94, 0), lit(2.2, 1.5, 0.25));   // TAXI light
  B.stone.add(boxGeometry(0.04, 0.38, 0.62, [1, 1]), at(2.26, 0.78, 0));                           // grille
  const lamp = new THREE.CylinderGeometry(0.12, 0.12, 0.05, 12);
  lamp.rotateZ(Math.PI / 2);
  for (const s of [-1, 1]) {
    B.glassLit.add(lamp, at(2.27, 0.86, s * 0.62), lit(2.2, 2.1, 1.8));
    B.glassLit.add(new THREE.BoxGeometry(0.03, 0.16, 0.16), at(-2.27, 0.86, s * 0.7), lit(1.8, 0.1, 0.05));
  }
  addWheels(B, M0, [-1.45, 1.45], [-0.82, 0.82], 0.34, 0.22);
  const c = colliderBox(parent, colliders, 4.5, 1.9, 1.8, x, 0.95, z);
  c.rotation.y = yaw;
}

/** Underground roundel on a post: red ring and blue bar, both glowing (no text). */
function addRoundel(B, x, z, yaw) {
  const M0 = mat(x, KERB_H, z, yaw);
  B.iron.add(new THREE.CylinderGeometry(0.06, 0.07, 3.2, 8), M0.clone().multiply(mat(0, 1.6, 0)));
  const ring = new THREE.RingGeometry(0.42, 0.62, 48);
  for (const flip of [0, Math.PI]) B.glassLit.add(ring, M0.clone().multiply(mat(0, 3.4, flip ? -0.02 : 0.02, flip)), lit(1.15, 0.03, 0.05));
  B.glassLit.add(new THREE.BoxGeometry(1.7, 0.27, 0.08), M0.clone().multiply(mat(0, 3.4, 0)), lit(0.03, 0.09, 1.0));
}

const STREET_NAMES = [
  ['BAKER STREET', 'NW1'], ['ABBEY ROAD', 'NW8'], ['FLEET STREET', 'EC4'], ['CARNABY STREET', 'W1'],
  ['BRICK LANE', 'E1'], ['PORTOBELLO ROAD', 'W11'], ['SAVILE ROW', 'W1'], ['DRURY LANE', 'WC2'],
];

/** All street-name plates in one texture (8 rows); white plate, black border and name, red district. */
function streetSignAtlas() {
  const W = 1024, rowH = 128, c = makeCanvas(W, rowH * STREET_NAMES.length), g = c.getContext('2d');
  STREET_NAMES.forEach(([name, code], i) => {
    const y = i * rowH;
    g.fillStyle = '#f4f2ec';
    g.fillRect(0, y, W, rowH);
    g.strokeStyle = '#111';
    g.lineWidth = 10;
    g.strokeRect(10, y + 10, W - 20, rowH - 20);
    g.font = '700 70px "Helvetica Neue", Helvetica, Arial, sans-serif';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    const width = (str) => { const m = g.measureText(str).width; return typeof m === 'number' ? m : str.length * 42; };
    const nameW = width(name), codeW = width(` ${code}`);
    const x0 = (W - nameW - codeW) / 2;
    g.fillStyle = '#111';
    g.fillText(name, x0, y + rowH / 2 + 3);
    g.fillStyle = '#c8102e';
    g.fillText(` ${code}`, x0 + nameW, y + rowH / 2 + 3);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function streetSignGeometry(i) {
  const g = new THREE.PlaneGeometry(1.4, 1.4 / 8);
  const uv = g.attributes.uv, n = STREET_NAMES.length;
  for (let k = 0; k < uv.count; k++) uv.setY(k, (n - 1 - i + uv.getY(k)) / n);
  return g;
}

/** White-stucco Georgian/Victorian front door: black door, glowing fanlight, columned porch, step. */
function georgianDoor(B, face, x, base) {
  const at = (gx, gy, gz) => face.clone().multiply(mat(x + gx, base + gy, gz));
  B.paint.add(new THREE.BoxGeometry(1.0, 2.25, 0.08), at(0, 1.13, -0.02), new THREE.Color('#0d0d0f'));
  const fan = new THREE.CircleGeometry(0.5, 24, 0, Math.PI);
  B.glassLit.add(fan, at(0, 2.3, 0.01), lit(1.4, 1.0, 0.55));
  for (const s of [-1, 1]) B.stucco.add(new THREE.CylinderGeometry(0.11, 0.13, 2.85, 12), at(s * 0.82, 1.43, 0.55));
  B.stucco.add(boxGeometry(2.1, 0.32, 0.75, [2, 2]), at(0, 3.0, 0.3));
  B.stone.add(boxGeometry(1.8, 0.16, 0.9, [2, 2]), at(0, 0.08, 0.45));
}

/** Black iron railings along a facade, leaving a gap for the door. */
function railings(B, face, width, doorX, base) {
  const bar = new THREE.BoxGeometry(0.025, 1.0, 0.025);
  for (let x = -width / 2 + 0.1; x < width / 2 - 0.05; x += 0.14) {
    if (Math.abs(x - doorX) < 0.95) continue;
    B.iron.add(bar, face.clone().multiply(mat(x, base + 0.5, 1.15)));
  }
  for (const [a, b] of [[-width / 2 + 0.05, doorX - 0.95], [doorX + 0.95, width / 2 - 0.05]]) {
    if (b - a < 0.2) continue;
    B.iron.add(new THREE.BoxGeometry(b - a, 0.05, 0.05), face.clone().multiply(mat((a + b) / 2, base + 1.0, 1.15)));
  }
}

// ---------- build ----------

function buildEnvironment(scene, world, colliders, tex) {
  const rand = rng(1337);

  scene.background = new THREE.Color(0x070202);
  scene.fog = new THREE.FogExp2(FOG.color, FOG.density);
  const hemi = new THREE.HemisphereLight(0x5a2420, 0x120505, 0.35);
  // Moonlight from above: the one shadow-casting light (keeps shadows affordable on a laptop).
  const top = new THREE.DirectionalLight(0x9aa0c0, 0.35);
  top.position.set(-30, 80, 25);
  top.castShadow = true;
  top.shadow.mapSize.set(2048, 2048);
  Object.assign(top.shadow.camera, { left: -62, right: 62, top: 62, bottom: -62, near: 10, far: 200 });
  top.shadow.bias = -0.0004;
  top.shadow.normalBias = 0.05;
  const below = new THREE.DirectionalLight(0xe0907c, 8); // lights the ceiling the player stands on
  below.position.set(0, -40, 0); // straight up: lights only downward-facing surfaces (the ceiling), not walls
  scene.add(hemi, top, below);

  const M = makeMaterials(tex, rand);
  const B = {
    brick: new Batch(M.brick), plaster: M.plaster.map((m) => new Batch(m)), stone: new Batch(M.stone),
    roof: new Batch(M.roof), wood: new Batch(M.wood), shutter: new Batch(M.shutter),
    paint: new Batch(M.paint, { vertexColors: true }), glass: new Batch(M.glass, { cast: false }),
    glassLit: new Batch(M.glassLit, { vertexColors: true, cast: false, receive: false }),
    pavement: new Batch(M.pavement, { cast: false }), puddle: new Batch(M.puddle, { cast: false }),
    stucco: new Batch(M.stucco), sandstone: new Batch(M.sandstone), gold: new Batch(M.gold), iron: new Batch(M.iron),
    rubber: new Batch(M.rubber), signs: new Batch(M.signs, { cast: false }), carPaint: new Batch(M.carPaint, { vertexColors: true }),
  };

  // Road (asphalt) and ceiling (stone, where the player lands).
  const ground = new THREE.Mesh(boxGeometry(HALF * 2 + 8, 1, HALF * 2 + 8, [4, 4]), M.asphalt);
  ground.position.y = -0.5;
  ground.receiveShadow = true;
  const ceiling = new THREE.Mesh(boxGeometry(HALF * 2 + 8, 1, HALF * 2 + 8, [2.5, 2.5]), M.ceiling);
  ceiling.position.y = CEIL + 0.5;
  ceiling.userData.isCeiling = true;
  world.add(ground, ceiling);
  colliders.push(ground, ceiling);

  // Invisible boundary walls (raycasts still hit invisible meshes).
  const wallGeo = new THREE.BoxGeometry(1, CEIL + 2, HALF * 2 + 2);
  for (const [x, z, ry] of [[-HALF, 0, 0], [HALF, 0, 0], [0, -HALF, Math.PI / 2], [0, HALF, Math.PI / 2]]) {
    const wall = new THREE.Mesh(wallGeo, new THREE.MeshBasicMaterial());
    wall.position.set(x, CEIL / 2, z);
    wall.rotation.y = ry;
    wall.visible = false;
    wall.userData.isBoundary = true;
    world.add(wall);
    colliders.push(wall);
  }

  // Blocks: raised flagstone pavement with kerbs on every lot; houses inside, towers on the outer ring.
  const outer = LOTS.flatMap((lx) => LOTS.map((lz) => [lx, lz])).filter(([lx, lz]) => Math.abs(lx) === 40 || Math.abs(lz) === 40);
  const towers = new Set();
  while (towers.size < 9) {
    const [lx, lz] = pick(rand, outer);
    if (!(lx === GLOBE.x && lz === GLOBE.z) && !landmarkAt(lx, lz)) towers.add(`${lx},${lz}`);
  }
  const kit = houseKit(B, rand);
  const TB = { facades: M.tower.map((m) => new Batch(m)), concrete: new Batch(M.concrete), metal: new Batch(M.iron) };
  const slab = boxGeometry(LOT_HALF * 2, KERB_H, LOT_HALF * 2, [2, 2]);
  const houseLots = [];
  let eye = null;
  for (const lx of LOTS) {
    for (const lz of LOTS) {
      B.pavement.add(slab, mat(lx, KERB_H / 2, lz));
      colliderBox(world, colliders, LOT_HALF * 2, KERB_H, LOT_HALF * 2, lx, KERB_H / 2, lz);
      const plaza = (lx === PLATE.x && lz === PLATE.y) || (lx === GLOBE.x && lz === GLOBE.z);
      if (plaza) continue;
      const lm = landmarkAt(lx, lz);
      if (lm === 'marshallWace') { addMarshallWace(B, TB, world, colliders, lx, lz); continue; }
      if (lm === 'shard') { addShard(world, colliders, lx, lz, rand); continue; }
      if (lm === 'gherkin') { addGherkin(world, colliders, lx, lz, rand); continue; }
      if (lm === 'bigBen') { addBigBen(B, world, colliders, lx, lz); continue; }
      if (lm === 'londonEye') { eye = addLondonEye(world, colliders, lx, lz); continue; }
      if (towers.has(`${lx},${lz}`)) { addTower(TB, rand, world, colliders, lx, lz); continue; }
      // Old town blocks, with London white-stucco terraces mixed in.
      const georgian = rand() < 0.32;
      const layout = georgian ? pick(rand, [BLOCK_LAYOUTS[2], BLOCK_LAYOUTS[4]]) : pick(rand, BLOCK_LAYOUTS);
      for (const [ox, oz, w, d] of layout) addHouse(B, kit, rand, world, colliders, lx + ox, lz + oz, w, d, lx, lz, georgian ? 'georgian' : 'old');
      houseLots.push([lx, lz]);
    }
  }

  // Puddles on the roads and plazas (low roughness: they mirror the lamps and the night sky).
  const puddleGeo = new THREE.PlaneGeometry(1, 1);
  puddleGeo.rotateX(-Math.PI / 2);
  const roads = [-48, -32, -16, 0, 16, 32, 48];
  const addPuddle = (x, y, z, sx, sz) => {
    const g = puddleGeo.clone();
    const q = Math.floor(rand() * 4), uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) + (q % 2)) / 2, (uv.getY(i) + Math.floor(q / 2)) / 2);
    g.scale(sx, 1, sz);
    B.puddle.add(g, mat(x, y, z, rand() * TAU));
  };
  for (let i = 0; i < 46; i++) {
    const along = (rand() - 0.5) * 100, road = pick(rand, roads), across = (rand() - 0.5) * 2.4;
    const [x, z] = rand() < 0.5 ? [road + across, along] : [along, road + across];
    addPuddle(x, 0.012, z, 1.5 + rand() * 2.5, 1 + rand() * 1.5);
  }
  for (const [px, pz] of [[PLATE.x, PLATE.y], [GLOBE.x, GLOBE.z]]) {
    for (let i = 0; i < 4; i++) addPuddle(px + (rand() - 0.5) * 9, KERB_H + 0.012, pz + (rand() - 0.5) * 9, 1.2 + rand() * 2, 1 + rand());
  }

  // London street life: phone boxes, buses, black cabs, Underground roundels, street-name plates.
  for (const [x, z, yaw] of [[-2.75, 3.2, Math.PI / 2], [13.25, 4.6, -Math.PI / 2], [-13.25, -21.5, -Math.PI / 2], [2.75, -20.5, Math.PI / 2],
    [-18.75, 27.2, Math.PI / 2], [29.25, -12.6, -Math.PI / 2], [18.75, 11.2, Math.PI / 2]]) addPhoneBox(B, colliders, world, x, z, yaw);
  for (const [x, z, yaw] of [[24, -0.75, 0], [-16.75, -24, Math.PI / 2], [16.75, 27, Math.PI / 2], [-27, 15.25, Math.PI]]) addBus(B, colliders, world, x, z, yaw);
  for (const [x, z, yaw] of [[7, 15.25, 0], [-32.75, -6, Math.PI / 2], [16.75, 8, -Math.PI / 2], [-7, -16.75, Math.PI], [30, -15.25, 0], [-0.75, 25, Math.PI / 2]]) addTaxi(B, colliders, world, x, z, yaw);
  for (const [x, z, yaw] of [[13.4, -2.6, Math.PI / 4], [-29.4, 18.6, -Math.PI / 4], [-2.6, 13.4, Math.PI / 4], [18.6, 29.4, -Math.PI / 4]]) {
    addRoundel(B, x, z, yaw);
    colliderBox(world, colliders, 0.2, 3, 0.2, x, KERB_H + 1.5, z);
  }
  houseLots.forEach(([lx, lz], i) => {
    if (i % 3 === 2) return;
    B.signs.add(streetSignGeometry(i % STREET_NAMES.length), mat(lx + BUILD_HALF + 0.03, KERB_H + 3.35, lz + BUILD_HALF - 0.95, Math.PI / 2));
    B.signs.add(streetSignGeometry((i + 3) % STREET_NAMES.length), mat(lx + BUILD_HALF - 0.95, KERB_H + 3.35, lz + BUILD_HALF + 0.03, 0));
  });

  for (const b of [B.brick, ...B.plaster, B.stone, B.roof, B.wood, B.shutter, B.paint, B.glass, B.glassLit, B.pavement, B.puddle,
    B.stucco, B.sandstone, B.gold, B.iron, B.rubber, B.signs, B.carPaint, ...TB.facades, TB.concrete, TB.metal]) b.build(world);

  // Cast-iron street lamps on the block corners (instanced), red glass that blooms.
  const lamp = lampGeometry();
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x3a0806, emissive: 0xff2a12, emissiveIntensity: 6, roughness: 0.25 });
  const spots = [];
  // On the kerb edge (lantern hangs out over the road), not hard against the house walls.
  for (const sx of [-32, -16, 0, 16, 32]) for (const sz of [-32, -16, 0, 16, 32]) spots.push([sx + 2.35, sz + 2.35]);
  const ironMesh = new THREE.InstancedMesh(lamp.iron, M.iron, spots.length);
  const glassMesh = new THREE.InstancedMesh(lamp.glass, glassMat, spots.length);
  const heads = [];
  spots.forEach(([x, z], i) => {
    const m = mat(x, KERB_H, z, (3 * Math.PI) / 4); // arm points diagonally over the road
    ironMesh.setMatrixAt(i, m);
    glassMesh.setMatrixAt(i, m);
    heads.push(lamp.head.clone().applyMatrix4(m));
    colliderBox(world, colliders, 0.3, 3.6, 0.3, x, KERB_H + 1.8, z);
  });
  ironMesh.castShadow = glassMesh.castShadow = true;
  ironMesh.receiveShadow = true;
  world.add(ironMesh, glassMesh);
  // Real red point lights only on the lamps along the route (spawn → portal → globe): cost.
  const route = [[0, 6], [PLATE.x, PLATE.y], [GLOBE.x, GLOBE.z], [-8, 8], [0, -10], [-16, 16]];
  const dist = (h) => Math.min(...route.map(([x, z]) => Math.hypot(h.x - x, h.z - z)));
  heads.slice().sort((a, b) => dist(a) - dist(b)).slice(0, 10).forEach((h) => {
    const l = new THREE.PointLight(0xff3018, 30, 18, 2);
    l.position.copy(h);
    world.add(l);
  });

  // Weathered fire hydrant on the pavement near the start.
  const hydrant = makeHydrantProp(M);
  hydrant.position.copy(HYDRANT_PROP);
  hydrant.rotation.y = 0.4;
  world.add(hydrant);
  colliderBox(world, colliders, 0.36, 0.85, 0.36, HYDRANT_PROP.x, KERB_H + 0.42, HYDRANT_PROP.z);

  return { hemi, top, below, eye };
}

// ---------- pressure plate: swirling golden particle portal ----------

const PORTAL_VS = /* glsl */ `
attribute float aAngle;
attribute float aRadius;
attribute float aSpeed;
attribute float aPhase;
attribute float aKind;
attribute float aSize;
uniform float uTime;
uniform float uScale;
uniform float uBoost;
varying float vAlpha;
varying vec3 vColor;
void main(){
  float t=uTime*aSpeed+aPhase;
  vec3 p;
  if(aKind<0.5){                     // sparks spiralling inward along three arms
    float life=fract(t*0.3);
    float r=mix(aRadius,0.06,life);
    float a=aAngle+life*5.5+uTime*1.4;
    p=vec3(cos(a)*r,0.03+0.04*sin(a*3.0+uTime*5.0),sin(a)*r);
    vAlpha=smoothstep(0.0,0.12,life)*(1.0-smoothstep(0.75,1.0,life));
  }else{                             // embers drifting up out of the portal
    float life=fract(t*0.16);
    float a=aAngle+uTime*0.7;
    float r=aRadius*(1.0-0.6*life);
    p=vec3(cos(a)*r,life*2.6,sin(a)*r);
    p.xz+=0.18*life*vec2(sin(uTime*1.3+aPhase*7.0),cos(uTime*1.1+aPhase*5.0));
    vAlpha=smoothstep(0.0,0.1,life)*(1.0-life);
  }
  vColor=mix(vec3(1.0,0.45,0.08),vec3(1.0,0.8,0.4),fract(aPhase*13.0))*(2.2+uBoost*3.5);
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  gl_Position=projectionMatrix*mv;
  gl_PointSize=max(aSize*uScale*projectionMatrix[1][1]/max(-mv.z,0.01),1.5);
}
`;
const PORTAL_FS = /* glsl */ `
uniform float uOpacity;
varying float vAlpha;
varying vec3 vColor;
void main(){
  float d=length(gl_PointCoord-0.5);
  float a=smoothstep(0.5,0.0,d)*vAlpha*uOpacity;
  if(a<0.003) discard;
  gl_FragColor=vec4(vColor,a);
}
`;

function buildPortal(parent) {
  const centre = new THREE.Vector3(PLATE.x, KERB_H + 0.02, PLATE.y);
  const SPARKS = 650, EMBERS = 220, N = SPARKS + EMBERS;
  const attrs = { aAngle: [], aRadius: [], aSpeed: [], aPhase: [], aKind: [], aSize: [] };
  for (let i = 0; i < N; i++) {
    const spark = i < SPARKS;
    attrs.aAngle.push(spark ? (i % 3) * (TAU / 3) + (Math.random() - 0.5) * 0.5 : Math.random() * TAU);
    attrs.aRadius.push(spark ? ZONE_R * (0.9 + Math.random() * 0.35) : ZONE_R * Math.random() * 0.9);
    attrs.aSpeed.push(0.7 + Math.random() * 0.6);
    attrs.aPhase.push(Math.random() * 10);
    attrs.aKind.push(spark ? 0 : 1);
    attrs.aSize.push(spark ? 0.03 + Math.random() * 0.03 : 0.025 + Math.random() * 0.03);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(N * 3), 3));
  for (const [k, v] of Object.entries(attrs)) geo.setAttribute(k, new THREE.Float32BufferAttribute(v, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uScale: { value: 400 }, uBoost: { value: 0 }, uOpacity: { value: 1 } },
    vertexShader: PORTAL_VS, fragmentShader: PORTAL_FS,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.position.copy(centre);
  points.frustumCulled = false;

  // Soft glow pool + camera-facing glow (fog-free so it reads from the ceiling 30 m away) + light.
  const glowTex = glowTexture();
  const additive = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false };
  const poolMat = new THREE.MeshBasicMaterial({ map: glowTex, color: 0xffa83a, side: THREE.DoubleSide, ...additive });
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(ZONE_R * 4.5, ZONE_R * 4.5), poolMat);
  pool.rotation.x = -Math.PI / 2;
  pool.position.copy(centre).setY(KERB_H + 0.015);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffc060, ...additive }));
  glow.position.copy(centre).setY(KERB_H + 0.5);
  const light = new THREE.PointLight(0xffb040, 18, 0, 2);
  light.position.copy(centre).setY(KERB_H + 1.2);
  parent.add(pool, points, glow, light);

  return {
    /** active: 0..1 (player standing in position), flash: 0..1 (just flipped), fade: 0..1 light scale. */
    update(dt, time, active, flash, fade = 1) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 2.4);
      const vh = ((typeof window !== 'undefined' && window.innerHeight) || 800) * Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2) / 2;
      mat.uniforms.uTime.value = time;
      mat.uniforms.uScale.value = vh;
      mat.uniforms.uBoost.value = active * 0.6 + flash;
      poolMat.opacity = Math.min(1, 0.45 + pulse * 0.2 + active * 0.3 + flash * 0.5);
      light.intensity = (18 + pulse * 8 + active * 20 + flash * 120) * fade;
      const gs = 3.2 + pulse * 0.6 + active * 1.2 + flash * 5;
      glow.scale.set(gs, gs, 1);
    },
  };
}

// ---------- holographic globe ----------

// Very rough continent outlines as [lon, lat] — just enough to read as Earth.
const CONTINENTS = [
  [[-168, 65], [-140, 70], [-95, 72], [-80, 62], [-60, 50], [-80, 25], [-97, 18], [-105, 22], [-125, 40], [-140, 58]],
  [[-80, 10], [-60, 8], [-35, -7], [-40, -22], [-58, -38], [-70, -55], [-75, -40], [-70, -18], [-81, -5]],
  [[-55, 60], [-20, 70], [-25, 82], [-60, 82], [-72, 77]],
  [[-10, 36], [0, 44], [-5, 48], [5, 52], [10, 58], [25, 70], [40, 66], [40, 45], [28, 40], [15, 38]],
  [[-17, 15], [-10, 35], [10, 37], [32, 31], [43, 12], [51, 11], [40, -15], [32, -30], [20, -35], [12, -18], [9, 4], [-8, 5]],
  [[40, 45], [40, 66], [70, 73], [110, 77], [140, 72], [180, 68], [160, 58], [140, 40], [122, 30], [110, 20], [100, 8], [80, 10], [72, 20], [60, 25], [48, 30]],
  [[113, -22], [130, -12], [142, -11], [153, -27], [146, -39], [135, -35], [115, -34]],
  [[-180, -70], [180, -70], [180, -90], [-180, -90]],
];

function earthTexture() {
  const W = 1024, H = 512, c = makeCanvas(W, H), g = c.getContext('2d');
  g.fillStyle = 'rgba(40,140,255,0.14)';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(120,220,255,0.35)';
  g.lineWidth = 1;
  for (let lon = -180; lon <= 180; lon += 30) {
    const x = ((lon + 180) / 360) * W;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = ((90 - lat) / 180) * H;
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
  }
  for (const poly of CONTINENTS) {
    g.beginPath();
    poly.forEach(([lon, lat], i) => {
      const x = ((lon + 180) / 360) * W, y = ((90 - lat) / 180) * H;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    });
    g.closePath();
    g.fillStyle = 'rgba(90,230,255,0.55)';
    g.fill();
    g.strokeStyle = 'rgba(210,250,255,0.95)';
    g.lineWidth = 3;
    g.stroke();
  }
  const t = toTexture(c);
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// ---------- mini world (revealed after E) ----------
//
// A miniature Quirkland: bright, warm rolling hills with wobbly paths, candy scattered everywhere,
// trees, flowers, butterflies and a small friendly fire hydrant — under a dome "ceiling" covered in
// rows of identical big smiling mouths. Built in the `mini` group's local frame; the group is turned
// so local +X faces the camera (+Y up, +Z screen-left). No text anywhere.

const PI = Math.PI;
const UP = new THREE.Vector3(0, 1, 0);
const DOME_R = GLOBE_R * 1.75;  // mouth-dome radius
const KEY_DIR = new THREE.Vector3(0.75, 0.6, 0.35).normalize();         // warm key light direction
const HYDRANT_DIR = new THREE.Vector3(Math.cos(1.25), Math.sin(1.25), 0); // near the top, leaning to camera
const HYDRANT_SCALE = 2;
const hsl = (h, s, l) => new THREE.Color().setHSL(h, s, l);

/** Soft rounded hills: surface offset for a unit direction. */
function hill(d) {
  return 0.06 * (Math.sin(d.x * 2.6 + 1.3) * Math.sin(d.y * 2.3 + 0.4) + Math.sin(d.z * 2.8 + 2.1) * Math.sin(d.x * 1.9 + d.y * 1.5))
    + 0.018 * Math.sin(d.x * 5 + d.z * 4.5);
}
const surfacePoint = (d, lift = 0, out = new THREE.Vector3()) => out.copy(d).multiplyScalar(GLOBE_R + hill(d) + lift);

// Wobbly paths: great circles with a wave in them. Returns 0..1 (1 = middle of a path).
const PATHS = [
  { n: new THREE.Vector3(0.15, 0.35, 1).normalize(), wob: 0.09, k: 5, ph: 0.3 },
  { n: new THREE.Vector3(-0.5, 1, -0.35).normalize(), wob: 0.07, k: 6, ph: 1.7 },
];
function pathAmount(d) {
  let best = 0;
  for (const p of PATHS) {
    const along = Math.atan2(d.z, d.x) + d.y; // any smoothly varying angle works for the wobble
    const off = d.dot(p.n) + p.wob * Math.sin(along * p.k + p.ph);
    const w = 0.045;
    best = Math.max(best, 1 - THREE.MathUtils.smoothstep(Math.abs(off), w * 0.6, w));
  }
  return best;
}

/** Random unit direction on the camera-facing side, off the paths, optionally away from `avoid`. */
function frontDir(minX = 0, avoid = null, minAngle = 0, allowPath = false, minY = -1) {
  const d = new THREE.Vector3();
  for (let i = 0; i < 80; i++) {
    d.randomDirection();
    if (d.x >= minX && d.y >= minY && (!avoid || d.angleTo(avoid) >= minAngle) && (allowPath || pathAmount(d) < 0.05)) return d;
  }
  return d.set(1, 0.3, 0).normalize();
}

/** Grass blades (instanced) that sway in the breeze; brighter toward the tips. */
const GRASS_VS = /* glsl */ `
uniform float uTime;
uniform vec3 uKey;
varying float vH;
varying float vShade;
void main(){
  vec3 p=position;
  vec4 root=instanceMatrix*vec4(0.0,0.0,0.0,1.0);
  float ph=root.x*7.0+root.z*5.0+root.y*3.0;
  float sway=sin(uTime*2.2+ph)*0.35+sin(uTime*3.7+ph*1.7)*0.12;
  p.x+=sway*p.y*p.y*14.0;
  vH=clamp(position.y/0.07,0.0,1.0);
  vec3 n=normalize((instanceMatrix*vec4(0.0,1.0,0.0,0.0)).xyz);
  vShade=(0.78+0.22*max(dot(n,normalize(uKey)),0.0))*(0.92+0.16*fract(sin(ph)*43758.5));
  gl_Position=projectionMatrix*viewMatrix*modelMatrix*instanceMatrix*vec4(p,1.0);
}
`;
const GRASS_FS = /* glsl */ `
varying float vH;
varying float vShade;
void main(){
  vec3 col=mix(vec3(0.3,0.66,0.16),vec3(0.72,0.95,0.36),vH)*vShade;
  gl_FragColor=vec4(pow(col,vec3(2.2)),1.0); // sRGB-authored colour → linear (tone mapping + sRGB happen in post)
}
`;

function bladeGeometry() {
  const h = 0.06, w = 0.006;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-w, 0, 0, w, 0, 0, -w * 0.6, h * 0.5, 0, w * 0.6, h * 0.5, 0, 0, h, 0], 3));
  geo.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]);
  return geo;
}

/** One big smiling mouth tile on a bright candy-stripe background; tiles seamlessly. */
function mouthDomeTexture() {
  const W = 256, H = 256, c = makeCanvas(W, H), g = c.getContext('2d');
  // Bright childlike background: diagonal pastel stripes + polka dots.
  const stripes = ['#ffd6e8', '#fff1a8', '#c9f2ff', '#ffe0b8'];
  for (let i = -8; i < 16; i++) {
    g.fillStyle = stripes[(i + 8) % stripes.length];
    g.beginPath();
    g.moveTo(i * 32, 0); g.lineTo(i * 32 + 32, 0); g.lineTo(i * 32 + 32 - H, H); g.lineTo(i * 32 - H, H);
    g.fill();
  }
  g.fillStyle = 'rgba(255,255,255,0.55)';
  for (const [x, y] of [[20, 20], [236, 236], [20, 236], [236, 20], [128, 8], [128, 248], [8, 128], [248, 128]]) {
    g.beginPath(); g.arc(x, y, 9, 0, PI * 2); g.fill();
  }
  // The mouth: a wide grin — dark inside, a row of square teeth, thick red lips.
  const cx = 128, cy = 132, w = 92, top = 22, bottom = 62;
  const grin = () => {
    g.beginPath();
    g.moveTo(cx - w, cy - 6);
    g.quadraticCurveTo(cx, cy + top, cx + w, cy - 6);
    g.quadraticCurveTo(cx, cy + bottom + 30, cx - w, cy - 6);
    g.closePath();
  };
  g.save();
  g.shadowColor = 'rgba(120,20,40,0.35)';
  g.shadowBlur = 10;
  g.lineWidth = 20;
  g.strokeStyle = '#e8364f';
  grin();
  g.stroke();
  g.restore();
  g.fillStyle = '#3a0612';
  grin();
  g.fill();
  g.save();
  grin();
  g.clip();
  g.fillStyle = '#ff6f8a'; // tongue
  g.beginPath(); g.ellipse(cx, cy + 46, 40, 18, 0, 0, PI * 2); g.fill();
  g.fillStyle = '#fffaf0'; // teeth
  for (let i = -5; i <= 5; i++) {
    const x = cx + i * 15;
    const y = cy - 6 + (top * (1 - Math.pow(i / 6, 2))) * 0.5;
    g.fillRect(x - 6.5, y - 2, 13, 17);
  }
  g.restore();
  g.lineWidth = 3; // lip highlight
  g.strokeStyle = 'rgba(255,190,200,0.8)';
  g.beginPath(); g.moveTo(cx - 50, cy - 8); g.quadraticCurveTo(cx, cy + 6, cx + 50, cy - 8); g.stroke();
  const t = toTexture(c);
  t.repeat.set(7, 3);
  return t;
}

/** Repeating diagonal stripes (for candy canes / lollipop swirls). */
function stripeTexture(a, b, n = 8) {
  const c = makeCanvas(128, 128), g = c.getContext('2d');
  g.fillStyle = a;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = b;
  const s = 128 / n;
  for (let i = -n; i < n * 2; i += 2) {
    g.beginPath();
    g.moveTo(i * s, 0); g.lineTo(i * s + s, 0); g.lineTo(i * s + s - 128, 128); g.lineTo(i * s - 128, 128);
    g.fill();
  }
  return toTexture(c);
}

/** Lollipop swirl disc face. */
function swirlTexture(colors) {
  const c = makeCanvas(128, 128), g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.beginPath(); g.arc(64, 64, 64, 0, PI * 2); g.fill();
  for (let k = 0; k < colors.length; k++) {
    g.strokeStyle = colors[k];
    g.lineWidth = 9;
    g.beginPath();
    for (let a = 0; a < PI * 7; a += 0.08) {
      const r = (a / (PI * 7)) * 60;
      const x = 64 + Math.cos(a + (k * 2 * PI) / colors.length) * r, y = 64 + Math.sin(a + (k * 2 * PI) / colors.length) * r;
      if (a === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const candyMat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.28, metalness: 0, emissive: color, emissiveIntensity: 0.12, ...extra });

function makeLollipop() {
  const g = new THREE.Group();
  const h = 0.16 + Math.random() * 0.08, r = 0.06 + Math.random() * 0.03;
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, h, 8), new THREE.MeshStandardMaterial({ color: 0xfdfaf2, roughness: 0.6 }));
  stick.position.y = h / 2;
  const palettes = [['#ff4f8b', '#ffd23f'], ['#3ec5ff', '#ff6fb5'], ['#7ae36b', '#ff9f1c'], ['#b06bff', '#4fe3c1']];
  const swirl = swirlTexture(palettes[Math.floor(Math.random() * palettes.length)]);
  const face = new THREE.MeshStandardMaterial({ map: swirl, emissiveMap: swirl, emissive: 0xffffff, emissiveIntensity: 0.45, roughness: 0.35 });
  const edge = candyMat(0xffffff);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.022, 32), [edge, face, face]);
  disc.rotation.z = PI / 2; // face toward ±X (the camera)
  disc.position.y = h + r * 0.9;
  g.add(stick, disc);
  return g;
}

function makeCandyCane(stripes) {
  const h = 0.16 + Math.random() * 0.07, hook = 0.035;
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, h * 0.7, 0),
    new THREE.Vector3(0, h, 0),
    new THREE.Vector3(0, h + hook * 0.9, -hook * 0.6),
    new THREE.Vector3(0, h + hook * 0.7, -hook * 1.6),
    new THREE.Vector3(0, h + hook * 0.1, -hook * 2),
  ]);
  const mat = new THREE.MeshStandardMaterial({ map: stripes, roughness: 0.3, emissive: 0xffffff, emissiveIntensity: 0.06 });
  const cane = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.011, 12, false), mat);
  const g = new THREE.Group();
  g.add(cane);
  g.rotation.y = Math.random() * PI * 2;
  return g;
}

function makeSweet() {
  const g = new THREE.Group();
  const col = ['#ff4f8b', '#ffd23f', '#3ec5ff', '#7ae36b', '#ff9f1c', '#b06bff'][Math.floor(Math.random() * 6)];
  const mat = candyMat(col, { roughness: 0.18 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.026, 20, 14), mat);
  body.scale.set(1.35, 1, 1);
  g.add(body);
  for (const s of [-1, 1]) { // twisted wrapper ends
    const end = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.03, 10), mat);
    end.rotation.z = (s * PI) / 2;
    end.position.x = s * 0.048;
    g.add(end);
  }
  g.position.y = 0.022;
  const wrap = new THREE.Group();
  wrap.add(g);
  wrap.rotation.y = Math.random() * PI * 2;
  return wrap;
}

function makeGumdrop() {
  const col = ['#ff5c7a', '#ffcf3a', '#5ad1ff', '#6fe07a', '#ff9a3c', '#c27bff'][Math.floor(Math.random() * 6)];
  const geo = new THREE.SphereGeometry(0.035, 24, 14, 0, PI * 2, 0, PI * 0.55);
  const pos = geo.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) { // taper into a gumdrop
    v.fromBufferAttribute(pos, i);
    const k = 1 - 0.25 * (v.y / 0.035);
    pos.setXYZ(i, v.x * k, v.y * 1.15, v.z * k);
  }
  geo.computeVertexNormals();
  geo.translate(0, -0.006, 0);
  const m = new THREE.Mesh(geo, candyMat(col, { roughness: 0.45, emissiveIntensity: 0.18 }));
  m.scale.setScalar(0.8 + Math.random() * 0.6);
  return m;
}

/** Small, friendly red fire hydrant (base at origin, +Y up, face toward +X). Returns { group, eyes }. */
function makeHydrant() {
  const red = new THREE.MeshStandardMaterial({ color: 0xd62a1e, roughness: 0.42, metalness: 0.1 });
  const darkRed = new THREE.MeshStandardMaterial({ color: 0xa81d14, roughness: 0.5, metalness: 0.1 });
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
  const black = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.25 });
  const g = new THREE.Group();
  const add = (geo, mat, x, y, z, rx = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, 0, rz);
    g.add(m);
    return m;
  };
  add(new THREE.CylinderGeometry(0.06, 0.064, 0.016, 24), darkRed, 0, 0.008, 0);            // base flange
  add(new THREE.CylinderGeometry(0.045, 0.048, 0.14, 24), red, 0, 0.086, 0);                // barrel
  add(new THREE.CylinderGeometry(0.055, 0.055, 0.016, 24), darkRed, 0, 0.16, 0);           // top ring
  add(new THREE.SphereGeometry(0.05, 24, 12, 0, PI * 2, 0, PI / 2), red, 0, 0.168, 0);      // dome cap
  add(new THREE.CylinderGeometry(0.012, 0.014, 0.022, 6), darkRed, 0, 0.226, 0);           // bonnet nut
  for (const s of [-1, 1]) {                                                                 // side outlets
    add(new THREE.CylinderGeometry(0.016, 0.016, 0.03, 16), red, 0, 0.11, s * 0.055, PI / 2);
    add(new THREE.CylinderGeometry(0.02, 0.02, 0.008, 6), darkRed, 0, 0.11, s * 0.072, PI / 2);
  }
  add(new THREE.CylinderGeometry(0.02, 0.02, 0.026, 16), red, -0.055, 0.1, 0, 0, PI / 2);  // rear pumper outlet

  // Friendly face on the front (+X).
  const eyes = new THREE.Group();
  for (const s of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(0.042, 0.128, s * 0.018);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 12), white);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.0065, 12, 10), black);
    pupil.position.set(0.008, -0.001, 0);
    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.0022, 8, 6), white);
    glint.position.set(0.0135, 0.002, -0.002);
    eye.add(ball, pupil, glint);
    eyes.add(eye);
  }
  g.add(eyes);
  const smile = new THREE.Mesh(new THREE.TorusGeometry(0.014, 0.0025, 8, 20, PI), black);
  smile.rotation.set(0, PI / 2, PI); // lower half-circle, facing +X
  smile.position.set(0.046, 0.1, 0);
  g.add(smile);
  for (const s of [-1, 1]) { // rosy cheeks
    const cheek = new THREE.Mesh(new THREE.SphereGeometry(0.007, 20, 14), new THREE.MeshStandardMaterial({ color: 0xff7a7a, roughness: 0.6 }));
    cheek.scale.set(0.4, 0.7, 1);
    cheek.position.set(0.045, 0.106, s * 0.03);
    g.add(cheek);
  }
  g.scale.setScalar(HYDRANT_SCALE);
  return { group: g, eyes };
}

function makeTree() {
  const tree = new THREE.Group();
  const h = 0.12 + Math.random() * 0.08;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.011, 0.018, h, 10),
    new THREE.MeshStandardMaterial({ color: 0x9a6a3e, roughness: 0.85 }),
  );
  trunk.position.y = h / 2;
  tree.add(trunk);
  const canopy = new THREE.Group();
  canopy.position.y = h;
  const leaf = new THREE.MeshStandardMaterial({ color: hsl(0.26 + Math.random() * 0.07, 0.7, 0.45 + Math.random() * 0.08), roughness: 0.75, emissive: 0x142a08 });
  const puffs = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < puffs; i++) {
    const r = 0.055 + Math.random() * 0.04;
    const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 3), leaf);
    puff.position.set((Math.random() - 0.5) * 0.08, 0.04 + Math.random() * 0.06, (Math.random() - 0.5) * 0.08);
    canopy.add(puff);
  }
  tree.add(canopy);
  return { tree, canopy, phase: Math.random() * 6 };
}

function makeWinged(color, span, chord) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, side: THREE.DoubleSide, emissive: color, emissiveIntensity: 0.15 });
  const wings = [-1, 1].map((s) => {
    const geo = new THREE.PlaneGeometry(span, chord);
    geo.translate(span / 2, 0, 0);
    geo.rotateX(-PI / 2);
    const w = new THREE.Mesh(geo, mat);
    if (s < 0) w.rotation.y = PI;
    g.add(w);
    return w;
  });
  return { group: g, wings };
}

function buildMiniWorld() {
  const R = GLOBE_R;
  const group = new THREE.Group();
  group.visible = false;
  const fadeMats = []; // materials that fade in with the reveal (opacity)

  // Terrain: soft rounded hills in bright greens with warm wobbly paths.
  const planetGeo = new THREE.SphereGeometry(R, 192, 128);
  const pos = planetGeo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const d = new THREE.Vector3(), c = new THREE.Color();
  const grassA = new THREE.Color('#5cc93c'), grassB = new THREE.Color('#9be04f'), hilltop = new THREE.Color('#c4ec62');
  const pathCol = new THREE.Color('#ffd9a0'), pathEdge = new THREE.Color('#f2b77c');
  for (let i = 0; i < pos.count; i++) {
    d.fromBufferAttribute(pos, i).normalize();
    surfacePoint(d, 0, d.clone()).toArray(pos.array, i * 3);
    const n1 = 0.5 + 0.5 * Math.sin(d.x * 4.1 + d.y * 3.3) * Math.sin(d.z * 3.7 + 1.1);
    c.lerpColors(grassA, grassB, n1);
    c.lerp(hilltop, THREE.MathUtils.smoothstep(hill(d), 0.03, 0.09) * 0.6);
    const p = pathAmount(d);
    if (p > 0) c.lerp(pathEdge, Math.min(1, p * 2)).lerp(pathCol, THREE.MathUtils.smoothstep(p, 0.5, 1));
    c.toArray(colors, i * 3);
  }
  planetGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  planetGeo.computeVertexNormals();
  const planet = new THREE.Mesh(planetGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, emissive: 0x16240a }));
  group.add(planet);

  // Dome ceiling covered in identical big grinning mouths (seen from inside, behind the planet).
  const domeTex = mouthDomeTexture();
  const domeMat = new THREE.MeshStandardMaterial({
    map: domeTex, emissiveMap: domeTex, emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 0.6,
    side: THREE.BackSide, transparent: true, opacity: 0,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_R, 96, 48, 0, PI * 2, 0, PI * 0.62), domeMat);
  dome.renderOrder = -1;
  group.add(dome);
  fadeMats.push(domeMat);

  // Warm, bright lighting: key from the front, warm fill, soft top light under the dome.
  const key = new THREE.PointLight(0xfff0d6, 0, 0, 2);
  key.position.copy(KEY_DIR).multiplyScalar(3);
  const fill = new THREE.PointLight(0xffe2c4, 0, 4.5, 2); // limited range: don't spotlight the dark street
  fill.position.set(2.5, 0.5, -2.0);
  const top = new THREE.PointLight(0xfff4c0, 0, 0, 2);
  top.position.set(0.3, DOME_R * 0.85, 0);
  group.add(key, fill, top);
  const lights = [[key, 11], [fill, 5], [top, 6]];

  // Fire hydrant.
  const hydrant = makeHydrant();
  surfacePoint(HYDRANT_DIR, -0.004, hydrant.group.position);
  hydrant.group.quaternion.setFromUnitVectors(UP, HYDRANT_DIR);
  group.add(hydrant.group);

  // Grass blades (off the paths).
  const BLADES = 2600;
  const grassMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uKey: { value: KEY_DIR } }, vertexShader: GRASS_VS, fragmentShader: GRASS_FS, side: THREE.DoubleSide,
  });
  const grass = new THREE.InstancedMesh(bladeGeometry(), grassMat, BLADES);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < BLADES; i++) {
    const dir = frontDir(-0.35, HYDRANT_DIR, 0.06);
    surfacePoint(dir, -0.003, dummy.position);
    dummy.quaternion.setFromUnitVectors(UP, dir).multiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.random() * PI));
    dummy.scale.setScalar(0.7 + Math.random() * 0.7);
    dummy.updateMatrix();
    grass.setMatrixAt(i, dummy.matrix);
  }
  grass.frustumCulled = false;
  group.add(grass);

  // Flowers: petals + yellow centres.
  const FLOWERS = 170;
  const petalColors = ['#ff9ec7', '#ffd84d', '#ffffff', '#c7a3ff', '#ff7b7b', '#ffb366', '#8fd3ff'].map((h) => new THREE.Color(h));
  const petals = new THREE.InstancedMesh(new THREE.CircleGeometry(0.014, 7), new THREE.MeshStandardMaterial({ roughness: 0.6, side: THREE.DoubleSide, emissive: 0x221a1a }), FLOWERS);
  const centres = new THREE.InstancedMesh(new THREE.SphereGeometry(0.0055, 8, 6), new THREE.MeshStandardMaterial({ color: 0xffc928, roughness: 0.5 }), FLOWERS);
  const zAxis = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i < FLOWERS; i++) {
    const dir = frontDir(-0.2, HYDRANT_DIR, 0.1);
    const lift = 0.035 + Math.random() * 0.025;
    surfacePoint(dir, lift, dummy.position);
    const face = dir.clone().add(new THREE.Vector3().randomDirection().multiplyScalar(0.35)).normalize();
    dummy.quaternion.setFromUnitVectors(zAxis, face);
    dummy.scale.setScalar(0.8 + Math.random() * 0.5);
    dummy.updateMatrix();
    petals.setMatrixAt(i, dummy.matrix);
    petals.setColorAt(i, petalColors[i % petalColors.length]);
    dummy.position.addScaledVector(face, 0.003);
    dummy.updateMatrix();
    centres.setMatrixAt(i, dummy.matrix);
  }
  group.add(petals, centres);

  // Round leafy trees.
  const trees = [];
  for (let i = 0; i < 7; i++) {
    const dir = frontDir(0.1, HYDRANT_DIR, 0.5, false, -0.3);
    const t = makeTree();
    surfacePoint(dir, -0.005, t.tree.position);
    t.baseQ = new THREE.Quaternion().setFromUnitVectors(UP, dir);
    t.tree.quaternion.copy(t.baseQ);
    t.tree.scale.setScalar(0.9 + Math.random() * 0.5);
    group.add(t.tree);
    trees.push(t);
  }

  // Candy scattered across the terrain (tall pieces kept clear of the hydrant and the zoom path).
  const caneStripes = [stripeTexture('#ffffff', '#e8243c'), stripeTexture('#ffffff', '#2fae5a'), stripeTexture('#fff3f8', '#ff5fa2')];
  const placeCandy = (obj, dir, lift = -0.004, faceCamera = false) => {
    surfacePoint(dir, lift, obj.position);
    const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
    if (faceCamera) { // spin about the surface normal so local +X points toward the camera (+X)
      const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      const want = new THREE.Vector3(1, 0, 0).addScaledVector(dir, -dir.x).normalize();
      const angle = Math.atan2(new THREE.Vector3().crossVectors(x, want).dot(dir), x.dot(want));
      q.premultiply(new THREE.Quaternion().setFromAxisAngle(dir, angle));
    }
    obj.quaternion.copy(q.multiply(obj.quaternion));
    group.add(obj);
  };
  for (let i = 0; i < 6; i++) placeCandy(makeLollipop(), frontDir(0.6, HYDRANT_DIR, 0.55, false, -0.1), -0.004, true);
  for (let i = 0; i < 6; i++) placeCandy(makeCandyCane(caneStripes[i % caneStripes.length]), frontDir(0.05, HYDRANT_DIR, 0.55, false, -0.25));
  for (let i = 0; i < 14; i++) placeCandy(makeSweet(), frontDir(-0.1, HYDRANT_DIR, 0.25, true, -0.3));
  for (let i = 0; i < 16; i++) placeCandy(makeGumdrop(), frontDir(-0.1, HYDRANT_DIR, 0.25, false, -0.3));

  // Butterflies fluttering over the grass.
  const flyers = [];
  ['#ff9a3c', '#6fb7ff', '#ffe066', '#ff8fc8', '#b98bff'].forEach((col) => {
    const b = makeWinged(col, 0.022, 0.026);
    group.add(b.group);
    flyers.push({ ...b, th: 0.5 + Math.random() * 0.9, ph: PI / 2 + 0.3 + Math.random() * (PI - 0.6), a: Math.random() * 6, b: Math.random() * 6, flap: 16 + Math.random() * 6 });
  });

  let time = 0;
  const prev = new THREE.Vector3();
  return {
    group, hydrant,
    /** Reveal amount k (0..1). */
    update(dt, k) {
      time += dt;
      grassMat.uniforms.uTime.value = time;
      for (const m of fadeMats) m.opacity = k;
      for (const [l, max] of lights) l.intensity = max * k;
      for (const t of trees) {
        const s = Math.sin(time * 1.3 + t.phase) * 0.04;
        t.tree.quaternion.copy(t.baseQ).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(s, 0, s * 0.7)));
        t.canopy.rotation.y = Math.sin(time * 0.9 + t.phase) * 0.08;
      }
      for (const f of flyers) {
        prev.copy(f.group.position);
        const th = f.th + 0.25 * Math.sin(time * 0.8 + f.a);
        const ph = f.ph + 0.5 * Math.sin(time * 0.55 + f.b);
        surfacePoint(sphereDir(th, ph), 0.1 + 0.05 * Math.sin(time * 2 + f.a), f.group.position);
        if (prev.distanceToSquared(f.group.position) > 1e-8) f.group.lookAt(group.localToWorld(prev.clone()));
        const flap = Math.sin(time * f.flap) * 0.9;
        f.wings[0].rotation.z = flap;
        f.wings[1].rotation.z = flap; // mirrored by rotation.y = PI, so same sign
      }
      // One friendly blink, then the occasional one.
      const blink = (time % 2.6) > 2.45 ? 0.15 : 1;
      hydrant.eyes.children.forEach((e) => { e.scale.y = blink; });
    },
  };
}

function sphereDir(theta, phi, out = new THREE.Vector3()) {
  return out.set(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
}

function buildGlobe(scene, world, colliders) {
  const R = GLOBE_R;
  const additive = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false };

  // Pedestal + projector cone belong to the world (they get pulled in too).
  const metal = new THREE.MeshStandardMaterial({ color: 0x1a1416, metalness: 0.7, roughness: 0.4 });
  const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 0.9, 24), metal);
  pedestal.position.set(GLOBE.x, 0.45, GLOBE.z);
  const padRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.62, 0.04, 8, 48),
    new THREE.MeshBasicMaterial({ color: 0x5ae0ff, ...additive }),
  );
  padRing.rotation.x = Math.PI / 2;
  padRing.position.set(GLOBE.x, 0.91, GLOBE.z);
  const beamMat = new THREE.MeshBasicMaterial({ color: 0x5ae0ff, opacity: 0.16, side: THREE.DoubleSide, ...additive });
  const beam = new THREE.Mesh(new THREE.ConeGeometry(R * 0.85, GLOBE.y - R * 0.6 - 0.9, 32, 1, true), beamMat);
  beam.rotation.x = Math.PI; // apex down at the pedestal
  beam.position.set(GLOBE.x, (0.9 + GLOBE.y - R * 0.6) / 2, GLOBE.z);
  world.add(pedestal, padRing, beam);
  colliders.push(pedestal);

  // The globe itself lives outside `world`.
  const globe = new THREE.Group();
  globe.position.copy(GLOBE);

  const earthGroup = new THREE.Group();
  const earthMat = new THREE.MeshBasicMaterial({ map: earthTexture(), color: 0x9af0ff, opacity: 0.9, side: THREE.DoubleSide, ...additive });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(R, 48, 32), earthMat);
  const gridMat = new THREE.MeshBasicMaterial({ color: 0x5ae0ff, wireframe: true, opacity: 0.12, ...additive });
  const grid = new THREE.Mesh(new THREE.SphereGeometry(R * 1.015, 24, 16), gridMat);
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(R * 0.96, 32, 24),
    new THREE.MeshBasicMaterial({ color: 0x041420, transparent: true, opacity: 0.45, depthWrite: false }),
  );
  earthGroup.add(core, earth, grid);

  const orbitMat = new THREE.MeshBasicMaterial({ color: 0x9af0ff, opacity: 0.6, ...additive });
  const orbit = new THREE.Mesh(new THREE.TorusGeometry(R * 1.4, 0.012, 6, 128), orbitMat);
  orbit.rotation.x = Math.PI / 2 - 0.35;

  const light = new THREE.PointLight(0x5ae0ff, 14, 0, 2);
  const mini = buildMiniWorld();

  globe.add(earthGroup, orbit, light, mini.group);
  scene.add(globe);

  return { globe, earth, earthGroup, earthMat, gridMat, orbit, orbitMat, beamMat, light, mini };
}

// ---------- sound ----------

function flipSound() {
  const a = ctx?.audio;
  if (!a) return;
  [330, 495, 660, 990].forEach((f, i) => setTimeout(() => a.tone(f, 0.35, { type: 'triangle', volume: 0.12 }), i * 55));
}

function landSound() {
  const a = ctx?.audio;
  if (!a) return;
  a.tone(55, 0.45, { type: 'sine', volume: 0.35 });
  a.noise(0.15, { volume: 0.08 });
}

// ---------- globe sequence (after E) ----------
//
// Everything is driven by the sequence time `seq.t` (frame-rate independent) through smooth curves:
//   • the camera follows ONE cubic-Bézier dolly from the player's eye to the hydrant's face, sampled by
//     arc length, with its progress from a monotone cubic spline (C1-continuous speed, eases in and out);
//   • the Earth hologram cross-fades into the mini world (no flicker-swapping); all globe scaling is
//     anchored at the globe's base, so it never dips below its resting height;
//   • the world is pulled in toward a point just BELOW the globe (ground side) and the ceiling toward a
//     point just ABOVE it, so neither the ground, the pedestal nor the ceiling ever crosses the globe.

const smoother = (x) => x * x * x * (x * (x * 6 - 15) + 10);           // smootherstep: zero 1st/2nd derivative at ends
const window01 = (t, a, b) => smoother(clamp01((t - a) / (b - a)));
const GLOBE_BASE_Y = GLOBE.y - 1.25;   // lowest point of the globe's contents (mini world planet + grass)
const GLOBE_TOP_Y = GLOBE.y + DOME_R;  // top of the mouth dome
const PULL_PIVOT_LOW = new THREE.Vector3(GLOBE.x, GLOBE_BASE_Y - 0.15, GLOBE.z);
const PULL_PIVOT_HIGH = new THREE.Vector3(GLOBE.x, GLOBE_TOP_Y + 0.3, GLOBE.z);

/** Monotone cubic interpolation (Fritsch–Carlson) through [[t, v], …], zero slope at both ends. */
function monotoneCurve(keys) {
  const n = keys.length, xs = keys.map((k) => k[0]), ys = keys.map((k) => k[1]);
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const k = 3 / Math.sqrt(h); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
  }
  m[0] = 0;
  m[n - 1] = 0;
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/** Scale/transform a group about a fixed pivot (uniform scale + spin about the vertical axis). */
function shrinkAbout(group, pivot, scale, angle) {
  group.scale.setScalar(scale);
  group.quaternion.setFromAxisAngle(UP, angle);
  group.position.copy(pivot).sub(pivot.clone().multiplyScalar(scale).applyQuaternion(group.quaternion));
}

function startGlobeSequence() {
  const { player, interact, effects, audio, camera } = ctx;
  const g = s.globe;
  interact.remove(g.earth);
  player.enabled = false;
  camera.up.copy(player.up);

  // Turn the mini world so its front (local +X, where the hydrant faces) looks back at the player.
  const away = camera.position.clone().sub(GLOBE);
  away.y = 0;
  if (away.lengthSq() < 1e-4) away.set(1, 0, 0);
  away.normalize();
  g.mini.group.rotation.y = Math.atan2(-away.z, away.x);

  // Where the dolly ends: far enough back that the whole mini world (mouth dome included) fills the
  // view with a margin — computed from the camera's fov/aspect, so nothing gets cropped.
  const centre = GLOBE.clone().add(new THREE.Vector3(0, 0.25, 0));
  const halfV = THREE.MathUtils.degToRad(camera.fov / 2);
  const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
  const fitDist = (DOME_R * 1.12) / Math.sin(Math.min(halfV, halfH));
  const toCam = away.clone().multiplyScalar(Math.cos(0.2)).add(new THREE.Vector3(0, Math.sin(0.2), 0)).normalize();
  const end = centre.clone().addScaledVector(toCam, fitDist);

  // One continuous dolly: crane back/up to frame the globe, then push in along the same line and settle.
  const startDist = Math.hypot(camera.position.x - GLOBE.x, camera.position.z - GLOBE.z);
  const c1 = GLOBE.clone().addScaledVector(away, Math.max(startDist, fitDist + 1.4)).setY(GLOBE.y + 1.6);
  const c2 = end.clone().addScaledVector(toCam, 1.2);
  const path = new THREE.CubicBezierCurve3(camera.position.clone(), c1, c2, end);
  // Progress over time (monotone cubic → continuous speed): crane, slow drift during the pull-in, push-in, ease to a hold.
  const progress = monotoneCurve([[0, 0], [1.9, 0.35], [T.pullEnd, 0.55], [T.settle, 1]]);

  const tone = (f, d, o) => () => audio.tone(f, d, o);
  const cues = [
    ...[523, 659, 784, 1047].map((f, i) => ({ at: T.morph + i * 0.12, fn: tone(f, 1.2, { type: 'sine', volume: 0.08 }) })),
    ...Array.from({ length: 8 }, (_, i) => ({ at: T.pull + i * 0.22, fn: tone(220 - i * 18, 0.35, { type: 'sawtooth', volume: 0.045 }) })),
    { at: T.pullEnd - 0.3, fn: tone(45, 1.0, { type: 'sine', volume: 0.35 }) },
    ...Array.from({ length: 6 }, (_, i) => ({ at: T.pullEnd + 0.3 + i * 0.18, fn: tone(330 * Math.pow(1.19, i), 0.3, { type: 'sine', volume: 0.06 }) })),
    ...[1047, 1319, 1568].map((f, i) => ({ at: T.flash + i * 0.04, fn: tone(f, 0.9, { type: 'sine', volume: 0.07 }) })), // shimmer with the flash
  ].sort((a, b) => a.at - b.at);

  seq = {
    t: 0,
    qFrom: camera.quaternion.clone(),
    path,
    progress,
    lookAt: centre,
    look: new THREE.Vector3(),
    m: new THREE.Matrix4(),
    q: new THREE.Quaternion(),
    cues,
    left: false,
    worldFade: 1,
    bg0: s.scene.background.clone(),
    fog0: s.scene.fog.color.clone(),
    earthOpacity: g.earthMat.opacity,
    gridOpacity: g.gridMat.opacity,
    orbitOpacity: g.orbitMat.opacity,
    light0: g.light.intensity,
    // Lights inside the world (lamps, portal): they shrink in with it but keep their brightness, so fade them.
    worldLights: (() => { const l = []; s.world.traverse((o) => { if (o.isLight) l.push([o, o.intensity]); }); return l; })(),
  };

  effects.error({ duration: T.error * 1000 });
  audio.glitch();
}

function updateGlobeSequence(dt) {
  const { camera } = ctx;
  const g = s.globe;
  const mini = g.mini;
  seq.t += dt;
  const t = seq.t;

  while (seq.cues.length && seq.cues[0].at <= t) seq.cues.shift().fn();

  // ---- Camera: one continuous dolly that settles with the globe filling the view; orientation eases from
  // the player's view onto the globe.
  seq.path.getPointAt(clamp01(seq.progress(t)), camera.position);
  seq.m.lookAt(camera.position, seq.lookAt, camera.up);
  seq.q.setFromRotationMatrix(seq.m);
  camera.quaternion.slerpQuaternions(seq.qFrom, seq.q, window01(t, 0, 1.3));

  // ---- Hologram: glitches during the ERROR, then expands a touch and fades out (anchored at its base).
  const morph = window01(t, T.morph, T.morphEnd);
  const glitching = t < T.error;
  const jitter = 0.035 * (1 - window01(t, T.error - 0.5, T.error)); // only during the error, dying away smoothly
  const flicker = glitching ? (Math.random() < 0.25 ? 0.35 : 1) : 1;
  const es = 1 + 0.12 * morph;
  g.earthGroup.scale.setScalar(es);
  g.earthGroup.position.set((Math.random() - 0.5) * jitter, GLOBE_R * (es - 1), (Math.random() - 0.5) * jitter);
  g.earthGroup.rotation.y += dt * 0.25;
  g.earthMat.opacity = seq.earthOpacity * flicker * (1 - morph);
  g.gridMat.opacity = seq.gridOpacity * (1 - morph);
  g.orbitMat.opacity = seq.orbitOpacity * (1 - morph);
  g.orbit.rotation.z += dt * 0.5;
  g.earthGroup.visible = morph < 1;
  g.orbit.visible = morph < 1;
  g.light.intensity = seq.light0 * (1 - morph); // the cyan light gives way to the mini world's warm lighting

  // ---- Mini world: grows smoothly out of the hologram (no overshoot), bottom anchored above the pedestal.
  mini.group.visible = morph > 0;
  const ms = 0.55 + 0.45 * morph;
  mini.group.scale.setScalar(ms);
  mini.group.position.set(0, (GLOBE.y - GLOBE_BASE_Y) * (1 - ms), 0);
  mini.update(dt, morph);

  // Post-processing and the dark world's lights ease over to the mini world's look.
  const pk = window01(t, T.morph, T.morphEnd + 0.3);
  const blend = {};
  for (const key of Object.keys(POST_DARK)) blend[key] = POST_DARK[key] + (POST_MINI[key] - POST_DARK[key]) * pk;
  ctx.post?.set(blend);

  // ---- The dark world is pulled into the globe: ground side toward a point just under the globe,
  // ceiling toward a point just above it — both shrink and swirl, never crossing the globe.
  const c = window01(t, T.pull, T.pullEnd);
  const L = s.lights, base = s.lightBase;
  L.hemi.intensity = base.hemi * (1 - 0.5 * pk) * (1 - c);
  L.top.intensity = base.top * (1 - c);
  L.below.intensity = base.below * (1 - c);
  if (c > 0) {
    const fade = Math.pow(1 - c, 2);
    seq.worldFade = fade;
    for (const [light, i0] of seq.worldLights) light.intensity = i0 * fade;
    const scale = Math.max(1e-4, 1 - c);
    const angle = c * c * PI * 2;
    shrinkAbout(s.world, PULL_PIVOT_LOW, scale, angle);
    shrinkAbout(s.sky, PULL_PIVOT_HIGH, scale, angle);
    s.world.visible = s.sky.visible = c < 1;
    const kk = 1 - c;
    s.scene.background.copy(seq.bg0).multiplyScalar(kk);
    s.scene.fog.color.copy(seq.fog0).multiplyScalar(kk);
    s.scene.fog.density = s.fogDensity * kk;
  }

  // ---- White flash: the scene brightens while the screen fades to pure white, and Quirkland fades in from white.
  if (t >= T.flash) {
    if (!seq.left) {
      seq.left = true;
      ctx.goTo('quirkland', { fadeColor: '#fff', fadeOutMs: 300 });
    }
    const f = window01(t, T.flash, T.flash + 0.3);
    ctx.post?.set({ exposure: POST_MINI.exposure * (1 + 2 * f), bloomStrength: POST_MINI.bloomStrength + 0.8 * f, bloomThreshold: POST_MINI.bloomThreshold * (1 - 0.6 * f) });
  }
}

function updateGlobeIdle(dt) {
  const g = s.globe;
  g.earthGroup.rotation.y += dt * 0.25;
  g.orbit.rotation.z += dt * 0.4;
  const flicker = Math.random() < 0.03 ? 0.4 : 1;
  g.earthMat.opacity = (0.8 + 0.1 * Math.sin(s.time * 13)) * flicker;
  g.gridMat.opacity = 0.1 + 0.05 * Math.sin(s.time * 3);
  g.beamMat.opacity = 0.12 + 0.06 * Math.sin(s.time * 5);
}

// ---------- scene ----------

export default {
  name: 'inverted',

  async init(c) {
    ctx = c;
    seq = null;
    const { scene, player, interact } = ctx;
    ctx.post?.set({ ...POST_DARK, ssaoRadius: 0.6 });
    const world = new THREE.Group(); // everything that gets pulled into the globe
    scene.add(world);

    // PBR texture sets + night HDRI (image-based lighting and wet reflections).
    const [tex] = await Promise.all([
      loadTextures(),
      ctx.setEnvironment ? ctx.setEnvironment(HDRI).catch((e) => console.warn('inverted: HDRI failed to load', e)) : null,
    ]);
    if (ctx !== c) return; // left the scene while loading

    const { eye, ...lights } = buildEnvironment(scene, world, player.colliders, tex);
    // The ceiling gets its own group so the globe sequence can pull it in from above the globe.
    const sky = new THREE.Group();
    scene.add(sky);
    sky.add(world.children.find((o) => o.userData.isCeiling));
    const portal = buildPortal(world);
    const globe = buildGlobe(scene, world, player.colliders);
    // The mini world keeps its own look: the night HDRI must not light it.
    globe.mini.group.traverse((o) => {
      for (const m of [].concat(o.material || [])) if ('envMapIntensity' in m) m.envMapIntensity = 0;
    });

    const lightBase = { hemi: lights.hemi.intensity, top: lights.top.intensity, below: lights.below.intensity };
    s = {
      portal, eye, scene, world, sky, lights, lightBase, fogDensity: FOG.density, globe,
      time: 0, flash: 0, active: 0, pendingFlip: null, wasGrounded: false, flips: 0,
    };

    // Pressure plate (the portal): jumping while directly vertically opposite it (or on it) flips gravity.
    player.onJump((p) => {
      if (inZone(p.position) && s.pendingFlip === null) s.pendingFlip = FLIP_DELAY;
    });

    // Holographic globe: E starts the sequence.
    interact.add(globe.earth, () => { if (!seq) startGlobeSequence(); }, { distance: GLOBE_REACH });

    // Arrive falling "up" onto the ceiling.
    player.spawn(SPAWN, 0, { flipped: true });
  },

  update(dt) {
    if (!s) return;
    const p = ctx.player;
    s.time += dt;

    if (seq) updateGlobeSequence(dt);
    else updateGlobeIdle(dt);

    if (s.pendingFlip !== null) {
      s.pendingFlip -= dt;
      if (s.pendingFlip <= 0) {
        s.pendingFlip = null;
        p.flipGravity();
        s.flips++;
        s.flash = 1;
        flipSound();
      }
    }

    // Portal: brighter while the player is in position, flares on a flip.
    const target = p.grounded && inZone(p.position) ? 1 : 0;
    s.active += (target - s.active) * Math.min(1, dt * 6);
    s.flash = Math.max(0, s.flash - dt * 1.5);
    s.portal.update(dt, s.time, s.active, s.flash, seq ? seq.worldFade : 1);
    s.eye?.update(dt);

    if (p.grounded && !s.wasGrounded) landSound();
    s.wasGrounded = p.grounded;

    // Safety net: escaped the level somehow → back to the start.
    const pos = p.position;
    if (!seq && (Math.abs(pos.x) > HALF + 4 || Math.abs(pos.z) > HALF + 4 || pos.y < -20 || pos.y > CEIL + 20)) {
      p.spawn(SPAWN, 0, { flipped: true });
      s.pendingFlip = null;
    }
  },

  dispose() {
    ctx = null;
    s = null;
    seq = null;
  },
};
