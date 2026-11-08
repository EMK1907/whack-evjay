import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// Quirkland (Varshan) — docs/GAME.md §7–9.
// A child's imagination: soft rolling green hills, wobbly paths and candy everywhere. There is no sky —
// overhead is a bright patterned ceiling covered in identical big smiling mouths.
// Arrival: the globe transition zooms into the Fire Hydrant; the camera pulls back to the player standing
// right in front of him, and his intro cutscene plays. Afterwards he follows the player as a companion.
// Every character has a `remembered` value (0–1) that controls how faded / desaturated they look.
// Inhabitants so far (E): the Intergalactic Kangaroo, the Infernal, the Kite (Skye), the Rock Guardian,
// Water Girl and Tongue Guy.
// The Masked Figure (§9) stands at the end of the north path. The hydrant says "He's unfamiliar." the first time
// he's on screen; E → he removes his mask → the camera zooms into the ruby → goTo('ending').

const NAME = 'quirkland';
const NEXT = 'ending';
const HYDRANT = 'Fire Hydrant';
const HYDRANT_COLOR = '#ff9d92';
const FOLLOW_DIST = 2.2;
const PLAY_R = 34;              // compact walkable meadow radius
// The final clearing sits apart from the meadow, up a narrow valley to the north, behind a candy hedge.
const CLEAR_C = [0, -48], CLEAR_R = 8;
const CORRIDOR_W = 1.7;         // half-width of the valley path
const HEDGE_Z = -PLAY_R - 1;    // where the hedge blocks the valley
const NEEDED = 5;               // encounters needed before the hedge opens
const CEIL_R = 95, CEIL_H = 34; // ceiling dome (ellipsoid) radius / height
const MOUTH_SIZE = 5.5;

// How much children remember each character: 1 = bright and strong, 0 = gone.
const REMEMBERED = { hydrant: 0.2, kangaroo: 1.0, infernal: 0.9, kite: 0.85, rock: 0.6, water: 0.45, tongue: 0.3 };

// Where the inhabitants live (kept clear of candy and trees).
const SPOTS = {
  kangaroo: [21, 9], infernal: [-13, -18], kite: [15, -14],
  rock: [-19, 9], water: [-1, 23], tongue: [-25, -6],
  masked: [CLEAR_C[0], CLEAR_C[1] - 2], // the remote final clearing
};

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
let shake = 0;        // camera shake amount (decays)
let masked = null;
let hedge = null;
let met = new Set();  // inhabitants whose demo the player has watched
let unlocked = false; // hedge open → the clearing is reachable
let progressEl = null;
let onDebugKey = null;

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
const nextFrame = () => new Promise((resolve) => tasks.push((dt) => { resolve(dt); return false; }));
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

// ---------- terrain height ----------
const HILLS = [[15, -14, 3.6, 5.5], [-19, 9, 3.8, 6.5], [7, 20, 2.8, 5], [-13, -18, 3.4, 6], [21, 9, 2.8, 5.5], [-25, -6, 3, 5.5]];

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
  // Big rounded rim hills close the meadow in — except for the valley up to the clearing.
  const [cx, cz] = CLEAR_C;
  const dc = Math.hypot(x - cx, z - cz);
  const valley = Math.max(1 - smooth(CLEAR_R + 1, CLEAR_R + 6, dc),
    (1 - smooth(CORRIDOR_W + 1, CORRIDOR_W + 5, Math.abs(x))) * smooth(-10, -PLAY_R + 2, z) * (z > cz ? 1 : 0));
  return h + Math.pow(smooth(PLAY_R + 1, PLAY_R + 26, r), 1.4) * 34 * (1 - valley) + valley * 0.6;
}

