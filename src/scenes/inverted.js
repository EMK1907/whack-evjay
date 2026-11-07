import * as THREE from 'three';

// Inverted world — docs/GAME.md §4–6. Owner: Emir.
//
// World layout (world Y axis): normal ground at y=0, the world's "ceiling" at y=CEIL.
// The player arrives with flipped gravity and lands on the ceiling, so the dark red city
// (all buildings stand on the ground, none reach higher than MAX_TOP) hangs upside down above them.
// The golden pressure plate is a glowing ring on the GROUND in an open plaza. Standing on the
// ceiling directly vertically opposite it and jumping (SPACE) flips gravity and drops the player
// onto it. Standing on the ring and jumping flips back.
//
// §6: a holographic Earth globe stands in another plaza on the ground. E on it → ERROR! glitch →
// it becomes a miniature Quirkland (candy-strewn hills under a dome of grinning mouths) with a small
// friendly fire hydrant on it →
// the whole dark world (everything in the `world` group) is pulled into the globe → the camera
// zooms down into the hydrant → goTo('quirkland'). No text; the whole sequence takes ~7.4s.

const CEIL = 30;
const MAX_TOP = CEIL - 6;      // nothing on the ground may rise above this (≥6m gap to the ceiling)
const HALF = 56;               // half-size of the playable area
const LOTS = [-40, -24, -8, 8, 24, 40];
const PLATE = new THREE.Vector2(8, -8); // ring centre (x, z) — plaza lot, kept empty
const ZONE_R = 1.2;            // ring radius = horizontal tolerance for "directly opposite"
const FLIP_DELAY = 0.18;       // seconds into the jump before gravity flips
const SPAWN = new THREE.Vector3(0, 4, 6);

const GLOBE = new THREE.Vector3(-24, 2.4, 24); // globe centre — plaza lot (-24, 24), on the ground
const GLOBE_R = 1.1;
const GLOBE_REACH = 4.5;       // interact distance

// Globe sequence timeline (seconds after pressing E). goTo at 7.0s, Quirkland visible ~7.4s.
const T = {
  camMove: 1.0,    // camera glides to the vantage point
  error: 1.4,      // ERROR! effect, globe glitches; then the mini world appears
  pull: 3.2,       // the dark world starts being pulled into the globe…
  pullEnd: 5.0,    // …and is gone
  zoomEnd: 7.0,    // camera has zoomed into the fire hydrant → goTo('quirkland')
};

let ctx = null;
let s = null;   // per-run state
let seq = null; // globe sequence state (null until E is pressed)

// ---------- helpers ----------

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (x) => x * x * (3 - 2 * x);
const easeIn = (x) => x * x * x;
const easeOutBack = (x) => 1 + 2.70158 * Math.pow(x - 1, 3) + 1.70158 * Math.pow(x - 1, 2);

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

function grime(g, rand, W, H, n = 400) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = `rgba(0,0,0,${rand() * 0.3})`;
    g.fillRect(rand() * W, rand() * H, 2 + rand() * 8, 2 + rand() * 8);
  }
}

const LIT = ['#ff6a3a', '#c8321e', '#ff8a4a'];
const DARK_GLASS = '#0c0505';

/** Builds a facade canvas pair. `draw(g, ge, rand)` paints colour + emissive. */
function facade(rand, W, H, base, draw) {
  const c = makeCanvas(W, H), e = makeCanvas(W, H);
  const g = c.getContext('2d'), ge = e.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, W, H);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, W, H);
  grime(g, rand, W, H);
  draw(g, ge, rand);
  return { map: toTexture(c), emissiveMap: toTexture(e) };
}

function windowRect(g, ge, rand, x, y, w, h, litChance) {
  const lit = rand() < litChance;
  const color = lit ? LIT[Math.floor(rand() * LIT.length)] : DARK_GLASS;
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
  if (lit) { ge.fillStyle = color; ge.fillRect(x, y, w, h); }
}

// Tile sizes (metres) for each facade style: [width, height].
const TILE = { grid: [8, 16], bands: [8, 8], house: [6, 6], shop: [8, 4] };

