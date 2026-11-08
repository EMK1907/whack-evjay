import * as THREE from 'three';

// Ending — docs/GAME.md §10 "The Ruby and the Final Error".
// Picks up exactly where Quirkland leaves off: the masked figure's ruby fills the screen.
//   1. The ruby begins to shine — a deep red glow builds inside it, light rays and glints break off its facets.
//   2. The error effect from the start of the game returns (ctx.effects.error).
//   3. Under the glitch the camera pulls back, up into a bird's-eye view of an infinite number of worlds —
//      the dark red city, the candy world, the white conveyor world and thousands more, drifting slowly.
//   4. The screen turns completely black.
//   5. A deep voice says exactly: "You will forever be in this loop, you cannot escape" (+ low rumble, subtitle).
//   6. Hold on black, then a small "LOOP" title. The game ends.
// ?debug: R restarts the ending.

const NAME = 'ending';
const LINE = 'You will forever be in this loop, you cannot escape';
const PULL_SEC = 13;

let ctx = null;
let gen = 0;
let time = 0;
let tasks = [];
let mode = 'gem';   // 'gem' (ruby close-up) | 'pull' (pull back over the worlds)
let shine = 0;      // 0–1: how hard the ruby is glowing
let camDist = 1.6;  // gem-mode camera distance
let pull = 0;       // 0–1: progress of the pull-back
let gem = null, ruby = null, core = null, rays = null, glints = [], beacon = null;
let uniforms = null, field = null, path = null, stars = null, sky = null;
let ui = null, subEl = null, titleEl = null, onKey = null;

const alive = (g) => ctx !== null && g === gen;
const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const _look = new THREE.Vector3(), _dir = new THREE.Vector3(), _tmp = new THREE.Vector3();
const LOOK_END = V(0, -60, -320);

function tween(sec, fn) {
  return new Promise((resolve) => {
    let t = 0;
    tasks.push((dt) => {
      t += dt;
      const k = Math.min(1, t / sec);
      fn(k);
      if (k >= 1) { resolve(); return false; }
      return true;
    });
  });
}
const wait = (sec) => tween(sec, () => {});

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const radialTex = () => canvasTex(128, 128, (g, w, h) => {
  const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(255,255,255,0.45)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, w, h);
});
const starTex = () => canvasTex(128, 128, (g, w, h) => {
  g.translate(w / 2, h / 2);
  for (const [a, len, th] of [[0, 62, 3], [Math.PI / 2, 62, 3], [Math.PI / 4, 30, 1.5], [-Math.PI / 4, 30, 1.5]]) {
    g.save(); g.rotate(a);
    const lg = g.createLinearGradient(-len, 0, len, 0);
    lg.addColorStop(0, 'rgba(255,255,255,0)'); lg.addColorStop(0.5, 'rgba(255,255,255,1)'); lg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = lg; g.fillRect(-len, -th / 2, len * 2, th);
    g.restore();
  }
  const r = g.createRadialGradient(0, 0, 0, 0, 0, 14);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(-14, -14, 28, 28);
});
const rayTex = () => canvasTex(64, 256, (g, w, h) => {
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = (x / (w - 1)) * 2 - 1, v = y / (h - 1); // v: 0 = tip (top), 1 = base
    const a = Math.exp(-u * u * 9) * Math.pow(v, 1.6);
    const i = (y * w + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = Math.round(a * 255);
  }
  g.putImageData(img, 0, 0);
});

