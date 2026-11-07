import * as THREE from 'three';
import { EYE_HEIGHT } from '../core/player.js';

// Opening scene (docs/GAME.md §2): sterile white room, the player rides a conveyor belt behind a
// queue of babies through X-ray curtains. At the curtains it's the player's turn and the system
// malfunctions: sign goes red and reads DLROW, room turns red, ERROR! everywhere → 'fall'.

const NAME = 'conveyor';
const NEXT = 'fall';

const ROOM_W = 16, ROOM_H = 7, ROOM_BACK = 10, ROOM_FRONT = -32;
const BELT_Y = 0.5;            // belt surface height
const BELT_W = 1.8;
const BELT_BACK = 9.5, BELT_FRONT = -22;
const BELT_SPEED = 1.4;        // m/s
const BELT_TEX_PER_M = 2;      // texture repeats per metre of belt
const CURTAIN_Z = -20;
const OPENING_W = BELT_W + 0.3, OPENING_TOP = 2.8;
const VOID_Z = CURTAIN_Z - 1.6; // babies vanish into the dark here
const TRIGGER_Z = CURTAIN_Z + 2.0;
const SPAWN_Z = 7.5;
const SIGN_POS = new THREE.Vector3(0, 4.3, CURTAIN_Z + 0.2);

const BABY_COLORS = [0xcfe8ff, 0xffd6e6, 0xfff3c4, 0xd8f5d8];

let ctx = null;
let alive = false;
let phase = 'belt';            // 'belt' → 'error'
let time = 0;
let tickTimer = 0;
let beltZ = SPAWN_Z;            // where the belt has carried the player
let beltTex = null;
let babies = [];
let strips = [];
let sign = null;               // { canvas, tex }
let lamp = null;
let tints = [];                // { color, base, red }
let redT = 0, redTarget = 0;
let lookQ = null;
let camBase = null;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function drawSign(text, red) {
  const { canvas: c, tex } = sign;
  const g = c.getContext('2d');
  g.fillStyle = red ? '#ff1a1a' : '#fbfcfc';
  g.fillRect(0, 0, c.width, c.height);
  g.lineWidth = 14;
  g.strokeStyle = red ? '#7a0000' : '#d3d8dc';
  g.strokeRect(7, 7, c.width - 14, c.height - 14);
  g.fillStyle = red ? '#2a0000' : '#1d2a33';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = 120;
  g.font = `800 ${size}px system-ui, sans-serif`;
  while (g.measureText(text).width > c.width - 120) g.font = `800 ${--size}px system-ui, sans-serif`;
  g.fillText(text, c.width / 2, c.height / 2 + 6);
  tex.needsUpdate = true;
}

function makeBaby(color) {
  const baby = new THREE.Group();
  const swaddle = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xf6d2b8, roughness: 0.8 });
  const dark = new THREE.MeshBasicMaterial({ color: 0x111111 });

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 16), swaddle);
  body.scale.set(1, 1.2, 1);
  body.position.y = 0.24;
  const head = new THREE.Group();
  head.position.y = 0.55;
  const face = new THREE.Mesh(new THREE.SphereGeometry(0.14, 20, 16), skin);
  const hood = new THREE.Mesh(new THREE.SphereGeometry(0.165, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.6), swaddle);
  hood.rotation.x = -Math.PI * 0.35;
  hood.position.z = -0.02;
  head.add(face, hood);
  for (const x of [-0.05, 0.05]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 8), dark);
    eye.position.set(x, 0.02, 0.13);
    head.add(eye);
  }
  const tag = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.01), new THREE.MeshStandardMaterial({ color: 0xffffff }));
  tag.position.set(0, 0.22, 0.2);
  baby.add(body, head, tag);
  baby.rotation.y = 0; // faces +z: back down the belt, at the player
  return { group: baby, head, beeped: false, phase: Math.random() * 10 };
}

function trefoilTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#ffd400';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#111';
    const cx = w / 2, cy = h / 2;
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
      g.beginPath();
      g.moveTo(cx, cy);
      g.arc(cx, cy, 100, a - Math.PI / 6, a + Math.PI / 6);
      g.closePath();
      g.fill();
    }
    g.fillStyle = '#ffd400';
    g.beginPath(); g.arc(cx, cy, 30, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#111';
    g.beginPath(); g.arc(cx, cy, 20, 0, Math.PI * 2); g.fill();
  });
}

