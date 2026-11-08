import * as THREE from 'three';

// The void of worlds — shared by the ending (bird's-eye pull-back) and the main menu (its backdrop).
// buildVoid(scene, uniforms) adds everything to `scene` and returns { field, path, vortex, stars, sky }.
// `uniforms` must hold { uTime, uScale } (updated by the caller every frame).
// `path` is the ending's camera flight from the ruby (origin) up to the bird's-eye view; its last point is that view.

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const _tmp = new THREE.Vector3();
export const VOID_LOOK = V(-60, -200, -520); // where the bird's-eye camera looks: down over the specks, the vortex below

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 3. the infinite worlds: a void full of specks, each one a world ----------
const NOISE = `
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise(vec3 x) {
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }`;

// Every world is a glowing speck: a hot core, a soft halo, and for some a faint ring or a twin.
const SPECK_VERT = `
  attribute float size; attribute float kind; attribute float seed;
  uniform float uScale; uniform float uTime;
  varying vec3 vC; varying float vK; varying float vTw; varying float vFade;
  void main() {
    vC = color; vK = kind;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float d = max(1.0, -mv.z);
    vTw = 0.7 + 0.3 * sin(uTime * (0.6 + seed * 2.0) + seed * 40.0);
    vFade = smoothstep(5200.0, 900.0, d);
    gl_PointSize = clamp(size * uScale / d, 2.4, 96.0);
    gl_Position = projectionMatrix * mv;
  }`;
const SPECK_FRAG = `
  varying vec3 vC; varying float vK; varying float vTw; varying float vFade;
  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float d = length(q);
    if (d > 0.5) discard;
    float core = smoothstep(0.16, 0.0, d);
    float halo = exp(-d * d * 30.0);
    float ring = vK > 0.5 && vK < 1.5 ? exp(-pow((d - 0.33) / 0.035, 2.0)) * 0.6 : 0.0;
    float twin = vK > 1.5 ? smoothstep(0.07, 0.0, length(q - vec2(0.22, -0.12))) : 0.0;
    vec3 c = vC * (halo * 1.1 + ring * 1.3 + twin * 1.6) + mix(vC, vec3(1.0), 0.45) * core * 2.4;
    gl_FragColor = vec4(c * vTw * vFade, 1.0);
    #include <colorspace_fragment>
  }`;

// The void below: an icy vortex (the loop), mist pouring off it, ink blots and white splatter.
const VORTEX_FRAG = `
  uniform float uTime; varying vec2 vUv;
  ${NOISE}
  void main() {
    vec2 p = (vUv - 0.5) * 2.0;            // -1..1 across the plane
    vec2 v = p * 2.6;                      // vortex space (ring at r ≈ 0.42)
    float r = length(v), a = atan(v.y, v.x);
    float sw = a + 1.6 / (r + 0.12) - uTime * 0.12;               // spiral arms wind into the hole
    vec3 sp = vec3(cos(sw) * r * 5.0, sin(sw) * r * 5.0, uTime * 0.04);
    float streak = fbm(sp), fine = fbm(sp * 3.0 + 9.0);
    float rim = exp(-pow((r - 0.42) / 0.035, 2.0));
    float rim2 = exp(-pow((r - 0.56) / 0.06, 2.0)) * 0.45;
    float disk = smoothstep(0.24, 0.32, r) * (1.0 - smoothstep(0.5, 0.95, r));
    float halo = exp(-pow((r - 0.45) / 0.3, 2.0));
    float hole = 1.0 - smoothstep(0.2, 0.26, r);
    vec3 ice = vec3(0.22, 0.48, 1.0), pale = vec3(0.7, 0.88, 1.0);
    vec3 col = ice * (rim * 1.5 + rim2 * 0.6 + halo * 0.18) + mix(ice, pale, fine) * disk * pow(streak, 2.0) * 0.95;
    col += pale * pow(fine, 7.0) * disk * 2.2;                    // bright sparkling filaments
    // mist plume streaming off to one side, like smoke
    vec2 m = vec2(p.x * 1.6 - 0.25, p.y * 3.4);
    float plume = fbm(vec3(m * 2.4 + vec2(-uTime * 0.03, 0.0), 2.0)) * smoothstep(-0.1, 0.5, p.x) * exp(-m.y * m.y * 1.5) * (1.0 - smoothstep(0.6, 1.0, length(p)));
    col += ice * 0.3 * smoothstep(0.4, 0.85, plume);
    // black ink blots clinging to the ring
    float blotMask = smoothstep(0.55, 0.7, noise(vec3(a * 1.3, 3.0, 1.0))) * smoothstep(0.28, 0.36, r) * (1.0 - smoothstep(0.6, 0.72, r));
    float blot = smoothstep(0.6, 0.64, fbm(vec3(v * 7.0, 5.0))) * blotMask;
    // white splatter thrown out to the far side
    float splMask = smoothstep(0.2, 0.45, p.x - p.y * 0.6) * (1.0 - smoothstep(0.2, 0.42, length(p - vec2(0.33, -0.2))));
    float splat = smoothstep(0.66, 0.69, fbm(vec3(p * 9.0, 11.0))) * splMask;
    col = mix(col, vec3(0.0), blot);
    col = mix(col, vec3(1.0), splat);
    col *= 1.0 - hole;
    float alpha = clamp(max(max(hole, blot), max(splat, length(col) * 0.9)), 0.0, 1.0) * (1.0 - smoothstep(0.85, 1.0, length(p)));
    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
  }`;

