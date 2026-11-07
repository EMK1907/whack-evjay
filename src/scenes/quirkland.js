import * as THREE from 'three';

// Quirkland (Varshan) — docs/GAME.md §7–8.
// A round world split into four corners around a central plaza:
//   Air (north-east), Water (north-west), Nature (south-west), Fire (south-east).
// Arrival → Fire Hydrant intro cutscene → he follows the player as a faded companion.
// In the Water zone, E on the hydrant shows his (weak) ability.
// Inhabitants (E): Ember the dragon (Fire), Skye the kite (Air).
// TEMP: the grey cube at the north edge goes to 'ending' until the masked figure (§9) is built.

const NAME = 'quirkland';
const NEXT = 'ending';
const HYDRANT = 'Fire Hydrant';
const HYDRANT_COLOR = '#ff9d92';
const WORLD_R = 60;
const PLAZA_R = 7;
const FOLLOW_DIST = 2.2;
const HYDRANT_OPACITY = 0.45;

const V = (x, y, z) => new THREE.Vector3(x, y, z);

const INTRO = [
  "Oh! A visitor. We haven't had one of those in... well, ever.",
  'Welcome to Quirkland. Everything here was dreamed up by children — every creature, every tree, every gust of wind.',
  'We exist because they imagine us. Air, Fire, Nature, Water — four corners, each one built from their stories.',
  "Me? I'm a fire hydrant. I keep things safe. When fire gets out of hand, I put it out. That's my ability.",
  "But look at me. See how faded I am? Children don't think about fire hydrants anymore.",
  'The more a child forgets you, the more you fade. Your ability weakens. One day... you just aren\'t here.',
  "The others — the dragon, the kite, the beanstalk — they're bright and strong. Children still dream about them every night.",
  "Come on. I'll show you around. Stick close — I don't get to talk to anyone new.",
];

// Each zone is a quarter of the disc. theta = start angle (0 = +x, counter-clockwise seen from above, toward -z).
const ZONES = {
  Air:    { theta: 0,               ground: 0xcfe0ff, hill: 0xf2f6ff, accent: '#7fb8ff' },
  Water:  { theta: Math.PI * 0.5,   ground: 0x8fd0e6, hill: 0x6aa8e8, accent: '#3fa9ff' },
  Nature: { theta: Math.PI,         ground: 0x5cbf4a, hill: 0x3f9a3a, accent: '#5fd35a' },
  Fire:   { theta: Math.PI * 1.5,   ground: 0xc4501a, hill: 0x5a2a1c, accent: '#ff7a2f' },
};

// ---------- module state (reset in init/dispose) ----------
let ctx = null;
let gen = 0;          // bumps every init/dispose so stale async sequences stop
let tasks = [];       // per-frame callbacks; return false to remove
let systems = [];     // particle systems
let time = 0;
let rand = Math.random;
let pxScale = 700;
let hydrant = null;
let state = 'intro';  // 'intro' | 'free'
let busy = false;     // an ability / conversation is playing
let zone = null;
let toastEl = null;
let toastTimer = null;

const alive = (g) => ctx !== null && g === gen;

// ---------- small helpers ----------
function every(fn) { tasks.push(fn); }

function tween(sec, fn) {
  return new Promise((resolve) => {
    let t = 0;
    tasks.push((dt) => {
      t += dt;
      const k = Math.min(1, t / sec);
      fn(k, dt);
      if (k >= 1) { resolve(); return false; }
      return true;
    });
  });
}
const wait = (sec) => tween(sec, () => {});
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const easeOutBack = (t) => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2);

function lerpAngle(a, b, k) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const polar = (theta, r) => V(Math.cos(theta) * r, 0, -Math.sin(theta) * r);
const zoneMid = (name) => ZONES[name].theta + Math.PI / 4;
const zoneCenter = (name, r = 24) => polar(zoneMid(name), r);

function randInZone(name, rMin, rMax, margin = 0.1) {
  const th = ZONES[name].theta + margin + rand() * (Math.PI / 2 - margin * 2);
  const r = Math.sqrt(rMin * rMin + rand() * (rMax * rMax - rMin * rMin));
  return polar(th, r);
}

function zoneAt(p) {
  if (p.x * p.x + p.z * p.z < PLAZA_R * PLAZA_R) return null;
  if (p.z < 0) return p.x >= 0 ? 'Air' : 'Water';
  return p.x >= 0 ? 'Fire' : 'Nature';
}

function std(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra });
}

function mesh(geo, mat, x = 0, y = 0, z = 0, parent = ctx.scene) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function collide(obj) { ctx.player.colliders.push(obj); return obj; }

function makeLabel(text, { color = '#fff', bg = 'rgba(0,0,0,0.55)', w = 3, font = "700 64px 'Rubik Bubbles', system-ui, sans-serif" } = {}) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = bg;
  g.beginPath();
  g.roundRect(4, 4, c.width - 8, c.height - 8, 56);
  g.fill();
  g.fillStyle = color;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, c.width / 2, c.height / 2 + 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
  sprite.scale.set(w, w / 4, 1);
  return sprite;
}