function tint(color, redHex) {
  tints.push({ color, base: color.clone(), red: new THREE.Color(redHex) });
}

function applyRed(t) {
  for (const { color, base, red } of tints) color.lerpColors(base, red, t);
}

function box(w, h, d, x, y, z, mat, collide = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  ctx.scene.add(m);
  if (collide) ctx.player.colliders.push(m);
  return m;
}

function buildRoom() {
  const { scene } = ctx;
  scene.background = new THREE.Color(0xffffff);
  scene.fog = new THREE.Fog(0xffffff, 16, 55);
  tint(scene.background, 0xa00000);
  tint(scene.fog.color, 0xa00000);

  const hemi = new THREE.HemisphereLight(0xffffff, 0xe6ecef, 2.2);
  const key = new THREE.DirectionalLight(0xffffff, 0.8);
  key.position.set(3, 10, 4);
  scene.add(hemi, key);
  tint(hemi.color, 0xff1010);
  tint(hemi.groundColor, 0x400000);
  tint(key.color, 0xff2020);

  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
  const floorTex = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#e3e7ea';
    g.lineWidth = 4;
    g.strokeRect(0, 0, w, h);
  });
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  const L = ROOM_BACK - ROOM_FRONT, midZ = (ROOM_BACK + ROOM_FRONT) / 2;
  floorTex.repeat.set(ROOM_W / 1.5, L / 1.5);
  const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.5 });

  const T = 0.5;
  box(ROOM_W, T, L, 0, -T / 2, midZ, floorMat);
  box(ROOM_W, T, L, 0, ROOM_H + T / 2, midZ, white);
  box(T, ROOM_H, L, -ROOM_W / 2 - T / 2, ROOM_H / 2, midZ, white);
  box(T, ROOM_H, L, ROOM_W / 2 + T / 2, ROOM_H / 2, midZ, white);
  box(ROOM_W, ROOM_H, T, 0, ROOM_H / 2, ROOM_BACK + T / 2, white);
  box(ROOM_W, ROOM_H, T, 0, ROOM_H / 2, ROOM_FRONT - T / 2, white);

  // Ceiling light strips.
  const panel = new THREE.MeshBasicMaterial({ color: 0xf3fbff });
  tint(panel.color, 0xff3030);
  for (let z = ROOM_BACK - 3; z > ROOM_FRONT + 2; z -= 5) {
    for (const x of [-3.5, 3.5]) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 3.2), panel);
      p.rotation.x = Math.PI / 2;
      p.position.set(x, ROOM_H - 0.01, z);
      scene.add(p);
    }
  }

  // Dark observation windows high on the side walls — someone is watching.
  const glass = new THREE.MeshStandardMaterial({ color: 0x23292d, roughness: 0.08, metalness: 0.8 });
  for (let z = 4; z > ROOM_FRONT + 4; z -= 9) {
    for (const side of [-1, 1]) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(3, 1.1), glass);
      win.position.set(side * (ROOM_W / 2 - 0.01), 4.4, z);
      win.rotation.y = -side * Math.PI / 2;
      scene.add(win);
    }
  }
}

function buildBelt() {
  const metal = new THREE.MeshStandardMaterial({ color: 0xeef1f3, roughness: 0.35, metalness: 0.3 });
  const len = BELT_BACK - BELT_FRONT, midZ = (BELT_BACK + BELT_FRONT) / 2;

  beltTex = canvasTexture(64, 128, (g, w, h) => {
    g.fillStyle = '#dfe3e6';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#c4cacf';
    g.fillRect(0, 0, w, 10);
  });
  beltTex.wrapS = beltTex.wrapT = THREE.RepeatWrapping;
  beltTex.repeat.set(1, len * BELT_TEX_PER_M);
  const beltMat = new THREE.MeshStandardMaterial({ map: beltTex, roughness: 0.9 });

  // Surface is the collider; the plane on top carries the scrolling texture.
  box(BELT_W, 0.1, len, 0, BELT_Y - 0.05, midZ, metal);
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(BELT_W, len), beltMat);
  surface.rotation.x = -Math.PI / 2;
  surface.position.set(0, BELT_Y + 0.002, midZ);
  ctx.scene.add(surface);
  box(BELT_W + 0.1, BELT_Y - 0.1, len, 0, (BELT_Y - 0.1) / 2, midZ, metal, false);

  // Side frames + tall glass guards keep the player on the belt (taller than a jump).
  const glass = new THREE.MeshStandardMaterial({ color: 0xdff3ff, transparent: true, opacity: 0.18, roughness: 0.05 });
  const railLen = BELT_BACK - CURTAIN_Z;
  const railZ = (BELT_BACK + CURTAIN_Z) / 2;
  for (const side of [-1, 1]) {
    const x = side * (BELT_W / 2 + 0.08);
    box(0.16, 0.6, len, x, 0.3, midZ, metal);
    box(0.04, 1.45, railLen, x, 0.6 + 1.45 / 2, railZ, glass);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, railLen, 10), metal);
    bar.rotation.x = Math.PI / 2;
    bar.position.set(x, 2.07, railZ);
    ctx.scene.add(bar);
    for (let z = BELT_BACK - 0.5; z > CURTAIN_Z; z -= 3) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 8), metal);
      post.position.set(x, 1.32, z);
      ctx.scene.add(post);
    }
  }
}