// ---------- 1. the ruby ----------
function buildRuby() {
  gem = new THREE.Group();
  gem.rotation.x = Math.PI / 2; // table (local +y) faces the camera, like the end of the Quirkland zoom
  ctx.scene.add(gem);
  // Brilliant-ish cut: table, crown, girdle, deep pavilion. Flat-shaded facets catch the studio reflections.
  const prof = [[0.001, -1.05], [0.36, -0.64], [0.86, -0.1], [1, 0], [1, 0.07], [0.8, 0.27], [0.55, 0.4], [0.001, 0.4]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  ruby = new THREE.Mesh(new THREE.LatheGeometry(prof, 16), new THREE.MeshPhysicalMaterial({
    color: 0x6e000c, emissive: 0xb8000c, emissiveIntensity: 0.1, roughness: 0.05, metalness: 0,
    clearcoat: 1, clearcoatRoughness: 0.02, transmission: 0.55, thickness: 1.6, ior: 1.77,
    attenuationColor: new THREE.Color(0x5a0008), attenuationDistance: 0.45, envMapIntensity: 0.7, flatShading: true,
  }));
  gem.add(ruby);
  // The fire inside: a hot core seen through the stone.
  core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 2), new THREE.MeshBasicMaterial({ color: 0xff0010 }));
  core.position.y = -0.15;
  gem.add(core);
  // Studio-style highlights so every facet flashes as it turns.
  for (const [x, y, z, i] of [[2.5, 2, 4, 7], [-3, -1.5, 3, 4], [0, 3.5, -2, 4]]) {
    const l = new THREE.PointLight(0xffffff, i, 0, 2);
    l.position.set(x, y, z);
    ctx.scene.add(l);
  }

  // Light rays fanning out from behind the stone (camera-facing, additive, HDR so they bloom).
  rays = new THREE.Group();
  const rt = rayTex(), rnd = mulberry32(3);
  for (let i = 0; i < 22; i++) {
    const len = 2.4 + rnd() * 4.5, w = 0.12 + rnd() * 0.3;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, len).translate(0, len / 2 + 0.4, 0), new THREE.MeshBasicMaterial({
      map: rt, color: new THREE.Color(1, 0.02 + rnd() * 0.03, 0.05).multiplyScalar(1.4), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    m.userData = { a: (i / 22) * Math.PI * 2 + rnd() * 0.2, sp: (rnd() - 0.5) * 0.12, f: 0.6 + rnd() * 1.8, ph: rnd() * 6.28 };
    rays.add(m);
  }
  ctx.scene.add(rays);

  // Glints: star sparkles sitting on the crown facets, flashing in turn.
  const st = starTex(), pos = ruby.geometry.attributes.position, seen = new Set();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < 0.05) continue;
    const key = `${pos.getX(i).toFixed(2)},${y.toFixed(2)},${pos.getZ(i).toFixed(2)}`;
    if (seen.has(key) || rnd() > 0.35) continue;
    seen.add(key);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: st, color: new THREE.Color(1, 0.55, 0.6).multiplyScalar(3), blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
    }));
    s.position.set(pos.getX(i), y, pos.getZ(i)).multiplyScalar(1.02);
    s.userData = { sp: 0.9 + rnd() * 1.6, ph: rnd() * 6.28 };
    s.scale.setScalar(0.0001);
    ruby.add(s);
    glints.push(s);
  }

  // Beacon: once we pull back, the ruby stays visible as a small red star at the centre of everything.
  beacon = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTex(), color: new THREE.Color(1, 0.02, 0.05).multiplyScalar(2.5), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0,
  }));
  ctx.scene.add(beacon);
}

