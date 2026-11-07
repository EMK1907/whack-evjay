import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Quirkland (Varshan) — docs/GAME.md §7–9.
// A child's imagination: soft rolling green hills, wobbly paths and candy everywhere. There is no sky —
// overhead is a bright patterned ceiling covered in identical big smiling mouths.
// Arrival: the globe transition zooms into the Fire Hydrant; the camera pulls back to the player standing
// right in front of him, and his intro cutscene plays. Afterwards he follows the player as a companion.
// Every character has a `remembered` value (0–1) that controls how faded / desaturated they look.
// Inhabitants so far (E): the Kite (Skye).
// TEMP: the grey cube at the end of the north path goes to 'ending' until the masked figure (§9) is built.

const NAME = 'quirkland';
const NEXT = 'ending';
const HYDRANT = 'Fire Hydrant';
const HYDRANT_COLOR = '#ff9d92';
const FOLLOW_DIST = 2.2;
const PLAY_R = 50;              // walkable radius (invisible wall)
const CEIL_R = 95, CEIL_H = 34; // ceiling dome (ellipsoid) radius / height
const MOUTH_SIZE = 5.5;

// How much children remember each character: 1 = bright and strong, 0 = gone.
const REMEMBERED = { hydrant: 0.2, kite: 1.0 };

const V = (x, y, z) => new THREE.Vector3(x, y, z);

const INTRO = [
  "Oh! A visitor. We haven't had one of those in... well, ever.",
  'Welcome to Quirkland. Everything here was dreamed up by children — every creature, every tree, every gust of wind.',
  'We exist because they imagine us. Air, Fire, Nature, Water — four corners, each one built from their stories.',
  "Me? I'm a fire hydrant. I keep things safe. When fire gets out of hand, I put it out. That's my ability.",
  "But look at me. See how faded I am? Children don't think about fire hydrants anymore.",
  'The more a child forgets you, the more you fade. Your ability weakens. One day... you just aren\'t here.',
  "The others — the kangaroo, the kite, the infernal one — they're bright and strong. Children still dream about them every night.",
  "Come on. I'll show you around. Stick close — I don't get to talk to anyone new.",
];

// ---------- module state (reset in init/dispose) ----------
let ctx = null;
let gen = 0;          // bumps every init/dispose so stale async sequences stop
let tasks = [];       // per-frame callbacks; return false to remove
let systems = [];     // particle systems
let fadables = [];    // characters with a `remembered` value
let time = 0;
let rand = Math.random;
let pxScale = 700;
let hydrant = null;
let state = 'intro';  // 'intro' | 'free'
let busy = false;     // an ability / conversation is playing
let pathPts = [];     // sampled path centre points (keeps props off the paths)
let pathEnds = [];
let props = [];       // occupied [x, z, radius]

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
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

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

function std(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...extra });
}

function mesh(geo, mat, x = 0, y = 0, z = 0, parent = ctx.scene) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function collide(obj) { ctx.player.colliders.push(obj); return obj; }

function makeLabel(text, { w = 2.4 } = {}) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.beginPath();
  g.roundRect(4, 4, c.width - 8, c.height - 8, 56);
  g.fill();
  g.fillStyle = '#fff';
  g.font = '700 54px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, c.width / 2, c.height / 2 + 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
  sprite.scale.set(w, w / 4, 1);
  return sprite;
}

// ---------- terrain height ----------
const HILLS = [[20, -16, 4.5, 7], [-24, 10, 5, 9], [8, 27, 3.5, 6.5], [-15, -27, 4.5, 8], [31, 13, 3.2, 7], [-33, -8, 3.8, 7]];

/** Ground height at (x, z): flat meadow at the arrival point, rolling hills, rising to big rounded hills at the rim. */
function H(x, z) {
  const r = Math.hypot(x, z);
  let h = 0.9 * Math.sin(x * 0.09 + 0.5) * Math.cos(z * 0.08 - 0.3)
        + 0.6 * Math.sin(x * 0.17 + z * 0.05 + 1.3)
        + 0.45 * Math.cos(z * 0.15 - x * 0.07 + 2.1);
  h *= smooth(4, 16, r);
  for (const [hx, hz, a, s] of HILLS) {
    const dx = x - hx, dz = z - hz;
    h += a * Math.exp(-(dx * dx + dz * dz) / (s * s));
  }
  return h + Math.pow(smooth(44, 76, r), 1.4) * 36;
}