// ---------- particles (soft round points with per-particle fade) ----------
class Particles {
  constructor({ count = 200, color = 0xffffff, color2 = color, size = 0.2, grow = 0, additive = false, gravity = 0, drag = 0 }) {
    this.n = count; this.size = size; this.grow = grow; this.gravity = gravity; this.drag = drag;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.alpha = new Float32Array(count);
    this.psize = new Float32Array(count);
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    this.base = new Float32Array(count);
    this.t01 = new Float32Array(count);
    this.next = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setAttribute('psize', new THREE.BufferAttribute(this.psize, 1));
    geo.setAttribute('t01', new THREE.BufferAttribute(this.t01, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(color) }, color2: { value: new THREE.Color(color2) }, scale: { value: pxScale } },
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: `
        attribute float alpha; attribute float psize; attribute float t01;
        uniform float scale; varying float vA; varying float vT;
        void main() {
          vA = alpha; vT = t01;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = alpha <= 0.0 ? 0.0 : psize * scale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 color; uniform vec3 color2; varying float vA; varying float vT;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          gl_FragColor = vec4(mix(color, color2, vT), vA * smoothstep(0.5, 0.1, d));
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    ctx.scene.add(this.points);
    systems.push(this);
  }

  emit(p, v, life, size = this.size) {
    const i = this.next;
    this.next = (i + 1) % this.n;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.age[i] = 0; this.life[i] = life; this.base[i] = size;
  }

  update(dt) {
    const { pos, vel, age, life } = this;
    const damp = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.n; i++) {
      if (age[i] >= life[i]) { this.alpha[i] = 0; continue; }
      age[i] += dt;
      const t = Math.min(1, age[i] / life[i]);
      const j = i * 3;
      vel[j + 1] -= this.gravity * dt;
      vel[j] *= damp; vel[j + 1] *= damp; vel[j + 2] *= damp;
      pos[j] += vel[j] * dt; pos[j + 1] += vel[j + 1] * dt; pos[j + 2] += vel[j + 2] * dt;
      this.alpha[i] = t >= 1 ? 0 : Math.min(1, t * 8) * (1 - t);
      this.psize[i] = this.base[i] * (1 + this.grow * t);
      this.t01[i] = t;
    }
    const a = this.points.geometry.attributes;
    a.position.needsUpdate = a.alpha.needsUpdate = a.psize.needsUpdate = a.t01.needsUpdate = true;
  }
}

// ---------- world ----------
function buildWorld() {
  const { scene, player } = ctx;

  // Pastel dream sky.
  const sky = new THREE.Mesh(new THREE.SphereGeometry(450, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(0x5fb0ff) }, bottom: { value: new THREE.Color(0xffd9ef) } },
    vertexShader: 'varying vec3 vP; void main() { vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 bottom; varying vec3 vP;
      void main() { gl_FragColor = vec4(mix(bottom, top, clamp(vP.y * 1.8 + 0.1, 0.0, 1.0)), 1.0);
      #include <colorspace_fragment>
      }`,
  }));
  scene.add(sky);
  scene.background = new THREE.Color(0xffd9ef);
  scene.fog = new THREE.Fog(0xffd9ef, 70, 170);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x99bb88, 1.5));
  const sun = new THREE.DirectionalLight(0xfff2dd, 2);
  sun.position.set(30, 50, 20);
  scene.add(sun);

  // Ground: four quarter-discs (colliders), sandy plaza, paths, signs.
  for (const z of Object.values(ZONES)) {
    const m = mesh(new THREE.CircleGeometry(WORLD_R, 24, z.theta, Math.PI / 2), std(z.ground, { roughness: 0.95 }));
    m.rotation.x = -Math.PI / 2;
    collide(m);
  }
  const plaza = mesh(new THREE.CircleGeometry(PLAZA_R, 48), std(0xf3e3bf), 0, 0.01, 0);
  plaza.rotation.x = -Math.PI / 2;
  const rim = mesh(new THREE.RingGeometry(PLAZA_R, PLAZA_R + 0.4, 48), std(0xffffff), 0, 0.015, 0);
  rim.rotation.x = -Math.PI / 2;

  const pathMat = std(0xf6ead0);
  for (const [name, z] of Object.entries(ZONES)) {
    const th = zoneMid(name);
    const g = new THREE.Group();
    g.rotation.y = th - Math.PI / 2;
    scene.add(g);
    const path = mesh(new THREE.PlaneGeometry(2.2, 12), pathMat, 0, 0.012, -(PLAZA_R + 6), g);
    path.rotation.x = -Math.PI / 2;

    // Signpost at the edge of the plaza.
    const p = polar(th, PLAZA_R + 1.5);
    mesh(new THREE.CylinderGeometry(0.07, 0.07, 2, 8), std(0xffffff), p.x, 1, p.z);
    const label = makeLabel(name.toUpperCase(), { color: z.accent, bg: 'rgba(255,255,255,0.92)', w: 2.6 });
    label.position.set(p.x, 2.3, p.z);
    scene.add(label);
  }

  // Invisible boundary wall.
  const wall = mesh(new THREE.CylinderGeometry(WORLD_R - 1, WORLD_R - 1, 8, 48, 1, true),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), 0, 4, 0);
  wall.visible = false;
  collide(wall);

  // Distant hills, tinted by the zone behind them.
  const hillGeo = new THREE.ConeGeometry(1, 1, 7);
  for (let i = 0; i < 44; i++) {
    const th = (i / 44) * Math.PI * 2 + rand() * 0.05;
    const name = zoneAt(polar(th, 10));
    const r = 66 + rand() * 14;
    const h = 8 + rand() * 16;
    const p = polar(th, r);
    const m = mesh(hillGeo, std(ZONES[name].hill, { flatShading: true }), p.x, h / 2 - 0.5, p.z);
    m.scale.set(6 + rand() * 6, h, 6 + rand() * 6);
  }

  buildAir();
  buildFire();
  buildNature();
  buildWater();

  // TEMP exit until the masked figure (§9) is built.
  const cube = mesh(new THREE.BoxGeometry(1, 1, 1), std(0x888888), 0, 0.5, -52);
  collide(cube);
  ctx.interact.add(cube, () => ctx.goTo(NEXT));
  const tmp = makeLabel('TEMP → ending', { w: 2.4, font: '700 54px system-ui, sans-serif' });
  tmp.position.set(0, 1.6, -52);
  scene.add(tmp);
}

function buildAir() {
  const white = std(0xffffff, { roughness: 1, emissive: 0xdfe8ff, emissiveIntensity: 0.3 });
  const puff = new THREE.SphereGeometry(1, 14, 10);
  for (let i = 0; i < 16; i++) {
    const c = new THREE.Group();
    const n = 4 + Math.floor(rand() * 3);
    for (let j = 0; j < n; j++) {
      const s = mesh(puff, white, (j - n / 2) * 0.9 + rand() * 0.4, rand() * 0.5, rand() * 0.8 - 0.4, c);
      s.scale.setScalar(0.8 + rand() * 0.7);
    }
    const p = randInZone('Air', 10, 55);
    const baseY = 4 + rand() * 9;
    c.position.set(p.x, baseY, p.z);
    c.scale.setScalar(0.8 + rand() * 0.9);
    ctx.scene.add(c);
    const ph = rand() * 6.28, sp = 0.3 + rand() * 0.4;
    every(() => { c.position.y = baseY + Math.sin(time * sp + ph) * 0.5; });
  }

  // Pinwheels.
  const stick = std(0xf5f0e6);
  const bladeShape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.5, 0.1), new THREE.Vector2(0.15, 0.5)]);
  const bladeGeo = new THREE.ShapeGeometry(bladeShape);
  const colors = [0xff6fae, 0xffd23f, 0x5ad1ff, 0x9b7bff];
  for (let i = 0; i < 9; i++) {
    const g = new THREE.Group();
    const p = randInZone('Air', 9, 50);
    g.position.copy(p);
    g.rotation.y = rand() * 6.28;
    ctx.scene.add(g);
    mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.6, 6), stick, 0, 0.8, 0, g);
    const wheel = new THREE.Group();
    wheel.position.set(0, 1.6, 0.06);
    g.add(wheel);
    for (let b = 0; b < 4; b++) {
      const m = mesh(bladeGeo, std(colors[b], { side: THREE.DoubleSide, emissive: colors[b], emissiveIntensity: 0.2 }), 0, 0, 0, wheel);
      m.rotation.z = (b * Math.PI) / 2;
    }
    const sp = 3 + rand() * 4;
    every((dt) => { wheel.rotation.z -= dt * sp; });
  }

  // Floating islands.
  for (let i = 0; i < 5; i++) {
    const g = new THREE.Group();
    const p = randInZone('Air', 16, 50);
    const baseY = 2.5 + rand() * 4;
    g.position.set(p.x, baseY, p.z);
    ctx.scene.add(g);
    const s = 1 + rand() * 1.2;
    const rock = mesh(new THREE.ConeGeometry(1.4 * s, 2 * s, 7), std(0xb99a7a, { flatShading: true }), 0, -s, 0, g);
    rock.rotation.x = Math.PI;
    mesh(new THREE.CylinderGeometry(1.45 * s, 1.45 * s, 0.25, 7), std(0x8fe08a, { flatShading: true }), 0, 0.1, 0, g);
    const ph = rand() * 6.28;
    every(() => { g.position.y = baseY + Math.sin(time * 0.6 + ph) * 0.35; g.rotation.y += 0.002; });
  }

  // Wind streaks drifting across the zone.
  const streakMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide });
  const streakGeo = new THREE.PlaneGeometry(3, 0.05);
  for (let i = 0; i < 28; i++) {
    const p = randInZone('Air', 8, 50);
    const m = mesh(streakGeo, streakMat, p.x, 0.6 + rand() * 6, p.z);
    m.rotation.x = rand() * Math.PI;
    const x0 = p.x - 8, sp = 6 + rand() * 6;
    m.position.x = x0 + rand() * 16;
    every((dt) => { m.position.x += dt * sp; if (m.position.x > x0 + 16) m.position.x = x0; });
  }
}