// ---------- 3. the infinite worlds ----------
const PLANET_VERT = `
  attribute float aKind; attribute vec3 aColA; attribute vec3 aColB; attribute float aSeed;
  uniform float uTime;
  varying vec3 vN; varying vec3 vP; varying vec3 vW; varying vec3 vA; varying vec3 vB; varying float vKind; varying float vSeed; varying float vDist;
  void main() {
    mat4 M = modelMatrix;
    #ifdef USE_INSTANCING
      M = M * instanceMatrix;
    #endif
    float a = uTime * (0.03 + aSeed * 0.12) + aSeed * 40.0;   // each world spins on its axis
    mat3 R = mat3(cos(a), 0.0, -sin(a), 0.0, 1.0, 0.0, sin(a), 0.0, cos(a));
    vP = R * normalize(position);
    vec4 w = M * vec4(position, 1.0);
    vW = w.xyz;
    vN = normalize(mat3(M) * position);
    vA = aColA; vB = aColB; vKind = aKind; vSeed = aSeed;
    vec4 mv = viewMatrix * w;
    vDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const NOISE = `
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise(vec3 x) {
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }`;
const PLANET_FRAG = `
  uniform float uTime; uniform vec3 uSun;
  varying vec3 vN; varying vec3 vP; varying vec3 vW; varying vec3 vA; varying vec3 vB; varying float vKind; varying float vSeed; varying float vDist;
  ${NOISE}
  void main() {
    vec3 N = normalize(vN), Vd = normalize(cameraPosition - vW), L = normalize(uSun);
    float ndl = dot(N, L), dif = max(ndl, 0.0), night = smoothstep(0.15, -0.3, ndl);
    float fr = pow(1.0 - max(dot(N, Vd), 0.0), 3.0);
    vec3 p = vP; float s = vSeed * 13.0;
    vec3 surf, emis = vec3(0.0);
    int k = int(vKind + 0.5);
    if (k == 0) {            // dark red city world (the inverted city): rust continents, glowing streets
      float n = fbm(p * 3.0 + s);
      surf = mix(vA * 0.25, vA * 0.7, n);
      float lit = step(0.84, hash(floor(p * 52.0) + s)) * smoothstep(0.38, 0.6, fbm(p * 5.0 + s));
      emis = vB * lit * (0.5 + 3.0 * night);
    } else if (k == 1) {     // bright candy world (Quirkland): swirled stripes, sugar speckles
      float b = sin(p.y * 10.0 + fbm(p * 2.5 + s) * 4.0 + atan(p.z, p.x) * 2.0);
      surf = mix(vA, vB, smoothstep(-0.25, 0.25, b));
      surf = mix(surf, vec3(1.0), smoothstep(0.8, 0.88, noise(p * 10.0 + s)) * 0.8);
      emis = surf * 0.06;
    } else if (k == 2) {     // gas giant: turbulent bands and a storm eye
      float lat = p.y + (fbm(p * vec3(2.0, 7.0, 2.0) + s) - 0.5) * 0.3;
      surf = mix(vA, vB, 0.5 + 0.5 * sin(lat * 19.0 + s));
      surf *= 0.85 + 0.3 * fbm(p * 9.0 + s);
      float eye = 1.0 - smoothstep(0.0, 0.18, length(p - normalize(vec3(0.7, -0.25, 0.6))));
      surf = mix(surf, vB * 1.4, eye * 0.7);
    } else if (k == 3) {     // ocean world with continents, ice caps and city lights on the night side
      float n = fbm(p * 2.2 + s);
      float land = smoothstep(0.5, 0.53, n);
      surf = mix(vB, vA * (0.6 + 0.6 * fbm(p * 8.0 + s)), land);
      surf = mix(surf, vec3(0.92), smoothstep(0.78, 0.95, abs(p.y)));
      emis = vec3(1.0, 0.7, 0.35) * step(0.9, hash(floor(p * 64.0) + s)) * land * night * 1.6;
    } else if (k == 4) {     // white/ice world (the conveyor world): pale, faceted glow at the rim
      float n = fbm(p * 4.0 + s);
      surf = mix(vA, vB, n);
      emis = vA * fr * 0.3;
    } else {                 // lava world: black crust, glowing cracks
      float n = fbm(p * 3.5 + s);
      surf = vec3(0.05, 0.025, 0.02) * (0.5 + n);
      emis = vA * (1.0 - smoothstep(0.0, 0.045, abs(n - 0.5))) * 3.5;
    }
    vec3 col = surf * (0.03 + dif * 0.95) + emis;
    col += mix(vA, vec3(1.0), 0.25) * fr * (0.2 + 0.8 * dif) * 0.75;   // atmosphere rim
    col *= smoothstep(3400.0, 500.0, vDist);                              // the far worlds fade into the dark
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`;

function planetMaterial() {
  return new THREE.ShaderMaterial({ uniforms, vertexShader: PLANET_VERT, fragmentShader: PLANET_FRAG });
}

const KINDS = [
  // [weight, colour A choices, colour B choices]
  [0.2, [0x8a0f12, 0x6e0c18, 0x9c1a0e], [0xff3a1e, 0xff5530]],          // dark red city
  [0.2, [0xff8fc8, 0xffb347, 0x9fd8ff, 0xc9a7ff], [0xffffff, 0x9ff0d0, 0xfff07a]], // candy
  [0.18, [0xd9a066, 0x6d7cff, 0xc4b27a, 0x9e5bd8], [0xf3e1c0, 0x2b2f7a, 0x6e5530, 0xffd0f0]], // gas giant
  [0.16, [0x5aa64a, 0xb08850, 0x7a9a40], [0x0d3a7a, 0x0a4e6e]],          // ocean world
  [0.14, [0xbfe6ff, 0xffffff, 0xd8d8e8], [0x7aa0c8, 0xb8c0d0]],          // ice / white
  [0.12, [0xff5a14, 0xff2a0a], [0x000000]],                              // lava
];
function pickKind(r) {
  let a = 0;
  for (let i = 0; i < KINDS.length; i++) { a += KINDS[i][0]; if (r < a) return i; }
  return 0;
}

function buildWorlds() {
  const rnd = mulberry32(11);
  field = new THREE.Group();
  ctx.scene.add(field);

  // The camera's flight path (ruby → high bird's-eye) — keep worlds out of its way.
  path = new THREE.CatmullRomCurve3([V(0, 0, 4), V(3, 3, 17), V(20, 28, 62), V(45, 120, 160), V(0, 360, 250)], false, 'centripetal');
  const pathPts = path.getSpacedPoints(80);

  const makeSet = (geo, list) => {
    const n = list.length;
    const mesh = new THREE.InstancedMesh(geo, planetMaterial(), n);
    const kind = new Float32Array(n), ca = new Float32Array(n * 3), cb = new Float32Array(n * 3), seed = new Float32Array(n);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), c = new THREE.Color();
    list.forEach((w, i) => {
      q.setFromEuler(e.set(w.tilt, 0, w.tilt * 0.6));
      mesh.setMatrixAt(i, m4.compose(w.pos, q, V(w.r, w.r, w.r)));
      kind[i] = w.kind; seed[i] = w.seed;
      c.set(w.a); ca.set([c.r, c.g, c.b], i * 3);
      c.set(w.b); cb.set([c.r, c.g, c.b], i * 3);
    });
    geo.setAttribute('aKind', new THREE.InstancedBufferAttribute(kind, 1));
    geo.setAttribute('aColA', new THREE.InstancedBufferAttribute(ca, 3));
    geo.setAttribute('aColB', new THREE.InstancedBufferAttribute(cb, 3));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
    mesh.frustumCulled = false;
    field.add(mesh);
    return mesh;
  };

  // Hero worlds right beside the ruby: the places this game has been.
  const heroes = [
    { pos: V(15, -4, -13), r: 6, kind: 0, a: 0x8a0f12, b: 0xff3a1e, tilt: 0.3, seed: 0.21 },   // the dark red city
    { pos: V(-14, 3, -21), r: 5, kind: 1, a: 0xff8fc8, b: 0x9ff0d0, tilt: -0.25, seed: 0.57 }, // the candy world
    { pos: V(5, 8, -36), r: 3.6, kind: 4, a: 0xffffff, b: 0xb8c0d0, tilt: 0.1, seed: 0.83 },   // the white conveyor world
    { pos: V(-6, -9, -55), r: 9, kind: 2, a: 0x9e5bd8, b: 0xffd0f0, tilt: 0.5, seed: 0.34 },
  ];
  makeSet(new THREE.SphereGeometry(1, 96, 64), heroes);

  // A candy-striped ring round the candy world.
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.45, 2.35, 160, 1), new THREE.ShaderMaterial({
    transparent: true, side: THREE.DoubleSide, depthWrite: false,
    vertexShader: 'varying vec3 vP; void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec3 vP;
      void main() {
        float r = length(vP.xy);
        float band = step(0.5, fract(r * 7.0));
        vec3 c = mix(vec3(1.0, 0.32, 0.6), vec3(1.0, 0.95, 0.97), band);
        float a = smoothstep(1.45, 1.55, r) * (1.0 - smoothstep(2.2, 2.35, r)) * 0.85;
        gl_FragColor = vec4(c * 0.9, a);
        #include <colorspace_fragment>
      }`,
  }));
  ring.position.copy(heroes[1].pos);
  ring.scale.setScalar(heroes[1].r);
  ring.rotation.set(-Math.PI / 2 + 0.45, 0.2, 0);
  field.add(ring);

  // Thousands more, out to the horizon.
  const crowd = [];
  for (let tries = 0; crowd.length < 3600 && tries < 20000; tries++) {
    const ang = rnd() * Math.PI * 2, dist = 70 + Math.pow(rnd(), 1.4) * 2900;
    const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
    const g = (rnd() + rnd() + rnd() - 1.5) / 1.5;
    const y = g * (40 + dist * 0.04);
    const r = 0.8 + Math.pow(rnd(), 2.6) * 24;
    const pos = V(x, y, z);
    if (heroes.some((h) => h.pos.distanceTo(pos) < h.r + r + 6)) continue;
    if (pathPts.some((p) => p.distanceTo(pos) < r + 30)) continue;
    const kind = pickKind(rnd());
    const [, as, bs] = KINDS[kind];
    crowd.push({ pos, r, kind, a: as[Math.floor(rnd() * as.length)], b: bs[Math.floor(rnd() * bs.length)], tilt: (rnd() - 0.5) * 0.8, seed: rnd() });
  }
  makeSet(new THREE.IcosahedronGeometry(1, 3), crowd);

  // Beyond those: countless distant worlds as points of light, and the stars behind them.
  const dots = (n, place, size, colors) => {
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), sz = new Float32Array(n), c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      place(i, pos);
      c.set(colors[Math.floor(rnd() * colors.length)]).multiplyScalar(0.6 + rnd() * 0.9);
      col.set([c.r, c.g, c.b], i * 3);
      sz[i] = size * (0.4 + rnd() * 1.2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sz, 1));
    const pts = new THREE.Points(geo, new THREE.ShaderMaterial({
      uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
      vertexShader: `attribute float size; uniform float uScale; uniform float uTime; varying vec3 vC; varying float vF;
        void main() {
          vC = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vF = 0.75 + 0.25 * sin(uTime * 1.3 + position.x * 0.05 + position.z * 0.07);
          gl_PointSize = clamp(size * uScale / max(1.0, -mv.z), 1.0, 14.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying vec3 vC; varying float vF;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          gl_FragColor = vec4(vC * vF, smoothstep(0.5, 0.0, d));
          #include <colorspace_fragment>
        }`,
    }));
    pts.frustumCulled = false;
    return pts;
  };
  const worldCols = [0xff3a2a, 0xff8fc8, 0x9fd8ff, 0xffd27a, 0xc9a7ff, 0xffffff, 0x7affc8];
  field.add(dots(26000, (i, a) => {
    const ang = rnd() * Math.PI * 2, d = 800 + Math.pow(rnd(), 0.8) * 3600;
    a.set([Math.cos(ang) * d, (rnd() + rnd() - 1) * (60 + d * 0.06), Math.sin(ang) * d], i * 3);
  }, 30, worldCols));
  stars = dots(7000, (i, a) => {
    _tmp.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize().multiplyScalar(4500);
    a.set([_tmp.x, _tmp.y, _tmp.z], i * 3);
  }, 14, [0xffffff, 0xcfe0ff, 0xffe6cf]);
  ctx.scene.add(stars);

  // A faint nebula behind everything, so the dark has depth.
  sky = new THREE.Mesh(new THREE.SphereGeometry(4700, 48, 32), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: 'varying vec3 vD; void main() { vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec3 vD; ${NOISE}
      void main() {
        float n = fbm(vD * 3.0 + 4.0), m = fbm(vD * 6.0 - 2.0);
        vec3 c = mix(vec3(0.05, 0.0, 0.015), vec3(0.03, 0.0, 0.06), m) * smoothstep(0.35, 0.8, n);
        c += vec3(0.08, 0.005, 0.02) * pow(smoothstep(0.55, 0.9, n), 2.0);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  }));
  ctx.scene.add(sky);
}