const WORLD_COLS = [
  [0.16, [1.0, 0.16, 0.12]],   // dark red cities
  [0.12, [1.0, 0.45, 0.78]],   // candy worlds
  [0.14, [1.0, 1.0, 1.0]],     // white worlds
  [0.22, [0.5, 0.78, 1.0]],    // ice-blue worlds
  [0.12, [0.35, 0.55, 1.0]],   // deep blue
  [0.09, [1.0, 0.78, 0.4]],    // gold
  [0.08, [0.72, 0.5, 1.0]],    // violet
  [0.07, [0.45, 1.0, 0.85]],   // mint
];
function pickCol(r) {
  let a = 0;
  for (const [w, c] of WORLD_COLS) { a += w; if (r < a) return c; }
  return WORLD_COLS[0][1];
}

function speckPoints(list, uniforms) {
  const n = list.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), kind = new Float32Array(n), seed = new Float32Array(n);
  list.forEach((w, i) => {
    pos.set(w.p, i * 3); col.set(w.c, i * 3); size[i] = w.s; kind[i] = w.k; seed[i] = w.seed;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('kind', new THREE.BufferAttribute(kind, 1));
  geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const pts = new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms, vertexShader: SPECK_VERT, fragmentShader: SPECK_FRAG, vertexColors: true,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  pts.frustumCulled = false;
  return pts;
}

export function buildVoid(scene, uniforms) {
  const rnd = mulberry32(11);
  const field = new THREE.Group();
  scene.add(field);

  // The camera's flight path (ruby → high bird's-eye) — keep specks from sitting right on the lens.
  const path = new THREE.CatmullRomCurve3([V(0, 0, 4), V(3, 3, 17), V(20, 28, 62), V(45, 120, 160), V(0, 360, 250)], false, 'centripetal');
  const pathPts = path.getSpacedPoints(60);
  const nearPath = (x, y, z, r) => pathPts.some((p) => (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2 < r * r);

  const list = [];
  // The worlds this game has been through, right beside the ruby.
  list.push({ p: [15, -4, -13], c: [1.0, 0.12, 0.08], s: 3.2, k: 0, seed: 0.2 });   // the dark red city
  list.push({ p: [-14, 3, -21], c: [1.0, 0.5, 0.82], s: 3.0, k: 1, seed: 0.5 });    // the candy world
  list.push({ p: [5, 8, -36], c: [1.0, 1.0, 1.0], s: 2.6, k: 0, seed: 0.8 });       // the white conveyor world
  // Countless more, spread through the void to the horizon.
  for (let tries = 0; list.length < 60000 && tries < 120000; tries++) {
    const ang = rnd() * Math.PI * 2, dist = 18 + Math.pow(rnd(), 1.35) * 3800;
    const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
    const y = (rnd() + rnd() + rnd() - 1.5) / 1.5 * (30 + dist * 0.05);
    if (dist < 400 && nearPath(x, y, z, 10)) continue;
    const big = rnd();
    const s = big > 0.995 ? 9 + rnd() * 8 : big > 0.95 ? 4 + rnd() * 4 : 1.2 + rnd() * 2.6;
    const kr = rnd();
    list.push({ p: [x, y, z], c: pickCol(rnd()).map((v) => v * (0.75 + rnd() * 0.6)), s, k: kr > 0.93 ? 1 : kr > 0.88 ? 2 : 0, seed: rnd() });
  }
  field.add(speckPoints(list, uniforms));

  // The vortex in the void beneath it all — the loop itself — slowly turning.
  const vortex = new THREE.Mesh(new THREE.PlaneGeometry(2600, 2600), new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: VORTEX_FRAG,
  }));
  vortex.rotation.x = -Math.PI / 2;
  vortex.position.set(-200, -460, -700);
  vortex.renderOrder = -1;
  scene.add(vortex);

  // Debris around it: black ink flecks and white spray (normal blending so the black reads as black).
  const fleck = (n, place, color, size) => {
    const pos = new Float32Array(n * 3), sz = new Float32Array(n);
    for (let i = 0; i < n; i++) { place(pos, i); sz[i] = size * (0.4 + rnd() * 1.4); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sz, 1));
    const pts = new THREE.Points(geo, new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uCol: { value: new THREE.Color(...color) } }, transparent: true, depthWrite: false,
      vertexShader: `attribute float size; uniform float uScale; varying float vF;
        void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vF = smoothstep(3000.0, 600.0, -mv.z);
          gl_PointSize = clamp(size * uScale / max(1.0, -mv.z), 1.0, 40.0); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uCol; varying float vF;
        void main() { vec2 q = gl_PointCoord - 0.5; q.x *= 1.6; float d = length(q); if (d > 0.5) discard;
          gl_FragColor = vec4(uCol, smoothstep(0.5, 0.3, d) * vF);
          #include <colorspace_fragment>
        }`,
    }));
    pts.frustumCulled = false;
    vortex.add(pts);
    return pts;
  };
  // (vortex-local: plane spans ±1300 in x/y; +z is up off the plane)
  fleck(1100, (a, i) => { const ang = rnd() * 6.28, r = 150 + rnd() * 200; a.set([Math.cos(ang) * r, Math.sin(ang) * r, 5 + rnd() * 120], i * 3); }, [0, 0, 0], 9);
  fleck(1600, (a, i) => { const t = rnd(); a.set([220 + t * 500 + (rnd() - 0.5) * 200, -(100 + t * 300) + (rnd() - 0.5) * 200, 5 + rnd() * 60], i * 3); }, [1.2, 1.25, 1.3], 6);

  // Tiny white specks everywhere, the void's dust.
  const dust = [];
  for (let i = 0; i < 6000; i++) {
    _tmp.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize().multiplyScalar(2400 + rnd() * 1700);
    dust.push({ p: [_tmp.x, _tmp.y, _tmp.z], c: [0.75, 0.85, 1.0], s: 5 + rnd() * 8, k: 0, seed: rnd() });
  }
  const stars = speckPoints(dust, uniforms);
  scene.add(stars);

  // The void itself: deep navy, with cold blue haze drifting through it.
  // (radius stays inside the camera's far plane from anywhere on the path)
  const sky = new THREE.Mesh(new THREE.SphereGeometry(4300, 64, 40), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: 'varying vec3 vD; void main() { vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec3 vD; ${NOISE}
      void main() {
        float n = fbm(vD * 2.5 + 4.0), m = fbm(vD * 5.0 - 2.0);
        vec3 c = mix(vec3(0.004, 0.012, 0.028), vec3(0.01, 0.03, 0.06), smoothstep(-0.6, 0.3, -vD.y));
        c += vec3(0.03, 0.07, 0.12) * smoothstep(0.45, 0.85, n) * (0.6 + 0.4 * m);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  }));
  scene.add(sky);
  return { field, path, vortex, stars, sky };
}