function buildFire() {
  const emberAt = zoneCenter('Fire', 27); // keep her clearing free
  // Lava pools.
  const rockMat = std(0x3b2622, { flatShading: true });
  for (let i = 0; i < 6; i++) {
    const p = randInZone('Fire', 12, 50);
    if (p.distanceTo(emberAt) < 11) continue;
    const r = 1.2 + rand() * 2.2;
    const lavaMat = new THREE.MeshBasicMaterial({ color: 0xff6a10 });
    const lava = mesh(new THREE.CircleGeometry(r, 24), lavaMat, p.x, 0.02, p.z);
    lava.rotation.x = -Math.PI / 2;
    const ring = mesh(new THREE.RingGeometry(r, r + 0.4, 24), rockMat, p.x, 0.025, p.z);
    ring.rotation.x = -Math.PI / 2;
    const ph = rand() * 6.28;
    every(() => { lavaMat.color.setHSL(0.06 + Math.sin(time * 1.5 + ph) * 0.02, 1, 0.52); });
  }

  // Volcanic rocks.
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  for (let i = 0; i < 16; i++) {
    const p = randInZone('Fire', 10, 54);
    if (p.distanceTo(emberAt) < 9) continue;
    const s = 0.5 + rand() * 1.3;
    const m = mesh(rockGeo, rockMat, p.x, s * 0.4, p.z);
    m.scale.set(s, s * 0.8, s);
    m.rotation.set(rand() * 3, rand() * 3, rand() * 3);
    if (s > 1) collide(m);
  }

  // Volcano with a glowing crater.
  const vp = polar(zoneMid('Fire'), 46);
  collide(mesh(new THREE.ConeGeometry(9, 12, 18), std(0x4a2b22, { flatShading: true }), vp.x, 6, vp.z));
  mesh(new THREE.SphereGeometry(2.3, 16, 10), new THREE.MeshBasicMaterial({ color: 0xff7a1a }), vp.x, 11.4, vp.z);

  // Embers drifting up everywhere in the zone, and out of the crater.
  const embers = new Particles({ count: 260, color: 0xffc04a, color2: 0xff2a00, size: 0.12, gravity: -0.5 });
  let acc = 0;
  every((dt) => {
    acc += dt * 40;
    while (acc > 1) {
      acc--;
      if (rand() < 0.3) {
        embers.emit(V(vp.x + (rand() - 0.5) * 3, 12, vp.z + (rand() - 0.5) * 3), V((rand() - 0.5) * 2, 3 + rand() * 2, (rand() - 0.5) * 2), 3, 0.3);
      } else {
        const p = randInZone('Fire', 8, 52, 0.02);
        embers.emit(V(p.x, 0.1, p.z), V((rand() - 0.5) * 0.6, 0.8 + rand() * 1.2, (rand() - 0.5) * 0.6), 3 + rand() * 2);
      }
    }
  });
}

function buildNature() {
  const sproutAt = zoneCenter('Nature');
  const trunkMat = std(0x7a4a2a);
  const leafMats = [0x3fae3a, 0x67c94a, 0x2f8f4a].map((c) => std(c, { flatShading: true }));
  for (let i = 0; i < 20; i++) {
    const p = randInZone('Nature', 10, 55);
    if (p.distanceTo(sproutAt) < 7) continue;
    const h = 2.5 + rand() * 2.5;
    collide(mesh(new THREE.CylinderGeometry(0.25, 0.4, h, 8), trunkMat, p.x, h / 2, p.z));
    const c = mesh(new THREE.IcosahedronGeometry(1.6 + rand() * 0.9, 0), leafMats[i % 3], p.x, h + 0.8, p.z);
    c.rotation.set(rand(), rand(), rand());
  }

  const stemGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.4, 4);
  const stemMat = std(0x2f8f3a);
  const headGeo = new THREE.SphereGeometry(0.1, 8, 6);
  const petalMats = [0xff5fa2, 0xffe14d, 0xffffff, 0xb57bff, 0xff8a3d].map((c) => std(c, { emissive: c, emissiveIntensity: 0.15 }));
  for (let i = 0; i < 80; i++) {
    const p = randInZone('Nature', 8, 55, 0.03);
    mesh(stemGeo, stemMat, p.x, 0.2, p.z);
    mesh(headGeo, petalMats[i % petalMats.length], p.x, 0.42, p.z);
  }

  const capMat = std(0xe8433f), spotMat = std(0xffffff), mStem = std(0xf4e9d4);
  for (let i = 0; i < 9; i++) {
    const p = randInZone('Nature', 9, 50);
    const s = 0.6 + rand() * 1.2;
    const g = new THREE.Group();
    g.position.copy(p); g.scale.setScalar(s);
    ctx.scene.add(g);
    mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.5, 8), mStem, 0, 0.25, 0, g);
    mesh(new THREE.SphereGeometry(0.42, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), capMat, 0, 0.45, 0, g);
    for (let k = 0; k < 5; k++) {
      const a = k * 1.26, sp = mesh(new THREE.SphereGeometry(0.06, 6, 4), spotMat, Math.cos(a) * 0.28, 0.72, Math.sin(a) * 0.28, g);
      sp.scale.y = 0.5;
    }
  }

  // Butterflies.
  const wingGeoR = new THREE.PlaneGeometry(0.22, 0.16).translate(0.11, 0, 0).rotateX(-Math.PI / 2);
  const wingGeoL = new THREE.PlaneGeometry(0.22, 0.16).translate(-0.11, 0, 0).rotateX(-Math.PI / 2);
  for (let i = 0; i < 10; i++) {
    const col = [0xff7ad9, 0xffd23f, 0x7ad9ff, 0xffffff][i % 4];
    const wm = new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide });
    const b = new THREE.Group();
    ctx.scene.add(b);
    const wr = mesh(wingGeoR, wm, 0, 0, 0, b), wl = mesh(wingGeoL, wm, 0, 0, 0, b);
    const home = randInZone('Nature', 10, 45);
    const ph = rand() * 6.28, sp = 0.5 + rand() * 0.5;
    every(() => {
      const t = time * sp + ph;
      b.position.set(home.x + Math.sin(t) * 3, 1 + Math.sin(t * 2.3) * 0.5 + 0.5, home.z + Math.cos(t * 0.7) * 3);
      b.rotation.y = -t;
      const f = Math.sin(time * 18 + ph) * 0.9;
      wr.rotation.z = f; wl.rotation.z = -f;
    });
  }
}