// ---------- 5–6. voice, subtitle, title ----------
const LINE_CSS = `
.end-line { position: absolute; left: 50%; top: 47%; transform: translate(-50%, -50%); width: min(92vw, 1500px); text-align: center;
  font-family: 'Rubik Wet Paint', 'Arial Black', Impact, sans-serif; font-weight: 900; font-size: clamp(44px, 7.4vw, 124px);
  line-height: 1.22; letter-spacing: 0.02em; transition: opacity 1.6s ease; }
.end-line.live { animation: end-flicker 5s steps(1) infinite; }
@keyframes end-flicker { 0%, 100% { opacity: 1; } 41% { opacity: 0.86; } 42% { opacity: 1; } 77% { opacity: 0.92; } 78% { opacity: 1; } }
.end-w { display: inline-block; position: relative; margin: 0 0.15em; opacity: 0; transform: translateY(0.3em) scale(1.3); filter: blur(12px);
  transition: opacity 0.9s ease, transform 1s cubic-bezier(0.2, 0.9, 0.25, 1.25), filter 0.9s ease; }
.end-w.on { opacity: 1; transform: none; filter: blur(0); }
.end-g { display: inline-block; color: transparent; -webkit-background-clip: text; background-clip: text;
  background-image: linear-gradient(180deg, #ff8a8a 0%, #ff2433 20%, #cc0012 52%, #74000a 82%, #3c0004 100%);
  filter: drop-shadow(0 0.045em 0 #2a0002) drop-shadow(0 0 0.22em rgba(255, 0, 28, 0.5)) drop-shadow(0 0.16em 0.12em rgba(0, 0, 0, 0.95));
  animation: end-wob var(--d, 3s) ease-in-out var(--dl, 0s) infinite alternate; }
@keyframes end-wob { from { transform: translateY(-0.025em) rotate(-1.4deg) scale(1); } to { transform: translateY(0.035em) rotate(1.4deg) scale(1.035); } }
.end-drip { position: absolute; top: 0.8em; width: var(--w); height: 0; border-radius: 0 0 999px 999px; z-index: -1;
  background: linear-gradient(180deg, #6a0007, #a8000e 55%, #d0101e); box-shadow: 0 0.05em 0.08em rgba(0, 0, 0, 0.85);
  animation: end-drip var(--t) cubic-bezier(0.55, 0, 0.85, 0.55) var(--dl) forwards; }
.end-drip::after { content: ''; position: absolute; left: 50%; bottom: -0.06em; width: 175%; aspect-ratio: 1 / 1.2; transform: translateX(-50%);
  border-radius: 50% 50% 50% 50% / 38% 38% 62% 62%; background: radial-gradient(circle at 34% 30%, #ff5a5f, #b0000e 55%, #4e0005); }
.end-w:not(.on) .end-drip { animation-play-state: paused; }
@keyframes end-drip { to { height: var(--h); } }
`;