// ---------- fading: remembered 0..1 → transparency + desaturation ----------
const _hsl = {};
function makeFadable(root, remembered) {
  const seen = new Set();
  const entries = [];
  root.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (seen.has(m) || !m.color) continue;
      seen.add(m);
      entries.push({ m, color: m.color.clone(), emissive: m.emissive ? m.emissive.clone() : null, k: m.userData.k || 1 });
    }
  });
  const rec = { root, entries, remembered, dip: 1 };
  if (remembered < 0.999) for (const e of entries) e.m.transparent = true;
  applyFade(rec, 1);
  fadables.push(rec);
  return rec;
}

function applyFade(rec, flicker) {
  const r = Math.min(1, Math.max(0, rec.remembered));
  const sat = 0.3 + 0.7 * r;
  const opacity = (0.3 + 0.7 * r) * flicker * rec.dip;
  for (const e of rec.entries) {
    e.color.getHSL(_hsl);
    e.m.color.setHSL(_hsl.h, _hsl.s * sat, _hsl.l + (1 - r) * 0.2 * (0.65 - _hsl.l));
    if (e.emissive) e.m.emissive.copy(e.emissive).multiplyScalar(r);
    if (e.m.transparent) e.m.opacity = Math.min(1, opacity * e.k);
  }
}

function updateFades() {
  for (const f of fadables) {
    const lost = 1 - f.remembered;
    if (lost < 0.01 && f.dip === 1) continue;
    // The more forgotten, the more they shimmer and flicker — barely holding on.
    const flicker = (1 - lost * 0.2 * (0.5 + 0.5 * Math.sin(time * 2.3))) * (Math.random() < lost * 0.02 ? 0.45 : 1);
    applyFade(f, flicker);
  }
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
  const { scene } = ctx;
  scene.background = new THREE.Color(0xffd6ea);
  scene.fog = new THREE.Fog(0xfff0dc, 80, 200);
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x8fdc70, 1.5));
  const key = new THREE.DirectionalLight(0xfff0d8, 1.8);
  key.position.set(20, 40, 15);
  scene.add(key);
  // Soft glow from the middle of the world so the inward-facing rim hills stay bright.
  const fill = new THREE.PointLight(0xfff3e0, 1.1, 0, 0);
  fill.position.set(0, 22, 0);
  scene.add(fill);

  buildTerrain();
  buildCeiling();
  buildPaths();
  buildCandy();
  buildTrees();

  // Invisible boundary wall (the rim hills rise behind it).
  const wall = mesh(new THREE.CylinderGeometry(PLAY_R, PLAY_R, 40, 64, 1, true),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), 0, 10, 0);
  wall.visible = false;
  collide(wall);
}

function buildTerrain() {
  // Split into chunks so the player's raycasts only test nearby triangles.
  const SIZE = 160, CHUNKS = 8, SEG = 32, cs = SIZE / CHUNKS;
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 });
  const cA = new THREE.Color(0x63dd48), cB = new THREE.Color(0xa6ec4c), cC = new THREE.Color(0x3fd27a);
  const sun = new THREE.Color(0xd8f56a), pastel = new THREE.Color(), col = new THREE.Color();
  const n = new THREE.Vector3();
  const e = 0.25;
  for (let cx = 0; cx < CHUNKS; cx++) {
    for (let cz = 0; cz < CHUNKS; cz++) {
      const ox = -SIZE / 2 + cs * (cx + 0.5), oz = -SIZE / 2 + cs * (cz + 0.5);
      const geo = new THREE.PlaneGeometry(cs, cs, SEG, SEG).rotateX(-Math.PI / 2).translate(ox, 0, oz);
      const pos = geo.attributes.position, nor = geo.attributes.normal;
      const colors = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), z = pos.getZ(i);
        const h = H(x, z);
        pos.setY(i, h);
        n.set(H(x - e, z) - H(x + e, z), 2 * e, H(x, z - e) - H(x, z + e)).normalize();
        nor.setXYZ(i, n.x, n.y, n.z);

        // Bright grass with soft colour patches; rim hills fade into a pastel rainbow.
        const r = Math.hypot(x, z);
        const v = 0.5 + 0.5 * Math.sin(x * 0.21 + Math.cos(z * 0.17) * 2) * Math.cos(z * 0.19 - x * 0.05);
        col.copy(cA).lerp(cB, v * 0.6);
        col.lerp(cC, smooth(0.3, 1, Math.sin(x * 0.07 - z * 0.11) * 0.5 + 0.5) * 0.35);
        col.lerp(sun, smooth(2.5, 5, h) * (1 - smooth(46, 60, r)) * 0.4);
        pastel.setHSL(((Math.atan2(z, x) / (Math.PI * 2)) + 1) % 1, 0.85, 0.8);
        col.lerp(pastel, smooth(46, 68, r) * 0.85);
        colors.set([col.r, col.g, col.b], i * 3);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      collide(mesh(geo, mat));
    }
  }
}