function buildWater() {
  const c = zoneCenter('Water', 26);
  const pondR = 10;
  const shore = mesh(new THREE.RingGeometry(pondR, pondR + 1, 48), std(0xe9d9a6), c.x, 0.02, c.z);
  shore.rotation.x = -Math.PI / 2;
  const pondMat = std(0x2f8fe0, { transparent: true, opacity: 0.85, roughness: 0.15, metalness: 0.1, emissive: 0x0a3a6a, emissiveIntensity: 0.4 });
  const pond = mesh(new THREE.CircleGeometry(pondR, 48), pondMat, c.x, 0.03, c.z);
  pond.rotation.x = -Math.PI / 2;
  every(() => { pondMat.emissiveIntensity = 0.35 + Math.sin(time * 1.2) * 0.1; });

  // Expanding ripples.
  const rippleGeo = new THREE.RingGeometry(0.9, 1, 40);
  for (let i = 0; i < 6; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false });
    const r = mesh(rippleGeo, mat, 0, 0.05, 0);
    r.rotation.x = -Math.PI / 2;
    let t = i / 6;
    const place = () => { const a = rand() * 6.28, d = rand() * 6; r.position.set(c.x + Math.cos(a) * d, 0.05, c.z + Math.sin(a) * d); };
    place();
    every((dt) => {
      t += dt / 3.5;
      if (t > 1) { t = 0; place(); }
      r.scale.setScalar(0.3 + t * 3.5);
      mat.opacity = 0.5 * (1 - t);
    });
  }

  // Lily pads.
  const padMat = std(0x3e9b4f, { side: THREE.DoubleSide });
  const lotus = std(0xff9ad5, { emissive: 0xff9ad5, emissiveIntensity: 0.2 });
  for (let i = 0; i < 12; i++) {
    const a = rand() * 6.28, d = 2 + rand() * 6.5;
    const pad = mesh(new THREE.CircleGeometry(0.5 + rand() * 0.4, 20, 0.3, Math.PI * 2 - 0.6), padMat, c.x + Math.cos(a) * d, 0.06, c.z + Math.sin(a) * d);
    pad.rotation.set(-Math.PI / 2, 0, rand() * 6.28);
    if (i % 3 === 0) mesh(new THREE.ConeGeometry(0.15, 0.25, 6), lotus, pad.position.x, 0.18, pad.position.z);
  }

  // Reeds around the shore.
  const reedMat = std(0x6b8e3a);
  const reedGeo = new THREE.CylinderGeometry(0.03, 0.03, 1, 4);
  for (let i = 0; i < 40; i++) {
    const a = rand() * 6.28, d = pondR + 0.3 + rand() * 0.8;
    const h = 0.6 + rand() * 0.9;
    const m = mesh(reedGeo, reedMat, c.x + Math.cos(a) * d, h / 2, c.z + Math.sin(a) * d);
    m.scale.y = h;
    m.rotation.z = (rand() - 0.5) * 0.3;
  }

  // Smooth pebbles and crystal spires around the rest of the zone.
  const pebbleMat = std(0x9fb6c9);
  const crystalMat = std(0x9fe6ff, { transparent: true, opacity: 0.8, emissive: 0x2a8fd0, emissiveIntensity: 0.4, flatShading: true });
  for (let i = 0; i < 14; i++) {
    const p = randInZone('Water', 9, 54);
    if (p.distanceTo(c) < pondR + 2) continue;
    if (i % 2) {
      const s = 0.4 + rand() * 0.9;
      const m = mesh(new THREE.SphereGeometry(1, 12, 8), pebbleMat, p.x, s * 0.3, p.z);
      m.scale.set(s * 1.3, s * 0.6, s);
      if (s > 0.9) collide(m);
    } else {
      const h = 1.5 + rand() * 3;
      const m = mesh(new THREE.OctahedronGeometry(1, 0), crystalMat, p.x, h * 0.45, p.z);
      m.scale.set(0.5, h, 0.5);
      m.rotation.y = rand() * 3;
      collide(m);
    }
  }

  // Bubbles rising from the pond.
  const bubbles = new Particles({ count: 80, color: 0xe8f8ff, size: 0.1, gravity: -0.4 });
  let acc = 0;
  every((dt) => {
    acc += dt * 10;
    while (acc > 1) {
      acc--;
      const a = rand() * 6.28, d = rand() * 8;
      bubbles.emit(V(c.x + Math.cos(a) * d, 0.05, c.z + Math.sin(a) * d), V(0, 0.3 + rand() * 0.4, 0), 2 + rand());
    }
  });
}