function buildUI() {
  if (!document.querySelector('link[data-end-font]')) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Rubik+Wet+Paint&display=swap';
    l.dataset.endFont = '1';
    document.head.appendChild(l);
  }
  document.fonts?.load('400 80px "Rubik Wet Paint"').catch(() => {});
  ui = document.createElement('div');
  Object.assign(ui.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '40' });
  const css = document.createElement('style');
  css.textContent = LINE_CSS;
  subEl = document.createElement('div');
  subEl.className = 'end-line';
  subEl.style.opacity = '0';
  titleEl = document.createElement('div');
  titleEl.textContent = 'LOOP';
  Object.assign(titleEl.style, {
    position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', paddingLeft: '0.9em',
    color: 'rgba(255,255,255,0.9)', font: '300 clamp(16px, 1.6vw, 22px) "Helvetica Neue", system-ui, sans-serif',
    letterSpacing: '0.9em', opacity: '0', transition: 'opacity 3.5s ease',
  });
  ui.append(css, subEl, titleEl);
  document.body.appendChild(ui);
}

// Builds the line as separate words (hidden), each with its own sway and a few blood drips.
function setLine(text) {
  subEl.textContent = '';
  const rnd = mulberry32(5);
  return text.split(' ').map((w) => {
    const word = document.createElement('span');
    word.className = 'end-w';
    const glyphs = document.createElement('span');
    glyphs.className = 'end-g';
    glyphs.textContent = w;
    glyphs.style.setProperty('--d', `${(2.2 + rnd() * 1.8).toFixed(2)}s`);
    glyphs.style.setProperty('--dl', `${(-rnd() * 3).toFixed(2)}s`);
    word.appendChild(glyphs);
    const n = w.length <= 2 ? (rnd() < 0.4 ? 1 : 0) : 1 + (rnd() < 0.55 ? 1 : 0) + (w.length > 5 && rnd() < 0.5 ? 1 : 0);
    for (let k = 0; k < n; k++) {
      const d = document.createElement('span');
      d.className = 'end-drip';
      d.style.left = `${(8 + rnd() * 78).toFixed(1)}%`;
      d.style.setProperty('--w', `${(0.05 + rnd() * 0.06).toFixed(3)}em`);
      d.style.setProperty('--h', `${(0.2 + Math.pow(rnd(), 1.5) * 0.95).toFixed(2)}em`);
      d.style.setProperty('--t', `${(3 + rnd() * 5).toFixed(2)}s`);
      d.style.setProperty('--dl', `${(0.5 + rnd() * 1.8).toFixed(2)}s`);
      word.appendChild(d);
    }
    subEl.appendChild(word);
    return word;
  });
}

