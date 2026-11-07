import * as THREE from 'three';

// E-to-interact: raycast from the screen centre; colliders occlude targets.
// Usage in a scene: ctx.interact.add(mesh, () => { ... }, { distance: 3 });

export class Interact {
  constructor(camera, { isBlocked = () => false, getOccluders = () => [] } = {}) {
    this.camera = camera;
    this.isBlocked = isBlocked;
    this.getOccluders = getOccluders;
    this.targets = new Map(); // object -> { onInteract, distance }
    this.enabled = true;
    this.current = null;

    this._ray = new THREE.Raycaster();
    this._ray.camera = camera; // required if a target/occluder contains sprites
    this._center = new THREE.Vector2(0, 0);

    this.el = document.createElement('div');
    this.el.textContent = 'Press E to interact';
    Object.assign(this.el.style, {
      position: 'fixed', left: '50%', top: 'calc(50% + 40px)', transform: 'translateX(-50%)',
      padding: '6px 14px', borderRadius: '6px', background: 'rgba(0,0,0,0.6)', color: '#fff',
      font: '16px system-ui, sans-serif', pointerEvents: 'none', zIndex: '10', display: 'none',
    });
    document.body.appendChild(this.el);

    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyE' || e.repeat) return;
      if (!this.enabled || this.isBlocked() || !this.current) return;
      const obj = this.current;
      const t = this.targets.get(obj);
      if (t) t.onInteract(obj);
    });
  }

  /** Make `object` (or any of its children) interactable. Returns a remove fn. */
  add(object, onInteract, { distance = 3 } = {}) {
    this.targets.set(object, { onInteract, distance });
    return () => this.remove(object);
  }

  remove(object) {
    this.targets.delete(object);
    if (this.current === object) this.current = null;
  }

  clear() {
    this.targets.clear();
    this.current = null;
    this.el.style.display = 'none';
  }

  update() {
    let found = null;
    if (this.enabled && !this.isBlocked() && this.targets.size) {
      let maxDist = 0;
      for (const t of this.targets.values()) maxDist = Math.max(maxDist, t.distance);
      this.camera.updateMatrixWorld();
      this._ray.setFromCamera(this._center, this.camera);
      this._ray.far = maxDist;
      const hits = this._ray.intersectObjects([...this.targets.keys(), ...this.getOccluders()], true);
      const first = hits[0];
      if (first) {
        const obj = this._resolve(first.object);
        if (obj && first.distance <= this.targets.get(obj).distance) found = obj;
      }
    }
    this.current = found;
    this.el.style.display = found ? 'block' : 'none';
  }

  _resolve(obj) {
    while (obj) {
      if (this.targets.has(obj)) return obj;
      obj = obj.parent;
    }
    return null;
  }
}