// ---------- the Fire Hydrant ----------
function buildHydrant() {
  const group = new THREE.Group();
  const body = new THREE.Group(); // bobs / squashes; group stays on the ground
  group.add(body);
  ctx.scene.add(group);

  // Desaturated, semi-transparent: he's fading because children forgot him.
  const red = std(0xc9645c, { transparent: true, emissive: 0x2a0a08, roughness: 0.6 });
  const metal = std(0xb7aaa6, { transparent: true, metalness: 0.3, roughness: 0.5 });
  const eye = new THREE.MeshBasicMaterial({ color: 0x1a1a1a, transparent: true });
  const shine = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true });
  red.userData.k = 1; metal.userData.k = 1; eye.userData.k = 1.5; shine.userData.k = 1.5;

  mesh(new THREE.CylinderGeometry(0.34, 0.36, 0.12, 20), metal, 0, 0.06, 0, body);
  mesh(new THREE.CylinderGeometry(0.24, 0.26, 0.64, 20), red, 0, 0.44, 0, body);
  mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.08, 20), metal, 0, 0.78, 0, body);
  mesh(new THREE.SphereGeometry(0.245, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), red, 0, 0.8, 0, body);
  mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.1, 6), metal, 0, 1.08, 0, body);
  for (const s of [-1, 1]) {
    const n = mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.16, 12), metal, s * 0.3, 0.52, 0, body);
    n.rotation.z = Math.PI / 2;
    // Eyes on the front (+z).
    mesh(new THREE.SphereGeometry(0.048, 10, 8), eye, s * 0.085, 0.66, 0.225, body);
    mesh(new THREE.SphereGeometry(0.016, 6, 4), shine, s * 0.085 + 0.015, 0.68, 0.268, body);
  }
  const mouth = mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.12, 14), metal, 0, 0.47, 0.27, body);
  mouth.rotation.x = Math.PI / 2;

  const nozzle = new THREE.Object3D(); // spray comes out of the right-side nozzle (+x)
  nozzle.position.set(0.4, 0.52, 0);
  body.add(nozzle);

  const wisps = new Particles({ count: 60, color: 0xffb7ae, color2: 0xffffff, size: 0.07, gravity: -0.35 });
  const spray = new Particles({ count: 220, color: 0x7fd0ff, color2: 0xe8f8ff, size: 0.15, gravity: 9.8, drag: 0.6 });

  return {
    group, body, nozzle, wisps, spray,
    mats: [red, metal, eye, shine],
    mode: 'manual',       // 'manual' | 'stay' (turn to face player) | 'follow'
    opacity: HYDRANT_OPACITY,
    puff: 1, hop: 0, hopY: 0, jumpY: 0, wispT: 0,
    interactable: false,
  };
}

function updateHydrant(dt) {
  const h = hydrant, g = h.group, player = ctx.player, p = player.position;
  const dx = p.x - g.position.x, dz = p.z - g.position.z;
  const d = Math.hypot(dx, dz);
  let moving = false;

  if (h.mode === 'follow') {
    if (d > 30) {
      // Lost him (e.g. after a gust) — he waddles back in from behind the player.
      g.position.set(p.x + Math.sin(player.yaw) * 2.5, 0, p.z + Math.cos(player.yaw) * 2.5);
    } else if (d > FOLLOW_DIST + 0.4) {
      const speed = Math.min(8, 2.5 + (d - FOLLOW_DIST) * 2);
      const step = Math.min(speed * dt, d - FOLLOW_DIST);
      g.position.x += (dx / d) * step;
      g.position.z += (dz / d) * step;
      moving = true;
    }
  }
  if (h.mode !== 'manual' && d > 0.01) {
    g.rotation.y = lerpAngle(g.rotation.y, Math.atan2(dx, dz), 1 - Math.exp(-dt * 8));
  }

  // Little hops while walking, squash while talking.
  h.hop = moving ? h.hop + dt * 11 : 0;
  const hopY = moving ? Math.abs(Math.sin(h.hop)) * 0.16 : 0;
  h.hopY += (hopY - h.hopY) * Math.min(1, dt * 20);
  h.body.position.y = h.hopY + h.jumpY;
  const talking = ctx.dialogue.speaker === HYDRANT && ctx.dialogue.typing;
  const sq = talking ? Math.sin(time * 28) * 0.05 : 0;
  h.body.scale.set(h.puff * (1 - sq * 0.5), h.puff * (1 + sq), h.puff * (1 - sq * 0.5));

  // Faded shimmer, with the odd flicker — like he's barely holding on.
  const flicker = Math.random() < 0.015 ? 0.4 : 1;
  const o = h.opacity * (0.85 + 0.15 * Math.sin(time * 2.3)) * flicker;
  for (const m of h.mats) m.opacity = Math.min(1, o * m.userData.k);

  // Wisps drifting off him.
  h.wispT -= dt;
  if (h.wispT <= 0) {
    h.wispT = 0.12;
    const a = Math.random() * 6.28;
    h.wisps.emit(V(g.position.x + Math.cos(a) * 0.25, h.body.position.y + 0.2 + Math.random() * 0.8, g.position.z + Math.sin(a) * 0.25),
      V(Math.cos(a) * 0.1, 0.3, Math.sin(a) * 0.1), 1.6);
  }

  // He only shows his ability by the water.
  const want = state === 'free' && !busy && zone === 'Water';
  if (want !== h.interactable) {
    h.interactable = want;
    if (want) ctx.interact.add(g, hydrantAbility, { distance: 4 });
    else ctx.interact.remove(g);
  }
}

// ---------- arrival + intro cutscene ----------
async function intro(g) {
  const { player, camera, dialogue, audio } = ctx;
  player.enabled = false;
  hydrant.mode = 'manual';
  hydrant.group.position.set(0, 0, 1.5);
  hydrant.group.rotation.y = Math.PI; // looking away at first

  const eye = V(0, 1.6, 5);
  const look = V(0, 0.75, 1.5);
  const from = V(-6, 16, 22);
  const lookFrom = V(0, 2, -20);
  const tmpLook = V(0, 0, 0);

  // Swoop down out of the sky into Quirkland.
  [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => alive(g) && audio.tone(f, 0.6, { volume: 0.08 }), i * 180));
  await tween(3.2, (k) => {
    const e = ease(k);
    camera.position.lerpVectors(from, eye, e);
    tmpLook.lerpVectors(lookFrom, look, ease(Math.min(1, k * 1.3)));
    camera.lookAt(tmpLook);
  });
  if (!alive(g)) return;

  // Don't start talking until the player is actually in the game (click-to-play overlay gone).
  while (!player.locked) {
    await wait(0.2);
    if (!alive(g)) return;
  }
  await wait(0.4);
  if (!alive(g)) return;

  const lines = INTRO.map((text) => ({ speaker: HYDRANT, color: HYDRANT_COLOR, text }));
  lines[0].onStart = () => {
    // Startled: hop and spin round to face the visitor.
    audio.tone(880, 0.15, { type: 'triangle', volume: 0.1 });
    const r0 = hydrant.group.rotation.y;
    tween(0.5, (k) => {
      hydrant.group.rotation.y = r0 * (1 - ease(k));
      hydrant.jumpY = Math.sin(k * Math.PI) * 0.35;
    }).then(() => { if (alive(g)) hydrant.mode = 'stay'; });
  };
  lines[4].onStart = () => {
    // "See how faded I am?" — he flickers almost out.
    tween(2.2, (k) => { hydrant.opacity = HYDRANT_OPACITY * (1 - 0.65 * Math.sin(k * Math.PI)); });
  };
  lines[7].onStart = () => {
    tween(0.4, (k) => { hydrant.jumpY = Math.sin(k * Math.PI) * 0.25; });
  };
  await dialogue.play(lines);
  if (!alive(g)) return;

  // Hand control back exactly where the camera is looking.
  player.yaw = 0;
  player.pitch = Math.atan2(look.y - eye.y, eye.z - look.z);
  player.enabled = true;
  hydrant.mode = 'follow';
  state = 'free';
}