function speak(text, onWord) {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    setTimeout(fin, 9500);
    if (!synth) { setTimeout(fin, 4500); return; }
    const go = () => {
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const vs = synth.getVoices().filter((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
      const pref = ['Ralph', 'Daniel', 'Arthur', 'Fred', 'Google UK English Male', 'Microsoft Guy', 'Microsoft David', 'Alex', 'Aaron'];
      let v = null;
      for (const n of pref) { v = vs.find((x) => x.name.includes(n)); if (v) break; }
      if (!v) v = vs.find((x) => /\bmale\b/i.test(x.name)) || vs[0];
      if (v) u.voice = v;
      u.pitch = 0.05; u.rate = 0.7; u.volume = 1;
      u.onend = fin; u.onerror = fin;
      u.onboundary = (ev) => { if (onWord && ev.charIndex != null) onWord(ev.charIndex); };
      synth.speak(u);
    };
    if (synth.getVoices().length) go();
    else {
      let started = false;
      const s = () => { if (!started) { started = true; go(); } };
      synth.addEventListener('voiceschanged', s, { once: true });
      setTimeout(s, 700);
    }
  });
}

function rumble(audio) {
  audio.tone(31, 7, { type: 'sine', volume: 0.3 });
  audio.tone(32.7, 7, { type: 'sine', volume: 0.22 });
  audio.tone(46, 5, { type: 'triangle', volume: 0.06 });
  audio.noise(3.5, { volume: 0.035 });
}