function buildScanner() {
  const { scene } = ctx;
  const white = new THREE.MeshStandardMaterial({ color: 0xfafbfc, roughness: 0.4, metalness: 0.1 });
  const HOUSE_W = 3.4, HOUSE_H = 3.3, DEPTH = 2.2;
  const z = CURTAIN_Z - DEPTH / 2 + 0.1;
  const sideW = (HOUSE_W - OPENING_W) / 2;
  for (const side of [-1, 1]) box(sideW, HOUSE_H, DEPTH, side * (OPENING_W / 2 + sideW / 2), HOUSE_H / 2, z, white);
  box(OPENING_W, HOUSE_H - OPENING_TOP, DEPTH, 0, (HOUSE_H + OPENING_TOP) / 2, z, white);

  // Darkness beyond the curtains.
  const voidPlane = new THREE.Mesh(new THREE.PlaneGeometry(OPENING_W, OPENING_TOP), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  voidPlane.position.set(0, OPENING_TOP / 2, VOID_Z);
  scene.add(voidPlane);

  // Radiation warning + status lamp.
  const warn = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), new THREE.MeshBasicMaterial({ map: trefoilTexture() }));
  warn.position.set(-(OPENING_W / 2 + sideW / 2), 2.2, CURTAIN_Z + 0.11);
  scene.add(warn);
  lamp = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), new THREE.MeshBasicMaterial({ color: 0x33ff77 }));
  lamp.position.set(0, 3.05, CURTAIN_Z + 0.12);
  scene.add(lamp);

  // Lead-rubber curtain strips, pivoting from the top of the opening.
  const n = 8;
  const stripW = OPENING_W / n;
  const stripMat = new THREE.MeshStandardMaterial({
    color: 0x7d878d, roughness: 0.45, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
  });
  const h = OPENING_TOP - BELT_Y - 0.03;
  for (let i = 0; i < n; i++) {
    const pivot = new THREE.Group();
    pivot.position.set(-OPENING_W / 2 + stripW * (i + 0.5), OPENING_TOP, CURTAIN_Z);
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(stripW * 1.04, h), stripMat);
    strip.position.y = -h / 2;
    pivot.add(strip);
    scene.add(pivot);
    strips.push({ pivot, angle: 0 });
  }

  // Overhead sign hanging from the ceiling.
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 220;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  sign = { canvas: c, tex };
  drawSign('BACK TO REAL WORLD', false);
  const SW = 4.6, SH = SW * c.height / c.width;
  const back = new THREE.Mesh(new THREE.BoxGeometry(SW + 0.1, SH + 0.1, 0.08), white);
  back.position.copy(SIGN_POS).add(new THREE.Vector3(0, 0, -0.05));
  const face = new THREE.Mesh(new THREE.PlaneGeometry(SW, SH), new THREE.MeshBasicMaterial({ map: tex }));
  face.position.copy(SIGN_POS);
  scene.add(back, face);
  const cableLen = ROOM_H - SIGN_POS.y - SH / 2;
  for (const x of [-SW / 2 + 0.3, SW / 2 - 0.3]) {
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, cableLen, 6), new THREE.MeshBasicMaterial({ color: 0x9aa1a6 }));
    cable.position.set(x, ROOM_H - cableLen / 2, SIGN_POS.z - 0.05);
    scene.add(cable);
  }
}

function buildBabies() {
  for (let i = 0; i < 7; i++) {
    const b = makeBaby(BABY_COLORS[i % BABY_COLORS.length]);
    b.group.position.set(0, BELT_Y, SPAWN_Z - 3 - i * 3);
    ctx.scene.add(b.group);
    babies.push(b);
  }
}