// ---------- fading: remembered 0..1 → transparency + desaturation ----------
const _hsl = {};
function makeFadable(root, remembered) {
  const seen = new Set();
  const entries = [];
  root.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (seen.has(m) || !m.color || m.userData.noFade) continue;
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
  // Forgotten things fade like sun-bleached paint: paler and see-through, but still their own colour
  // (desaturating toward grey let the green grass show through and turned the red hydrant olive).
  const sat = 0.5 + 0.5 * r;
  const opacity = (0.35 + 0.65 * r) * flicker * rec.dip;
  for (const e of rec.entries) {
    e.color.getHSL(_hsl);
    e.m.color.setHSL(_hsl.h, _hsl.s * sat, _hsl.l + (1 - r) * 0.35 * Math.max(0, 0.78 - _hsl.l));
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
  key.position.set(25, 55, 18);
  key.castShadow = true; // soft grounding shadows across the whole play area
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.04;
  Object.assign(key.shadow.camera, { left: -44, right: 44, top: 60, bottom: -44, near: 1, far: 160 });
  key.shadow.camera.updateProjectionMatrix();
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

  buildClearing();
  buildHedge();
  // The edge of the walkable area is enforced in confinePlayer() (meadow + valley + clearing).
}

const _grey = new THREE.Color();
function buildTerrain() {
  // Split into chunks so the player's raycasts only test nearby triangles.
  const SIZE = 136, CHUNKS = 8, SEG = 32, cs = SIZE / CHUNKS;
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
        col.lerp(sun, smooth(2.5, 5, h) * (1 - smooth(PLAY_R - 2, PLAY_R + 10, r)) * 0.4);
        pastel.setHSL(((Math.atan2(z, x) / (Math.PI * 2)) + 1) % 1, 0.85, 0.8);
        col.lerp(pastel, smooth(PLAY_R - 2, PLAY_R + 20, r) * 0.85);
        // The clearing and its valley: drained of colour — nothing here was dreamed up by a child.
        const dcl = Math.hypot(x - CLEAR_C[0], z - CLEAR_C[1]);
        const drain = Math.max(1 - smooth(CLEAR_R - 2, CLEAR_R + 5, dcl), (1 - smooth(CORRIDOR_W, CORRIDOR_W + 4, Math.abs(x))) * smooth(-PLAY_R + 1, -PLAY_R - 6, z) * 0.7);
        col.lerp(_grey.setRGB(0.36, 0.38, 0.34), drain * 0.8);
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
        gl_FragColor = vec4(pow(col, vec3(2.2)) * 1.4, 1.0); // linear; unlit, so lifted to read bright under ACES
        #include <colorspace_fragment>
      }`,
  }));
  dome.scale.y = CEIL_H / CEIL_R;
  dome.userData.sky = true; // no shadows / SSAO from the ceiling
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
      g.userData.sky = true;
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
    const end = k === 0 ? PLAY_R - 1 : PLAY_R - 5; // the north path runs right up to the hedge
    for (let r = 7; r <= end; r += 3) {
      const wob = k === 0 ? 1 - smooth(PLAY_R - 12, PLAY_R - 4, r) : 1; // straightens into the valley
      const a = a0 + Math.sin(r * 0.17 + k * 2.1) * 0.3 * wob;
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    if (k === 0) for (let z = -PLAY_R - 4; z >= CLEAR_C[1] + 2; z -= 4) pts.push([0, z]); // valley → clearing
    wobblyPath(pts, { width: 2, seed: k * 3 + 2, wobble: k === 0 ? 0.15 : 0.25 });
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
    [lollipop, 10, () => 0.8 + rand() * 1.4, 0.9],
    [candyCane, 8, () => 0.7 + rand() * 1.0, 0.9],
    [gumdrop, 14, () => 0.6 + rand() * 1.9, 1.1],
    [sweet, 10, () => 0.8 + rand() * 1.1, 0.8],
  ];
  for (const [make, count, size, rad] of kinds) {
    for (let i = 0; i < count; i++) {
      const s = size();
      const spot = freeSpot(8, PLAY_R - 3, rad * s);
      if (!spot) continue;
      placeOnGround(make(s), spot[0], spot[1]);
    }
  }
}

function buildTrees() {
  // Cotton-candy trees with striped candy trunks, and round bushes.
  const canopyCols = [0xffa6d6, 0xa8d8ff, 0xd3b4ff, 0xb5f5d0, 0xffd6a0];
  const ball = new THREE.SphereGeometry(1, 40, 24);
  for (let i = 0; i < 9; i++) {
    const spot = freeSpot(10, PLAY_R - 3, 2.4, 3);
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
  for (let i = 0; i < 14; i++) {
    const spot = freeSpot(8, PLAY_R - 3, 1, 1.2);
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

// ---------- the remote clearing, the candy hedge and progression ----------
function buildClearing() {
  // Forgotten candy at the edge of the clearing: colourless, drooping, half sunk into the ground.
  const grey = std(0x8a8a86, { roughness: 0.9 });
  const stick = std(0x6e6e6a, { roughness: 0.9 });
  const disc = new THREE.CylinderGeometry(0.5, 0.5, 0.14, 48);
  const stem = new THREE.CylinderGeometry(0.04, 0.04, 1.4, 16);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.4;
    if (Math.abs(Math.sin(a) - 1) < 0.25) continue; // keep the valley mouth clear
    const x = CLEAR_C[0] + Math.cos(a) * (CLEAR_R - 1), z = CLEAR_C[1] + Math.sin(a) * (CLEAR_R - 1);
    const g = new THREE.Group();
    mesh(stem, stick, 0, 0.7, 0, g);
    const d = mesh(disc, grey, 0, 1.4, 0, g);
    d.rotation.x = Math.PI / 2;
    g.rotation.set((rand() - 0.5) * 0.9, rand() * 6.28, (rand() - 0.5) * 0.9);
    placeOnGround(g, x, z, 0.3);
  }
}

function buildHedge() {
  // A thick wall of cotton-candy puffs on a striped candy-cane frame, plugging the valley.
  const half = CORRIDOR_W + 3.2;
  const puffs = [];
  for (let row = 0; row < 3; row++) {
    for (let x = -half; x <= half; x += 0.85) {
      const jx = x + (rand() - 0.5) * 0.3, z = HEDGE_Z + (row - 1) * 0.55 + (rand() - 0.5) * 0.2;
      const r = 0.7 + rand() * 0.35;
      const y = H(jx, z) + 0.5 + row * 0.1 + rand() * 0.2;
      puffs.push({ x: jx, y, z, r, top: false });
      if (rand() < 0.85) puffs.push({ x: jx + 0.2, y: y + 1.05 + rand() * 0.3, z, r: r * 0.85, top: true });
    }
  }
  const cols = [0xffa6d6, 0xffffff, 0xffc4e6, 0xd8b8ff];
  const inst = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 32, 20), std(0xffffff, { roughness: 1 }), puffs.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = V(0, 0, 0), c = new THREE.Color();
  puffs.forEach((p, i) => {
    inst.setMatrixAt(i, m4.compose(V(p.x, p.y, p.z), q, sc.setScalar(p.r)));
    inst.setColorAt(i, c.setHex(cols[i % cols.length]));
  });
  ctx.scene.add(inst);
  // Candy-cane posts poking out of it.
  const posts = [];
  for (let k = -2; k <= 2; k++) {
    const x = k * (half / 2.3);
    const post = mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.8, 24),
      std(0xffffff, { map: stripeTex('#ffffff', '#ff2d4a', 5), roughness: 0.3 }), x, H(x, HEDGE_Z) + 1.3, HEDGE_Z);
    posts.push(post);
  }
  const blocker = mesh(new THREE.BoxGeometry(half * 2, 6, 2.2), new THREE.MeshBasicMaterial(), 0, H(0, HEDGE_Z) + 3, HEDGE_Z);
  blocker.visible = false;
  collide(blocker);
  hedge = { inst, puffs, posts, blocker, open: false };
}

function openHedge() {
  if (!hedge || hedge.open) return;
  hedge.open = true;
  unlocked = true;
  updateProgress();
  ctx.player.colliders = ctx.player.colliders.filter((o) => o !== hedge.blocker);
  const { audio } = ctx;
  [523, 659, 784, 1047, 1319].forEach((f, i) => setTimeout(() => ctx && audio.tone(f, 0.5, { type: 'triangle', volume: 0.06 }), i * 120));
  audio.noise(0.8, { volume: 0.06 });
  const sparkle = new Particles({ count: 200, color: 0xffffff, color2: 0xffa6d6, size: 0.12, gravity: -0.6, drag: 0.8 });
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = V(0, 0, 0), pos = V(0, 0, 0);
  // The hedge parts down the middle like curtains and shrinks back into the hillsides.
  tween(2.2, (t) => {
    const e = ease(t);
    hedge.puffs.forEach((p, i) => {
      const side = p.x === 0 ? 1 : Math.sign(p.x);
      pos.set(p.x + side * e * 5, p.y - e * 0.6, p.z);
      hedge.inst.setMatrixAt(i, m4.compose(pos, q, sc.setScalar(Math.max(0.0001, p.r * (1 - e * 0.95)))));
      if (Math.random() < 0.03) sparkle.emit(pos, V((Math.random() - 0.5) * 2, 1 + Math.random() * 2, (Math.random() - 0.5) * 2), 1.2);
    });
    hedge.inst.instanceMatrix.needsUpdate = true;
    hedge.posts.forEach((post) => { post.scale.y = Math.max(0.0001, 1 - e); post.position.y -= 0.002; });
  }).then(() => { if (hedge) { hedge.inst.visible = false; hedge.posts.forEach((p) => { p.visible = false; }); } });
}

function updateProgress() {
  if (!progressEl) return;
  progressEl.style.opacity = state === 'free' ? '1' : '0';
  progressEl.textContent = unlocked ? 'The candy hedge to the north has opened' : `Inhabitants met: ${Math.min(met.size, NEEDED)} / ${NEEDED}`;
  if (unlocked) setTimeout(() => { if (progressEl) progressEl.style.opacity = '0'; }, 5000);
}

// Keep the player inside the meadow, the valley and the clearing (the rim hills are too steep anyway).
const _lastOk = V(0, 0, 0);
function allowed(x, z) {
  if (Math.hypot(x, z) <= PLAY_R) return true;
  if (Math.abs(x) <= CORRIDOR_W && z <= -PLAY_R + 3 && z >= CLEAR_C[1]) return true;
  return Math.hypot(x - CLEAR_C[0], z - CLEAR_C[1]) <= CLEAR_R;
}
function confinePlayer() {
  const p = ctx.player.position;
  if (!ctx.player.enabled || allowed(p.x, p.z)) { _lastOk.copy(p); return; }
  if (allowed(p.x, _lastOk.z)) p.z = _lastOk.z;
  else if (allowed(_lastOk.x, p.z)) p.x = _lastOk.x;
  else { p.x = _lastOk.x; p.z = _lastOk.z; }
}

// ---------- the Fire Hydrant ----------
function buildHydrant() {
  const group = new THREE.Group();
  const body = new THREE.Group(); // bobs / squashes; group stays on the ground
  group.add(body);
  ctx.scene.add(group);

  // Same design as the mini hydrant on the globe (inverted.js makeHydrant) — he's the same character —
  // scaled up to ~1.1 m. True colours here; the fade system washes them out by how remembered he is.
  const K = 4.6;
  const red = std(0xd62a1e, { roughness: 0.42, metalness: 0.1 });
  const darkRed = std(0xa81d14, { roughness: 0.5, metalness: 0.1 });
  const white = std(0xffffff, { roughness: 0.3 });
  const black = std(0x141414, { roughness: 0.25 });
  const cheekMat = std(0xff7a7a, { roughness: 0.6 });
  red.userData.k = darkRed.userData.k = 1.9; // clearly red, but you can still just see through him
  white.userData.k = black.userData.k = 2.2;
  cheekMat.userData.k = 2;

  const model = new THREE.Group(); // built facing +X like the mini hydrant, then turned to face +Z
  model.rotation.y = -Math.PI / 2;
  model.scale.setScalar(K);
  body.add(model);
  const add = (geo, mat, x, y, z, rx = 0, rz = 0) => {
    const m = mesh(geo, mat, x, y, z, model);
    m.rotation.set(rx, 0, rz);
    return m;
  };
  const PI = Math.PI;
  add(new THREE.CylinderGeometry(0.06, 0.064, 0.016, 48), darkRed, 0, 0.008, 0);              // base flange
  add(new THREE.CylinderGeometry(0.045, 0.048, 0.14, 48), red, 0, 0.086, 0);                  // barrel
  add(new THREE.CylinderGeometry(0.055, 0.055, 0.016, 48), darkRed, 0, 0.16, 0);             // top ring
  add(new THREE.SphereGeometry(0.05, 48, 24, 0, PI * 2, 0, PI / 2), red, 0, 0.168, 0);        // dome cap
  add(new THREE.CylinderGeometry(0.012, 0.014, 0.022, 6), darkRed, 0, 0.226, 0);             // bonnet nut
  for (const s of [-1, 1]) {                                                                   // side outlets
    add(new THREE.CylinderGeometry(0.016, 0.016, 0.03, 32), red, 0, 0.11, s * 0.055, PI / 2);
    add(new THREE.CylinderGeometry(0.02, 0.02, 0.008, 6), darkRed, 0, 0.11, s * 0.072, PI / 2);
  }
  add(new THREE.CylinderGeometry(0.02, 0.02, 0.026, 32), red, -0.055, 0.1, 0, 0, PI / 2);    // rear pumper outlet

  // Big friendly face on the front.
  for (const s of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(0.042, 0.128, s * 0.018);
    model.add(eye);
    mesh(new THREE.SphereGeometry(0.012, 32, 24), white, 0, 0, 0, eye);
    mesh(new THREE.SphereGeometry(0.0065, 24, 16), black, 0.008, -0.001, 0, eye);
    mesh(new THREE.SphereGeometry(0.0022, 12, 8), white, 0.0135, 0.002, -0.002, eye);
    const cheek = add(new THREE.SphereGeometry(0.007, 24, 16), cheekMat, 0.045, 0.106, s * 0.03); // rosy cheeks
    cheek.scale.set(0.4, 0.7, 1);
  }
  const smile = add(new THREE.TorusGeometry(0.014, 0.0025, 12, 32, PI), black, 0.046, 0.1, 0);
  smile.rotation.set(0, PI / 2, PI); // lower half-circle, facing +X

  const nozzle = new THREE.Object3D(); // spray comes out of the side outlet that ends up on his right (+x)
  nozzle.position.set(0, 0.11, -0.085);
  model.add(nozzle);

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
  if (h.watch) {
    // Staring at something (the masked figure).
    g.rotation.y = lerpAngle(g.rotation.y, Math.atan2(h.watch.x - g.position.x, h.watch.z - g.position.z), 1 - Math.exp(-dt * 6));
  } else if (h.mode !== 'manual' && d > 0.01) {
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
  const face = V(0, gy + 0.58, 0.2);
  const from = V(0, gy + 0.6, 0.48);  // the globe's zoom ends right up against his face
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
  updateProgress();
}

// ---------- the hydrant's ability ----------
async function hydrantAbility() {
  if (busy || state !== 'free') return;
  busy = true;
  ctx.interact.enabled = false;
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
  ctx.interact.enabled = true;
  busy = false;
}

// ---------- inhabitants ----------
// Each one: E → their line → ability demo → the Fire Hydrant reacts.
async function meet(who) {
  if (busy || state !== 'free') return;
  busy = true;
  ctx.interact.enabled = false; // no "Press E" prompt while a demo plays
  const g = gen;
  await faceToward(who.group, ctx.player.position, 0.4);
  if (!alive(g)) return;
  await ctx.dialogue.say(who.line, { speaker: who.name, color: who.color });
  if (!alive(g)) return;
  await who.ability(g);
  if (!alive(g)) return;
  await ctx.dialogue.say(who.reaction, { speaker: HYDRANT, color: HYDRANT_COLOR });
  if (!alive(g)) return;
  ctx.interact.enabled = true;
  busy = false;
  if (!met.has(who.name)) {
    met.add(who.name);
    updateProgress();
    if (met.size >= NEEDED) openHedge();
  }
}

function faceToward(obj, p, sec) {
  const r0 = obj.rotation.y;
  const r1 = Math.atan2(p.x - obj.position.x, p.z - obj.position.z);
  return tween(sec, (k) => { obj.rotation.y = lerpAngle(r0, r1, ease(k)); });
}

// Tube whose radius tapers from r0 to r1 along the curve (horns, tails).
function taperTube(curve, T, r0, r1, R = 16) {
  const geo = new THREE.TubeGeometry(curve, T, 1, R, false);
  const pos = geo.attributes.position;
  const c = V(0, 0, 0), v = V(0, 0, 0);
  for (let i = 0; i <= T; i++) {
    curve.getPointAt(i / T, c);
    const r = r0 + (r1 - r0) * (i / T);
    for (let j = 0; j <= R; j++) {
      const idx = i * (R + 1) + j;
      v.fromBufferAttribute(pos, idx).sub(c).multiplyScalar(r);
      pos.setXYZ(idx, c.x + v.x, c.y + v.y, c.z + v.z);
    }
  }
  geo.computeVertexNormals();
  return geo;
}

function standAt([x, z]) {
  const g = new THREE.Group();
  g.position.set(x, H(x, z), z);
  g.rotation.y = Math.atan2(-x, -z); // face the middle of the world
  ctx.scene.add(g);
  return g;
}

// ===== 1. The Intergalactic Kangaroo (remembered 1.0) =====
const GALAXY_VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
const GALAXY_FRAG = `
  uniform float time; varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float a = atan(p.y, p.x);
    float arms = pow(0.5 + 0.5 * sin(a * 3.0 + log(r + 0.05) * 6.0 - time * 4.0), 3.0);
    vec3 col = mix(vec3(0.03, 0.01, 0.1), mix(vec3(0.5, 0.15, 0.9), vec3(0.2, 0.75, 1.0), r), arms * (1.0 - r * 0.5));
    col += vec3(1.0, 0.85, 1.0) * exp(-r * 6.0) * 1.6;
    vec2 g = vec2(a * 8.0 - time * 1.5 + r * 4.0, r * 22.0);
    float star = step(0.86, hash(floor(g))) * smoothstep(0.14, 0.0, length(fract(g) - 0.5));
    col += star;
    col += vec3(0.7, 0.45, 1.0) * smoothstep(0.72, 0.98, r) * 1.3;
    gl_FragColor = vec4(pow(col, vec3(2.2)), smoothstep(1.0, 0.93, r)); // linear HDR: the bright core blooms
    #include <colorspace_fragment>
  }`;

function makePortal(mat) {
  const p = new THREE.Group();
  mesh(new THREE.CircleGeometry(1, 96), mat, 0, 0, 0, p);
  mesh(new THREE.TorusGeometry(1, 0.045, 16, 96), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xc9a6ff).multiplyScalar(2.5), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }), 0, 0, 0, p);
  p.scale.setScalar(0.0001);
  p.visible = false;
  ctx.scene.add(p);
  return p;
}

function buildKangaroo() {
  const g = standAt(SPOTS.kangaroo);
  const suit = std(0x1b2a6b, { roughness: 0.4, metalness: 0.15 });
  const dark = std(0x0d0d18, { roughness: 0.35, metalness: 0.2 });
  const fur = std(0xc9773c, { roughness: 0.85 });
  const furLight = std(0xf3cfa0, { roughness: 0.85 });
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const pupil = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const gold = std(0xffd23f, { emissive: 0xffb000, emissiveIntensity: 0.8, roughness: 0.3, metalness: 0.4 });
  const ball = new THREE.SphereGeometry(1, 48, 32);

  const body = new THREE.Group();
  g.add(body);
  const torso = mesh(ball, suit, 0, 1.45, 0, body);
  torso.scale.set(0.5, 0.75, 0.45);
  torso.rotation.x = 0.15;
  mesh(ball, dark, 0, 1.33, 0.13, body).scale.set(0.36, 0.52, 0.34);
  // Chest emblem: a little gold star.
  const starShape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 0.42 : 1;
    i ? starShape.lineTo(Math.cos(a) * r, Math.sin(a) * r) : starShape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const emblem = mesh(new THREE.ExtrudeGeometry(starShape, { depth: 0.15, bevelEnabled: true, bevelSize: 0.12, bevelThickness: 0.1, bevelSegments: 6, curveSegments: 12 }),
    gold, 0, 1.68, 0.42, body);
  emblem.scale.setScalar(0.13);
  emblem.rotation.x = 0.15;

  // Cape.
  const cape = mesh(new THREE.CylinderGeometry(0.4, 0.62, 1.3, 48, 8, true, Math.PI / 2, Math.PI),
    std(0x101a4a, { side: THREE.DoubleSide, roughness: 0.5 }), 0, 1.45, -0.08, body);

  // Head, with a black superhero mask across the eyes.
  const headG = new THREE.Group();
  headG.position.set(0, 2.22, 0.12);
  body.add(headG);
  const head = mesh(ball, fur, 0, 0, 0, headG);
  head.scale.set(0.28, 0.3, 0.3);
  mesh(new THREE.SphereGeometry(1.05, 48, 16, 0, Math.PI * 2, 1.12, 0.42), dark, 0, 0, 0, head);
  for (const sx of [-1, 1]) {
    mesh(new THREE.SphereGeometry(0.19, 24, 16), white, sx * 0.4, 0.17, 0.86, head);
    mesh(new THREE.SphereGeometry(0.09, 16, 12), pupil, sx * 0.4, 0.17, 1.03, head);
    const ear = mesh(ball, fur, sx * 0.12, 0.3, -0.02, headG);
    ear.scale.set(0.07, 0.21, 0.045);
    ear.rotation.z = -sx * 0.25;
    const inner = mesh(ball, furLight, 0, 0, 0.5, ear);
    inner.scale.set(0.6, 0.8, 0.4);
    const tie = mesh(new THREE.CapsuleGeometry(0.03, 0.22, 8, 16), dark, sx * 0.07, 0.04, -0.32, headG);
    tie.rotation.set(-0.9, 0, sx * 0.5); // mask ties flutter at the back
  }
  mesh(ball, furLight, 0, -0.08, 0.24, headG).scale.set(0.16, 0.13, 0.22);
  mesh(new THREE.SphereGeometry(0.05, 16, 12), pupil, 0, -0.02, 0.45, headG);

  // Arms with black gloves.
  for (const sx of [-1, 1]) {
    const arm = mesh(new THREE.CapsuleGeometry(0.07, 0.34, 10, 20), suit, sx * 0.3, 1.66, 0.3, body);
    arm.rotation.set(1.0, 0, sx * 0.2);
    mesh(new THREE.SphereGeometry(0.09, 24, 16), dark, sx * 0.32, 1.48, 0.48, body);
  }

  // Tail.
  const tailCurve = new THREE.CatmullRomCurve3([V(0, 1.15, -0.32), V(0, 0.7, -0.8), V(0, 0.2, -1.25), V(0, 0.08, -1.75)]);
  mesh(taperTube(tailCurve, 48, 0.17, 0.06), suit, 0, 0, 0, body);

  // Legs (pivot at the hip) with big black boots.
  const legs = [], boots = [];
  for (const sx of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(sx * 0.28, 1.0, -0.05);
    body.add(hip);
    mesh(ball, suit, 0, -0.05, 0.05, hip).scale.set(0.22, 0.38, 0.32);
    const shin = mesh(new THREE.CapsuleGeometry(0.08, 0.5, 10, 20), suit, 0, -0.5, -0.12, hip);
    shin.rotation.x = 0.45;
    const boot = mesh(new THREE.CapsuleGeometry(0.1, 0.42, 12, 24), dark, 0, -0.86, 0.12, hip);
    boot.rotation.x = Math.PI / 2;
    legs.push(hip);
    boots.push(boot);
  }
  const footTip = new THREE.Object3D();
  footTip.position.set(0.28, -0.86, 0.42); // between the two boot tips (left hip is at x -0.28)
  legs[0].add(footTip);

  const twinkles = new Particles({ count: 60, color: 0xffffff, color2: 0xa98bff, size: 0.06 });

  // Portals + the foot that comes out of the second one.
  const galaxy = new THREE.ShaderMaterial({ uniforms: { time: { value: 0 } }, vertexShader: GALAXY_VERT, fragmentShader: GALAXY_FRAG, transparent: true, side: THREE.DoubleSide });
  const portalA = makePortal(galaxy), portalB = makePortal(galaxy);
  const ghost = new THREE.Group();
  portalB.add(ghost);
  mesh(new THREE.CapsuleGeometry(0.1, 0.42, 12, 24).rotateX(Math.PI / 2), dark, 0, 0, 0, ghost);
  mesh(new THREE.CapsuleGeometry(0.085, 0.7, 10, 20).rotateX(Math.PI / 2), suit, 0, 0.03, -0.6, ghost);
  const sole = mesh(new THREE.ExtrudeGeometry(starShape, { depth: 0.05, bevelEnabled: true, bevelSize: 0.08, bevelThickness: 0.05, bevelSegments: 4, curveSegments: 12 }), gold, 0, 0, 0.3, ghost);
  sole.scale.setScalar(0.06);
  ghost.scale.setScalar(1 / 0.55); // portal B opens to 0.55, keep the foot full size
  ghost.visible = false;
  const swirl = new Particles({ count: 200, color: 0xd9c2ff, color2: 0x4fc3ff, size: 0.07 });

  const roo = {
    name: 'Intergalactic Kangaroo', color: '#8fb4ff', group: g,
    line: 'A kangaroo superhero from outer space! Kids draw me on every school book, every single day. Nobody forgets me — watch this!',
    reaction: 'He does that to everyone. I still flinch every time.',
    ability: (gg) => kangarooKick(roo, gg),
    body, legs, boots, footTip, portalA, portalB, ghost, swirl, kicking: false,
  };
  roo.fade = makeFadable(g, REMEMBERED.kangaroo);

  let tw = 0;
  every((dt) => {
    galaxy.uniforms.time.value = time;
    cape.rotation.x = 0.06 + Math.sin(time * 1.7) * 0.05;
    if (!roo.kicking) {
      // Springy little idle hops.
      const hop = Math.pow(Math.max(0, Math.sin(time * 2.4)), 2);
      body.position.y = hop * 0.22;
      for (const l of legs) { l.rotation.x = -hop * 0.25; l.scale.y = 1; }
    }
    headG.rotation.z = Math.sin(time * 0.9) * 0.06;
    tw -= dt;
    if (tw <= 0) {
      tw = 0.12;
      const a = Math.random() * 6.28;
      twinkles.emit(V(g.position.x + Math.cos(a) * 0.9, g.position.y + 0.5 + Math.random() * 2, g.position.z + Math.sin(a) * 0.9), V(0, 0.2, 0), 1.2);
    }
    for (const p of [portalA, portalB]) {
      if (!p.visible) continue;
      p.children[0].rotation.z += dt * 2;
      const s = p.scale.x;
      if (Math.random() < 0.7) {
        const a = Math.random() * 6.28;
        const o = V(Math.cos(a) * s, Math.sin(a) * s, 0).applyQuaternion(p.quaternion).add(p.position);
        const v = V(-Math.sin(a), Math.cos(a), 0).multiplyScalar(1.5).applyQuaternion(p.quaternion);
        swirl.emit(o, v, 0.5);
      }
    }
  });

  ctx.interact.add(g, () => meet(roo), { distance: 7 });
  return roo;
}

async function kangarooKick(k, g) {
  const { player, camera, audio } = ctx;
  player.enabled = false; // hold the camera still so the foot lands right in front of it
  // Cartoon jump-kick: a little hop, lean back, legs swing forward and stretch out.
  const pose = (lean, kick) => {
    const ext = Math.max(0, kick / 1.5);
    k.body.rotation.x = -lean;
    k.body.position.y = 0.3 * ext;
    for (const l of k.legs) { l.rotation.x = -kick; l.scale.y = 1 + 0.4 * ext; }
  };
  k.kicking = true;

  // Turn side-on so the player can see the kick (and portal A) in profile.
  const toP = Math.atan2(player.position.x - k.group.position.x, player.position.z - k.group.position.z);
  const r0 = k.group.rotation.y;
  await tween(0.4, (t) => { k.group.rotation.y = lerpAngle(r0, toP + Math.PI / 2, ease(t)); });
  if (!alive(g)) return;

  // Portal A goes exactly where his feet will be at full extension.
  pose(0.15, 1.5);
  k.group.updateMatrixWorld(true);
  const tipA = V(0, 0, 0);
  k.footTip.getWorldPosition(tipA);
  const startPose = { lean: 0, kick: -k.legs[0].rotation.x };
  pose(0, startPose.kick);
  k.portalA.position.copy(tipA);
  // Face it halfway between the kangaroo and the player so it reads as a disc, not edge-on.
  const look = V(k.group.position.x - tipA.x, 0, k.group.position.z - tipA.z).normalize()
    .add(V(player.position.x - tipA.x, 0, player.position.z - tipA.z).normalize()).normalize();
  k.portalA.lookAt(tipA.x + look.x, tipA.y, tipA.z + look.z);
  k.portalA.visible = true;

  // Portal B opens right in front of the player's face.
  const camPos = camera.position.clone();
  const fwd = V(0, 0, -1).applyQuaternion(camera.quaternion);
  k.portalB.position.copy(camPos).addScaledVector(fwd, 1.35);
  k.portalB.lookAt(camPos);

  audio.tone(440, 0.6, { type: 'sine', volume: 0.08 });
  audio.tone(660, 0.6, { type: 'sine', volume: 0.05 });
  await tween(0.5, (t) => { k.portalA.scale.setScalar(Math.max(0.0001, 0.7 * easeOut(t))); });
  if (!alive(g)) return;

  // Wind up: lean back onto the tail and tuck the legs.
  await tween(0.45, (t) => pose(0.15 * ease(t), startPose.kick + (-0.4 - startPose.kick) * ease(t)));
  if (!alive(g)) return;

  k.portalB.visible = true;
  tween(0.2, (t) => { k.portalB.scale.setScalar(Math.max(0.0001, 0.55 * easeOut(t))); });
  await tween(0.17, (t) => pose(0.15, -0.4 + 1.9 * easeOut(t)));
  if (!alive(g)) return;

  // Feet vanish into portal A... and burst out of portal B.
  for (const b of k.boots) b.visible = false;
  audio.tone(70, 0.45, { type: 'sine', volume: 0.35 });
  audio.noise(0.3, { volume: 0.25 });
  k.ghost.visible = true;
  k.ghost.position.z = -1.6;
  await tween(0.14, (t) => { k.ghost.position.z = -1.6 + 2.65 * easeOut(t); });
  if (!alive(g)) return;
  await tween(0.4, (t) => {
    const a = (1 - t) * 0.05;
    camera.position.set(camPos.x + (Math.random() - 0.5) * a, camPos.y + (Math.random() - 0.5) * a, camPos.z + (Math.random() - 0.5) * a);
  });
  if (!alive(g)) return;
  camera.position.copy(camPos);
  await wait(0.35);
  if (!alive(g)) return;

  await tween(0.3, (t) => { k.ghost.position.z = 1.05 - 2.65 * ease(t); });
  if (!alive(g)) return;
  k.ghost.visible = false;
  for (const b of k.boots) b.visible = true;
  tween(0.35, (t) => { k.portalB.scale.setScalar(Math.max(0.0001, 0.55 * (1 - ease(t)))); });
  await tween(0.45, (t) => pose(0.15 * (1 - ease(t)), 1.5 * (1 - ease(t))));
  if (!alive(g)) return;
  await tween(0.35, (t) => { k.portalA.scale.setScalar(Math.max(0.0001, 0.7 * (1 - ease(t)))); });
  if (!alive(g)) return;
  k.portalA.visible = k.portalB.visible = false;
  k.kicking = false;
  player.enabled = true;
  await faceToward(k.group, player.position, 0.4);
}

// ===== 2. The Infernal (remembered 0.9) =====
function crackTex() {
  return canvasTex('cracks', (g, s) => {
    g.fillStyle = '#160907';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 260; i++) {
      g.fillStyle = `rgba(${40 + Math.floor(rand() * 30)},${14 + Math.floor(rand() * 10)},10,0.5)`;
      g.beginPath();
      g.arc(rand() * s, rand() * s, 4 + rand() * 18, 0, Math.PI * 2);
      g.fill();
    }
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.shadowColor = '#ff6a00';
    g.shadowBlur = 14;
    for (let c = 0; c < 30; c++) {
      let x = rand() * s, y = rand() * s, a = rand() * 6.28;
      g.strokeStyle = rand() < 0.5 ? '#ff7a1a' : '#ffc04d';
      g.lineWidth = 1.5 + rand() * 3.5;
      g.beginPath();
      g.moveTo(x, y);
      for (let k = 0; k < 12; k++) {
        a += (rand() - 0.5) * 1.2;
        x += Math.cos(a) * 14; y += Math.sin(a) * 14;
        g.lineTo(x, y);
      }
      g.stroke();
    }
  }, 512);
}

function buildInfernal() {
  const g = standAt(SPOTS.infernal);
  const cracks = crackTex();
  cracks.wrapS = cracks.wrapT = THREE.RepeatWrapping;
  const skin = std(0xffffff, { map: cracks, emissive: 0xffffff, emissiveMap: cracks, emissiveIntensity: 1.2, roughness: 0.85 });
  const horn = std(0x1a0f0c, { roughness: 0.5, emissive: 0x3a0a00, emissiveIntensity: 0.6 });
  const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe36b).multiplyScalar(3) });   // HDR → blooms
  const molten = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff7a1a).multiplyScalar(3) });
  glow.userData.noFade = molten.userData.noFade = true;
  const ball = new THREE.SphereGeometry(1, 48, 32);

  const body = new THREE.Group();
  g.add(body);
  const prof = [[0.0, 1.2], [0.32, 1.24], [0.38, 1.5], [0.5, 1.9], [0.64, 2.25], [0.58, 2.5], [0.3, 2.7], [0.0, 2.74]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  mesh(new THREE.LatheGeometry(new THREE.SplineCurve(prof).getPoints(40), 64), skin, 0, 0, 0, body).scale.z = 0.72;
  mesh(ball, skin, 0, 1.25, 0, body).scale.set(0.36, 0.25, 0.28);
  mesh(ball, molten, 0, 2.05, 0.3, body).scale.set(0.09, 0.09, 0.05); // molten heart

  for (const sx of [-1, 1]) {
    mesh(new THREE.CapsuleGeometry(0.17, 0.75, 12, 24), skin, sx * 0.22, 0.62, 0, body);
    mesh(ball, horn, sx * 0.22, 0.1, 0.08, body).scale.set(0.18, 0.12, 0.28);
  }

  const arms = [], hands = [];
  for (const sx of [-1, 1]) {
    mesh(ball, skin, sx * 0.64, 2.38, 0, body).scale.setScalar(0.26);
    const arm = new THREE.Group();
    arm.position.set(sx * 0.66, 2.38, 0);
    arm.rotation.z = sx * 0.22;
    body.add(arm);
    mesh(new THREE.CapsuleGeometry(0.13, 0.5, 12, 24), skin, 0, -0.38, 0, arm);
    mesh(new THREE.CapsuleGeometry(0.12, 0.48, 12, 24), skin, 0, -0.95, 0.04, arm);
    mesh(ball, skin, 0, -1.32, 0.07, arm).scale.setScalar(0.15);
    for (let c = -1; c <= 1; c++) {
      const claw = mesh(new THREE.ConeGeometry(0.035, 0.16, 16), horn, c * 0.06, -1.48, 0.1, arm);
      claw.rotation.x = Math.PI + 0.3;
    }
    const hand = new THREE.Object3D();
    hand.position.set(0, -1.38, 0.12);
    arm.add(hand);
    arms.push(arm);
    hands.push(hand);
  }

  const headG = new THREE.Group();
  headG.position.set(0, 2.98, 0.05);
  body.add(headG);
  mesh(ball, skin, 0, 0, 0, headG).scale.set(0.3, 0.32, 0.3);
  mesh(ball, skin, 0, -0.18, 0.1, headG).scale.set(0.23, 0.14, 0.21);
  for (const sx of [-1, 1]) {
    const eye = mesh(ball, glow, sx * 0.11, 0.04, 0.26, headG);
    eye.scale.set(0.06, 0.035, 0.03);
    eye.rotation.z = sx * -0.35;
    const hc = new THREE.CatmullRomCurve3([V(sx * 0.18, 0.15, 0), V(sx * 0.4, 0.35, -0.05), V(sx * 0.47, 0.66, -0.2), V(sx * 0.38, 0.92, -0.36)]);
    mesh(taperTube(hc, 40, 0.085, 0.012), horn, 0, 0, 0, headG);
  }
  const mouth = mesh(new THREE.CapsuleGeometry(0.025, 0.14, 8, 16), molten, 0, -0.18, 0.3, headG);
  mouth.rotation.z = Math.PI / 2;

  const light = new THREE.PointLight(0xff7a2a, 6, 12, 1.5);
  light.position.set(0, 2.2, 0.8);
  g.add(light);

  const flames = new Particles({ count: 300, color: 0xffd04a, color2: 0xff3000, size: 0.2, grow: 1.2, gravity: -2.5, drag: 0.8 });
  const fire = new Particles({ count: 1400, color: 0xffb030, color2: 0xc81800, size: 0.3, grow: 2, gravity: -0.6, drag: 0.35 });
  const core = new Particles({ count: 600, color: 0xfff0b0, color2: 0xff7a00, size: 0.2, grow: 0.8, additive: true, drag: 0.2 });
  const smoke = new Particles({ count: 200, color: 0x4a3a36, color2: 0x9a8f8c, size: 0.5, grow: 3, gravity: -1.2, drag: 0.5 });

  const inf = {
    name: 'The Infernal', color: '#ff7a2f', group: g,
    line: 'Every child who\'s scared of the dark keeps my fire burning. Fear is the one thing they never forget.',
    reaction: 'I\'m supposed to put that out. I... really can\'t.',
    ability: (gg) => infernalFire(inf, gg),
    body, arms, hands, skin, light, fire, core, smoke, flames, charging: 0,
  };
  inf.fade = makeFadable(g, REMEMBERED.infernal);

  const hp = V(0, 0, 0);
  every((dt) => {
    const b = 1 + Math.sin(time * 1.6) * 0.02;
    body.scale.set(b, 1, b);
    skin.emissiveIntensity = 1.1 + Math.sin(time * 2.1) * 0.3 + inf.charging * 1.2;
    light.intensity = 5 + Math.sin(time * 13) * 0.8 + Math.sin(time * 7.3) * 0.6 + inf.charging * 10;
    // Flames licking off his head and shoulders.
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * 6.28;
      const src = Math.random() < 0.5 ? V(Math.cos(a) * 0.2, 3.15, Math.sin(a) * 0.2) : V((Math.random() < 0.5 ? -1 : 1) * 0.64, 2.55, (Math.random() - 0.5) * 0.3);
      src.applyMatrix4(body.matrixWorld);
      flames.emit(src, V((Math.random() - 0.5) * 0.4, 1 + Math.random(), (Math.random() - 0.5) * 0.4), 0.6 + Math.random() * 0.4, 0.15 + Math.random() * 0.12);
    }
    if (inf.charging > 0) {
      // Fire gathering in his hands.
      for (const h of hands) {
        h.getWorldPosition(hp);
        const a = Math.random() * 6.28, e = Math.random() * 3.14;
        const off = V(Math.cos(a) * Math.sin(e), Math.cos(e), Math.sin(a) * Math.sin(e)).multiplyScalar(0.9);
        flames.emit(V(hp.x + off.x, hp.y + off.y, hp.z + off.z), off.multiplyScalar(-2.2), 0.4, 0.14);
      }
    }
  });

  ctx.interact.add(g, () => meet(inf), { distance: 7 });
  return inf;
}

async function infernalFire(f, g) {
  const { audio } = ctx;
  const r0 = f.arms.map((a) => ({ x: a.rotation.x, z: a.rotation.z }));
  // Raise both hands forward and gather the fire.
  f.charging = 0;
  await tween(0.8, (t) => {
    const e = ease(t);
    f.arms.forEach((a, i) => { a.rotation.x = r0[i].x - 1.45 * e; a.rotation.z = r0[i].z * (1 - e) - (i ? 0.18 : -0.18) * e; });
    f.charging = e;
  });
  if (!alive(g)) return;
  audio.tone(55, 0.9, { type: 'sawtooth', volume: 0.1 });
  await wait(0.5);
  if (!alive(g)) return;

  // A roaring stream of fire, swept across in front of the player (stopping just short of them).
  audio.noise(3.2, { volume: 0.35 });
  audio.tone(48, 3, { type: 'sawtooth', volume: 0.16 });
  audio.tone(73, 3, { type: 'sawtooth', volume: 0.1 });
  const a = V(0, 0, 0), b = V(0, 0, 0), o = V(0, 0, 0), d = V(0, 0, 0);
  const yaw0 = f.group.rotation.y;
  let acc = 0, accS = 0;
  await tween(2.8, (t, dt) => {
    f.hands[0].getWorldPosition(a);
    f.hands[1].getWorldPosition(b);
    o.addVectors(a, b).multiplyScalar(0.5);
    const yaw = yaw0 - 1.35 + 0.95 * ease(t), pitch = 0.04;
    d.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    acc += dt * 480;
    while (acc > 1) {
      acc--;
      const sp = 11 + Math.random() * 4, j = 1.8;
      f.fire.emit(o, V(d.x * sp + (Math.random() - 0.5) * j, d.y * sp + (Math.random() - 0.5) * j, d.z * sp + (Math.random() - 0.5) * j),
        0.8 + Math.random() * 0.4, 0.3 + Math.random() * 0.22);
      if (Math.random() < 0.5) {
        const cs = 14 + Math.random() * 3;
        f.core.emit(o, V(d.x * cs + (Math.random() - 0.5) * 0.6, d.y * cs + (Math.random() - 0.5) * 0.6, d.z * cs + (Math.random() - 0.5) * 0.6), 0.45);
      }
    }
    accS += dt * 45;
    while (accS > 1) {
      accS--;
      f.smoke.emit(V(o.x + d.x * 8, o.y + d.y * 8 + 0.5, o.z + d.z * 8), V(d.x * 6, d.y * 6 + 1, d.z * 6), 1.6, 0.4);
    }
    f.charging = 1 + Math.sin(t * 40) * 0.2;
  });
  if (!alive(g)) return;
  await tween(0.7, (t) => {
    const e = ease(t);
    f.arms.forEach((arm, i) => { arm.rotation.x = r0[i].x - 1.45 * (1 - e); arm.rotation.z = r0[i].z * e - (i ? 0.18 : -0.18) * (1 - e); });
    f.charging = 1 - e;
  });
  f.charging = 0;
}

// ===== 3. The Kite (remembered 0.85) =====
function kiteSailGeo() {
  const S = 32, T = 48;
  const pos = [], col = [], idx = [];
  const A = new THREE.Color(0xff5fa2), B = new THREE.Color(0xffd23f), C = new THREE.Color(0x5ad1ff), D = new THREE.Color(0x9b7bff);
  const top = new THREE.Color(), bot = new THREE.Color(), c = new THREE.Color();
  for (let j = 0; j <= T; j++) {
    const t = j / T, y = 1.2 - t * 2.7;
    const hw = y >= 0 ? 0.85 * (1 - y / 1.2) : 0.85 * (1 + y / 1.5);
    for (let i = 0; i <= S; i++) {
      const s = -1 + (2 * i) / S;
      pos.push(s * hw, y, 0.2 * (1 - s * s) * Math.sin(Math.PI * t)); // billowed in the wind
      const wx = smooth(-0.08, 0.08, s), wy = smooth(-0.1, 0.1, y);
      top.copy(A).lerp(B, wx);
      bot.copy(C).lerp(D, wx);
      c.copy(bot).lerp(top, wy);
      col.push(c.r, c.g, c.b);
      if (i < S && j < T) {
        const a = j * (S + 1) + i;
        idx.push(a, a + S + 1, a + 1, a + 1, a + S + 1, a + S + 2);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

const TORNADO_FRAG = `
  uniform float time; uniform float fade; uniform float speed; varying vec2 vUv;
  void main() {
    float u = vUv.x, v = vUv.y;
    float s1 = sin((u * 9.0 + v * 4.0 - time * speed) * 6.2831);
    float s2 = sin((u * 16.0 - v * 6.0 - time * speed * 1.7) * 6.2831);
    float streak = smoothstep(0.1, 1.0, s1 * 0.6 + s2 * 0.4);
    float edge = smoothstep(0.0, 0.1, v) * smoothstep(1.0, 0.7, v);
    vec3 col = mix(vec3(0.78, 0.76, 0.92), vec3(1.0), streak);
    gl_FragColor = vec4(pow(col, vec3(2.2)), (0.16 + 0.55 * streak) * edge * fade);
    #include <colorspace_fragment>
  }`;

function buildTornado() {
  const group = new THREE.Group();
  group.visible = false;
  ctx.scene.add(group);
  const spin = new THREE.Group();
  group.add(spin);
  const prof = [];
  for (let i = 0; i <= 40; i++) {
    const y = (i / 40) * 11;
    prof.push(new THREE.Vector2(0.5 + 0.09 * Math.pow(y, 1.6), y));
  }
  const geo = new THREE.LatheGeometry(prof, 96);
  const mats = [3.0, 4.5].map((speed) => new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, fade: { value: 1 }, speed: { value: speed } },
    vertexShader: GALAXY_VERT, fragmentShader: TORNADO_FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  }));
  mesh(geo, mats[0], 0, 0, 0, spin);
  mesh(geo, mats[1], 0, 0, 0, spin).scale.set(0.8, 1, 0.8);
  const debris = new Particles({ count: 400, color: 0xffffff, color2: 0xffa6d6, size: 0.12, drag: 0.3 });
  const dust = new Particles({ count: 200, color: 0xf3e2b8, color2: 0xffffff, size: 0.35, grow: 2, drag: 1 });
  return {
    group, spin, mats, debris, dust,
    step(dt, strength) {
      spin.rotation.y += dt * 7;
      spin.rotation.z = Math.sin(time * 1.7) * 0.06;
      for (const m of mats) { m.uniforms.time.value = time; m.uniforms.fade.value = strength; }
      const p = group.position;
      for (let i = 0; i < 6 * strength; i++) {
        const a = Math.random() * 6.28, h = Math.random() * 8, r = 0.5 + 0.09 * Math.pow(h, 1.6);
        debris.emit(V(p.x + Math.cos(a) * r, p.y + h, p.z + Math.sin(a) * r), V(-Math.sin(a) * 6, 1.5, Math.cos(a) * 6), 0.7);
      }
      for (let i = 0; i < 2 * strength; i++) {
        const a = Math.random() * 6.28;
        dust.emit(V(p.x + Math.cos(a) * 0.8, p.y + 0.1, p.z + Math.sin(a) * 0.8), V(Math.cos(a) * 3, 0.4, Math.sin(a) * 3), 0.9);
      }
    },
  };
}

function buildKite() {
  const g = standAt(SPOTS.kite);
  mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.6, 16), std(0x8a6a4a), 0, 0.3, 0, g);

  const kite = new THREE.Group();
  kite.position.set(0, 3.8, 0.6);
  g.add(kite);
  mesh(kiteSailGeo(), new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.45, emissive: 0x332233 }), 0, 0, 0, kite);
  const spar = std(0xfff6e0);
  mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.7, 12), spar, 0, -0.15, -0.02, kite);
  mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.7, 12), spar, 0, 0, -0.02, kite).rotation.z = Math.PI / 2;
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff }), black = new THREE.MeshBasicMaterial({ color: 0x111111 });
  for (const sx of [-1, 1]) {
    mesh(new THREE.SphereGeometry(0.13, 24, 16), white, sx * 0.24, 0.3, 0.2, kite).scale.z = 0.4;
    mesh(new THREE.SphereGeometry(0.065, 16, 12), black, sx * 0.24, 0.29, 0.25, kite).scale.z = 0.4;
  }
  const smile = mesh(new THREE.TorusGeometry(0.2, 0.03, 12, 32, Math.PI), black, 0, 0, 0.21, kite);
  smile.rotation.z = Math.PI;

  // Long flowing ribbon tail (rebuilt every frame) with soft bows.
  const N = 80, L = 7.5;
  const tpos = new Float32Array((N + 1) * 2 * 3), tcol = [], tidx = [];
  const c0 = new THREE.Color(0xff4f9a), c1 = new THREE.Color(0xffd23f), c2 = new THREE.Color(0x4fd2ff), cc = new THREE.Color();
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    cc.copy(t < 0.5 ? c0 : c1).lerp(t < 0.5 ? c1 : c2, t < 0.5 ? t * 2 : t * 2 - 1);
    tcol.push(cc.r, cc.g, cc.b, cc.r, cc.g, cc.b);
    if (i < N) { const a = i * 2; tidx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const tgeo = new THREE.BufferGeometry();
  tgeo.setAttribute('position', new THREE.BufferAttribute(tpos, 3));
  tgeo.setAttribute('color', new THREE.Float32BufferAttribute(tcol, 3));
  tgeo.setIndex(tidx);
  mesh(tgeo, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.4 }), 0, 0, 0, kite).frustumCulled = false;
  const bowMat = std(0xff7ac4, { roughness: 0.4 });
  const bows = new Map(); // ribbon index -> bow
  for (let i = 0; i < 6; i++) {
    const b = new THREE.Group();
    kite.add(b);
    for (const sx of [-1, 1]) {
      const lobe = mesh(new THREE.SphereGeometry(1, 24, 16), bowMat, sx * 0.1, 0, 0, b);
      lobe.scale.set(0.11, 0.065, 0.025);
      lobe.rotation.z = sx * 0.3;
    }
    mesh(new THREE.SphereGeometry(0.03, 12, 8), bowMat, 0, 0, 0, b);
    bows.set(Math.round(((i + 1) / 7) * N), b);
  }
  const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff });
  const string = new THREE.Line(new THREE.BufferGeometry().setFromPoints([V(0, 0.6, 0), V(0, 0, 0)]), lineMat);
  g.add(string);

  const tornado = buildTornado();
  const kt = {
    name: 'Skye', color: '#ff7ac4', group: g,
    line: 'Nearly every child has run with a kite on a windy day. My tail\'s a little shorter than it used to be... but I can still fly.',
    reaction: 'Hey! Wait for me! ...These legs weren\'t made for running.',
    ability: (gg) => kiteTornado(kt, gg),
    kite, tornado, loop: 0,
  };
  kt.fade = makeFadable(g, REMEMBERED.kite);

  const p = V(0, 0, 0);
  every(() => {
    kite.position.y = 3.8 + Math.sin(time * 1.3) * 0.3;
    kite.position.x = Math.sin(time * 0.7) * 0.4;
    kite.rotation.z = Math.sin(time * 0.9) * 0.15 + kt.loop;
    kite.rotation.x = -0.2 + Math.sin(time * 1.1) * 0.08;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      p.set(Math.sin(time * 2.6 - t * 7) * 0.7 * t, -1.5 - t * L * 0.72, -t * L * 0.5 + Math.sin(time * 1.9 - t * 5) * 0.4 * t);
      const tw = Math.sin(time * 2.2 - t * 6) * 0.9, hw = 0.1 * (1 - t * 0.4);
      tpos.set([p.x - Math.cos(tw) * hw, p.y, p.z - Math.sin(tw) * hw, p.x + Math.cos(tw) * hw, p.y, p.z + Math.sin(tw) * hw], i * 6);
      const bow = bows.get(i);
      if (bow) { bow.position.copy(p); bow.rotation.y = tw; }
    }
    tgeo.attributes.position.needsUpdate = true;
    tgeo.computeVertexNormals();
    const sp = string.geometry.attributes.position;
    sp.setXYZ(1, kite.position.x, kite.position.y - 0.4, kite.position.z);
    sp.needsUpdate = true;
  });

  ctx.interact.add(g, () => meet(kt), { distance: 8 });
  return kt;
}

async function kiteTornado(k, g) {
  const { player, camera, audio } = ctx;
  const tor = k.tornado;
  const P0 = player.position.clone();

  // Landing spot: the other side of the map, nudged until it's clear of props.
  const away = Math.hypot(P0.x, P0.z) > 3 ? Math.atan2(-P0.z, -P0.x) : Math.PI;
  let P1 = null;
  for (let i = 0; i < 30 && !P1; i++) {
    const a = away + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.1;
    const x = Math.cos(a) * (PLAY_R - 9), z = Math.sin(a) * (PLAY_R - 9);
    if (!props.some(([px, pz, pr]) => (px - x) ** 2 + (pz - z) ** 2 < (pr + 2) ** 2)) P1 = V(x, 0, z);
  }
  if (!P1) P1 = V(Math.cos(away) * (PLAY_R - 9), 0, Math.sin(away) * (PLAY_R - 9));

  // The kite whips round and a tornado spins up in front of the player.
  const fwd = V(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  const T0 = P0.clone().addScaledVector(fwd, 5);
  tor.group.visible = true;
  audio.noise(1.5, { volume: 0.25 });
  audio.tone(110, 6, { type: 'sine', volume: 0.12 });
  await tween(1.3, (t, dt) => {
    k.loop = ease(t) * Math.PI * 2;
    const e = ease(t);
    tor.group.position.set(T0.x + (P0.x - T0.x) * e, 0, T0.z + (P0.z - T0.z) * e);
    tor.group.position.y = H(tor.group.position.x, tor.group.position.z);
    tor.group.scale.setScalar(Math.max(0.0001, easeOut(t)));
    tor.step(dt, t);
  });
  if (!alive(g)) return;
  k.loop = 0;

  // Picked up, spun round and carried across Quirkland.
  player.enabled = false;
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  let ang = 0, yaw = player.yaw, pitch = player.pitch;
  audio.noise(2.5, { volume: 0.3 });
  setTimeout(() => alive(g) && audio.noise(2.5, { volume: 0.25 }), 2000);
  await tween(4.6, (t, dt) => {
    const e = ease(t);
    const cx = P0.x + (P1.x - P0.x) * e, cz = P0.z + (P1.z - P0.z) * e;
    tor.group.position.set(cx, H(cx, cz), cz);
    tor.step(dt, 1);
    const spinRate = 2 + 2.5 * Math.sin(Math.PI * t);
    ang += dt * spinRate;
    const R = 0.4 + 1.1 * smooth(0, 0.12, t) * (1 - smooth(0.85, 1, t));
    const lift = 9 * Math.pow(Math.sin(Math.PI * t), 0.8);
    const x = cx + Math.cos(ang) * R, z = cz + Math.sin(ang) * R;
    player.position.set(x, H(x, z) + lift, z);
    yaw += dt * spinRate * 0.7;
    pitch += (-0.15 + Math.sin(time * 2.5) * 0.12 - pitch) * Math.min(1, dt * 3);
    camera.position.set(x, player.position.y + 1.6, z);
    camera.quaternion.setFromEuler(euler.set(pitch, yaw, 0));
  });
  if (!alive(g)) return;

  // Set down gently on the far side.
  player.position.y = H(player.position.x, player.position.z);
  player.velocity.set(0, 0, 0);
  player.yaw = yaw;
  player.pitch = pitch;
  player.enabled = true;

  // The tornado wanders on and blows itself out.
  const dir = V(P1.x - P0.x, 0, P1.z - P0.z).normalize();
  await tween(1.4, (t, dt) => {
    tor.group.position.addScaledVector(dir, dt * 4);
    tor.group.position.y = H(tor.group.position.x, tor.group.position.z);
    tor.group.scale.set(Math.max(0.0001, 1 - ease(t) * 0.6), Math.max(0.0001, 1 - ease(t)), Math.max(0.0001, 1 - ease(t) * 0.6));
    tor.step(dt, 1 - t);
  });
  tor.group.visible = false;
}

// ===== 4. The Rock Guardian (remembered 0.6) =====
// Smooth lumpy boulder with moss growing on its upward-facing side.
function boulderGeo(r, seed) {
  let geo = new THREE.SphereGeometry(1, 48, 32);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo);
  const pos = geo.attributes.position, v = V(0, 0, 0);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = 1 + 0.11 * Math.sin(3 * v.x + seed) * Math.sin(4 * v.y + 2 * seed) * Math.sin(3.5 * v.z + 3 * seed)
                + 0.05 * Math.sin(7 * v.x - seed) * Math.sin(6 * v.z + seed);
    v.multiplyScalar(n * r);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  const nor = geo.attributes.normal, col = new Float32Array(pos.count * 3);
  const rock = new THREE.Color(), moss = new THREE.Color(0x5fae3a), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    rock.setHSL(0.08, 0.06, 0.42 + 0.08 * Math.sin(v.x * 5 + v.z * 4 + seed));
    const m = smooth(0.2, 0.6, nor.getY(i) + 0.25 * Math.sin(v.x * 3 + seed) * Math.cos(v.z * 3 - seed));
    c.copy(rock).lerp(moss, m);
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

function glowSprite(color, size) {
  const tex = canvasTex(`glow${color}`, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, color);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  }, 128);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  sp.scale.setScalar(size);
  return sp;
}

function buildRockGuardian() {
  const g = standAt(SPOTS.rock);
  const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  const mossMat = std(0x5fae3a, { roughness: 1 });
  const body = new THREE.Group();
  g.add(body);
  for (const sx of [-1, 1]) mesh(boulderGeo(0.8, sx * 3 + 1), rockMat, sx * 0.85, 0.7, 0, body);
  mesh(boulderGeo(1.6, 2), rockMat, 0, 2.6, 0, body).scale.set(1.15, 1, 0.9);
  mesh(boulderGeo(0.85, 5), rockMat, 0, 4.25, 0.25, body);
  mesh(boulderGeo(0.5, 9), rockMat, 0, 4.85, 0.75, body).scale.set(1.1, 0.4, 0.5); // heavy brow
  // One big glowing gold eye — no pupil.
  const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc83a).multiplyScalar(3) }); // HDR → blooms
  eyeMat.userData.noFade = true; // the eye stays fully glowing gold
  mesh(new THREE.SphereGeometry(0.32, 48, 32), eyeMat, 0, 4.4, 0.98, body);
  const halo = glowSprite('rgba(255,200,60,0.9)', 1.8);
  halo.position.set(0, 4.4, 1.2);
  body.add(halo);
  const eyeLight = new THREE.PointLight(0xffc83a, 3, 8, 1.5);
  eyeLight.position.set(0, 4.4, 1.6);
  body.add(eyeLight);
  const smile = mesh(new THREE.TorusGeometry(0.3, 0.05, 12, 32, Math.PI), std(0x2a2a26), 0, 3.95, 1.02, body);
  smile.rotation.z = Math.PI;
  // Moss tufts.
  for (const [x, y, z, s] of [[0, 5.0, 0.1, 0.5], [-1.4, 3.6, 0, 0.45], [1.4, 3.7, -0.1, 0.4], [0.6, 3.5, 0.9, 0.3]]) {
    mesh(new THREE.SphereGeometry(1, 32, 16), mossMat, x, y, z, body).scale.set(s, s * 0.4, s);
  }
  // Long gorilla arms (pivot at the shoulder).
  const arms = [], fists = [];
  for (const sx of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(sx * 1.75, 3.3, 0);
    body.add(arm);
    mesh(boulderGeo(0.6, sx + 11), rockMat, 0, -0.5, 0, arm);
    mesh(boulderGeo(0.55, sx + 13), rockMat, 0, -1.4, 0.1, arm);
    const fist = mesh(boulderGeo(0.68, sx + 17), rockMat, 0, -2.3, 0.2, arm);
    arms.push(arm);
    fists.push(fist);
  }
  const blocker = mesh(new THREE.CylinderGeometry(1.9, 1.9, 5, 24), new THREE.MeshBasicMaterial(), 0, 2.5, 0, g);
  blocker.visible = false;
  collide(blocker);

  const fx = {
    fire: new Particles({ count: 600, color: 0xffb030, color2: 0xc81800, size: 0.5, grow: 2.2, gravity: -1, drag: 1.5 }),
    flash: new Particles({ count: 300, color: 0xfff4c0, color2: 0xff7a00, size: 0.6, grow: 1.5, additive: true, drag: 2 }),
    dust: new Particles({ count: 600, color: 0xc9b28a, color2: 0xe8dcc4, size: 0.5, grow: 3, gravity: -0.3, drag: 1.8 }),
    rocks: new Particles({ count: 300, color: 0x5b5650, color2: 0x3b3833, size: 0.18, gravity: 14, drag: 0.2 }),
  };
  const wave = mesh(new THREE.CylinderGeometry(1, 1, 0.8, 96, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xfff1d0, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }), 0, 0, 0);
  const ring = mesh(new THREE.RingGeometry(0.8, 1, 96).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }), 0, 0, 0);

  const rg = {
    name: 'Rock Guardian', color: '#ffc83a', group: g,
    line: 'Kids still build forts and castles out of stones. Not as many as they used to... but enough to keep me standing. Stand back!',
    reaction: 'Okay. My ears are ringing. ...Do I have ears?',
    ability: (gg) => rockSmash(rg, gg),
    body, arms, fists, fx, wave, ring, halo, eyeLight,
  };
  rg.fade = makeFadable(g, REMEMBERED.rock);

  every(() => {
    const b = Math.sin(time * 1.1);
    body.position.y = b * 0.04;
    halo.scale.setScalar(1.7 + Math.sin(time * 2.3) * 0.15);
    eyeLight.intensity = 3 + Math.sin(time * 2.3) * 0.6;
  });

  ctx.interact.add(g, () => meet(rg), { distance: 8 });
  return rg;
}

async function rockSmash(r, g) {
  const { audio } = ctx;
  // Raise both fists high overhead.
  audio.tone(60, 1.2, { type: 'sine', volume: 0.12 });
  await tween(1.0, (t) => {
    const e = ease(t);
    for (const a of r.arms) a.rotation.x = -2.7 * e;
    r.body.rotation.x = -0.12 * e;
  });
  if (!alive(g)) return;
  await wait(0.25);
  if (!alive(g)) return;
  // SMASH.
  await tween(0.22, (t) => {
    const e = t * t;
    for (const a of r.arms) a.rotation.x = -2.7 + 2.15 * e;
    r.body.rotation.x = -0.12 + 0.42 * e;
    r.body.position.y = -0.7 * e;
  });
  if (!alive(g)) return;

  const c = V(0, 0, 0), f2 = V(0, 0, 0);
  r.fists[0].getWorldPosition(c);
  r.fists[1].getWorldPosition(f2);
  c.add(f2).multiplyScalar(0.5);
  c.y = H(c.x, c.z);
  audio.tone(42, 1.4, { type: 'sine', volume: 0.5 });
  audio.noise(1.2, { volume: 0.4 });
  shake = 0.35;
  r.wave.position.copy(c);
  r.ring.position.set(c.x, c.y + 0.15, c.z);
  for (let i = 0; i < 60; i++) {
    const a = Math.random() * 6.28, s = 2 + Math.random() * 5;
    r.fx.dust.emit(V(c.x, c.y + 0.3, c.z), V(Math.cos(a) * s, 1 + Math.random() * 3, Math.sin(a) * s), 1.6, 0.6);
    r.fx.rocks.emit(V(c.x, c.y + 0.3, c.z), V(Math.cos(a) * s * 0.8, 5 + Math.random() * 6, Math.sin(a) * s * 0.8), 1.6);
  }

  // Shockwave rolls outward, setting off explosions as it goes.
  const booms = [];
  for (let i = 0; i < 10; i++) booms.push({ a: (i / 10) * 6.28 + Math.random() * 0.4, r: 3 + Math.random() * 9, done: false });
  booms.sort((x, y) => x.r - y.r);
  await tween(1.3, (t) => {
    const rad = 0.5 + easeOut(t) * 15;
    r.wave.scale.set(rad, 1 + (1 - t) * 1.5, rad);
    r.wave.material.opacity = 0.45 * (1 - t);
    r.ring.scale.setScalar(rad);
    r.ring.material.opacity = 0.8 * (1 - t);
    for (const b of booms) {
      if (b.done || b.r > rad) continue;
      b.done = true;
      const x = c.x + Math.cos(b.a) * b.r, z = c.z + Math.sin(b.a) * b.r, y = H(x, z);
      audio.noise(0.3, { volume: 0.18 });
      shake = Math.max(shake, 0.12);
      for (let i = 0; i < 28; i++) {
        const d = V(Math.random() - 0.5, Math.random() * 0.9 + 0.3, Math.random() - 0.5).normalize();
        r.fx.fire.emit(V(x, y + 0.3, z), d.clone().multiplyScalar(4 + Math.random() * 3), 0.6 + Math.random() * 0.3, 0.45);
        if (i % 3 === 0) r.fx.flash.emit(V(x, y + 0.5, z), d.clone().multiplyScalar(2.5), 0.35, 0.7);
        if (i % 2) r.fx.dust.emit(V(x, y + 0.3, z), d.multiplyScalar(2 + Math.random() * 2), 1.4, 0.5);
        if (i % 4 === 0) r.fx.rocks.emit(V(x, y + 0.3, z), V(d.x * 4, 5 + Math.random() * 4, d.z * 4), 1.3);
      }
    }
  });
  if (!alive(g)) return;
  r.wave.material.opacity = r.ring.material.opacity = 0;
  await tween(0.8, (t) => {
    const e = ease(t);
    for (const a of r.arms) a.rotation.x = -0.55 * (1 - e);
    r.body.rotation.x = 0.3 * (1 - e);
    r.body.position.y = -0.7 * (1 - e);
  });
}

// ===== 5. Water Girl (remembered 0.45) =====
const POOL_FRAG = `
  uniform float time; uniform float grow; varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > grow) discard;
    float rip = 0.5 + 0.5 * sin(r * 26.0 - time * 5.0);
    float caustic = pow(0.5 + 0.5 * sin(p.x * 18.0 + time * 1.7) * sin(p.y * 16.0 - time * 1.3), 4.0);
    vec3 col = mix(vec3(0.05, 0.38, 0.85), vec3(0.45, 0.85, 1.0), r * 0.7 + rip * 0.15);
    col += vec3(0.9, 1.0, 1.0) * caustic * 0.35;
    float edge = smoothstep(grow, grow - 0.06, r);
    col = mix(vec3(1.0), col, edge);
    gl_FragColor = vec4(pow(col, vec3(2.2)), 0.85);
    #include <colorspace_fragment>
  }`;

function buildWaterGirl() {
  const g = standAt(SPOTS.water);
  const skin = std(0xffd9c2, { roughness: 0.6 });
  const water = std(0x4fc3ff, { roughness: 0.1, metalness: 0.1, emissive: 0x1a6aa8, emissiveIntensity: 0.5, transparent: true, opacity: 0.8 });
  const dressMat = std(0x7fdcff, { roughness: 0.2, emissive: 0x2a8ac8, emissiveIntensity: 0.4, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const iris = new THREE.MeshBasicMaterial({ color: 0x1b5fa8 });
  const dark = new THREE.MeshBasicMaterial({ color: 0x5a2a2a });

  const fig = new THREE.Group(); // the girl herself (moves during her power)
  g.add(fig);
  for (const sx of [-1, 1]) {
    mesh(new THREE.CapsuleGeometry(0.055, 0.42, 8, 16), skin, sx * 0.08, 0.3, 0, fig);
    mesh(new THREE.SphereGeometry(0.07, 24, 16), water, sx * 0.08, 0.05, 0.03, fig).scale.set(1, 0.6, 1.4);
  }
  const prof = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    prof.push(new THREE.Vector2(0.13 + 0.27 * t * t, 1.0 - t * 0.52));
  }
  const dress = mesh(new THREE.LatheGeometry(prof, 64), dressMat, 0, 0, 0, fig);
  mesh(new THREE.CapsuleGeometry(0.12, 0.22, 10, 20), dressMat, 0, 1.08, 0, fig);
  const arms = [];
  for (const sx of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(sx * 0.16, 1.2, 0);
    arm.rotation.z = sx * 0.15;
    fig.add(arm);
    mesh(new THREE.CapsuleGeometry(0.045, 0.38, 8, 16), skin, 0, -0.22, 0, arm);
    mesh(new THREE.SphereGeometry(0.055, 16, 12), skin, 0, -0.45, 0, arm);
    arms.push(arm);
  }
  mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.1, 16), skin, 0, 1.3, 0, fig);
  const head = new THREE.Group();
  head.position.set(0, 1.45, 0);
  fig.add(head);
  mesh(new THREE.SphereGeometry(0.17, 48, 32), skin, 0, 0, 0, head);
  for (const sx of [-1, 1]) {
    mesh(new THREE.SphereGeometry(0.045, 20, 16), white, sx * 0.065, 0.01, 0.145, head).scale.z = 0.6;
    mesh(new THREE.SphereGeometry(0.028, 16, 12), iris, sx * 0.065, 0.005, 0.17, head).scale.z = 0.5;
  }
  const smile = mesh(new THREE.TorusGeometry(0.04, 0.008, 8, 16, Math.PI), dark, 0, -0.07, 0.16, head);
  smile.rotation.z = Math.PI;
  mesh(new THREE.TorusGeometry(0.17, 0.014, 12, 48), water, 0, 0.06, 0, head).rotation.x = Math.PI / 2 + 0.25;
  // Hair made of flowing water.
  const strands = [];
  for (let i = 0; i < 9; i++) {
    const a = Math.PI * (0.15 + (0.7 * i) / 8);
    const pivot = new THREE.Group();
    pivot.position.set(Math.cos(a) * 0.12, 0.1, -Math.sin(a) * 0.12);
    head.add(pivot);
    const len = 0.5 + Math.sin(i * 1.7) * 0.08;
    const curve = new THREE.CatmullRomCurve3([V(0, 0, 0), V(Math.cos(a) * 0.08, -0.15, -0.08), V(Math.cos(a) * 0.1, -len * 0.6, -0.12), V(Math.cos(a) * 0.06, -len, -0.1)]);
    mesh(taperTube(curve, 24, 0.045, 0.01, 10), water, 0, 0, 0, pivot);
    strands.push(pivot);
  }

  // Her pool (revealed by the `grow` uniform so it can hug the terrain).
  const poolMat = new THREE.ShaderMaterial({ uniforms: { time: { value: 0 }, grow: { value: 0 } }, vertexShader: GALAXY_VERT, fragmentShader: POOL_FRAG, transparent: true, depthWrite: false });
  const pool = new THREE.Mesh(new THREE.RingGeometry(0.0001, 3.4, 64, 14).rotateX(-Math.PI / 2), poolMat);
  pool.visible = false;
  ctx.scene.add(pool);
  const splash = new Particles({ count: 900, color: 0xffffff, color2: 0x4fc3ff, size: 0.12, grow: 0.6, gravity: 9.8, drag: 0.3 });
  const drips = new Particles({ count: 60, color: 0x9fe0ff, size: 0.04, gravity: 6 });

  const wg = {
    name: 'Water Girl', color: '#5ec8ff', group: g,
    line: 'Puddles, bathtubs, the seaside... children used to dream about me every summer. Now only sometimes. But watch!',
    reaction: 'Water\'s my thing too, you know. Well. It was.',
    ability: (gg) => waterGirlRide(wg, gg),
    fig, arms, strands, pool, poolMat, splash, posing: false,
  };
  wg.fade = makeFadable(g, REMEMBERED.water);

  const hp = V(0, 0, 0);
  every((dt) => {
    poolMat.uniforms.time.value = time;
    strands.forEach((s, i) => { s.rotation.x = Math.sin(time * 2 + i) * 0.12 + (wg.posing ? 0.9 : 0); s.rotation.z = Math.sin(time * 1.7 + i * 0.7) * 0.08; });
    dress.rotation.y = Math.sin(time * 1.3) * 0.1;
    if (!wg.posing) {
      fig.position.y = Math.sin(time * 1.6) * 0.03;
      arms.forEach((a, i) => { a.rotation.z = (i ? 1 : -1) * (0.15 + Math.sin(time * 1.6) * 0.04); a.rotation.x = 0; });
    }
    if (Math.random() < dt * 4) {
      head.getWorldPosition(hp);
      drips.emit(V(hp.x + (Math.random() - 0.5) * 0.3, hp.y - 0.3, hp.z + (Math.random() - 0.5) * 0.3), V(0, 0, 0), 0.6);
    }
  });

  ctx.interact.add(g, () => meet(wg), { distance: 6 });
  return wg;
}

function shapePool(pool, c) {
  // Make the pool hug the ground around centre c.
  const pos = pool.geometry.attributes.position;
  if (!pool.userData.base) pool.userData.base = Float32Array.from(pos.array);
  const base = pool.userData.base, cy = H(c.x, c.z);
  for (let i = 0; i < pos.count; i++) {
    const x = base[i * 3], z = base[i * 3 + 2];
    pos.setY(i, H(c.x + x, c.z + z) - cy + 0.08);
  }
  pos.needsUpdate = true;
  pool.geometry.computeBoundingSphere();
  pool.position.set(c.x, cy, c.z);
}

async function waterGirlRide(w, g) {
  const { player, audio } = ctx;
  w.group.updateMatrixWorld(true);
  const home = w.group.position.clone();
  const u = V(player.position.x - home.x, 0, player.position.z - home.z).normalize(); // toward player
  const p = V(-u.z, 0, u.x);                                                        // across the view
  const C = home.clone().addScaledVector(u, 2).addScaledVector(p, 1.4);
  shapePool(w.pool, C);
  w.pool.visible = true;
  w.posing = true;

  // Raise her arms and the pool spreads out of nowhere.
  audio.noise(1.2, { volume: 0.12 });
  await tween(1.0, (t) => {
    const e = ease(t);
    w.arms.forEach((a, i) => { a.rotation.z = (i ? 1 : -1) * (0.15 + 2.2 * e); });
    w.poolMat.uniforms.grow.value = easeOut(t);
    if (Math.random() < 0.5) {
      const a = Math.random() * 6.28, r = Math.random() * 3.2 * t;
      w.splash.emit(V(C.x + Math.cos(a) * r, H(C.x, C.z) + 0.1, C.z + Math.sin(a) * r), V(0, 2 + Math.random() * 2, 0), 0.5);
    }
  });
  if (!alive(g)) return;

  // Local frame: the figure moves inside the group, so work in the group's space.
  const toLocal = (v) => w.group.worldToLocal(v.clone());
  const A = C.clone().addScaledVector(p, -2.6), B = C.clone().addScaledVector(p, 2.6);
  A.y = H(A.x, A.z) + 0.08; B.y = H(B.x, B.z) + 0.08;
  const startL = w.fig.position.clone(), aL = toLocal(A), bL = toLocal(B);
  const faceAlong = (dx, dz) => { w.fig.rotation.y = Math.atan2(dx, dz); };

  // Hop into the pool...
  await tween(0.5, (t) => {
    w.fig.position.lerpVectors(startL, aL, ease(t));
    w.fig.position.y += Math.sin(Math.PI * t) * 0.6;
    faceAlong(aL.x - startL.x, aL.z - startL.z);
  });
  if (!alive(g)) return;
  audio.noise(0.4, { volume: 0.15 });
  // ...slide across it, arms out...
  const wp = V(0, 0, 0);
  await tween(1.3, (t) => {
    w.fig.position.lerpVectors(aL, bL, ease(t));
    faceAlong(bL.x - aL.x, bL.z - aL.z);
    w.fig.rotation.z = Math.sin(t * Math.PI) * 0.15;
    w.arms.forEach((a, i) => { a.rotation.z = (i ? 1 : -1) * 1.5; });
    w.fig.getWorldPosition(wp);
    for (let i = 0; i < 4; i++) {
      w.splash.emit(V(wp.x + (Math.random() - 0.5) * 0.3, wp.y + 0.05, wp.z + (Math.random() - 0.5) * 0.3),
        V((Math.random() - 0.5) * 2, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 2), 0.6);
    }
  });
  if (!alive(g)) return;
  w.fig.rotation.z = 0;

  // ...then a jet of water launches her up and she rides it round in a loop.
  audio.noise(3.4, { volume: 0.22 });
  audio.tone(220, 0.6, { type: 'sine', volume: 0.06 });
  const center = toLocal(C);
  const ang0 = Math.atan2(bL.z - center.z, bL.x - center.x);
  const R0 = Math.hypot(bL.x - center.x, bL.z - center.z);
  let px = bL.x, pz = bL.z, jet = 0;
  await tween(3.6, (t, dt) => {
    const ang = ang0 + t * Math.PI * 2.2;
    const R = R0 * (1 - 0.2 * Math.sin(Math.PI * t));
    const x = center.x + Math.cos(ang) * R, z = center.z + Math.sin(ang) * R;
    const ground = bL.y + (startL.y - bL.y) * smooth(0.85, 1, t);
    const lift = 4 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.7);
    w.fig.position.set(x + (startL.x - x) * smooth(0.85, 1, t), ground + lift, z + (startL.z - z) * smooth(0.85, 1, t));
    faceAlong(w.fig.position.x - px, w.fig.position.z - pz);
    px = w.fig.position.x; pz = w.fig.position.z;
    w.fig.rotation.x = 0.25 * Math.sin(Math.PI * t);
    w.arms.forEach((a, i) => { a.rotation.z = (i ? 1 : -1) * (1.3 + Math.sin(time * 6) * 0.1); });
    // The stream of water under her feet.
    w.fig.getWorldPosition(wp);
    if (lift > 0.2) {
      jet += dt * 420;
      while (jet > 1) {
        jet--;
        w.splash.emit(V(wp.x + (Math.random() - 0.5) * 0.15, wp.y + Math.random() * 0.1, wp.z + (Math.random() - 0.5) * 0.15),
          V((Math.random() - 0.5) * 0.6, -4 - Math.random() * 2, (Math.random() - 0.5) * 0.6), 0.7 + Math.random() * 0.3, 0.2);
      }
    }
  });
  if (!alive(g)) return;
  w.fig.position.copy(startL);
  w.fig.rotation.set(0, 0, 0);
  w.posing = false;
  await tween(0.8, (t) => { w.poolMat.uniforms.grow.value = 1 - ease(t); });
  w.pool.visible = false;
}

// ===== 6. Tongue Guy (remembered 0.3) =====
function buildTongueGuy() {
  const g = standAt(SPOTS.tongue);
  const skinMat = std(0xb07cff, { roughness: 0.5 });
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const black = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const mouthMat = new THREE.MeshBasicMaterial({ color: 0x4a0a1a });
  const tongueMat = std(0xff2f6e, { roughness: 0.35, emissive: 0xa01040, emissiveIntensity: 0.5 });
  tongueMat.userData.k = 1.8; // stays readable as a tongue even though he's faded

  const body = new THREE.Group();
  g.add(body);
  mesh(new THREE.SphereGeometry(0.8, 64, 48), skinMat, 0, 0.95, 0, body).scale.set(1, 0.95, 0.92);
  for (const sx of [-1, 1]) {
    mesh(new THREE.SphereGeometry(0.2, 32, 24), skinMat, sx * 0.35, 0.14, 0.1, body).scale.set(1, 0.6, 1.3);
    const arm = mesh(new THREE.CapsuleGeometry(0.08, 0.35, 10, 20), skinMat, sx * 0.85, 0.9, 0.05, body);
    arm.rotation.z = sx * 0.9;
    // Big googly eyes on top.
    mesh(new THREE.SphereGeometry(0.22, 32, 24), white, sx * 0.25, 1.72, 0.35, body);
    mesh(new THREE.SphereGeometry(0.1, 24, 16), black, sx * 0.25, 1.7, 0.55, body);
    mesh(new THREE.SphereGeometry(0.06, 16, 12), skinMat, sx * 0.25, 1.98, 0.3, body).scale.set(1.6, 0.4, 0.8);
  }
  for (let i = 0; i < 3; i++) mesh(new THREE.SphereGeometry(0.08, 16, 12), skinMat, (i - 1) * 0.1, 1.82, -0.1, body);
  const mouth = mesh(new THREE.SphereGeometry(1, 48, 24), mouthMat, 0, 0.9, 0.7, body);
  mouth.scale.set(0.38, 0.2, 0.1);
  const mouthPt = new THREE.Object3D();
  mouthPt.position.set(0, 0.86, 0.78);
  body.add(mouthPt);
  const lip = mesh(new THREE.SphereGeometry(1, 32, 16), tongueMat, 0, 0.82, 0.8, body); // tongue tip resting on the lip
  lip.scale.set(0.16, 0.06, 0.12);

  // The super-long tongue lives in world space (it's rebuilt as it stretches).
  const tongueRoot = new THREE.Group();
  ctx.scene.add(tongueRoot);
  const tongue = new THREE.Mesh(new THREE.BufferGeometry(), tongueMat);
  tongue.frustumCulled = false;
  tongueRoot.add(tongue);
  const tip = mesh(new THREE.SphereGeometry(0.2, 32, 16), tongueMat, 0, 0, 0, tongueRoot);
  tip.scale.set(1, 0.6, 1.3);
  tongueRoot.visible = false;

  const tg = {
    name: 'Tongue Guy', color: '#c7a0ff', group: g,
    line: 'Kids used to stick their tongues out at each other all day long. They\'ve mostly forgotten me now... but I\'ve still got reach!',
    reaction: 'Huh. I didn\'t know he could still do that.',
    ability: (gg) => tongueStretch(tg, gg),
    body, mouthPt, lip, tongue, tip, tongueRoot,
  };
  tg.fade = makeFadable(g, REMEMBERED.tongue);
  tg.tongueFade = makeFadable(tongueRoot, REMEMBERED.tongue);

  every(() => {
    body.scale.set(1 + Math.sin(time * 2) * 0.02, 1 - Math.sin(time * 2) * 0.02, 1);
    body.rotation.z = Math.sin(time * 1.3) * 0.04;
  });

  ctx.interact.add(g, () => meet(tg), { distance: 6 });
  return tg;
}

async function tongueStretch(tg, g) {
  const { player, audio } = ctx;
  const m0 = V(0, 0, 0);
  tg.mouthPt.getWorldPosition(m0);
  // Shoot it across the view (perpendicular to the player), whichever way has more room.
  const home = tg.group.position;
  const u = V(player.position.x - home.x, 0, player.position.z - home.z).normalize();
  let dir = V(-u.z, 0, u.x);
  if (dir.x * -home.x + dir.z * -home.z < 0) dir.negate();
  const perp = V(-dir.z, 0, dir.x);
  let L = 0;
  while (L < 46) {
    const x = home.x + dir.x * (L + 1), z = home.z + dir.z * (L + 1);
    if (Math.hypot(x, z) > PLAY_R - 3) break;
    L += 1;
  }
  const at = (s, out) => {
    const x = m0.x + dir.x * s + perp.x * Math.sin(s * 0.22) * 1.6 * smooth(0, 6, s);
    const z = m0.z + dir.z * s + perp.z * Math.sin(s * 0.22) * 1.6 * smooth(0, 6, s);
    const y = m0.y + (H(x, z) + 1.1 - m0.y) * smooth(0, 4, s);
    return out.set(x, y, z);
  };

  // Turn to face along the tongue's path.
  const r0 = tg.group.rotation.y, r1 = Math.atan2(dir.x, dir.z);
  await tween(0.4, (t) => { tg.group.rotation.y = lerpAngle(r0, r1, ease(t)); });
  if (!alive(g)) return;
  tg.group.updateMatrixWorld(true);
  tg.mouthPt.getWorldPosition(m0);
  tg.lip.visible = false;
  tg.tongueRoot.visible = true;

  const build = (len, wiggle) => {
    const n = Math.max(4, Math.ceil(len / 1.5));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const p = at((i / n) * len, V(0, 0, 0));
      p.y += Math.sin(i * 0.9 - time * 8) * wiggle * (i / n);
      pts.push(p);
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    tg.tongue.geometry.dispose();
    tg.tongue.geometry = new THREE.TubeGeometry(curve, Math.max(16, n * 6), 0.13, 14);
    tg.tip.position.copy(pts[pts.length - 1]);
  };

  [260, 330, 420, 520].forEach((f, i) => setTimeout(() => alive(g) && audio.tone(f, 0.2, { type: 'triangle', volume: 0.07 }), i * 220));
  await tween(1.7, (t) => build(Math.max(0.3, L * easeOut(t)), 0.15));
  if (!alive(g)) return;
  await tween(1.4, () => build(L, 0.5)); // waggle it at the far end
  if (!alive(g)) return;
  audio.noise(0.6, { volume: 0.12 });
  [520, 400, 300, 220].forEach((f, i) => setTimeout(() => alive(g) && audio.tone(f, 0.18, { type: 'triangle', volume: 0.07 }), i * 180));
  await tween(1.0, (t) => build(Math.max(0.3, L * (1 - ease(t))), 0.15));
  if (!alive(g)) return;
  tg.tongueRoot.visible = false;
  tg.lip.visible = true;
  await faceToward(tg.group, player.position, 0.4);
}

// ===== 7. The Masked Figure (§9) — not from a child's imagination, so never faded =====
function buildMaskedFigure() {
  const [x, z] = SPOTS.masked;
  const g = standAt(SPOTS.masked);
  // Entirely black: a matte, light-swallowing body; the mask is black too, but glossy, so it reads as a
  // separate object you can see him lift off.
  const black = std(0x020202, { roughness: 0.95, metalness: 0 });
  const voidMat = new THREE.MeshBasicMaterial({ color: 0x000000 }); // pure darkness, no shading
  const maskMat = std(0x070707, { roughness: 0.12, metalness: 0, side: THREE.DoubleSide });
  const rubyMat = std(0xd0002a, { roughness: 0.12, metalness: 0.3, emissive: 0x3a0006, emissiveIntensity: 1, flatShading: true, side: THREE.DoubleSide });

  const body = new THREE.Group();
  g.add(body);
  // Impossibly long, thin legs.
  for (const sx of [-1, 1]) {
    const leg = new THREE.CatmullRomCurve3([V(sx * 0.12, 3.95, 0), V(sx * 0.13, 2.0, 0.08), V(sx * 0.14, 0.12, 0.02)]);
    mesh(taperTube(leg, 64, 0.075, 0.04, 16), black, 0, 0, 0, body);
    mesh(new THREE.CapsuleGeometry(0.04, 0.32, 8, 16).rotateX(Math.PI / 2), black, sx * 0.14, 0.05, 0.14, body);
  }
  mesh(new THREE.SphereGeometry(1, 32, 24), black, 0, 3.95, 0, body).scale.set(0.17, 0.12, 0.12);
  const prof = [[0.13, 3.95], [0.11, 4.4], [0.17, 5.2], [0.2, 5.65], [0.12, 5.85], [0.05, 5.95]].map(([r, y]) => new THREE.Vector2(r, y));
  mesh(new THREE.LatheGeometry(new THREE.SplineCurve(prof).getPoints(32), 48), black, 0, 0, 0, body).scale.z = 0.6;
  const neck = mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.6, 16), black, 0, 6.2, 0, body);

  // Head: under the mask there is nothing but darkness — and a ruby.
  const head = new THREE.Group();
  head.position.set(0, 6.72, 0);
  body.add(head);
  const skull = mesh(new THREE.SphereGeometry(0.26, 48, 32), voidMat, 0, 0, 0, head);
  skull.scale.set(0.85, 1.15, 0.9);
  const mask = mesh(new THREE.SphereGeometry(0.3, 48, 32, Math.PI / 2 - 0.65 * Math.PI, 1.3 * Math.PI, 0.05, Math.PI - 0.1), maskMat, 0, 0, 0, skull);
  const rubyProf = [[0, -0.05], [0.045, 0], [0.034, 0.024], [0, 0.03]].map(([r, y]) => new THREE.Vector2(r, y));
  const ruby = mesh(new THREE.LatheGeometry(rubyProf, 8), rubyMat, 0, 0.11, 0.21, head); // on his forehead, under the mask
  ruby.rotation.x = Math.PI / 2;

  // Long arms with long fingers (shoulder and elbow pivots so he can reach his face).
  const arms = [];
  for (const sx of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(sx * 0.24, 5.75, 0);
    shoulder.rotation.z = sx * 0.06;
    body.add(shoulder);
    mesh(taperTube(new THREE.CatmullRomCurve3([V(0, 0, 0), V(0, -0.7, 0.02), V(0, -1.4, 0)]), 32, 0.05, 0.035, 12), black, 0, 0, 0, shoulder);
    const elbow = new THREE.Group();
    elbow.position.set(0, -1.4, 0);
    shoulder.add(elbow);
    mesh(taperTube(new THREE.CatmullRomCurve3([V(0, 0, 0), V(0, -0.65, 0.02), V(0, -1.3, 0)]), 32, 0.035, 0.025, 12), black, 0, 0, 0, elbow);
    const hand = new THREE.Group();
    hand.position.set(0, -1.3, 0);
    elbow.add(hand);
    const fingers = [];
    for (let f = 0; f < 4; f++) {
      const fx = (f - 1.5) * 0.025;
      const fing = new THREE.Group();
      fing.position.set(fx, 0, 0);
      hand.add(fing);
      mesh(taperTube(new THREE.CatmullRomCurve3([V(0, 0, 0), V(fx * 0.5, -0.2, 0.02), V(fx, -0.4, 0.05)]), 16, 0.012, 0.005, 8), black, 0, 0, 0, fing);
      fingers.push(fing);
    }
    arms.push({ shoulder, elbow, hand, fingers });
  }

  const blocker = mesh(new THREE.CylinderGeometry(0.45, 0.45, 7, 16), new THREE.MeshBasicMaterial(), 0, 3.5, 0, g);
  blocker.visible = false;
  collide(blocker);

  const shadow = mesh(new THREE.CircleGeometry(1.4, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }), x, H(x, z) + 0.06, z);
  shadow.renderOrder = 1;
  const murk = new Particles({ count: 160, color: 0x000000, color2: 0x1c1c1c, size: 0.25, grow: 2.2, gravity: -0.35, drag: 0.4 });

  const mf = { group: g, body, head, skull, mask, ruby, arms, murk, seen: false, revealing: false, headYaw: 0 };

  const hp = V(0, 0, 0);
  let wispT = 0;
  every((dt) => {
    // Barely moves. Just the slow sway — and the head that always turns to follow you.
    if (!mf.revealing) {
      body.rotation.z = Math.sin(time * 0.4) * 0.012;
      const p = ctx.player.position;
      const want = THREE.MathUtils.clamp(lerpAngle(0, Math.atan2(p.x - g.position.x, p.z - g.position.z) - g.rotation.y, 1), -1.1, 1.1);
      mf.headYaw += (want - mf.headYaw) * Math.min(1, dt * 0.8);
      head.rotation.y = mf.headYaw;
      head.rotation.z = 0.18 + Math.sin(time * 0.3) * 0.04;
      // Occasional finger twitch.
      for (const a of arms) a.fingers.forEach((f, i) => { f.rotation.x = Math.max(0, Math.sin(time * 0.7 + i * 1.3)) ** 8 * 0.5; });
    }
    wispT -= dt;
    if (wispT <= 0) {
      wispT = 0.08;
      const a = Math.random() * 6.28, h = Math.random() * 6.5;
      murk.emit(V(g.position.x + Math.cos(a) * 0.25, g.position.y + h, g.position.z + Math.sin(a) * 0.25), V(Math.cos(a) * 0.15, 0.2, Math.sin(a) * 0.15), 2.2);
    }
  });

  ctx.interact.add(g, () => revealMaskedFigure(mf), { distance: 7 });
  return mf;
}

// "He's unfamiliar." — the first time the figure is actually on screen (in view, close enough, not hidden behind a hill).
const _frustum = new THREE.Frustum(), _pm = new THREE.Matrix4(), _ray = new THREE.Raycaster();
let sightT = 0;
function checkFirstSight(mf, dt) {
  if (mf.seen || state !== 'free' || !unlocked) return;
  sightT -= dt;
  if (sightT > 0) return;
  sightT = 0.25;
  const cam = ctx.camera;
  // Aim at his middle: he has to be fairly close and near the centre of the view, not a speck at the edge.
  const mid = mf.group.position.clone().setY(mf.group.position.y + 3.5);
  const dist = cam.position.distanceTo(mid);
  if (dist > 25) return;
  cam.updateMatrixWorld();
  _frustum.setFromProjectionMatrix(_pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  if (!_frustum.containsPoint(mid)) return;
  const toMid = mid.clone().sub(cam.position).normalize();
  if (toMid.dot(V(0, 0, -1).applyQuaternion(cam.quaternion)) < Math.cos(0.5)) return;
  _ray.set(cam.position, toMid);
  _ray.far = dist - 1;
  if (_ray.intersectObjects(ctx.player.colliders, false).length) return;
  mf.seen = true;
  sayUnfamiliar(mf);
}

async function sayUnfamiliar(mf) {
  const g = gen;
  mf.lineDone = (async () => {
    while (busy || ctx.dialogue.active) { await wait(0.3); if (!alive(g)) return; }
    hydrant.watch = mf.group.position;
    ctx.audio.tone(98, 2.5, { type: 'sine', volume: 0.12 });
    ctx.audio.tone(104, 2.5, { type: 'sine', volume: 0.1 }); // dissonant
    await ctx.dialogue.say("He's unfamiliar.", { speaker: HYDRANT, color: HYDRANT_COLOR });
    if (alive(g)) hydrant.watch = null;
  })();
  return mf.lineDone;
}

// Numerically pose a 2-bone arm so the hand reaches `target` (world). Cheap: done once per pose.
function solveArm(arm, target) {
  const sh = arm.shoulder, el = arm.elbow, hp = V(0, 0, 0);
  const save = [sh.rotation.x, sh.rotation.z, el.rotation.x];
  const lim = [[-3.3, 0.6], [-1.4, 1.4], [-2.9, 0]];
  const x = save.slice();
  const cost = () => {
    sh.rotation.x = x[0]; sh.rotation.z = x[1]; el.rotation.x = x[2];
    sh.updateMatrixWorld(true);
    return arm.hand.getWorldPosition(hp).distanceToSquared(target);
  };
  let best = cost();
  for (let step = 0.5; step > 0.002; step *= 0.6) {
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < 3; i++) {
        for (const d of [step, -step]) {
          const old = x[i];
          x[i] = THREE.MathUtils.clamp(old + d, lim[i][0], lim[i][1]);
          const c = cost();
          if (c < best - 1e-7) { best = c; improved = true; } else x[i] = old;
        }
      }
    }
  }
  const out = x.slice();
  [sh.rotation.x, sh.rotation.z, el.rotation.x] = save;
  sh.updateMatrixWorld(true);
  return out;
}

function poseArm(arm, from, to, e) {
  arm.shoulder.rotation.x = from[0] + (to[0] - from[0]) * e;
  arm.shoulder.rotation.z = from[1] + (to[1] - from[1]) * e;
  arm.elbow.rotation.x = from[2] + (to[2] - from[2]) * e;
}

// True when the ruby covers all four corners of the screen.
const _corner = new THREE.Raycaster(), _ndc = new THREE.Vector2();
function rubyFillsScreen(ruby) {
  const cam = ctx.camera;
  cam.updateMatrixWorld();
  for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    _corner.setFromCamera(_ndc.set(x * 0.999, y * 0.999), cam);
    if (!_corner.intersectObject(ruby, false).length) return false;
  }
  return true;
}

async function revealMaskedFigure(mf) {
  if (busy || state !== 'free' || mf.revealing || !unlocked) return;
  const g = gen;
  const { player, camera, audio } = ctx;
  if (!mf.seen) { mf.seen = true; sayUnfamiliar(mf); }
  busy = true;
  ctx.interact.enabled = false;
  await mf.lineDone;
  if (!alive(g)) return;

  // ---- The camera locks, and you look up at him. ----
  player.enabled = false;
  mf.revealing = true;
  mf.body.rotation.z = 0;
  const camPos = camera.position.clone();
  const q0 = camera.quaternion.clone(), q1 = new THREE.Quaternion(), m4 = new THREE.Matrix4();
  const rubyPos = () => { mf.group.updateMatrixWorld(true); return mf.ruby.getWorldPosition(V(0, 0, 0)); };
  const lookQ = (from, at) => q1.setFromRotationMatrix(m4.lookAt(from, at, camera.up));

  // His head turns down to face you while your view tilts up to his face (centred on where the ruby is).
  const h0 = { y: mf.head.rotation.y, z: mf.head.rotation.z, x: mf.head.rotation.x };
  const hp = mf.head.getWorldPosition(V(0, 0, 0));
  const yawT = THREE.MathUtils.clamp(lerpAngle(0, Math.atan2(camPos.x - mf.group.position.x, camPos.z - mf.group.position.z) - mf.group.rotation.y, 1), -1.2, 1.2);
  const pitchT = Math.atan2(hp.y - camPos.y, Math.hypot(hp.x - camPos.x, hp.z - camPos.z));
  audio.tone(55, 7, { type: 'sine', volume: 0.15 });
  audio.tone(58, 7, { type: 'sine', volume: 0.1 });
  await tween(2.2, (t) => {
    const e = ease(t);
    mf.head.rotation.set(h0.x + (pitchT - h0.x) * e, h0.y + (yawT - h0.y) * e, h0.z * (1 - e));
    camera.quaternion.copy(q0).slerp(lookQ(camPos, rubyPos()), e);
  });
  if (!alive(g)) return;
  await wait(0.5);
  if (!alive(g)) return;

  // ---- He slowly lays one long hand on top of his head... ----
  const arm = mf.arms[0];
  const crown = (dx, dy, dz) => mf.head.localToWorld(V(dx, dy, dz));
  mf.group.updateMatrixWorld(true);
  const rest = [arm.shoulder.rotation.x, arm.shoulder.rotation.z, arm.elbow.rotation.x];
  const onHead = solveArm(arm, crown(0, 0.48, -0.04));
  await tween(2.8, (t) => {
    const e = ease(t);
    poseArm(arm, rest, onHead, e);
    arm.fingers.forEach((f) => { f.rotation.x = 1.1 * e; }); // fingers curl down over the crown
    camera.quaternion.copy(lookQ(camPos, rubyPos()));
  });
  if (!alive(g)) return;
  await wait(0.8);
  if (!alive(g)) return;

  // ---- ...and lifts the black mask up and off. Nothing beneath but darkness, and a ruby. ----
  arm.hand.attach(mf.mask);
  audio.noise(0.4, { volume: 0.05 });
  const lifted = solveArm(arm, crown(-0.55, 1.1, 0.35));
  await tween(2.4, (t) => {
    poseArm(arm, onHead, lifted, ease(t));
    camera.quaternion.copy(lookQ(camPos, rubyPos()));
  });
  if (!alive(g)) return;
  const lowered = [0.15, -0.38, -0.35];
  await tween(1.8, (t) => {
    poseArm(arm, lifted, lowered, ease(t));
    arm.fingers.forEach((f) => { f.rotation.x = 1.1 - 0.5 * ease(t); });
    camera.quaternion.copy(lookQ(camPos, rubyPos()));
  });
  if (!alive(g)) return;
  await wait(1.0);
  if (!alive(g)) return;

  // ---- The ruby stays dead centre while the camera closes in, until it covers all four corners. ----
  const facing = V(0, 1, 0).transformDirection(mf.ruby.matrixWorld); // the gem's table faces out of his forehead
  const fov0 = camera.fov;
  const at = (d) => rubyPos().addScaledVector(facing, d);
  const start = camPos.clone();
  let covered = false;
  for (let t = 0; t < 1 && !covered;) {
    t = Math.min(1, t + (await nextFrame()) / 4.2);
    if (!alive(g)) return;
    const e = ease(t);
    camera.position.lerpVectors(start, at(0.12), e);
    camera.fov = fov0 + (12 - fov0) * e;
    camera.updateProjectionMatrix();
    camera.lookAt(rubyPos());
    covered = t > 0.5 && rubyFillsScreen(mf.ruby);
  }
  // Very wide screens may need a little more: keep creeping in (and narrowing) until every corner is ruby.
  let d = camera.position.distanceTo(rubyPos());
  for (let i = 0; i < 120 && !covered; i++) {
    await nextFrame();
    if (!alive(g)) return;
    d = Math.max(0.075, d * 0.985);
    camera.position.copy(at(d));
    camera.fov = Math.max(5, camera.fov * 0.99);
    camera.updateProjectionMatrix();
    camera.lookAt(rubyPos());
    covered = rubyFillsScreen(mf.ruby);
  }
  mf.coveredAtEnd = covered;
  await wait(0.5);
  if (!alive(g)) return;
  ctx.goTo(NEXT);
}

function setupShadows() {
  ctx.scene.traverse((o) => {
    if (!o.isMesh) return;
    for (let a = o; a; a = a.parent) if (a.userData.sky) { o.userData.noSSAO = true; return; }
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    o.receiveShadow = mats.some((m) => m.isMeshStandardMaterial);
    // Faded (see-through) characters, particles and custom shaders don't cast.
    o.castShadow = mats.every((m) => !m.transparent && !m.isShaderMaterial);
  });
}

// ---------- scene ----------
export default {
  name: NAME,

  init(c) {
    ctx = c;
    gen++;
    tasks = []; systems = []; fadables = []; pathPts = []; pathEnds = []; props = [[0, 0, 6], ...Object.values(SPOTS).map(([x, z]) => [x, z, 5])];
    time = 0; state = 'intro'; busy = false; shake = 0; sightT = 0;
    met = new Set(); unlocked = false; hedge = null;
    rand = mulberry32(7);
    pxScale = (window.innerHeight * Math.min(window.devicePixelRatio, 2)) / (2 * Math.tan(THREE.MathUtils.degToRad(ctx.camera.fov / 2)));

    buildWorld();
    buildKangaroo();
    buildInfernal();
    buildKite();
    buildRockGuardian();
    buildWaterGirl();
    buildTongueGuy();
    hydrant = buildHydrant();

    masked = buildMaskedFigure();

    progressEl = document.createElement('div');
    Object.assign(progressEl.style, {
      position: 'fixed', top: '18px', left: '50%', transform: 'translateX(-50%)', padding: '6px 14px', borderRadius: '999px',
      background: 'rgba(0,0,0,0.45)', color: '#fff', font: '600 15px system-ui, sans-serif', pointerEvents: 'none',
      zIndex: '20', opacity: '0', transition: 'opacity 0.6s',
    });
    document.body.appendChild(progressEl);
    if (new URLSearchParams(location.search).has('debug')) {
      onDebugKey = (e) => { if (e.code === 'KeyU' && ctx) openHedge(); }; // ?debug: U unlocks the final route
      window.addEventListener('keydown', onDebugKey);
    }
    setupShadows();

    // Tuned for the ACES pipeline: the bright pastels need exposure below 1 to keep their colour;
    // bloom only catches genuinely hot things (glowing eyes, portals, fire); light SSAO grounds the props.
    ctx.post?.set({ exposure: 0.62, bloomStrength: 0.5, bloomRadius: 0.55, bloomThreshold: 1.5, ssao: true, ssaoRadius: 0.6, vignette: 0.25 });

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
    confinePlayer();
    checkFirstSight(masked, dt);
    // Camera shake rides on top of wherever the player put the camera this frame.
    if (shake > 0) {
      const c = ctx.camera.position;
      c.x += (Math.random() - 0.5) * shake; c.y += (Math.random() - 0.5) * shake; c.z += (Math.random() - 0.5) * shake;
      shake = Math.max(0, shake - dt * 0.35);
    }
  },

  dispose() {
    gen++;
    tasks = []; systems = []; fadables = [];
    for (const t of texCache.values()) t.dispose(); // base textures (clones are disposed with the scene)
    texCache.clear();
    hydrant = null;
    masked = null;
    hedge = null;
    progressEl?.remove();
    progressEl = null;
    if (onDebugKey) window.removeEventListener('keydown', onDebugKey);
    onDebugKey = null;
    ctx = null;
  },
};