function buildCeiling() {
  // Bright childlike pattern: soft rainbow swirl bands with polka dots.
  const dome = new THREE.Mesh(new THREE.SphereGeometry(CEIL_R, 128, 64, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.ShaderMaterial({
    side: THREE.BackSide, fog: false,
    uniforms: { time: { value: 0 } },
    vertexShader: 'varying vec3 vP; void main() { vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform float time; varying vec3 vP;
      vec3 hsl2rgb(vec3 c) {
        vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
        return c.z + c.y * (rgb - 0.5) * (1.0 - abs(2.0 * c.z - 1.0));
      }
      void main() {
        float az = atan(vP.z, vP.x) / 6.28318;
        float el = vP.y;
        float s = az * 3.0 + el * 3.5 + time * 0.01;
        float band = s * 6.0;
        float f = fract(band);
        float hue = (floor(band) + smoothstep(0.82, 1.0, f)) / 6.0;
        vec3 col = hsl2rgb(vec3(fract(hue), 0.8, 0.8));
        vec2 uv = vec2(az * 40.0, el * 18.0);
        float dots = 1.0 - smoothstep(0.17, 0.22, length(fract(uv) - 0.5));
        col = mix(col, vec3(1.0, 0.98, 0.92), dots * 0.8);
        gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);
        #include <colorspace_fragment>
      }`,
  }));
  dome.scale.y = CEIL_H / CEIL_R;
  ctx.scene.add(dome);
  every(() => { dome.material.uniforms.time.value = time; });

  // One mouth design, copied all over the ceiling — identical, and all moving in perfect sync.
  const yU = (x) => 0.05 + 0.25 * x * x;    // upper lip line
  const yL = (x) => -0.75 + 1.05 * x * x;   // lower lip line (big open grin)
  const outline = [];
  for (let i = 0; i <= 14; i++) { const x = -1 + (2 * i) / 14; outline.push(new THREE.Vector2(x, yU(x))); }
  for (let i = 13; i >= 1; i--) { const x = -1 + (2 * i) / 14; outline.push(new THREE.Vector2(x, yL(x))); }
  const lipGeo = new THREE.TubeGeometry(
    new THREE.CatmullRomCurve3(outline.map((p) => V(p.x, p.y, 0)), true, 'centripetal'), 240, 0.075, 16, true);
  const innerGeo = new THREE.ShapeGeometry(new THREE.Shape(outline), 24);
  const teeth = [];
  for (let i = 0; i < 7; i++) {
    const x = -0.6 + i * 0.2;
    teeth.push(new THREE.CapsuleGeometry(0.065, 0.06, 8, 16).scale(1, 1, 0.45).translate(x, yU(x) - 0.1, 0.02));
  }
  const teethGeo = mergeGeometries(teeth);
  const tongueGeo = new THREE.SphereGeometry(1, 32, 16).scale(0.36, 0.16, 0.07);
  const dimpleGeo = new THREE.SphereGeometry(0.06, 16, 12);

  const lipMat = std(0xff3d64, { roughness: 0.3, emissive: 0xa0102c, emissiveIntensity: 0.6, fog: false });
  const innerMat = new THREE.MeshBasicMaterial({ color: 0x4a0618, side: THREE.DoubleSide, fog: false });
  const toothMat = std(0xffffff, { roughness: 0.25, emissive: 0xfff4ea, emissiveIntensity: 0.55, fog: false });
  const tongueMat = std(0xff7a9a, { roughness: 0.5, emissive: 0xc03050, emissiveIntensity: 0.5, fog: false });

  const mouths = [];
  const tongues = [];
  const n = V(0, 0, 0), p = V(0, 0, 0), toEye = V(0, 0, 0), face = V(0, 0, 0);
  const rings = [[0, 1, 0], [17, 6, 0.3], [31, 10, 0], [44, 13, 0.2], [57, 17, 0.1]];
  for (const [rho, count, off] of rings) {
    for (let i = 0; i < count; i++) {
      const th = (i / count) * Math.PI * 2 + off;
      const y = CEIL_H * Math.sqrt(1 - (rho / CEIL_R) ** 2);
      p.set(Math.cos(th) * rho, y, Math.sin(th) * rho);
      n.set(p.x / (CEIL_R * CEIL_R), p.y / (CEIL_H * CEIL_H), p.z / (CEIL_R * CEIL_R)).normalize();
      const g = new THREE.Group();
      // Face partly toward the middle of the world, so they look down at whoever is there.
      toEye.set(-p.x, 2 - p.y, -p.z).normalize();
      face.copy(n).negate().lerp(toEye, 0.55).normalize();
      g.position.copy(p).addScaledVector(n, -1.4);
      if (rho === 0) g.up.set(0, 0, -1);
      g.lookAt(g.position.x + face.x, g.position.y + face.y, g.position.z + face.z);
      ctx.scene.add(g);
      const inner = new THREE.Group(); // the part that animates
      g.add(inner);
      mesh(innerGeo, innerMat, 0, 0, -0.02, inner);
      mesh(lipGeo, lipMat, 0, 0, 0, inner);
      mesh(teethGeo, toothMat, 0, 0, 0, inner);
      tongues.push(mesh(tongueGeo, tongueMat, 0, -0.52, 0.01, inner));
      for (const sx of [-1, 1]) mesh(dimpleGeo, lipMat, sx * 1.1, 0.3, 0, inner);
      mouths.push(inner);
    }
  }
  every(() => {
    // Slow synchronized breathing, and every few seconds they all grin wider at once.
    const breathe = Math.sin(time * 1.3);
    const grin = Math.pow(Math.max(0, Math.sin(time * 0.7)), 12);
    const sx = MOUTH_SIZE * (1 + grin * 0.14), sy = MOUTH_SIZE * (1 + breathe * 0.06 + grin * 0.12);
    for (const m of mouths) m.scale.set(sx, sy, MOUTH_SIZE);
    const tx = Math.sin(time * 2) * 0.05;
    for (const t of tongues) t.position.x = tx;
  });
}

function ribbon(curve, { closed = false, width = 2, color, y = 0.05, N = 260, wobble = 0.25, seed = 0, offset = -1, record = false }) {
  const pos = [], idx = [];
  const p = V(0, 0, 0), tan = V(0, 0, 0);
  for (let i = 0; i <= N; i++) {
    const t = closed ? (i / N) % 1 : i / N;
    curve.getPointAt(t, p);
    curve.getTangentAt(t, tan);
    const l = Math.hypot(tan.x, tan.z) || 1;
    const sx = -tan.z / l, sz = tan.x / l;
    const w = (width * (1 + wobble * Math.sin(i / N * 37 + seed) * Math.sin(i / N * 13 + seed * 2))) / 2;
    for (const s of [-1, 1]) {
      const x = p.x + sx * w * s, z = p.z + sz * w * s;
      pos.push(x, H(x, z) + y, z);
    }
    if (i < N) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    if (record && i % 4 === 0) pathPts.push([p.x, p.z]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = std(color, { roughness: 0.85, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset });
  return mesh(geo, mat);
}

function wobblyPath(points, opts) {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, z]) => V(x, 0, z)), !!opts.closed, 'centripetal');
  ribbon(curve, { ...opts, width: opts.width + 0.7, color: 0xffbf73, y: 0.04, offset: -1 });  // soft border
  ribbon(curve, { ...opts, color: 0xffe6b8, y: 0.07, offset: -2, record: true });                // path
  return curve;
}

function buildPaths() {
  // Wobbly ring around the arrival meadow.
  const ring = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2, r = 7 + Math.sin(i * 1.7) * 0.8;
    ring.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  wobblyPath(ring, { closed: true, width: 1.8, seed: 1 });

  // Paths wandering out towards the hills (the first one heads north, -z).
  const starts = [1.5 * Math.PI, 0.25, 1.2, 2.3, 3.4, 4.4];
  starts.forEach((a0, k) => {
    const pts = [];
    for (let r = 7; r <= 46; r += 4) {
      const a = a0 + Math.sin(r * 0.13 + k * 2.1) * 0.32;
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    wobblyPath(pts, { width: 2, seed: k * 3 + 2 });
    pathEnds.push(pts[pts.length - 1]);
  });
}

function freeSpot(rMin, rMax, radius, pathClear = 2.2) {
  for (let tries = 0; tries < 40; tries++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rMin * rMin + rand() * (rMax * rMax - rMin * rMin));
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (pathPts.some(([px, pz]) => (px - x) ** 2 + (pz - z) ** 2 < (radius + pathClear) ** 2)) continue;
    if (props.some(([px, pz, pr]) => (px - x) ** 2 + (pz - z) ** 2 < (radius + pr + 0.8) ** 2)) continue;
    props.push([x, z, radius]);
    return [x, z];
  }
  return null;
}

// ---------- candy ----------
const texCache = new Map();
function canvasTex(key, draw, size = 256) {
  if (texCache.has(key)) return texCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  texCache.set(key, tex);
  return tex;
}

function swirlTex(c1, c2) {
  return canvasTex(`swirl${c1}${c2}`, (g, s) => {
    const m = s / 2;
    for (let r = m; r > 0; r -= 1.5) {
      for (let k = 0; k < 8; k++) {
        g.fillStyle = k % 2 ? c1 : c2;
        g.beginPath();
        g.moveTo(m, m);
        g.arc(m, m, r, (k * Math.PI) / 4 + r * 0.045, ((k + 1) * Math.PI) / 4 + r * 0.045);
        g.fill();
      }
    }
  });
}

function stripeTex(c1, c2, repeat = 1) {
  const base = canvasTex(`stripe${c1}${c2}`, (g, s) => {
    g.fillStyle = c1;
    g.fillRect(0, 0, s, s);
    g.fillStyle = c2;
    for (let i = -2; i < 4; i++) {
      g.beginPath();
      g.moveTo(i * s / 2, 0); g.lineTo(i * s / 2 + s / 4, 0);
      g.lineTo(i * s / 2 + s / 4 + s, s); g.lineTo(i * s / 2 + s, s);
      g.fill();
    }
  }, 128);
  const t = base.clone();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, 1);
  t.needsUpdate = true;
  return t;
}

const CANDY = [['#ff4f8b', '#ffffff'], ['#ffb02e', '#fff3c4'], ['#7b6cff', '#ffffff'], ['#29c7b8', '#e9fffb'], ['#ff5a3c', '#ffe14d']];

function placeOnGround(obj, x, z, sink = 0.05) {
  obj.position.set(x, H(x, z) - sink, z);
  ctx.scene.add(obj);
  return obj;
}

function lollipop(s) {
  const g = new THREE.Group();
  const [c1, c2] = CANDY[Math.floor(rand() * CANDY.length)];
  const stickH = 1.6 * s, R = 0.6 * s, T = 0.18 * s;
  const stick = mesh(new THREE.CylinderGeometry(0.05 * s, 0.05 * s, stickH, 24), std(0xfffaf0, { roughness: 0.4 }), 0, stickH / 2, 0, g);
  const swirl = std(0xffffff, { map: swirlTex(c1, c2), roughness: 0.25 });
  const rimMat = std(c1, { roughness: 0.25 });
  const disc = mesh(new THREE.CylinderGeometry(R, R, T, 64), [rimMat, swirl, swirl], 0, stickH + R * 0.9, 0, g);
  disc.rotation.x = Math.PI / 2;
  mesh(new THREE.TorusGeometry(R, T / 2, 20, 96), rimMat, 0, stickH + R * 0.9, 0, g);
  g.rotation.set((rand() - 0.5) * 0.15, rand() * Math.PI * 2, (rand() - 0.5) * 0.15);
  if (s > 1.4) collide(stick);
  return g;
}

function candyCane(s) {
  const g = new THREE.Group();
  const h = 2 * s, k = 0.8 * s;
  const pts = [[0, 0], [0, h * 0.5], [0, h], [k * 0.15, h + k * 0.38], [k * 0.5, h + k * 0.52], [k * 0.85, h + k * 0.38], [k, h], [k, h - k * 0.3]]
    .map(([x, y]) => V(x, y, 0));
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const mat = std(0xffffff, { map: stripeTex('#ffffff', '#ff2d4a', Math.round((curve.getLength() * 2.2) / s)), roughness: 0.3 });
  const r = 0.13 * s;
  const tube = mesh(new THREE.TubeGeometry(curve, 160, r, 24), mat, 0, 0, 0, g);
  mesh(new THREE.SphereGeometry(r, 24, 12), std(0xffffff, { roughness: 0.3 }), pts[7].x, pts[7].y, 0, g);
  g.rotation.y = rand() * Math.PI * 2;
  g.rotation.z = (rand() - 0.5) * 0.12;
  if (s > 0.9) collide(tube);
  return g;
}

function gumdrop(s) {
  const R = 0.5 * s, Hh = 0.75 * s;
  const prof = [new THREE.Vector2(0, 0), new THREE.Vector2(R * 0.92, 0), new THREE.Vector2(R, 0.06 * R)];
  for (let i = 1; i <= 24; i++) {
    const a = (i / 24) * (Math.PI / 2);
    prof.push(new THREE.Vector2(Math.max(0.0001, R * Math.cos(a) * (1 - 0.12 * Math.sin(a))), 0.06 * R + Hh * Math.sin(a)));
  }
  const col = [0xff4f8b, 0xffb02e, 0x7b6cff, 0x29c7b8, 0x8ee04a, 0xff5a3c][Math.floor(rand() * 6)];
  const m = new THREE.Mesh(new THREE.LatheGeometry(prof, 64), std(col, { roughness: 0.75, emissive: col, emissiveIntensity: 0.12 }));
  if (s > 1.6) collide(m);
  return m;
}

function sweet(s) {
  const g = new THREE.Group();
  const [c1, c2] = CANDY[Math.floor(rand() * CANDY.length)];
  const body = mesh(new THREE.SphereGeometry(0.35 * s, 40, 24), std(0xffffff, { roughness: 0.2, map: stripeTex(c1, c2, 3) }), 0, 0.3 * s, 0, g);
  body.scale.set(1.3, 0.85, 0.85);
  const prof = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    prof.push(new THREE.Vector2(0.06 * s + 0.26 * s * t * t + 0.02 * s * Math.sin(t * 20), t * 0.35 * s));
  }
  const wrapMat = std(c2 === '#ffffff' ? c1 : c2, { roughness: 0.15, metalness: 0.2, side: THREE.DoubleSide, transparent: true, opacity: 0.9 });
  for (const sx of [-1, 1]) {
    const w = mesh(new THREE.LatheGeometry(prof, 48), wrapMat, sx * 0.4 * s, 0.3 * s, 0, g);
    w.rotation.z = (-sx * Math.PI) / 2;
  }
  g.rotation.y = rand() * Math.PI * 2;
  return g;
}

function buildCandy() {
  const kinds = [
    [lollipop, 14, () => 0.8 + rand() * 1.6, 0.9],
    [candyCane, 12, () => 0.7 + rand() * 1.1, 0.9],
    [gumdrop, 22, () => 0.6 + rand() * 2.2, 1.1],
    [sweet, 16, () => 0.8 + rand() * 1.2, 0.8],
  ];
  for (const [make, count, size, rad] of kinds) {
    for (let i = 0; i < count; i++) {
      const s = size();
      const spot = freeSpot(9, 47, rad * s);
      if (!spot) continue;
      placeOnGround(make(s), spot[0], spot[1]);
    }
  }
}

function buildTrees() {
  // Cotton-candy trees with striped candy trunks, and round bushes.
  const canopyCols = [0xffa6d6, 0xa8d8ff, 0xd3b4ff, 0xb5f5d0, 0xffd6a0];
  const ball = new THREE.SphereGeometry(1, 40, 24);
  for (let i = 0; i < 14; i++) {
    const spot = freeSpot(12, 46, 2.4, 3);
    if (!spot) continue;
    const g = new THREE.Group();
    const h = 3 + rand() * 2.5, bend = rand() * Math.PI * 2;
    const pts = [0, 0.35, 0.7, 1].map((t) => V(Math.cos(bend) * 0.5 * t * t, t * h, Math.sin(bend) * 0.5 * t * t));
    collide(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.22, 20),
      std(0xffffff, { map: stripeTex('#fff6ea', '#ff8fb8', Math.round(h * 1.5)), roughness: 0.4 }), 0, 0, 0, g));
    const col = canopyCols[i % canopyCols.length];
    const cm = std(col, { roughness: 1, emissive: col, emissiveIntensity: 0.15 });
    const top = pts[3];
    for (let k = 0; k < 5; k++) {
      const a = k * 1.3;
      const b = mesh(ball, cm, top.x + Math.cos(a) * 0.9, top.y + 0.4 + (k % 2) * 0.6, top.z + Math.sin(a) * 0.9, g);
      b.scale.setScalar(1.1 + rand() * 0.5);
    }
    placeOnGround(g, spot[0], spot[1], 0.1);
  }
  const bushMat = [0x4fd35a, 0x7fe35a].map((c) => std(c, { roughness: 0.9 }));
  for (let i = 0; i < 26; i++) {
    const spot = freeSpot(9, 47, 1, 1.2);
    if (!spot) continue;
    const g = new THREE.Group();
    for (let k = 0; k < 3; k++) {
      const b = mesh(ball, bushMat[(i + k) % 2], (k - 1) * 0.55, 0.35, (rand() - 0.5) * 0.4, g);
      b.scale.set(0.6 + rand() * 0.2, 0.5 + rand() * 0.2, 0.6);
    }
    g.rotation.y = rand() * 6.28;
    placeOnGround(g, spot[0], spot[1], 0.05);
  }
}

// ---------- the Fire Hydrant ----------
function buildHydrant() {
  const group = new THREE.Group();
  const body = new THREE.Group(); // bobs / squashes; group stays on the ground
  group.add(body);
  ctx.scene.add(group);

  // True colours here; the fade system washes them out according to how remembered he is.
  const red = std(0xe8262b, { emissive: 0x3a0505, roughness: 0.45 });
  const metal = std(0xd8c8b8, { metalness: 0.3, roughness: 0.4 });
  const eye = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
  const shine = new THREE.MeshBasicMaterial({ color: 0xffffff });
  red.userData.k = 1.6; metal.userData.k = 1.4; eye.userData.k = 2; shine.userData.k = 2;

  mesh(new THREE.CylinderGeometry(0.34, 0.36, 0.12, 48), metal, 0, 0.06, 0, body);
  mesh(new THREE.CylinderGeometry(0.24, 0.26, 0.64, 48), red, 0, 0.44, 0, body);
  mesh(new THREE.TorusGeometry(0.27, 0.035, 12, 48), metal, 0, 0.78, 0, body).rotation.x = Math.PI / 2;
  mesh(new THREE.SphereGeometry(0.245, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), red, 0, 0.78, 0, body);
  mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.1, 6), metal, 0, 1.06, 0, body);
  for (const s of [-1, 1]) {
    const n = mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.16, 32), metal, s * 0.3, 0.52, 0, body);
    n.rotation.z = Math.PI / 2;
    mesh(new THREE.SphereGeometry(0.048, 24, 16), eye, s * 0.085, 0.66, 0.225, body);
    mesh(new THREE.SphereGeometry(0.016, 12, 8), shine, s * 0.085 + 0.015, 0.68, 0.268, body);
  }
  const mouth = mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.12, 32), metal, 0, 0.47, 0.27, body);
  mouth.rotation.x = Math.PI / 2;

  const nozzle = new THREE.Object3D(); // spray comes out of the right-side nozzle (+x)
  nozzle.position.set(0.4, 0.52, 0);
  body.add(nozzle);

  const wisps = new Particles({ count: 60, color: 0xffb7ae, color2: 0xffffff, size: 0.07, gravity: -0.35 });
  const spray = new Particles({ count: 220, color: 0x7fd0ff, color2: 0xe8f8ff, size: 0.15, gravity: 9.8, drag: 0.6 });

  return {
    group, body, nozzle, wisps, spray,
    fade: makeFadable(group, REMEMBERED.hydrant),
    mode: 'manual',       // 'manual' | 'stay' (turn to face player) | 'follow'
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
      // Lost him (e.g. after a gust) — he pops back in from behind the player.
      g.position.set(p.x + Math.sin(player.yaw) * 2.5, 0, p.z + Math.cos(player.yaw) * 2.5);
      g.position.y = H(g.position.x, g.position.z);
    } else if (d > FOLLOW_DIST + 0.4) {
      const speed = Math.min(8, 2.5 + (d - FOLLOW_DIST) * 2);
      const step = Math.min(speed * dt, d - FOLLOW_DIST);
      g.position.x += (dx / d) * step;
      g.position.z += (dz / d) * step;
      moving = true;
    }
    g.position.y += (H(g.position.x, g.position.z) - g.position.y) * Math.min(1, dt * 15);
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

  // Wisps drift off him — the more forgotten, the faster he comes apart.
  h.wispT -= dt * (1 - h.fade.remembered) * 1.25;
  if (h.wispT <= 0) {
    h.wispT = 0.12;
    const a = Math.random() * 6.28;
    h.wisps.emit(V(g.position.x + Math.cos(a) * 0.25, g.position.y + h.body.position.y + 0.2 + Math.random() * 0.8, g.position.z + Math.sin(a) * 0.25),
      V(Math.cos(a) * 0.1, 0.3, Math.sin(a) * 0.1), 1.6);
  }

  const want = state === 'free' && !busy;
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
  const gy = H(0, 0);
  hydrant.group.position.set(0, gy, 0);
  hydrant.group.rotation.y = 0; // facing the player

  const eye = V(0, H(0, 2.6) + 1.6, 2.6);
  const look = V(0, gy + 0.75, 0);
  const face = V(0, gy + 0.64, 0.24);
  const from = V(0, gy + 0.66, 0.5);  // the globe's zoom ends right up against his face
  const tmpLook = V(0, 0, 0);

  // Pull back from his face to where the player is standing.
  camera.position.copy(from);
  camera.lookAt(face);
  [784, 659, 523].forEach((f, i) => setTimeout(() => alive(g) && audio.tone(f, 0.5, { volume: 0.07 }), i * 140));
  await tween(2.4, (k) => {
    const e = easeOut(k);
    camera.position.lerpVectors(from, eye, e);
    tmpLook.lerpVectors(face, look, e);
    camera.lookAt(tmpLook);
  });
  if (!alive(g)) return;

  // Don't start talking until the player is actually in the game (click-to-play overlay gone).
  while (!player.locked) {
    await wait(0.2);
    if (!alive(g)) return;
  }
  await wait(0.3);
  if (!alive(g)) return;

  const lines = INTRO.map((text) => ({ speaker: HYDRANT, color: HYDRANT_COLOR, text }));
  lines[0].onStart = () => {
    // Startled little hop.
    audio.tone(880, 0.15, { type: 'triangle', volume: 0.1 });
    tween(0.5, (k) => { hydrant.jumpY = Math.sin(k * Math.PI) * 0.35; }).then(() => { if (alive(g)) hydrant.mode = 'stay'; });
  };
  lines[4].onStart = () => {
    // "See how faded I am?" — he flickers almost out.
    tween(2.2, (k) => { hydrant.fade.dip = 1 - 0.65 * Math.sin(k * Math.PI); });
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

// ---------- the hydrant's ability ----------
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

// --- Skye the kite (air) — flies above the hill north-east of the meadow ---
function buildSkye() {
  const [ax, az] = HILLS[0];
  const g = new THREE.Group();
  g.position.set(ax, H(ax, az), az);
  g.rotation.y = Math.atan2(-ax, -az);
  ctx.scene.add(g);
  props.push([ax, az, 2.5]);
  mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.6, 16), std(0x8a6a4a), 0, 0.3, 0, g);

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
  mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.7, 12), spar, 0, -0.15, -0.03, kite);
  mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.7, 12), spar, 0, 0, -0.03, kite).rotation.z = Math.PI / 2;
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff }), black = new THREE.MeshBasicMaterial({ color: 0x111111 });
  for (const sx of [-1, 1]) {
    mesh(new THREE.SphereGeometry(0.13, 24, 16), white, sx * 0.24, 0.3, 0.03, kite).scale.z = 0.4;
    mesh(new THREE.SphereGeometry(0.065, 16, 12), black, sx * 0.24, 0.29, 0.08, kite).scale.z = 0.4;
  }
  const smile = mesh(new THREE.TorusGeometry(0.2, 0.03, 12, 32, Math.PI), black, 0, 0, 0.04, kite);
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
  skye.fade = makeFadable(g, REMEMBERED.kite);

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

// ---------- scene ----------
export default {
  name: NAME,

  init(c) {
    ctx = c;
    gen++;
    tasks = []; systems = []; fadables = []; pathPts = []; pathEnds = []; props = [[0, 0, 6]];
    time = 0; state = 'intro'; busy = false;
    rand = mulberry32(7);
    pxScale = (window.innerHeight * Math.min(window.devicePixelRatio, 2)) / (2 * Math.tan(THREE.MathUtils.degToRad(ctx.camera.fov / 2)));

    buildWorld();
    buildSkye();
    hydrant = buildHydrant();

    // TEMP exit until the masked figure (§9) is built: end of the north path.
    const [ex, ez] = pathEnds[0];
    const cube = mesh(new THREE.BoxGeometry(1, 1, 1), std(0x888888), ex, H(ex, ez) + 0.5, ez);
    collide(cube);
    ctx.interact.add(cube, () => ctx.goTo(NEXT));
    const tmp = makeLabel('TEMP → ending');
    tmp.position.set(ex, H(ex, ez) + 1.6, ez);
    ctx.scene.add(tmp);

    ctx.player.spawn(V(0, H(0, 2.6), 2.6), 0);
    intro(gen);
  },

  update(dt) {
    if (!ctx) return;
    time += dt;
    const run = tasks;
    tasks = [];
    for (const fn of run) if (fn(dt) !== false) tasks.push(fn);
    for (const s of systems) s.update(dt);
    updateHydrant(dt);
    updateFades();
  },

  dispose() {
    gen++;
    tasks = []; systems = []; fadables = [];
    for (const t of texCache.values()) t.dispose(); // base textures (clones are disposed with the scene)
    texCache.clear();
    hydrant = null;
    ctx = null;
  },
};