async function malfunction() {
  const { player, camera, audio, effects } = ctx;
  phase = 'error';
  audio.tone(55, 0.5, { type: 'square', volume: 0.2 }); // belt clunks to a stop

  // Freeze the player and turn their head up to the sign.
  player.enabled = false;
  camBase = camera.position.clone();
  // Matrix4.lookAt uses the camera convention (looks down -z), unlike Object3D.lookAt.
  const m = new THREE.Matrix4().lookAt(camBase, SIGN_POS, new THREE.Vector3(0, 1, 0));
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
  lamp.material.color.set(0xff0000);
  redTarget = 1;

  await effects.error({ duration: 3200, audio });
  if (!alive) return;
  effects.setFade(1); // the crash cuts straight to black
  ctx.goTo(NEXT);
}

export default {
  name: NAME,

  init(c) {
    ctx = c;
    alive = true;
    phase = 'belt';
    time = 0; tickTimer = 0; beltZ = SPAWN_Z;
    babies = []; strips = []; tints = [];
    redT = 0; redTarget = 0;
    lookQ = null; camBase = null;

    buildRoom();
    buildBelt();
    buildScanner();
    buildBabies();

    ctx.player.spawn(new THREE.Vector3(0, BELT_Y, SPAWN_Z), 0);
  },

  update(dt) {
    if (!ctx) return;
    const { player, camera, audio } = ctx;
    time += dt;

    // The belt only runs while the game has the pointer (not behind the start overlay).
    const v = phase === 'belt' && player.locked ? BELT_SPEED : 0;
    if (v) {
      beltTex.offset.y -= v * dt * BELT_TEX_PER_M;
      beltZ -= v * dt;
      tickTimer += dt;
      if (tickTimer > 0.75) {
        tickTimer = 0;
        audio.tone(160, 0.04, { type: 'square', volume: 0.012 });
      }
    }

    for (const b of babies) {
      const p = b.group.position;
      p.z -= v * dt;
      if (!b.beeped && p.z < CURTAIN_Z) {
        b.beeped = true;
        audio.tone(1046, 0.15, { volume: 0.06 });
        setTimeout(() => alive && audio.tone(784, 0.25, { volume: 0.06 }), 150);
      }
      b.group.visible = p.z > VOID_Z;
      b.group.position.y = BELT_Y + Math.abs(Math.sin(time * 3 + b.phase)) * 0.015;
      b.head.rotation.z = Math.sin(time * 0.9 + b.phase) * 0.12;
      b.head.rotation.y = Math.sin(time * 0.5 + b.phase * 2) * 0.25;
    }
    // No walking or jumping: the belt owns the player's position. player.update() has already run
    // this frame, so undo whatever WASD/SPACE did and re-place the camera; mouse look is untouched.
    if (phase === 'belt') {
      player.position.set(0, BELT_Y, beltZ);
      player.velocity.set(0, 0, 0);
      player.grounded = true;
      camera.position.set(0, BELT_Y + EYE_HEIGHT, beltZ);
    }

    // Curtains part around whatever is pushing through them.
    const pushers = babies.filter((b) => b.group.visible).map((b) => b.group.position);
    pushers.push(player.position);
    for (let i = 0; i < strips.length; i++) {
      const s = strips[i];
      let target = Math.sin(time * 1.3 + i) * 0.015;
      for (const p of pushers) {
        const dz = p.z - CURTAIN_Z;
        if (Math.abs(p.x - s.pivot.position.x) < 0.35 && dz < 0.3 && dz > -0.8) target = Math.max(target, 0.35);
      }
      s.angle += (target - s.angle) * Math.min(1, dt * 6);
      s.pivot.rotation.x = s.angle;
    }

    if (phase === 'belt' && player.position.z <= TRIGGER_Z) malfunction();

    if (phase === 'error') {
      if (redTarget > redT) {
        redT = Math.min(redTarget, redT + dt * 2);
        applyRed(redT);
      }
      if (lookQ) camera.quaternion.slerp(lookQ, 1 - Math.exp(-dt * 3));
      if (camBase) {
        const shake = 0.04 * redT;
        camera.position.copy(camBase).add(new THREE.Vector3(
          (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake));
      }
    }
  },

  dispose() {
    alive = false;
    ctx = null;
    babies = []; strips = []; tints = [];
    sign = null; lamp = null; beltTex = null;
  },
};