// ---------- abilities ----------
async function hydrantAbility() {
  if (busy || state !== 'free') return;
  busy = true;
  const g = gen;
  const { dialogue, audio } = ctx;
  hydrant.mode = 'stay'; // faces the player, so his side nozzle points across the view

  await dialogue.say('Watch this!', { speaker: HYDRANT, color: HYDRANT_COLOR, duration: 600 });
  if (!alive(g)) return;

  await tween(0.5, (k) => { hydrant.puff = 1 + 0.15 * ease(k); }); // takes a big breath
  if (!alive(g)) return;

  // A weak, sputtering arc that fizzles out halfway.
  const origin = V(0, 0, 0), dir = V(0, 0, 0);
  let acc = 0, sputter = 0;
  await tween(2.6, (k, dt) => {
    hydrant.nozzle.getWorldPosition(origin);
    dir.set(1, 0, 0).transformDirection(hydrant.body.matrixWorld);
    sputter -= dt;
    if (sputter <= 0) {
      sputter = 0.12 + Math.random() * 0.25;
      if (Math.random() < 0.6) audio.noise(0.08, { volume: 0.06 });
    }
    const on = sputter > 0.08 || Math.random() < 0.2;
    acc += on ? (90 * (1 - k * 0.6)) * dt : 0;
    while (acc > 1) {
      acc--;
      const power = (1 - k * 0.5) * (0.8 + Math.random() * 0.4);
      hydrant.spray.emit(origin,
        V(dir.x * 2.6 * power + (Math.random() - 0.5) * 0.3, 3.2 * power + Math.random() * 0.4, dir.z * 2.6 * power + (Math.random() - 0.5) * 0.3),
        0.35 + Math.random() * 0.25);
    }
    hydrant.body.position.x = (Math.random() - 0.5) * 0.03; // straining
  });
  if (!alive(g)) return;
  // Last few drips.
  for (let i = 0; i < 4; i++) hydrant.spray.emit(origin, V(dir.x * 0.4, 0.2, dir.z * 0.4), 0.5, 0.08);
  hydrant.body.position.x = 0;
  await tween(0.6, (k) => { hydrant.puff = 1.15 - 0.15 * ease(k); });
  if (!alive(g)) return;

  await dialogue.say('...It used to reach the clouds. Back when they remembered me.', { speaker: HYDRANT, color: HYDRANT_COLOR });
  if (!alive(g)) return;
  hydrant.mode = 'follow';
  busy = false;
}

// ---------- inhabitants ----------
// Each one: E → their line → ability demo → the Fire Hydrant reacts.
async function meet(who) {
  if (busy || state !== 'free') return;
  busy = true;
  const g = gen;
  await faceToward(who.group, ctx.player.position, 0.4);
  if (!alive(g)) return;
  await ctx.dialogue.say(who.line, { speaker: who.name, color: who.color });
  if (!alive(g)) return;
  await who.ability(g);
  if (!alive(g)) return;
  await ctx.dialogue.say(who.reaction, { speaker: HYDRANT, color: HYDRANT_COLOR });
  if (!alive(g)) return;
  busy = false;
}

function faceToward(obj, p, sec) {
  const r0 = obj.rotation.y;
  const r1 = Math.atan2(p.x - obj.position.x, p.z - obj.position.z);
  return tween(sec, (k) => { obj.rotation.y = lerpAngle(r0, r1, ease(k)); });
}

// --- Ember the dragon (Fire) ---
function buildEmber() {
  const at = zoneCenter('Fire', 27);
  const g = new THREE.Group();
  g.position.copy(at);
  g.rotation.y = Math.atan2(-at.x, -at.z); // face the plaza
  ctx.scene.add(g);

  const scale = std(0xff4a1c, { emissive: 0xff3300, emissiveIntensity: 0.35, roughness: 0.5 });
  const belly = std(0xffc24d, { emissive: 0xffa000, emissiveIntensity: 0.3 });
  const wingMat = std(0xff2d6a, { emissive: 0xff1040, emissiveIntensity: 0.3, side: THREE.DoubleSide });
  const horn = std(0xfff1c1);
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const black = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const ball = new THREE.SphereGeometry(1, 20, 14);

  const body = mesh(ball, scale, 0, 1.4, 0, g);
  body.scale.set(1.1, 0.95, 1.5);
  collide(body);
  mesh(ball, belly, 0, 1.25, 0.5, g).scale.set(0.85, 0.75, 1.05);
  for (const [x, z] of [[-0.6, 0.7], [0.6, 0.7], [-0.6, -0.7], [0.6, -0.7]]) {
    mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.9, 10), scale, x, 0.45, z, g);
  }

  const neck = new THREE.Group();
  neck.position.set(0, 1.9, 1.0);
  g.add(neck);
  mesh(new THREE.CylinderGeometry(0.32, 0.45, 1.4, 12), scale, 0, 0.6, 0.25, neck).rotation.x = 0.4;
  const head = new THREE.Group();
  head.position.set(0, 1.35, 0.55);
  neck.add(head);
  mesh(ball, scale, 0, 0, 0, head).scale.set(0.55, 0.48, 0.62);
  mesh(ball, scale, 0, -0.1, 0.55, head).scale.set(0.4, 0.3, 0.45);
  for (const sx of [-1, 1]) {
    mesh(new THREE.SphereGeometry(0.15, 12, 8), white, sx * 0.26, 0.15, 0.38, head);
    mesh(new THREE.SphereGeometry(0.075, 8, 6), black, sx * 0.29, 0.16, 0.5, head);
    mesh(new THREE.ConeGeometry(0.09, 0.45, 8), horn, sx * 0.22, 0.48, -0.2, head).rotation.x = -0.5;
    mesh(new THREE.SphereGeometry(0.04, 6, 4), black, sx * 0.12, -0.02, 0.98, head);
  }
  const mouth = new THREE.Object3D();
  mouth.position.set(0, -0.15, 1.0);
  head.add(mouth);

  const wingShape = new THREE.Shape([
    new THREE.Vector2(0, 0), new THREE.Vector2(2.3, 0.9), new THREE.Vector2(2.7, -0.2),
    new THREE.Vector2(1.9, -0.5), new THREE.Vector2(1.2, -0.9), new THREE.Vector2(0.5, -0.6),
  ]);
  const wingGeo = new THREE.ShapeGeometry(wingShape).rotateX(-Math.PI / 2);
  const wings = [-1, 1].map((sx) => {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.6, 2.1, -0.1);
    pivot.scale.x = sx;
    g.add(pivot);
    mesh(wingGeo, wingMat, 0, 0, 0, pivot);
    return pivot;
  });

  const tail = [];
  for (let i = 0; i < 8; i++) {
    const r = 0.42 * (1 - i / 9);
    tail.push(mesh(new THREE.SphereGeometry(r, 12, 8), scale, 0, 1.15 - i * 0.12, -1.4 - i * 0.42, g));
  }
  const tip = mesh(new THREE.ConeGeometry(0.18, 0.4, 4), wingMat, 0, 0.2, -4.9, g);
  tip.rotation.x = -Math.PI / 2;
  tail.push(tip);

  // Unlit torches in a ring around her.
  const wood = std(0x4a2e1e), iron = std(0x333333), coal = std(0x1c1c1c);
  const torches = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.2;
    const tx = at.x + Math.cos(a) * 6, tz = at.z + Math.sin(a) * 6;
    collide(mesh(new THREE.CylinderGeometry(0.08, 0.11, 1.7, 8), wood, tx, 0.85, tz));
    mesh(new THREE.CylinderGeometry(0.26, 0.14, 0.25, 12), iron, tx, 1.8, tz);
    const char = mesh(new THREE.SphereGeometry(0.2, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), coal, tx, 1.88, tz);
    const flame = new THREE.Group();
    flame.position.set(tx, 1.9, tz);
    flame.visible = false;
    ctx.scene.add(flame);
    mesh(new THREE.ConeGeometry(0.24, 0.7, 10), new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.9 }), 0, 0.35, 0, flame);
    mesh(new THREE.ConeGeometry(0.12, 0.4, 8), new THREE.MeshBasicMaterial({ color: 0xffe680 }), 0, 0.22, 0, flame);
    const light = new THREE.PointLight(0xff8a3a, 0, 10, 1.5);
    light.position.set(tx, 2.4, tz);
    ctx.scene.add(light);
    torches.push({ x: tx, z: tz, char, flame, light, lit: false, ph: rand() * 6 });
  }

  const fire = new Particles({ count: 600, color: 0xffd04a, color2: 0xff3000, size: 0.3, grow: 2.2, gravity: -1.5, drag: 0.6 });

  const ember = {
    name: 'Ember', color: '#ff8a3d', group: g,
    line: 'A human! Do they still tell stories about dragons out there? They must — look how bright I am!',
    reaction: 'Show-off.',
    ability: (gg) => emberBreath(ember, gg),
    neck, mouth, torches, fire,
  };

  every(() => {
    const b = 1 + Math.sin(time * 2) * 0.03;
    body.scale.set(1.1 * b, 0.95 * b, 1.5);
    wings[0].rotation.z = -(0.25 + Math.sin(time * 2.4) * 0.3);
    wings[1].rotation.z = -(0.25 + Math.sin(time * 2.4) * 0.3);
    tail.forEach((m, i) => { m.position.x = Math.sin(time * 2 - i * 0.6) * i * 0.06; });
    for (const t of torches) {
      if (!t.lit) continue;
      const f = 1 + Math.sin(time * 14 + t.ph) * 0.12 + Math.sin(time * 23 + t.ph) * 0.06;
      t.flame.scale.set(1, f, 1);
      t.light.intensity = 9 * f;
    }
  });

  ctx.interact.add(g, () => meet(ember), { distance: 7 });
  return ember;
}

