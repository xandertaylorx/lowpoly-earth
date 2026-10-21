import * as THREE from 'three';

// Airliner: ~38 m long, cruise ~250 m/s. Forward = -Z, up = +Y, right = +X. Quaternion-based flight.
export const G = 9.81;
export const STALL = 65;      // m/s
export const ROTATE = 70;     // m/s: pull back gently from here to lift off
export const VMAX = 300;      // m/s at full throttle (cruise ≈ 250 at ~83%)
const GEAR = 3.6;             // centre height above ground when parked

export interface PlaneInput { pitch: number; roll: number; yaw: number; throttleDelta: number; brake: boolean }

export class Plane {
  group = new THREE.Group();
  q = new THREE.Quaternion();
  throttle = 0;
  speed = 0;           // airspeed along the nose, m/s
  vs = 0;              // vertical speed m/s (for HUD)
  onGround = true;
  placed = false;
  crashed = false;
  private v = new THREE.Vector3();
  private e = new THREE.Euler();
  private f = new THREE.Vector3(); private tmpQ = new THREE.Quaternion(); private tmpQ2 = new THREE.Quaternion();
  private wind = new THREE.Vector3();

  get pos() { return this.group.position; }

  constructor(scene: THREE.Scene) {
    const white = new THREE.MeshLambertMaterial({ color: '#eef1f5', flatShading: true });
    const grey = new THREE.MeshLambertMaterial({ color: '#8c96a4', flatShading: true });
    const blue = new THREE.MeshLambertMaterial({ color: '#1f4f9f', flatShading: true });
    const dark = new THREE.MeshLambertMaterial({ color: '#1a2230', flatShading: true });
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
      const o = new THREE.Mesh(g, m); o.position.set(x, y, z); o.rotation.set(rx, ry, rz); this.group.add(o); return o;
    };
    const along = Math.PI / 2;
    add(new THREE.CylinderGeometry(2.0, 2.0, 30, 8), white, 0, 0, 0, along, 0, 0);               // fuselage
    add(new THREE.ConeGeometry(2.0, 6, 8), white, 0, 0, -18, -along, 0, 0);                      // nose
    add(new THREE.ConeGeometry(2.0, 8, 8), white, 0, 0.4, 19, along, 0, 0);                      // tail cone
    add(new THREE.BoxGeometry(2.2, 0.7, 1.2), dark, 0, 0.9, -17.5);                              // cockpit glass
    add(new THREE.BoxGeometry(2.1, 0.12, 30), blue, 0, -0.35, 0).scale.set(1.8, 1, 0.9);         // cheat line
    // swept wings
    for (const s of [-1, 1]) {
      const w = add(new THREE.BoxGeometry(17, 0.35, 5), grey, s * 9.5, -0.9, 3, 0, s * 0.45, s * -0.05);
      w.geometry.translate(0, 0, 0);
      add(new THREE.CylinderGeometry(1.0, 1.0, 4, 8), grey, s * 8, -2.1, -0.5, along, 0, 0);      // engine
      add(new THREE.BoxGeometry(0.2, 2.2, 3), blue, s * 18, 0.1, 7.5, 0, 0, s * 0.2);              // winglet
      add(new THREE.BoxGeometry(6, 0.25, 3), grey, s * 4, 0.5, 22, 0, s * 0.4, 0);                // tailplane
    }
    add(new THREE.BoxGeometry(0.35, 6, 5), blue, 0, 3.8, 21, 0.25, 0, 0);                          // fin
    // landing gear
    for (const [x, z] of [[0, -13], [-2.4, 2], [2.4, 2]]) add(new THREE.CylinderGeometry(0.55, 0.55, 0.5, 8), dark, x, -GEAR + 0.55, z, 0, 0, along);
    scene.add(this.group);
    this.group.visible = true;
  }

  /** Put the plane on the ground at (x,z) facing yaw (radians, 0 = north). */
  park(x: number, z: number, ground: number, yaw: number) {
    this.group.position.set(x, ground + GEAR, z);
    this.q.setFromEuler(this.e.set(0, yaw, 0, 'YXZ'));
    this.group.quaternion.copy(this.q);
    this.speed = 0; this.throttle = 0; this.onGround = true; this.crashed = false; this.placed = true;
  }

  forward(out: THREE.Vector3) { return out.set(0, 0, -1).applyQuaternion(this.q); }
  headingRad() { this.forward(this.f); return Math.atan2(this.f.x, -this.f.z); }
  pitchDeg() { this.forward(this.f); return (Math.asin(this.f.y) * 180) / Math.PI; }
  bankDeg() { this.e.setFromQuaternion(this.q, 'YXZ'); return (this.e.z * 180) / Math.PI; }

  /** ground: terrain/sea height under the plane (or null if unknown). windAt: wind in m/s at altitude. */
  update(dt: number, inp: PlaneInput, ground: number | null, wind: THREE.Vector3) {
    this.wind.copy(wind);
    this.throttle = Math.min(1, Math.max(0, this.throttle + inp.throttleDelta * dt * 0.35));
    const auth = Math.min(1, Math.max(0, (this.speed - 25) / 70)); // control authority grows with airspeed

    // --- speed: thrust toward throttle*VMAX, gravity along the flight path, drag ---
    this.forward(this.f);
    const target = this.throttle * VMAX;
    let a = (target - this.speed) * 0.28 - G * this.f.y * (this.f.y > 0 ? 2.6 : 1.2); // climbing bleeds speed fast
    if (this.onGround && inp.brake) a -= 12;
    if (this.onGround && this.throttle < 0.02) a -= 2;
    this.speed = Math.min(340, Math.max(0, this.speed + a * dt));

    // --- rotations (local axes) ---
    this.e.setFromQuaternion(this.q, 'YXZ');
    const roll = this.e.z;
    let pitchRate = inp.pitch * 0.38 * auth;        // + = nose up
    let rollRate = -inp.roll * 1.1 * auth;          // + roll = left wing down; D (roll right) -> negative
    if (!inp.roll && Math.abs(this.e.x) < 0.9) rollRate += -roll * 0.5 * auth; // wings-level assist
    let yawRate = inp.yaw * (this.onGround ? 0.6 * Math.min(1, this.speed / 8) : 0.12);
    if (!this.onGround && this.speed < STALL) pitchRate -= 0.45 * (1 - this.speed / STALL); // stall: nose drops
    if (!this.onGround && !inp.pitch) pitchRate += -this.e.x * 0.05 * auth;                  // gentle pitch stability
    this.q.multiply(this.tmpQ2.setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitchRate * dt));
    this.q.multiply(this.tmpQ2.setFromAxisAngle(new THREE.Vector3(0, 0, 1), rollRate * dt));
    this.q.multiply(this.tmpQ2.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawRate * dt));
    if (!this.onGround && this.speed > 20) { // coordinated turn: bank -> heading change about world Y
      const tanB = Math.max(-2.5, Math.min(2.5, Math.sin(roll) / Math.max(0.35, Math.cos(roll))));
      const turn = Math.max(-0.5, Math.min(0.5, (G * tanB) / this.speed));
      this.q.premultiply(this.tmpQ2.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, turn * dt));
    }
    this.q.normalize();

    // --- translate ---
    this.forward(this.f);
    this.v.copy(this.f).multiplyScalar(this.speed).add(this.wind);
    let sink = 0;
    if (!this.onGround && this.speed < STALL) sink = (1 - this.speed / STALL) * 25;
    this.v.y -= sink;
    const prevY = this.group.position.y;
    this.group.position.addScaledVector(this.v, dt);

    // --- ground contact ---
    const wasAirborne = !this.onGround;
    this.onGround = false;
    if (ground !== null) {
      const floor = Math.max(0, ground) + GEAR;
      if (this.group.position.y <= floor) {
        // only a hard arrival from the air can crash: fast sink rate, steep nose-down or heavily banked
        if (wasAirborne && !this.crashed && this.speed > 45 && (this.v.y < -14 || this.f.y < -0.3 || Math.abs(roll) > 0.6)) this.crashed = true;
        this.group.position.y = floor;
        this.onGround = true;
        // level out on the ground: no roll, nose not into the dirt
        this.e.setFromQuaternion(this.q, 'YXZ');
        this.e.z *= 0.8;
        this.e.x = Math.min(Math.max(this.e.x, 0), this.speed > ROTATE ? 0.45 : 0);
        this.q.setFromEuler(this.e);
      }
    }
    this.vs = (this.group.position.y - prevY) / Math.max(dt, 1e-4);
    this.group.quaternion.copy(this.q);
  }

  /** after a crash: stop dead, upright, on the ground */
  recover(ground: number) {
    this.e.setFromQuaternion(this.q, 'YXZ');
    this.q.setFromEuler(this.e.set(0, this.e.y, 0));
    this.group.quaternion.copy(this.q);
    this.group.position.y = Math.max(0, ground) + GEAR;
    this.speed = 0; this.throttle = 0; this.onGround = true; this.crashed = false;
  }
}