// ---------- the sequence ----------
async function run(g) {
  const { audio, effects } = ctx;
  // 1. The ruby begins to shine.
  audio.tone(55, 7, { type: 'sine', volume: 0.14 });
  audio.tone(82.4, 6, { type: 'sine', volume: 0.06 });
  audio.tone(110, 5.5, { type: 'triangle', volume: 0.025 });
  let chime = 0;
  await tween(5.2, (k) => {
    shine = smoother(k);
    camDist = 1.6 + (4.2 - 1.6) * smoother(Math.min(1, k * 1.1));
    if (k > chime) { chime += 0.17; audio.tone(1760 + Math.random() * 1400, 0.9, { type: 'sine', volume: 0.015 + 0.02 * k }); }
  });
  if (!alive(g)) return;
  await wait(0.6); if (!alive(g)) return;

  // 2. The error from the beginning of the game returns...
  const err = effects.error({ duration: 2800, audio });
  await wait(1.3); if (!alive(g)) return;
  // 3. ...and under it, we pull away: the ruby is one world among infinitely many.
  mode = 'pull';
  ruby.material.transmission = 0; // the transmission pass would re-render every world — not needed from far away
  ruby.material.needsUpdate = true;
  audio.tone(36, 13, { type: 'sine', volume: 0.16 });
  audio.tone(54, 12, { type: 'sine', volume: 0.07 });
  audio.tone(72.5, 10, { type: 'triangle', volume: 0.02 });
  const s0 = shine;
  const pulling = tween(PULL_SEC, (k) => { pull = k; shine = s0 * (1 - 0.75 * smoother(Math.min(1, k * 4))); });
  await err;
  await pulling; if (!alive(g)) return;
  await wait(2.2); if (!alive(g)) return;

  // 4. The screen turns completely black.
  effects.setFade(1);
  await wait(1.8); if (!alive(g)) return;

  // 5. A deep voice.
  rumble(audio);
  const words = setLine(LINE);
  subEl.style.opacity = '1';
  subEl.classList.add('live');
  // Each word fades in as it is spoken (speech word boundaries), with a steady schedule as the fallback.
  let shown = -1;
  const show = (i) => { while (shown < Math.min(i, words.length - 1)) words[++shown].classList.add('on'); };
  words.forEach((_, i) => setTimeout(() => { if (alive(g)) show(i); }, 300 + i * 430));
  const onWord = (charIndex) => { if (alive(g)) show(LINE.slice(0, charIndex).split(' ').length - 1); };
  await Promise.all([speak(LINE, onWord), wait(words.length * 0.43 + 1.2)]);
  if (!alive(g)) return;
  show(words.length - 1);
  await wait(2.6); if (!alive(g)) return;
  subEl.style.opacity = '0';
  await wait(2.6); if (!alive(g)) return;

  // 6. The game ends.
  titleEl.style.opacity = '1';
  audio.tone(41, 6, { type: 'sine', volume: 0.08 });
}

