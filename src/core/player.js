import * as THREE from 'three';

// First-person controller: WASD, mouse look, SPACE jump, gravity along -up.
// Collision is raycast-based against meshes in `player.colliders` (scenes push into it).
// `orientation` defines which way is "up"; flipGravity() turns it 180° (reversible).

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);
const RIGHT = new THREE.Vector3(1, 0, 0);

export const EYE_HEIGHT = 1.6;
const RADIUS = 0.35;
const STEP = 0.5;          // max height auto-climbed
const GRAVITY = 25;
const JUMP_SPEED = 8;
const WALK_SPEED = 5;
const SPRINT_MULT = 1.6;
const LOOK_SENS = 0.0022;
const FLIP_TIME = 0.45;    // seconds for the camera roll animation
const MAX_FALL = 60;

export class Player {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.position = new THREE.Vector3();     // feet
    this.velocity = new THREE.Vector3();     // world space
    this.yaw = 0;
    this.pitch = 0;
    this.orientation = new THREE.Quaternion(); // physics "up" frame
    this.colliders = [];
    this.enabled = true;   // false = scene drives the camera (cutscenes)
    this.grounded = false;
    this.locked = false;
    this.keys = new Set();

    this._view = new THREE.Quaternion();      // animated version of orientation
    this._flipFrom = new THREE.Quaternion();
    this._flipT = 1;
    this._jumpQueued = false;
    this._jumpListeners = new Set();
    this._ray = new THREE.Raycaster();
    this._ray.camera = camera;

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === dom;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      this.yaw -= e.movementX * LOOK_SENS;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * LOOK_SENS, -1.55, 1.55);
    });
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) this._jumpQueued = true;
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** World-space up vector (opposite of gravity). */
  get up() { return WORLD_UP.clone().applyQuaternion(this.orientation); }
  get gravityDir() { return this.up.negate(); }
  get flipped() { return this.up.y < 0; }

  /** Register a callback fired when the player jumps. Returns an unsubscribe fn. */
  onJump(fn) {
    this._jumpListeners.add(fn);
    return () => this._jumpListeners.delete(fn);
  }

  /** Place the player (feet) at `position`, facing `yaw` radians, normal gravity. */
  spawn(position, yaw = 0) {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.orientation.identity();
    this._view.identity();
    this._flipT = 1;
    this.grounded = false;
    this._applyCamera();
  }

  /** Called by the scene manager between scenes. */
  reset() {
    this.colliders = [];
    this._jumpListeners.clear();
    this.enabled = true;
    this.orientation.identity();
    this._view.identity();
    this._flipT = 1;
    this.velocity.set(0, 0, 0);
    this.grounded = false;
  }

  /** Flip gravity 180°. Rolls around the facing direction; call again to flip back. */
  flipGravity() {
    const oldUp = this.up;
    const eye = this.position.clone().addScaledVector(oldUp, EYE_HEIGHT);

    // Keep the eye where it is: new feet sit EYE_HEIGHT "above" the eye (clamped by a ceiling).
    let shift = EYE_HEIGHT;
    const hit = this._cast(eye, oldUp, EYE_HEIGHT);
    if (hit) shift = Math.max(0, hit.distance - 0.05);
    this.position.copy(eye).addScaledVector(oldUp, shift);

    const yawQ = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, this.yaw);
    const roll = new THREE.Quaternion().setFromAxisAngle(FORWARD, Math.PI);
    this._flipFrom.copy(this._view);
    this.orientation.multiply(yawQ).multiply(roll).multiply(yawQ.invert()).normalize();
    this._flipT = 0;
    this.grounded = false;
  }

  update(dt) {
    if (this._flipT < 1) {
      this._flipT = Math.min(1, this._flipT + dt / FLIP_TIME);
      const t = this._flipT;
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      this._view.slerpQuaternions(this._flipFrom, this.orientation, eased);
    } else {
      this._view.copy(this.orientation);
    }

    if (!this.enabled) { this._jumpQueued = false; return; }

    const up = this.up;
    const basis = this.orientation.clone().multiply(new THREE.Quaternion().setFromAxisAngle(WORLD_UP, this.yaw));
    const fwd = FORWARD.clone().applyQuaternion(basis);
    const right = RIGHT.clone().applyQuaternion(basis);

    const k = this.keys;
    const wish = new THREE.Vector3();
    if (k.has('KeyW') || k.has('ArrowUp')) wish.add(fwd);
    if (k.has('KeyS') || k.has('ArrowDown')) wish.sub(fwd);
    if (k.has('KeyD') || k.has('ArrowRight')) wish.add(right);
    if (k.has('KeyA') || k.has('ArrowLeft')) wish.sub(right);
    if (wish.lengthSq() > 0) {
      const sprint = k.has('ShiftLeft') || k.has('ShiftRight');
      wish.normalize().multiplyScalar(WALK_SPEED * (sprint ? SPRINT_MULT : 1));
    }

    let vUp = this.velocity.dot(up);
    if (this._jumpQueued && this.grounded) {
      vUp = JUMP_SPEED;
      this.grounded = false;
      for (const fn of this._jumpListeners) fn(this);
    }
    this._jumpQueued = false;
    vUp = Math.max(vUp - GRAVITY * dt, -MAX_FALL);

    this._moveHorizontal(wish.clone().multiplyScalar(dt), up);
    vUp = this._moveVertical(vUp, dt, up);

    this.velocity.copy(wish).addScaledVector(up, vUp);
    this._applyCamera();
  }

  _moveHorizontal(delta, up) {
    for (let i = 0; i < 2; i++) {
      const len = delta.length();
      if (len < 1e-6) return;
      const dir = delta.clone().divideScalar(len);
      let block = null;
      for (const h of [STEP + 0.05, EYE_HEIGHT * 0.9]) {
        const hit = this._cast(this.position.clone().addScaledVector(up, h), dir, len + RADIUS);
        if (hit && (!block || hit.distance < block.distance)) block = hit;
      }
      if (!block) { this.position.add(delta); return; }

      const allowed = Math.max(0, block.distance - RADIUS);
      this.position.addScaledVector(dir, allowed);

      // Slide along the wall for the remaining distance.
      const n = block.face
        ? block.face.normal.clone().transformDirection(block.object.matrixWorld)
        : dir.clone().negate();
      n.addScaledVector(up, -n.dot(up));
      if (n.lengthSq() < 1e-6) return;
      n.normalize();
      const remaining = dir.multiplyScalar(len - allowed);
      delta = remaining.addScaledVector(n, -remaining.dot(n));
    }
  }

  _moveVertical(vUp, dt, up) {
    if (vUp <= 0) {
      const drop = -vUp * dt;
      const origin = this.position.clone().addScaledVector(up, STEP);
      const hit = this._cast(origin, up.clone().negate(), STEP + drop + (this.grounded ? 0.1 : 0.01));
      if (hit) {
        this.position.copy(hit.point);
        this.grounded = true;
        return 0;
      }
      this.position.addScaledVector(up, -drop);
      this.grounded = false;
      return vUp;
    }
    this.grounded = false;
    const rise = vUp * dt;
    const head = this.position.clone().addScaledVector(up, EYE_HEIGHT);
    if (this._cast(head, up, 0.15 + rise)) return 0;
    this.position.addScaledVector(up, rise);
    return vUp;
  }

  _cast(origin, dir, far) {
    if (!this.colliders.length) return null;
    this._ray.set(origin, dir);
    this._ray.near = 0;
    this._ray.far = far;
    return this._ray.intersectObjects(this.colliders, true)[0] || null;
  }

  _applyCamera() {
    const yawQ = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, this.yaw);
    const pitchQ = new THREE.Quaternion().setFromAxisAngle(RIGHT, this.pitch);
    this.camera.quaternion.copy(this._view).multiply(yawQ).multiply(pitchQ);
    this.camera.position.copy(this.position).addScaledVector(this.up, EYE_HEIGHT);
  }
}
