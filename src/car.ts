import * as THREE from 'three';

// A simple low-poly car that follows the terrain (4 wheel contact points) and can't drive into deep water.
export interface CarInput { throttle: number; steer: number; brake: boolean }

const MAX_SPEED = 75;   // m/s (270 km/h)
const REVERSE = 12;
const WHEEL_X = 0.95, WHEEL_Z = 1.5;

export class Car {
  group = new THREE.Group();
  q = new THREE.Quaternion();
  speed = 0;           // signed, m/s along the nose
  yaw = 0;
  placed = false;
  onGround = true;
  grounded = false;    // false until the first terrain snap after parking / teleport
  cam = { back: 9, up: 3.2, cockpit: [-0.45, 1.25, -0.3] as [number, number, number] };
  private e = new THREE.Euler();
  private m = new THREE.Matrix4();
  private fwd = new THREE.Vector3(); private right = new THREE.Vector3(); private up = new THREE.Vector3();

  get pos() { return this.group.position; }

  /** swap the built-in boxes for a loaded glTF model */
  useModel(model: THREE.Object3D) {
    for (const c of [...this.group.children]) this.group.remove(c);
    model.traverse((o) => { o.castShadow = true; });
    this.group.add(model);
  }

  constructor(scene: THREE.Scene) {
    const paint = new THREE.MeshLambertMaterial({ color: '#c2262e', flatShading: true });
    const glass = new THREE.MeshLambertMaterial({ color: '#27384d', flatShading: true });
    const black = new THREE.MeshLambertMaterial({ color: '#16181b', flatShading: true });
    const light = new THREE.MeshBasicMaterial({ color: '#fff4c9' });
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
      const o = new THREE.Mesh(g, m); o.position.set(x, y, z); this.group.add(o); return o;
    };
    add(new THREE.BoxGeometry(1.9, 0.62, 4.4), paint, 0, 0.62, 0);            // body
    add(new THREE.BoxGeometry(1.7, 0.2, 1.1), paint, 0, 0.95, -1.35);         // bonnet slope
    add(new THREE.BoxGeometry(1.6, 0.56, 2.1), glass, 0, 1.18, 0.25);         // cabin
    add(new THREE.BoxGeometry(1.5, 0.08, 1.7), paint, 0, 1.48, 0.28);         // roof
    add(new THREE.BoxGeometry(1.95, 0.18, 0.3), black, 0, 0.42, -2.2);        // bumpers
    add(new THREE.BoxGeometry(1.95, 0.18, 0.3), black, 0, 0.42, 2.2);
    for (const s of [-1, 1]) {
      add(new THREE.BoxGeometry(0.4, 0.16, 0.08), light, s * 0.65, 0.72, -2.21);
      add(new THREE.BoxGeometry(0.4, 0.14, 0.08), new THREE.MeshBasicMaterial({ color: '#ff2a2a' }), s * 0.65, 0.72, 2.21);
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const w = add(new THREE.CylinderGeometry(0.38, 0.38, 0.28, 10), black, sx * WHEEL_X, 0.38, sz * WHEEL_Z);
      w.rotation.z = Math.PI / 2;
    }
    this.group.traverse((o) => { o.castShadow = true; });
    scene.add(this.group);
  }

  park(x: number, z: number, ground: number, yaw: number) {
    this.group.position.set(x, ground + 0.05, z);
    this.yaw = yaw; this.speed = 0; this.placed = true; this.grounded = false;
    this.q.setFromEuler(this.e.set(0, yaw, 0, 'YXZ'));
    this.group.quaternion.copy(this.q);
  }

  forward(out: THREE.Vector3) { return out.set(0, 0, -1).applyQuaternion(this.q); }
  headingRad() { return -this.yaw; }

  /** ground(x,z) -> terrain height or null while unknown */
  update(dt: number, inp: CarInput, ground: (x: number, z: number) => number | null) {
    // --- longitudinal ---
    const dir = Math.sign(this.speed);
    let a = 0;
    if (inp.throttle > 0) a = this.speed < -0.5 ? 30 : 15 * (1 - Math.max(0, this.speed) / MAX_SPEED);
    else if (inp.throttle < 0) a = this.speed > 0.5 ? -30 : -9 * (1 - Math.max(0, -this.speed) / REVERSE);
    else a = -dir * Math.min(Math.abs(this.speed) / dt, 3 + Math.abs(this.speed) * 0.04);
    if (inp.brake) a = -dir * Math.min(Math.abs(this.speed) / dt, 40);
    this.speed = Math.max(-REVERSE, Math.min(MAX_SPEED, this.speed + a * dt));

    // --- steering: tighter at low speed, calmer at high speed ---
    const grip = Math.min(1, Math.abs(this.speed) / 5);
    this.yaw += inp.steer * 1.5 * grip * Math.sign(this.speed || 1) / (1 + Math.abs(this.speed) / 28) * dt;

    // --- move; refuse to enter deep water ---
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const nx = this.pos.x + fx * this.speed * dt, nz = this.pos.z + fz * this.speed * dt;
    const ahead = ground(nx + fx * 2, nz + fz * 2);
    if (ahead !== null && ahead < -0.6) this.speed *= 0.2;
    else { this.pos.x = nx; this.pos.z = nz; }

    // --- terrain following: height at the four wheels -> y, pitch, roll ---
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const h = (sx: number, sz: number) => ground(this.pos.x + rx * sx * WHEEL_X + fx * -sz * WHEEL_Z, this.pos.z + rz * sx * WHEEL_X + fz * -sz * WHEEL_Z);
    const fl = h(-1, 1), fr = h(1, 1), bl = h(-1, -1), br = h(1, -1);
    if (fl !== null && fr !== null && bl !== null && br !== null) {
      const c = (v: number) => Math.max(0, v);
      const avg = (c(fl) + c(fr) + c(bl) + c(br)) / 4;
      this.grounded ? (this.pos.y += (avg + 0.05 - this.pos.y) * Math.min(1, dt * 14)) : (this.pos.y = avg + 0.05, this.grounded = true);
      this.fwd.set(fx, ((c(fl) + c(fr)) - (c(bl) + c(br))) / 2 / (2 * WHEEL_Z), fz).normalize();
      this.right.set(rx, ((c(fr) + c(br)) - (c(fl) + c(bl))) / 2 / (2 * WHEEL_X), rz).normalize();
      this.up.crossVectors(this.right, this.fwd).normalize();
      this.right.crossVectors(this.fwd, this.up).normalize();
      this.m.makeBasis(this.right, this.up, this.fwd.clone().negate());
      const target = new THREE.Quaternion().setFromRotationMatrix(this.m);
      this.q.slerp(target, Math.min(1, dt * 10));
    } else {
      this.q.setFromEuler(this.e.set(0, this.yaw, 0, 'YXZ'));
    }
    this.group.quaternion.copy(this.q);
  }
}