/** Skyscraper: 4 × 8 punched windows (tile 8m × 16m). */
const gridFacade = (rand, base) => facade(rand, 256, 512, base, (g, ge) => {
  const cw = 64, ch = 64;
  for (let r = 0; r < 8; r++) {
    g.fillStyle = 'rgba(0,0,0,0.4)';
    g.fillRect(0, r * ch + ch - 5, 256, 5);
    for (let c = 0; c < 4; c++) windowRect(g, ge, rand, c * cw + 13, r * ch + 12, 38, 35, 0.2);
  }
});

/** Office block: continuous ribbon windows with mullions, 4 floors (tile 8m × 8m). */
const bandFacade = (rand, base) => facade(rand, 256, 256, base, (g, ge) => {
  for (let r = 0; r < 4; r++) {
    const y = r * 64 + 18;
    for (let c = 0; c < 8; c++) windowRect(g, ge, rand, c * 32 + 2, y, 28, 30, 0.15);
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.fillRect(0, y + 30, 256, 3);
  }
});

/** House: brick courses, 2 floors × 2 framed windows (tile 6m × 6m). */
const houseFacade = (rand, base) => facade(rand, 256, 256, base, (g, ge) => {
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 1;
  for (let y = 0; y < 256; y += 8) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke();
    for (let x = (y / 8) % 2 ? 0 : 12; x < 256; x += 24) {
      g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 8); g.stroke();
    }
  }
  for (let r = 0; r < 2; r++) {
    for (const cx of [48, 160]) {
      g.fillStyle = '#1a0e0a';
      g.fillRect(cx - 4, r * 128 + 30, 56, 64);
      windowRect(g, ge, rand, cx, r * 128 + 34, 48, 56, 0.3);
      g.fillStyle = '#1a0e0a';
      g.fillRect(cx + 22, r * 128 + 34, 4, 56);
    }
  }
});

/** Shop front: sign band + lit display window (tile 8m × 4m, one storey). */
const shopFacade = (rand, base) => facade(rand, 256, 128, base, (g, ge) => {
  const sign = ['#ff3a20', '#ff7a30', '#d02818'][Math.floor(rand() * 3)];
  g.fillStyle = '#140808';
  g.fillRect(10, 6, 236, 22);
  g.fillStyle = sign;
  for (let x = 24; x < 230; x += 22) g.fillRect(x, 11, 14, 12); // abstract lettering
  ge.fillStyle = sign;
  for (let x = 24; x < 230; x += 22) ge.fillRect(x, 11, 14, 12);
  const glow = rand() < 0.6 ? '#b8381e' : '#3a1210';
  g.fillStyle = glow;
  g.fillRect(14, 44, 150, 72);
  if (glow !== '#3a1210') { ge.fillStyle = '#6a1e10'; ge.fillRect(14, 44, 150, 72); }
  g.fillStyle = '#0a0404';
  g.fillRect(186, 44, 48, 84); // door
});

function asphaltTexture(rand) {
  const c = makeCanvas(256, 256), g = c.getContext('2d');
  g.fillStyle = '#1b0e0e';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1500; i++) {
    g.fillStyle = `rgba(${rand() < 0.5 ? '0,0,0' : '90,30,30'},${rand() * 0.25})`;
    g.fillRect(rand() * 256, rand() * 256, 2, 2);
  }
  g.strokeStyle = 'rgba(120,40,30,0.35)';
  g.lineWidth = 3;
  g.strokeRect(0, 0, 256, 256);
  return toTexture(c, 15);
}