// ---------- scene ----------
export default {
  name: NAME,

  async init(c) {
    ctx = c;
    gen++;
    const g = gen;
    tasks = []; glints = [];
    time = 0; mode = 'gem'; shine = 0; camDist = 1.6; pull = 0;
    const { scene, camera, player } = ctx;
    scene.background = new THREE.Color(0x000000);
    player.enabled = false; // the scene drives the camera from here to the end
    camera.fov = 35;
    camera.updateProjectionMatrix();
    camera.position.set(0, 0, camDist);
    camera.lookAt(0, 0, 0);
    ctx.post?.set({ exposure: 0.9, bloomStrength: 0.6, bloomRadius: 0.7, bloomThreshold: 1.0, ssao: false, vignette: 0.55 });
    try { await ctx.setEnvironment('assets/hdri/white_studio_05_1k.hdr', { background: false }); } catch (e) { console.warn(e); }
    if (!alive(g)) return;

    uniforms = { uTime: { value: 0 }, uSun: { value: V(-0.55, 0.6, 0.5) }, uScale: { value: 700 } };
    buildRuby();
    buildWorlds();
    buildUI();

    if (new URLSearchParams(location.search).has('debug')) {
      onKey = (e) => { if (ctx && !e.repeat && e.code === 'KeyR') ctx.goTo(NAME); };
      window.addEventListener('keydown', onKey);
    }
    run(g);
  },

  update(dt) {
    if (!ctx || !uniforms) return;
    time += dt;
    const run = tasks;
    tasks = [];
    for (const fn of run) if (fn(dt) !== false) tasks.push(fn);

    const { camera } = ctx;
    uniforms.uTime.value = time;
    uniforms.uScale.value = window.innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    field.rotation.y = time * 0.0022;
    field.visible = stars.visible = sky.visible = mode === 'pull'; // the close-up is just the stone in the dark

    // The ruby: slow turn, and the fire inside building with `shine`.
    ruby.rotation.y = time * 0.16;
    const e = shine, flick = 0.93 + 0.07 * Math.sin(time * 6.3) * Math.sin(time * 2.1);
    ruby.material.emissiveIntensity = 0.1 + 0.95 * e * e * flick;
    core.material.color.setRGB(1, 0.0, 0.03).multiplyScalar(0.8 + 5 * e * flick);
    if (mode === 'gem') ctx.post.bloomStrength = 0.6 + 0.6 * e;

    // Rays and glints only belong to the close-up.
    rays.visible = mode === 'gem' && e > 0.01;
    if (rays.visible) {
      camera.getWorldDirection(_dir);
      rays.position.copy(_dir).multiplyScalar(0.7); // just behind the stone, so it occludes their roots
      rays.quaternion.copy(camera.quaternion);
      for (const r of rays.children) {
        const u = r.userData;
        r.rotation.z = u.a + time * u.sp;
        r.material.opacity = e * (0.25 + 0.75 * Math.pow(0.5 + 0.5 * Math.sin(time * u.f + u.ph), 2));
        r.scale.y = 0.35 + 0.85 * e + 0.12 * Math.sin(time * u.f * 0.7 + u.ph);
      }
    }
    for (const s of glints) {
      const u = s.userData;
      s.visible = mode === 'gem';
      s.scale.setScalar(1e-4 + e * 0.55 * Math.pow(Math.max(0, Math.sin(time * u.sp + u.ph)), 16));
    }

    // Camera.
    if (mode === 'gem') {
      camera.position.set(Math.sin(time * 0.31) * 0.05 * camDist, Math.sin(time * 0.23) * 0.04 * camDist, camDist);
      camera.lookAt(0, 0, 0);
    } else {
      const p = smoother(pull);
      path.getPointAt(Math.min(1, p), camera.position);
      // a slow drift keeps going once we arrive
      camera.position.x += Math.sin(time * 0.06) * 6 * p;
      _look.set(0, 0, 0).lerp(LOOK_END, smoother(Math.min(1, pull * 1.25)));
      camera.lookAt(_look);
      camera.fov = 35 + 23 * p;
      camera.updateProjectionMatrix();
      ctx.post.bloomStrength = 0.75 - 0.2 * p;
    }
    // The ruby as a red star at the centre once we're away from it.
    const d = camera.position.length();
    beacon.material.opacity = mode === 'pull' ? Math.min(1, Math.max(0, (d - 6) / 20)) : 0;
    beacon.scale.setScalar(Math.max(1, d * 0.022));
  },

  dispose() {
    gen++;
    tasks = [];
    try { window.speechSynthesis?.cancel(); } catch {}
    ui?.remove();
    ui = subEl = titleEl = null;
    if (onKey) window.removeEventListener('keydown', onKey);
    onKey = null;
    gem = ruby = core = rays = beacon = field = path = uniforms = stars = sky = null;
    glints = [];
    ctx = null;
  },
};