async function emberBreath(e, g) {
  const { audio } = ctx;
  const g0 = e.group;
  const mouthPos = V(0, 0, 0), aim = V(0, 0, 0);

  // Rear back...
  await tween(0.5, (k) => { e.neck.rotation.x = -0.45 * ease(k); });
  if (!alive(g)) return;
  audio.noise(1.6, { volume: 0.3 });
  audio.tone(70, 1.4, { type: 'sawtooth', volume: 0.12 });

  // ...then a full sweep of fire, lighting every torch the plume reaches.
  const r0 = g0.rotation.y;
  let acc = 0;
  await tween(3.4, (k, dt) => {
    e.neck.rotation.x = -0.45 + 0.75 * Math.min(1, k * 6);
    g0.rotation.y = r0 + ease(k) * Math.PI * 2;
    e.mouth.getWorldPosition(mouthPos);
    const fx = Math.sin(g0.rotation.y), fz = Math.cos(g0.rotation.y);
    aim.set(g0.position.x + fx * 6, 2.0, g0.position.z + fz * 6).sub(mouthPos).normalize();
    acc += dt * 170;
    while (acc > 1) {
      acc--;
      const sp = 9 + Math.random() * 3;
      e.fire.emit(mouthPos, V(aim.x * sp + (Math.random() - 0.5) * 1.6, aim.y * sp + (Math.random() - 0.5) * 1.6, aim.z * sp + (Math.random() - 0.5) * 1.6),
        0.55 + Math.random() * 0.3, 0.25 + Math.random() * 0.2);
    }
    for (const t of e.torches) {
      if (t.lit) continue;
      const bearing = Math.atan2(t.x - g0.position.x, t.z - g0.position.z);
      if (Math.abs(lerpAngle(0, bearing - g0.rotation.y, 1)) < 0.2) lightTorch(t, g);
    }
  });
  if (!alive(g)) return;
  await tween(0.4, (k) => { e.neck.rotation.x = 0.3 * (1 - ease(k)); });
  if (!alive(g)) return;
  await faceToward(g0, ctx.player.position, 0.4);
}

function lightTorch(t, g) {
  t.lit = true;
  setTimeout(() => {
    if (!alive(g)) return;
    t.char.visible = false;
    t.flame.visible = true;
    ctx.audio.noise(0.25, { volume: 0.15 });
    ctx.audio.tone(320, 0.2, { type: 'triangle', volume: 0.06 });
    tween(0.3, (k) => { t.flame.scale.setScalar(Math.max(0.01, easeOutBack(k))); });
  }, 380);
}