function tileTexture(rand, repeat) {
  const c = makeCanvas(256, 256), g = c.getContext('2d');
  const n = 4, sz = 256 / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const v = 30 + rand() * 18;
      g.fillStyle = `rgb(${v + 14},${v * 0.35},${v * 0.35})`;
      g.fillRect(i * sz, j * sz, sz, sz);
    }
  }
  g.strokeStyle = '#0a0303';
  g.lineWidth = 4;
  for (let i = 0; i <= n; i++) {
    g.beginPath(); g.moveTo(i * sz, 0); g.lineTo(i * sz, 256); g.stroke();
    g.beginPath(); g.moveTo(0, i * sz); g.lineTo(256, i * sz); g.stroke();
  }
  g.strokeStyle = 'rgba(0,0,0,0.6)'; // cracks
  g.lineWidth = 1.5;
  for (let k = 0; k < 6; k++) {
    let x = rand() * 256, y = rand() * 256;
    g.beginPath();
    g.moveTo(x, y);
    for (let m = 0; m < 5; m++) { x += (rand() - 0.5) * 40; y += (rand() - 0.5) * 40; g.lineTo(x, y); }
    g.stroke();
  }
  return toTexture(c, repeat);
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
const dotTexture = () => radialTexture([[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.6)'], [1, 'rgba(255,255,255,0)']]);

/** Box whose side UVs are in world units / tile size, so one facade texture fits any size. */
function boxGeometry(w, h, d, [tw, th]) {
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

/** Octagonal tower body with side UVs scaled like boxGeometry. */
function towerGeometry(r, h, [tw, th]) {
  const segs = 8;
  const geo = new THREE.CylinderGeometry(r, r, h, segs, 1);
  const uv = geo.attributes.uv;
  const circ = 2 * Math.PI * r;
  for (let k = 0; k < (segs + 1) * 2; k++) uv.setXY(k, (uv.getX(k) * circ) / tw, (uv.getY(k) * h) / th);
  return geo;
}

/** Triangular-prism roof, ridge along Z, base at y=0. */
function roofGeometry(w, d, rh) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(0, rh);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
  geo.translate(0, 0, -d / 2);
  return geo;
}

function inZone(pos) {
  return Math.hypot(pos.x - PLATE.x, pos.z - PLATE.y) < ZONE_R;
}

// ---------- city ----------

function makeMaterials(rand) {
  const std = (o) => new THREE.MeshStandardMaterial({ roughness: 0.9, ...o });
  const lit = (tex) => std({ ...tex, emissive: 0xffffff, emissiveIntensity: 0.9 });
  return {
    sky: ['#3a1717', '#2b1414', '#41201a'].map((b) => lit(gridFacade(rand, b))),
    office: ['#3b2420', '#2e1a1a', '#4a2a1e'].map((b) => lit(bandFacade(rand, b))),
    house: ['#5a2a1e', '#4a1e18', '#5e3a26'].map((b) => lit(houseFacade(rand, b))),
    shop: ['#3a1a14', '#4a2418', '#33140f'].map((b) => lit(shopFacade(rand, b))),
    wall: std({ color: 0x2e1814 }),
    roof: std({ color: 0x1c0c0c, roughness: 1 }),
    tiles: [std({ color: 0x3a1410 }), std({ color: 0x2a1a12 }), std({ color: 0x4a1c14 })],
    awning: [std({ color: 0x5a0f0f }), std({ color: 0x3e1a12 }), std({ color: 0x701810 })],
    metal: std({ color: 0x2a1a1a, metalness: 0.6, roughness: 0.5 }),
    door: std({ color: 0x0a0404, roughness: 0.6 }),
    doorLamp: std({ color: 0xff3020, emissive: 0xff3020, emissiveIntensity: 2 }),
    brick: std({ color: 0x3a1a14 }),
  };
}

function cityBuilder(parent, colliders, M, rand) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const doorGeo = new THREE.BoxGeometry(1.4, 2.4, 0.2);
  const doorLampGeo = new THREE.BoxGeometry(0.5, 0.15, 0.35);
  const antennaGeo = new THREE.CylinderGeometry(0.05, 0.05, 1, 6);
  const tankGeo = new THREE.CylinderGeometry(1, 1, 1.8, 16);

  function add(geo, mat, x, y, z, { collide = true, ry = 0 } = {}) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    parent.add(m);
    if (collide) colliders.push(m);
    return m;
  }

  /** Door + lamp at the base of a wall; (nx, nz) is the outward wall normal. */
  function door(x, z, nx, nz, lamp = true) {
    const ry = Math.atan2(nx, nz);
    add(doorGeo, M.door, x + nx * 0.05, 1.2, z + nz * 0.05, { collide: false, ry });
    if (lamp) add(doorLampGeo, M.doorLamp, x + nx * 0.15, 2.7, z + nz * 0.15, { collide: false, ry });
  }

  function antenna(x, baseY, z, want) {
    const h = Math.min(want, MAX_TOP - baseY);
    if (h < 0.5) return;
    const a = add(antennaGeo, M.metal, x, baseY + h / 2, z, { collide: false });
    a.scale.y = h;
  }

  const sideMats = (side, roof = M.roof) => [side, side, roof, roof, side, side];

  return {
    skyscraper(lx, lz) {
      const w = 6 + rand() * 3, d = 6 + rand() * 3, h1 = 14 + rand() * 5;
      const mat = pick(M.sky);
      add(boxGeometry(w, h1, d, TILE.grid), sideMats(mat), lx, h1 / 2, lz);
      const w2 = w * 0.65, d2 = d * 0.65, h2 = 2 + rand() * 2.5; // setback crown
      add(boxGeometry(w2, h2, d2, TILE.grid), sideMats(mat), lx, h1 + h2 / 2, lz);
      antenna(lx, h1 + h2, lz, 3 + rand() * 4);
      door(lx, lz - d / 2, 0, -1);
      door(lx + w / 2, lz, 1, 0);
    },

    office(lx, lz) {
      const w = 9 + rand(), d = 8 + rand() * 2, h = 7 + rand() * 5;
      add(boxGeometry(w, h, d, TILE.bands), sideMats(pick(M.office)), lx, h / 2, lz);
      for (let i = 0; i < 2; i++) { // rooftop HVAC units
        const u = new THREE.BoxGeometry(1.6, 0.9, 1.2);
        add(u, M.metal, lx + (rand() - 0.5) * (w - 3), h + 0.45, lz + (rand() - 0.5) * (d - 3), { collide: false });
      }
      if (rand() < 0.6) add(tankGeo, M.metal, lx + (rand() - 0.5) * (w - 3), h + 0.9, lz + (rand() - 0.5) * (d - 3), { collide: false });
      door(lx - 1.5, lz - d / 2, 0, -1);
      door(lx + 1.5, lz - d / 2, 0, -1, false);
    },

    houses(lx, lz) {
      for (const [ox, oz] of [[-2.6, -2.6], [2.6, -2.6], [-2.6, 2.6], [2.6, 2.6]]) {
        if (rand() < 0.2) continue;
        const w = 3.8 + rand() * 0.8, d = 3.8 + rand() * 0.8, h = rand() < 0.5 ? 3 : 5.5;
        const x = lx + ox, z = lz + oz;
        add(boxGeometry(w, h, d, TILE.house), sideMats(pick(M.house)), x, h / 2, z);
        const rh = 1.4 + rand() * 1.2;
        add(roofGeometry(w + 0.5, d + 0.5, rh), pick(M.tiles), x, h, z);
        add(new THREE.BoxGeometry(0.5, 1.6, 0.5), M.brick, x + w * 0.25, h + rh * 0.6, z + d * 0.2, { collide: false });
        door(x, z + (oz < 0 ? -d / 2 : d / 2), 0, oz < 0 ? -1 : 1, false);
      }
    },

    tower(lx, lz) {
      const r = 2.6 + rand() * 1, h = 11 + rand() * 5;
      add(towerGeometry(r, h, TILE.grid), [pick(M.sky), M.roof, M.roof], lx, h / 2, lz);
      add(new THREE.CylinderGeometry(r + 0.35, r + 0.35, 0.5, 8), M.metal, lx, h + 0.25, lz, { collide: false });
      add(new THREE.CylinderGeometry(r + 0.25, r + 0.25, 0.35, 8), M.metal, lx, h * 0.5, lz, { collide: false });
      const sh = Math.min(4 + rand() * 4, MAX_TOP - h - 0.5);
      add(new THREE.ConeGeometry(r * 0.75, sh, 8), M.roof, lx, h + 0.5 + sh / 2, lz, { collide: false });
      door(lx, lz - r, 0, -1);
    },

    shops(lx, lz) {
      for (const ox of [-2.4, 2.4]) {
        const w = 4.5, d = 7 + rand() * 2, h = 4;
        const x = lx + ox;
        const mats = [M.wall, M.wall, M.roof, M.roof, M.wall, pick(M.shop)]; // shopfront faces -Z
        add(boxGeometry(w, h, d, TILE.shop), mats, x, h / 2, lz);
        const awning = add(new THREE.BoxGeometry(w - 0.3, 0.12, 1.4), pick(M.awning), x, 3.1, lz - d / 2 - 0.65, { collide: false });
        awning.rotation.x = -0.25;
        if (rand() < 0.5) add(new THREE.BoxGeometry(1.2, 0.7, 1.2), M.metal, x, h + 0.35, lz, { collide: false });
      }
    },
  };
}

