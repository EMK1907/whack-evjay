import * as THREE from 'three';

// STUB (Varshan) — placeholder grey room. Replace with the real scene (docs/GAME.md §7–9).
// Press E on the cube to continue to 'ending'.

const NAME = 'quirkland';
const NEXT = 'ending';
let ctx = null;

function makeLabel(text) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 160;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(0,0,0,0.65)';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#fff';
  g.font = 'bold 56px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
  sprite.scale.set(4, 0.625, 1);
  return sprite;
}

export default {
  name: NAME,

  init(c) {
    ctx = c;
    const { scene, player, interact } = ctx;
    scene.background = new THREE.Color(0x1a1a1a);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(4, 10, 6);
    scene.add(sun);

    // Room: floor, ceiling, 4 walls (all colliders).
    const grey = new THREE.MeshStandardMaterial({ color: 0x8a8a8a });
    const W = 20, H = 6, T = 0.5;
    const slabs = [
      [W, T, W, 0, -T / 2, 0], [W, T, W, 0, H + T / 2, 0],
      [T, H, W, -W / 2 - T / 2, H / 2, 0], [T, H, W, W / 2 + T / 2, H / 2, 0],
      [W, H, T, 0, H / 2, -W / 2 - T / 2], [W, H, T, 0, H / 2, W / 2 + T / 2],
    ];
    for (const [w, h, d, x, y, z] of slabs) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), grey);
      m.position.set(x, y, z);
      scene.add(m);
      player.colliders.push(m);
    }

    const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x3ddc84 }));
    cube.position.set(0, 0.5, -5);
    scene.add(cube);
    player.colliders.push(cube);
    interact.add(cube, () => ctx.goTo(NEXT));

    const label = makeLabel(`${NAME.toUpperCase()}  →  E: go to ${NEXT}`);
    label.position.set(0, 1.7, -5);
    scene.add(label);

    player.spawn(new THREE.Vector3(0, 0, 3), 0);
  },

  update(dt) {},

  dispose() {
    ctx = null;
  },
};