// --- Skye the kite (Air) ---
function buildSkye() {
  const at = zoneCenter('Air', 27);
  const g = new THREE.Group();
  g.position.copy(at);
  g.rotation.y = Math.atan2(-at.x, -at.z);
  ctx.scene.add(g);
  mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.6, 6), std(0x8a6a4a), 0, 0.3, 0, g);

  const kite = new THREE.Group();
  kite.position.set(0, 3.6, 0.6);
  g.add(kite);
  const corners = [new THREE.Vector2(0, 1.2), new THREE.Vector2(0.85, 0), new THREE.Vector2(0, -1.5), new THREE.Vector2(-0.85, 0)];
  const cols = [0xff5fa2, 0xffd23f, 0x5ad1ff, 0x9b7bff];
  for (let i = 0; i < 4; i++) {
    const shape = new THREE.Shape([new THREE.Vector2(0, 0), corners[i], corners[(i + 1) % 4]]);
    mesh(new THREE.ShapeGeometry(shape), std(cols[i], { side: THREE.DoubleSide, emissive: cols[i], emissiveIntensity: 0.35 }), 0, 0, 0, kite);
  }
  const spar = std(0xfff6e0);
  mesh(new THREE.BoxGeometry(0.04, 2.7, 0.04), spar, 0, -0.15, -0.03, kite);
  mesh(new THREE.BoxGeometry(1.7, 0.04, 0.04), spar, 0, 0, -0.03, kite);
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff }), black = new THREE.MeshBasicMaterial({ color: 0x111111 });
  for (const sx of [-1, 1]) {
    mesh(new THREE.SphereGeometry(0.13, 12, 8), white, sx * 0.24, 0.3, 0.03, kite).scale.z = 0.4;
    mesh(new THREE.SphereGeometry(0.065, 8, 6), black, sx * 0.24, 0.29, 0.08, kite).scale.z = 0.4;
  }
  const smile = mesh(new THREE.TorusGeometry(0.2, 0.03, 6, 16, Math.PI), black, 0, 0, 0.04, kite);
  smile.rotation.z = Math.PI;

  // Tail with bows, and the string down to the stake.
  const bowShape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.2, 0.12), new THREE.Vector2(0.2, -0.12)]);
  const bowGeo = new THREE.ShapeGeometry(bowShape);
  const bows = [];
  for (let i = 0; i < 5; i++) {
    const b = new THREE.Group();
    kite.add(b);
    const m = std(cols[i % 4], { side: THREE.DoubleSide, emissive: cols[i % 4], emissiveIntensity: 0.3 });
    mesh(bowGeo, m, 0, 0, 0, b);
    mesh(bowGeo, m, 0, 0, 0, b).rotation.z = Math.PI;
    bows.push(b);
  }
  const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff });
  const tailLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(new Array(6).fill(0).map(() => V(0, 0, 0))), lineMat);
  kite.add(tailLine);
  const string = new THREE.Line(new THREE.BufferGeometry().setFromPoints([V(0, 0.6, 0), V(0, 0, 0)]), lineMat);
  g.add(string);

  const wind = new Particles({ count: 400, color: 0xffffff, color2: 0xcfe6ff, size: 0.14, grow: 0.6 });

  const skye = {
    name: 'Skye', color: '#ff7ac4', group: g,
    line: 'Every windy day, a child somewhere runs with a kite. That\'s what keeps me flying!',
    reaction: 'I used to be able to do that with water. Sort of.',
    ability: (gg) => skyeGust(skye, gg),
    kite, wind, loop: 0,
  };

  every(() => {
    kite.position.y = 3.6 + Math.sin(time * 1.3) * 0.3;
    kite.position.x = Math.sin(time * 0.7) * 0.4;
    kite.rotation.z = Math.sin(time * 0.9) * 0.15 + skye.loop;
    kite.rotation.x = -0.2 + Math.sin(time * 1.1) * 0.08;
    const tp = tailLine.geometry.attributes.position;
    for (let i = 0; i < 6; i++) {
      const x = Math.sin(time * 3 - i * 0.9) * 0.12 * i, y = -1.5 - i * 0.45, z = -i * 0.12;
      tp.setXYZ(i, x, y, z);
      if (i > 0) { bows[i - 1].position.set(x, y, z); bows[i - 1].rotation.y = Math.sin(time * 4 + i) * 0.6; }
    }
    tp.needsUpdate = true;
    const sp = string.geometry.attributes.position;
    sp.setXYZ(1, kite.position.x, kite.position.y - 0.4, kite.position.z);
    sp.needsUpdate = true;
  });

  ctx.interact.add(g, () => meet(skye), { distance: 7 });
  return skye;
}

async function skyeGust(s, g) {
  const { player, audio } = ctx;
  const from = V(0, 0, 0);
  audio.noise(2.5, { volume: 0.3 });
  audio.tone(180, 1.5, { type: 'sine', volume: 0.08 });
  let acc = 0, t = 0;
  // A strong gust lifts the player, holds them a moment, then sets them down gently.
  await tween(3.6, (k, dt) => {
    t += dt;
    s.loop = ease(Math.min(1, t / 1.2)) * Math.PI * 2; // the kite does a loop-the-loop
    s.kite.getWorldPosition(from);
    const pp = player.position;
    acc += dt * 160;
    while (acc > 1) {
      acc--;
      if (Math.random() < 0.5) {
        const o = V(from.x + (Math.random() - 0.5) * 3, from.y + (Math.random() - 0.5) * 2, from.z + (Math.random() - 0.5) * 3);
        const d = V(pp.x - o.x, pp.y + 1 - o.y, pp.z - o.z).normalize().multiplyScalar(12);
        s.wind.emit(o, V(d.x, d.y + 1, d.z), 1.1);
      } else {
        const a = Math.random() * Math.PI * 2, r = 1 + Math.random() * 0.6;
        s.wind.emit(V(pp.x + Math.cos(a) * r, pp.y + Math.random() * 0.6, pp.z + Math.sin(a) * r), V(-Math.sin(a) * 4, 5, Math.cos(a) * 4), 0.8);
      }
    }
    const hold = 25 * dt; // cancels one frame of gravity (player.js GRAVITY)
    if (t < 0.7) player.velocity.y = 5 + hold;
    else if (t < 1.6) player.velocity.y = hold;
    else if (!player.grounded) player.velocity.y = -2.8 + hold;
  });
  s.loop = 0;
}

// ---------- zone title ----------
function showZone(name) {
  if (!toastEl) return;
  toastEl.textContent = name.toUpperCase();
  toastEl.style.color = ZONES[name].accent;
  toastEl.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (toastEl) toastEl.style.opacity = '0'; }, 2200);
}

// ---------- scene ----------
export default {
  name: NAME,

  init(c) {
    ctx = c;
    gen++;
    tasks = []; systems = []; time = 0; state = 'intro'; busy = false; zone = null;
    rand = mulberry32(7);
    pxScale = (window.innerHeight * Math.min(window.devicePixelRatio, 2)) / (2 * Math.tan(THREE.MathUtils.degToRad(ctx.camera.fov / 2)));

    toastEl = document.createElement('div');
    Object.assign(toastEl.style, {
      position: 'fixed', top: '36px', left: '50%', transform: 'translateX(-50%)', pointerEvents: 'none', zIndex: '20',
      font: "48px 'Rubik Bubbles', system-ui, sans-serif", letterSpacing: '0.08em', opacity: '0', transition: 'opacity 0.5s',
      textShadow: '0 3px 0 rgba(255,255,255,0.9), 0 0 20px rgba(0,0,0,0.25)',
    });
    document.body.appendChild(toastEl);

    buildWorld();
    hydrant = buildHydrant();
    buildEmber();
    buildSkye();

    ctx.player.spawn(V(0, 0, 5), 0);
    intro(gen);
  },

  update(dt) {
    if (!ctx) return;
    time += dt;
    const run = tasks;
    tasks = [];
    for (const fn of run) if (fn(dt) !== false) tasks.push(fn);
    for (const s of systems) s.update(dt);

    if (state === 'free') {
      const z = zoneAt(ctx.player.position);
      if (z !== zone) { zone = z; if (z) showZone(z); }
    }
    updateHydrant(dt);
  },

  dispose() {
    gen++;
    clearTimeout(toastTimer);
    toastEl?.remove();
    toastEl = null;
    tasks = []; systems = [];
    hydrant = null;
    ctx = null;
  },
};
