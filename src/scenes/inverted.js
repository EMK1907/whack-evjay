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
// into the globe → the camera zooms down into the hydrant → goTo('quirkland'). No text; ~7.4s.
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
  camMove: 1.0,    // camera glides to the vantage point
  error: 1.4,      // ERROR! effect, globe glitches; then the mini world appears
  pull: 3.2,       // the dark world starts being pulled into the globe…
  pullEnd: 5.0,    // …and is gone
  zoomEnd: 7.0,    // camera has zoomed into the fire hydrant → goTo('quirkland')
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
const smooth = (x) => x * x * (3 - 2 * x);
const easeIn = (x) => x * x * x;
const easeOutBack = (x) => 1 + 2.70158 * Math.pow(x - 1, 3) + 1.70158 * Math.pow(x - 1, 2);
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
  return {
    brick: std(tex.brick, { color: 0xa8968c, roughness: 1 }),
    plaster: ['#c8b496', '#b99c8a', '#a6a496', '#c09c80'].map((c) => std(tex.plaster, { color: c, roughness: 1 })),
    stone: std(tex.pavers, { color: 0xb3a99c, roughness: 1 }),
    roof: std(tex.roof, { color: 0x9c8078, roughness: 1 }),
    wood: std(tex.wood, { color: 0x7a6a5c, roughness: 1 }),
    shutter: std(tex.shutter, { color: 0x9a8c80, roughness: 1 }),
    iron: std(tex.metal, { color: 0x34302e, metalness: 0.55, roughness: 0.85 }),
    hydrant: std(tex.metal, { color: 0xc23a2a, metalness: 0.35, roughness: 0.9 }),
    paint: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65 }),
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
    puddle: new THREE.MeshStandardMaterial({
      // The scene's lamps give the puddles their highlights; no HDRI reflection (its own lamps are far too bright).
      color: 0x050303, roughness: 0.1, metalness: 0, envMapIntensity: 0, alphaMap: puddleAtlas(rand),
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
  };
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
  function windowAt(face, x, y, litChance) {
    const at = (gx, gy, gz) => face.clone().multiply(mat(x + gx, y + gy, gz));
    const frame = pick(rand, FRAME_COLORS);
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

/** One old 2–4 storey house: walls, plinth, cornice, roof, chimneys, windows/doors on street faces. */
function addHouse(B, kit, rand, parent, colliders, cx, cz, w, d, lotX, lotZ) {
  const base = KERB_H;
  const floors = 2 + Math.floor(rand() * 3);
  const wallH = 0.6 + floors * FLOOR_H;
  const brick = rand() < 0.4;
  const wallBatch = brick ? B.brick : pick(rand, B.plaster);
  const wallTile = brick ? [2, 2] : [2.5, 2.5];

  wallBatch.add(boxGeometry(w, wallH, d, wallTile), mat(cx, base + wallH / 2, cz));
  B.stone.add(boxGeometry(w + 0.08, 0.6, d + 0.08, [2, 2]), mat(cx, base + 0.3, cz));                      // plinth
  B.stone.add(boxGeometry(w + 0.1, 0.12, d + 0.1, [2, 2]), mat(cx, base + 0.6 + FLOOR_H, cz));              // string course
  B.stone.add(boxGeometry(w + 0.3, 0.22, d + 0.3, [2, 2]), mat(cx, base + wallH - 0.05, cz));               // cornice

  // Roof: ridge along the longer side; keep everything under MAX_TOP.
  const alongZ = d >= w;
  const span = alongZ ? w : d, len = alongZ ? d : w;
  const roofBase = base + wallH + 0.06;
  const rh = Math.min((span / 2) * Math.tan(0.6 + rand() * 0.25), MAX_TOP - 2 - roofBase);
  const M0 = mat(cx, roofBase, cz, alongZ ? 0 : Math.PI / 2);
  addRoof(B, wallBatch, M0, span, len, rh);
  for (let i = 0; i < 1 + (rand() < 0.5 ? 1 : 0); i++) { // chimneys poke through the slope
    const lx = (rand() < 0.5 ? -1 : 1) * span * 0.18, lz = (rand() - 0.5) * len * 0.6;
    const h = rh + 0.6 + rand() * 0.8;
    B.brick.add(boxGeometry(0.55, h, 0.55, [2, 2]), M0.clone().multiply(mat(lx, h / 2, lz)));
    B.stone.add(boxGeometry(0.7, 0.1, 0.7, [2, 2]), M0.clone().multiply(mat(lx, h + 0.05, lz)));
  }
  colliderBox(parent, colliders, w, wallH + rh, d, cx, base + (wallH + rh) / 2, cz);

  // Street-facing facades: those on the block's outer edge.
  const faces = [
    { n: [1, 0], at: cx + w / 2, edge: lotX + BUILD_HALF, width: d, ox: cx + w / 2, oz: cz },
    { n: [-1, 0], at: cx - w / 2, edge: lotX - BUILD_HALF, width: d, ox: cx - w / 2, oz: cz },
    { n: [0, 1], at: cz + d / 2, edge: lotZ + BUILD_HALF, width: w, ox: cx, oz: cz + d / 2 },
    { n: [0, -1], at: cz - d / 2, edge: lotZ - BUILD_HALF, width: w, ox: cx, oz: cz - d / 2 },
  ].filter((f) => Math.abs(f.at - f.edge) < 0.01);
  let doorDone = false;
  for (const f of faces) {
    const face = mat(f.ox, 0, f.oz, Math.atan2(f.n[0], f.n[1]));
    const slots = Math.max(1, Math.floor((f.width - 0.6) / 1.75));
    const xs = Array.from({ length: slots }, (_, i) => (i + 0.5) * (f.width / slots) - f.width / 2);
    // Ground floor: a door (one per house), sometimes a garage shutter, otherwise windows.
    let used = [];
    if (!doorDone) {
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
      if (!used.some(([a, b]) => x + 0.6 > a && x - 0.6 < b)) kit.windowAt(face, x, base + 0.6 + 1.55, 0.18);
    }
    for (let fl = 1; fl < floors; fl++) {
      for (const x of xs) kit.windowAt(face, x, base + 0.6 + fl * FLOOR_H + 1.55, 0.3);
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
    if (!(lx === GLOBE.x && lz === GLOBE.z)) towers.add(`${lx},${lz}`);
  }
  const kit = houseKit(B, rand);
  const TB = { facades: M.tower.map((m) => new Batch(m)), concrete: new Batch(M.concrete), metal: new Batch(M.iron) };
  const slab = boxGeometry(LOT_HALF * 2, KERB_H, LOT_HALF * 2, [2, 2]);
  for (const lx of LOTS) {
    for (const lz of LOTS) {
      B.pavement.add(slab, mat(lx, KERB_H / 2, lz));
      colliderBox(world, colliders, LOT_HALF * 2, KERB_H, LOT_HALF * 2, lx, KERB_H / 2, lz);
      const plaza = (lx === PLATE.x && lz === PLATE.y) || (lx === GLOBE.x && lz === GLOBE.z);
      if (plaza) continue;
      if (towers.has(`${lx},${lz}`)) { addTower(TB, rand, world, colliders, lx, lz); continue; }
      for (const [ox, oz, w, d] of pick(rand, BLOCK_LAYOUTS)) addHouse(B, kit, rand, world, colliders, lx + ox, lz + oz, w, d, lx, lz);
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

  for (const b of [B.brick, ...B.plaster, B.stone, B.roof, B.wood, B.shutter, B.paint, B.glass, B.glassLit, B.pavement, B.puddle,
    ...TB.facades, TB.concrete, TB.metal]) b.build(world);

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

  return { hemi, top, below };
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
    /** active: 0..1 (player standing in position), flash: 0..1 (just flipped). */
    update(dt, time, active, flash) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 2.4);
      const vh = ((typeof window !== 'undefined' && window.innerHeight) || 800) * Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2) / 2;
      mat.uniforms.uTime.value = time;
      mat.uniforms.uScale.value = vh;
      mat.uniforms.uBoost.value = active * 0.6 + flash;
      poolMat.opacity = Math.min(1, 0.45 + pulse * 0.2 + active * 0.3 + flash * 0.5);
      light.intensity = 18 + pulse * 8 + active * 20 + flash * 120;
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

const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

function startGlobeSequence() {
  const { player, interact, effects, audio, camera } = ctx;
  const g = s.globe;
  interact.remove(g.earth);
  player.enabled = false;
  camera.up.copy(player.up);

  // Vantage point: back off from the globe on the player's side, slightly above it.
  const away = camera.position.clone().sub(GLOBE);
  away.y = 0;
  if (away.lengthSq() < 1e-4) away.set(1, 0, 0);
  away.normalize();
  const vantage = GLOBE.clone().addScaledVector(away, 4.4);
  vantage.y = GLOBE.y + 0.8;
  const lookAt = GLOBE.clone().add(new THREE.Vector3(0, 0.25, 0));

  // Turn the mini world so its front (local +X, where the hydrant faces) looks at the camera.
  g.mini.group.rotation.y = Math.atan2(-away.z, away.x);

  const tone = (f, d, o) => () => audio.tone(f, d, o);
  const cues = [
    ...[523, 659, 784, 1047].map((f, i) => ({ at: T.error + i * 0.09, fn: tone(f, 1.0, { type: 'sine', volume: 0.08 }) })),
    ...Array.from({ length: 8 }, (_, i) => ({ at: T.pull + i * 0.22, fn: tone(220 - i * 18, 0.35, { type: 'sawtooth', volume: 0.045 }) })),
    { at: T.pullEnd - 0.3, fn: tone(45, 1.0, { type: 'sine', volume: 0.35 }) },
    ...Array.from({ length: 7 }, (_, i) => ({ at: T.pullEnd + 0.6 + i * 0.18, fn: tone(330 * Math.pow(1.19, i), 0.3, { type: 'sine', volume: 0.06 }) })),
  ];

  seq = {
    t: 0,
    camFrom: camera.position.clone(),
    qFrom: camera.quaternion.clone(),
    camTo: vantage,
    lookAt,
    qTo: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(vantage, lookAt, camera.up)),
    cues,
    revealed: false,
    zoom: null,
    left: false,
    bg0: s.scene.background.clone(),
    fog0: s.scene.fog.color.clone(),
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

  while (seq.cues.length) {
    seq.cues.sort((a, b) => a.at - b.at);
    if (seq.cues[0].at > t) break;
    seq.cues.shift().fn();
  }

  // Camera glides to the vantage point and frames the globe (until the zoom takes over).
  if (t < T.pullEnd) {
    const cm = smooth(clamp01(t / T.camMove));
    camera.position.lerpVectors(seq.camFrom, seq.camTo, cm);
    camera.quaternion.slerpQuaternions(seq.qFrom, seq.qTo, cm);
  }

  // 1. ERROR: the hologram glitches between Earth and the mini world.
  if (t < T.error) {
    const glitch = Math.random() < 0.22;
    g.earthGroup.visible = !glitch;
    mini.group.visible = glitch;
    mini.update(dt, glitch ? 1 : 0);
    g.globe.scale.setScalar(1 + (Math.random() - 0.5) * 0.16);
    g.globe.position.set(GLOBE.x + (Math.random() - 0.5) * 0.08, GLOBE.y, GLOBE.z + (Math.random() - 0.5) * 0.08);
    return;
  }
  if (!seq.revealed) {
    seq.revealed = true;
    g.globe.position.copy(GLOBE);
    g.earthGroup.visible = false;
    mini.group.visible = true;
    g.light.intensity = 0; // the cyan hologram light gives way to the mini world's own warm lighting
  }

  // 2. The bright mini world with its fire hydrant.
  const r = t - T.error;
  mini.update(dt, clamp01(r / 0.45));
  const pk = smooth(clamp01(r / 0.6));
  const blend = {};
  for (const key of Object.keys(POST_DARK)) blend[key] = POST_DARK[key] + (POST_MINI[key] - POST_DARK[key]) * pk;
  ctx.post?.set(blend);
  g.globe.scale.setScalar(0.85 + 0.15 * easeOutBack(clamp01(r / 0.5)));
  g.orbit.rotation.z += dt * 0.6;
  g.orbitMat.opacity = 0.6 * (1 - clamp01(r / 0.5));
  const L = s.lights, base = s.lightBase;
  L.hemi.intensity = base.hemi * (1 - 0.5 * clamp01(r / 1.0)); // the dark world dims next to it

  // 3. The whole dark inverted world is pulled into the globe (swirling shrink about its centre).
  if (t > T.pull) {
    const c = clamp01((t - T.pull) / (T.pullEnd - T.pull));
    const scale = Math.max(1e-4, 1 - smooth(c));
    const w = s.world;
    w.scale.setScalar(scale);
    w.quaternion.setFromAxisAngle(UP, c * c * PI * 2);
    w.position.copy(GLOBE).sub(GLOBE.clone().multiplyScalar(scale).applyQuaternion(w.quaternion));
    w.visible = c < 1;
    const kk = 1 - c;
    L.hemi.intensity = base.hemi * 0.5 * kk;
    L.top.intensity = base.top * kk;
    L.below.intensity = base.below * kk;
    s.scene.background.copy(seq.bg0).multiplyScalar(kk);
    s.scene.fog.color.copy(seq.fog0).multiplyScalar(kk);
    s.scene.fog.density = s.fogDensity * kk;
  }

  // 4. Zoom down into the mini world and right into the fire hydrant, then Quirkland.
  if (t >= T.pullEnd) {
    if (!seq.zoom) {
      g.globe.scale.setScalar(1);
      g.globe.updateMatrixWorld(true);
      const h = mini.hydrant.group;
      const face = h.localToWorld(new THREE.Vector3(0.045, 0.114, 0)); // middle of the face, between eyes and smile
      const front = h.localToWorld(new THREE.Vector3(1, 0.114, 0)).sub(h.localToWorld(new THREE.Vector3(0, 0.114, 0))).normalize();
      seq.zoom = { face, end: face.clone().addScaledVector(front, 0.1), from: camera.position.clone() };
    }
    const z = clamp01((t - T.pullEnd) / (T.zoomEnd - T.pullEnd));
    const e = easeInOut(z);
    camera.position.lerpVectors(seq.zoom.from, seq.zoom.end, e);
    camera.lookAt(new THREE.Vector3().lerpVectors(seq.lookAt, seq.zoom.face, smooth(Math.min(1, z * 1.4))));
    camera.fov = 75 - 25 * e;
    camera.updateProjectionMatrix();
    if (z >= 1 && !seq.left) {
      seq.left = true;
      ctx.goTo('quirkland');
    }
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

    const lights = buildEnvironment(scene, world, player.colliders, tex);
    const portal = buildPortal(world);
    const globe = buildGlobe(scene, world, player.colliders);
    // The mini world keeps its own look: the night HDRI must not light it.
    globe.mini.group.traverse((o) => {
      for (const m of [].concat(o.material || [])) if ('envMapIntensity' in m) m.envMapIntensity = 0;
    });

    const lightBase = { hemi: lights.hemi.intensity, top: lights.top.intensity, below: lights.below.intensity };
    s = {
      portal, scene, world, lights, lightBase, fogDensity: FOG.density, globe,
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
    s.portal.update(dt, s.time, s.active, s.flash);

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
