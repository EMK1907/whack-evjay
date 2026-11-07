import * as THREE from 'three';

// Inverted world — docs/GAME.md §4–5. Owner: Emir.
//
// World layout (world Y axis): normal ground at y=0, the world's "ceiling" at y=CEIL.
// The player arrives with flipped gravity and lands on the ceiling, so the dark red city
// (all buildings stand on the ground, none reach higher than MAX_TOP) hangs upside down above them.
// The golden pressure plate is a glowing ring on the GROUND in an open plaza. Standing on the
// ceiling directly vertically opposite it and jumping (SPACE) flips gravity and drops the player
// onto it. Standing on the ring and jumping flips back.
//
// TODO §6: holographic globe → Quirkland (no exit from this scene yet; ?debug + N skips).

const CEIL = 30;
const MAX_TOP = CEIL - 6;      // nothing on the ground may rise above this (≥6m gap to the ceiling)
const HALF = 56;               // half-size of the playable area
const LOTS = [-40, -24, -8, 8, 24, 40];
const PLATE = new THREE.Vector2(8, -8); // ring centre (x, z) — plaza lot, kept empty
const ZONE_R = 1.2;            // ring radius = horizontal tolerance for "directly opposite"
const FLIP_DELAY = 0.18;       // seconds into the jump before gravity flips
const SPAWN = new THREE.Vector3(0, 4, 6);

let ctx = null;
let s = null; // per-run state

// ---------- helpers ----------

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

function glowTexture() {
  const c = makeCanvas(128, 128), g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,220,120,1)');
  grad.addColorStop(0.35, 'rgba(255,170,40,0.45)');
  grad.addColorStop(1, 'rgba(255,140,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return toTexture(c, 1);
}

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

function cityBuilder(scene, colliders, M, rand) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const doorGeo = new THREE.BoxGeometry(1.4, 2.4, 0.2);
  const doorLampGeo = new THREE.BoxGeometry(0.5, 0.15, 0.35);
  const antennaGeo = new THREE.CylinderGeometry(0.05, 0.05, 1, 6);
  const tankGeo = new THREE.CylinderGeometry(1, 1, 1.8, 16);

  function add(geo, mat, x, y, z, { collide = true, ry = 0 } = {}) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    scene.add(m);
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

function buildEnvironment(scene, colliders) {
  const rand = rng(1337);

  scene.background = new THREE.Color(0x120203);
  scene.fog = new THREE.FogExp2(0x1f0405, 0.022);
  scene.add(new THREE.HemisphereLight(0x8a1a1a, 0x2a0505, 1.2));
  const top = new THREE.DirectionalLight(0xff3a28, 0.9);
  top.position.set(-20, 40, 10);
  scene.add(top);
  const below = new THREE.DirectionalLight(0x9a1810, 0.6); // lights the ceiling the player stands on
  below.position.set(15, -40, -10);
  scene.add(below);

  // Ground (world bottom) and ceiling (where the player lands).
  const groundMat = new THREE.MeshStandardMaterial({ map: asphaltTexture(rand), roughness: 1 });
  const ground = new THREE.Mesh(new THREE.BoxGeometry(HALF * 2 + 8, 1, HALF * 2 + 8), groundMat);
  ground.position.y = -0.5;
  const ceilMat = new THREE.MeshStandardMaterial({ map: tileTexture(rand, 30), roughness: 0.95 });
  const ceiling = new THREE.Mesh(new THREE.BoxGeometry(HALF * 2 + 8, 1, HALF * 2 + 8), ceilMat);
  ceiling.position.y = CEIL + 0.5;
  ceiling.userData.isCeiling = true;
  scene.add(ground, ceiling);
  colliders.push(ground, ceiling);

  // Invisible boundary walls (raycasts still hit invisible meshes).
  const wallGeo = new THREE.BoxGeometry(1, CEIL + 2, HALF * 2 + 2);
  for (const [x, z, ry] of [[-HALF, 0, 0], [HALF, 0, 0], [0, -HALF, Math.PI / 2], [0, HALF, Math.PI / 2]]) {
    const wall = new THREE.Mesh(wallGeo, new THREE.MeshBasicMaterial());
    wall.position.set(x, CEIL / 2, z);
    wall.rotation.y = ry;
    wall.visible = false;
    wall.userData.isBoundary = true;
    scene.add(wall);
    colliders.push(wall);
  }

  // Buildings: every type appears several times, shuffled across the lots (deterministic).
  const M = makeMaterials(rand);
  const city = cityBuilder(scene, colliders, M, rand);
  const types = [
    ...Array(7).fill('skyscraper'), ...Array(7).fill('office'), ...Array(7).fill('houses'),
    ...Array(6).fill('tower'), ...Array(6).fill('shops'), null, null, // two extra empty plazas
  ];
  for (let i = types.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [types[i], types[j]] = [types[j], types[i]];
  }
  let t = 0;
  for (const lx of LOTS) {
    for (const lz of LOTS) {
      if (lx === PLATE.x && lz === PLATE.y) continue; // pressure-plate plaza
      const type = types[t++];
      if (type) city[type](lx, lz);
    }
  }

  // Paved plaza under the pressure plate.
  const plaza = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 10),
    new THREE.MeshStandardMaterial({ map: tileTexture(rand, 2.5), roughness: 0.9 }),
  );
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.set(PLATE.x, 0.01, PLATE.y);
  scene.add(plaza);

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
      scene.add(pole, bulb);
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
      scene.add(l);
    });
}

/** The pressure plate: a glowing golden ring on the ground, visible from the ceiling. */
function buildPressurePlate(scene) {
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

  scene.add(halo, ring, glow, light);
  return { ringMat, haloMat, glow, light };
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

// ---------- scene ----------

export default {
  name: 'inverted',

  init(c) {
    ctx = c;
    const { scene, player } = ctx;
    buildEnvironment(scene, player.colliders);
    const plate = buildPressurePlate(scene);

    s = { ...plate, time: 0, flash: 0, active: 0, pendingFlip: null, wasGrounded: false, flips: 0 };

    // Pressure plate: jumping while directly vertically opposite the ring (or on it) flips gravity.
    player.onJump((p) => {
      if (inZone(p.position) && s.pendingFlip === null) s.pendingFlip = FLIP_DELAY;
    });

    // Arrive falling "up" onto the ceiling.
    player.spawn(SPAWN, 0, { flipped: true });
  },

  update(dt) {
    if (!s) return;
    const p = ctx.player;
    s.time += dt;

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
    if (Math.abs(pos.x) > HALF + 4 || Math.abs(pos.z) > HALF + 4 || pos.y < -20 || pos.y > CEIL + 20) {
      p.spawn(SPAWN, 0, { flipped: true });
      s.pendingFlip = null;
    }
  },

  dispose() {
    ctx = null;
    s = null;
  },
};