/** Lights/fog go on the scene; all geometry goes in `world` (so it can be pulled into the globe). */
function buildEnvironment(scene, world, colliders) {
  const rand = rng(1337);

  scene.background = new THREE.Color(0x120203);
  scene.fog = new THREE.FogExp2(0x1f0405, 0.022);
  const hemi = new THREE.HemisphereLight(0x8a1a1a, 0x2a0505, 1.2);
  const top = new THREE.DirectionalLight(0xff3a28, 0.9);
  top.position.set(-20, 40, 10);
  const below = new THREE.DirectionalLight(0x9a1810, 0.6); // lights the ceiling the player stands on
  below.position.set(15, -40, -10);
  scene.add(hemi, top, below);

  // Ground (world bottom) and ceiling (where the player lands).
  const groundMat = new THREE.MeshStandardMaterial({ map: asphaltTexture(rand), roughness: 1 });
  const ground = new THREE.Mesh(new THREE.BoxGeometry(HALF * 2 + 8, 1, HALF * 2 + 8), groundMat);
  ground.position.y = -0.5;
  const ceilMat = new THREE.MeshStandardMaterial({ map: tileTexture(rand, 30), roughness: 0.95 });
  const ceiling = new THREE.Mesh(new THREE.BoxGeometry(HALF * 2 + 8, 1, HALF * 2 + 8), ceilMat);
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

  // Buildings: every type appears several times, shuffled across the lots (deterministic).
  const M = makeMaterials(rand);
  const city = cityBuilder(world, colliders, M, rand);
  const types = [
    ...Array(7).fill('skyscraper'), ...Array(7).fill('office'), ...Array(7).fill('houses'),
    ...Array(6).fill('tower'), ...Array(6).fill('shops'), null, null, // extra empty plazas
  ];
  for (let i = types.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [types[i], types[j]] = [types[j], types[i]];
  }
  let t = 0;
  for (const lx of LOTS) {
    for (const lz of LOTS) {
      if (lx === PLATE.x && lz === PLATE.y) continue; // pressure-plate plaza
      if (lx === GLOBE.x && lz === GLOBE.z) continue; // globe plaza
      const type = types[t++];
      if (type) city[type](lx, lz);
    }
  }

  // Paved plazas under the pressure plate and the globe.
  const plazaMat = new THREE.MeshStandardMaterial({ map: tileTexture(rand, 2.5), roughness: 0.9 });
  for (const [x, z] of [[PLATE.x, PLATE.y], [GLOBE.x, GLOBE.z]]) {
    const plaza = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), plazaMat);
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.set(x, 0.01, z);
    world.add(plaza);
  }

  // Street lamps on the ground (seen upside down from the ceiling).
  const poleGeo = new THREE.CylinderGeometry(0.12, 0.15, 5, 8);
  const bulbGeo = new THREE.SphereGeometry(0.3, 12, 8);
  const bulbMat = new THREE.MeshStandardMaterial({ color: 0xff4020, emissive: 0xff2a10, emissiveIntensity: 3 });
  const lamps = [];
  for (const sx of [-32, -16, 0, 16, 32]) {
    for (const sz of [-32, -16, 0, 16, 32]) {
      const x = sx + 2.4, z = sz + 2.4;
      const pole = new THREE.Mesh(poleGeo, M.metal);
      pole.position.set(x, 2.5, z);
      const bulb = new THREE.Mesh(bulbGeo, bulbMat);
      bulb.position.set(x, 5.2, z);
      world.add(pole, bulb);
      colliders.push(pole);
      lamps.push(bulb.position);
    }
  }
  // Real point lights only on the few lamps nearest the plate (cost).
  const plate3 = new THREE.Vector3(PLATE.x, 0, PLATE.y);
  lamps
    .sort((a, b) => a.distanceToSquared(plate3) - b.distanceToSquared(plate3))
    .slice(0, 6)
    .forEach((p) => {
      const l = new THREE.PointLight(0xff2a14, 25, 30, 1.6);
      l.position.copy(p);
      world.add(l);
    });

  return { hemi, top, below };
}

/** The pressure plate: a glowing golden ring on the ground, visible from the ceiling. */
function buildPressurePlate(parent) {
  const glowTex = glowTexture();
  const additive = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false };

  const ringMat = new THREE.MeshBasicMaterial({ color: 0xffb030, side: THREE.DoubleSide, ...additive });
  const ring = new THREE.Mesh(new THREE.RingGeometry(ZONE_R - 0.25, ZONE_R, 64), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(PLATE.x, 0.04, PLATE.y);

  // Flat glow pool on the ground (reads clearly when looking straight "up" from the ceiling).
  const haloMat = new THREE.MeshBasicMaterial({ map: glowTex, color: 0xffa020, side: THREE.DoubleSide, ...additive });
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(ZONE_R * 5, ZONE_R * 5), haloMat);
  halo.rotation.x = -Math.PI / 2;
  halo.position.set(PLATE.x, 0.03, PLATE.y);

  // Camera-facing glow so it's visible from any angle through the fog.
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffc060, ...additive }));
  glow.position.set(PLATE.x, 0.4, PLATE.y);

  const light = new THREE.PointLight(0xffb030, 30, 0, 2);
  light.position.set(PLATE.x, 1.5, PLATE.y);

  parent.add(halo, ring, glow, light);
  return { ringMat, haloMat, glow, light };
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
  gl_FragColor=vec4(col,1.0);
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
  const face = new THREE.MeshStandardMaterial({ map: swirlTexture(palettes[Math.floor(Math.random() * palettes.length)]), roughness: 0.25, emissive: 0xffffff, emissiveIntensity: 0.08 });
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
  g.globe.scale.setScalar(0.85 + 0.15 * easeOutBack(clamp01(r / 0.5)));
  g.orbit.rotation.z += dt * 0.6;
  g.orbitMat.opacity = 0.6 * (1 - clamp01(r / 0.5));
  s.lights.hemi.intensity = 1.2 * (1 - 0.5 * clamp01(r / 1.0)); // the dark world dims next to it

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
    s.lights.hemi.intensity = 0.6 * kk;
    s.lights.top.intensity = 0.9 * kk;
    s.lights.below.intensity = 0.6 * kk;
    s.scene.background.copy(seq.bg0).multiplyScalar(kk);
    s.scene.fog.color.copy(seq.fog0).multiplyScalar(kk);
    s.scene.fog.density = 0.022 * kk;
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

  init(c) {
    ctx = c;
    seq = null;
    const { scene, player, interact } = ctx;
    const world = new THREE.Group(); // everything that gets pulled into the globe
    scene.add(world);
    const lights = buildEnvironment(scene, world, player.colliders);
    const plate = buildPressurePlate(world);
    const globe = buildGlobe(scene, world, player.colliders);

    s = { ...plate, scene, world, lights, globe, time: 0, flash: 0, active: 0, pendingFlip: null, wasGrounded: false, flips: 0 };

    // Pressure plate: jumping while directly vertically opposite the ring (or on it) flips gravity.
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

    // Glow pulse; brighter while the player is in position, flash on flip.
    const pulse = 0.5 + 0.5 * Math.sin(s.time * 2.4);
    const target = p.grounded && inZone(p.position) ? 1 : 0;
    s.active += (target - s.active) * Math.min(1, dt * 6);
    s.flash = Math.max(0, s.flash - dt * 1.5);
    const k = 0.6 + pulse * 0.25 + s.active * 0.4 + s.flash;
    s.ringMat.opacity = Math.min(1, k);
    s.haloMat.opacity = Math.min(1, 0.35 + pulse * 0.2 + s.active * 0.3 + s.flash * 0.5);
    s.light.intensity = 30 + pulse * 15 + s.active * 30 + s.flash * 150;
    const gs = 4 + pulse * 0.8 + s.active * 1.5 + s.flash * 5;
    s.glow.scale.set(gs, gs, 1);

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
