import * as THREE from 'three';

// Aircraft: quaternion-based flight. Forward = -Z, up = +Y, right = +X.
export const G = 9.81;

export interface PlaneInput { pitch: number; roll: number; yaw: number; throttleDelta: number; brake: boolean }

export interface PlaneSpec {
  name: string;
  vmax: number;        // m/s at full throttle
  cap: number;         // hard speed cap
  cruise: number;      // for the help text
  stall: number;       // m/s
  rotate: number;      // m/s: pull back from here to lift off
  accelGain: number;   // 1/s toward throttle*vmax
  accelMax: number;    // m/s^2 cap on thrust acceleration
  climbUp: number; climbDown: number; // gravity along the flight path
  pitchRate: number; rollRate: number; yawRate: number; // rad/s
  turnGain: number;    // bank-to-turn multiplier
  gear: number;        // centre height above ground when parked
  authFrom: number; authSpan: number; // control authority ramp (m/s)
  brake: number;
  camBack: number; camUp: number; cockpit: [number, number, number];
}

export const AIRLINER: PlaneSpec = {
  name: 'Airliner', vmax: 300, cap: 340, cruise: 250, stall: 65, rotate: 70, accelGain: 0.28, accelMax: 1e9,
  climbUp: 2.6, climbDown: 1.2, pitchRate: 0.38, rollRate: 1.1, yawRate: 0.12, turnGain: 1,
  gear: 3.6, authFrom: 25, authSpan: 70, brake: 12, camBack: 40, camUp: 9, cockpit: [0, 2.2, -16],
};

export const JET: PlaneSpec = {
  name: 'Stealth jet', vmax: 1100, cap: 1250, cruise: 900, stall: 55, rotate: 85, accelGain: 0.5, accelMax: 45,
  climbUp: 0.9, climbDown: 0.5, pitchRate: 1.0, rollRate: 3.0, yawRate: 0.25, turnGain: 4,
  gear: 2.1, authFrom: 20, authSpan: 50, brake: 22, camBack: 24, camUp: 5.5, cockpit: [0, 1.0, -4.5],
};

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
  private f = new THREE.Vector3(); private tmpQ2 = new THREE.Quaternion();
  private wind = new THREE.Vector3();
  private flame?: THREE.Mesh;

  get pos() { return this.group.position; }
  get cam() { return { back: this.spec.camBack, up: this.spec.camUp, cockpit: this.spec.cockpit }; }

  constructor(scene: THREE.Scene, public spec: PlaneSpec) {
    if (spec === JET) this.buildJet(); else this.buildAirliner();
    scene.add(this.group);
  }

  private mat(color: string, extra: THREE.MeshLambertMaterialParameters = {}) {
    return new THREE.MeshLambertMaterial({ color, flatShading: true, side: THREE.DoubleSide, ...extra });
  }
  private add(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
    const o = new THREE.Mesh(g, m); o.position.set(x, y, z); o.rotation.set(rx, ry, rz); this.group.add(o); return o;
  }

  private buildAirliner() {
    const white = this.mat('#eef1f5'), grey = this.mat('#8c96a4'), blue = this.mat('#1f4f9f'), dark = this.mat('#1a2230');
    const along = Math.PI / 2, GEAR = this.spec.gear, add = this.add.bind(this);
    add(new THREE.CylinderGeometry(2.0, 2.0, 30, 8), white, 0, 0, 0, along, 0, 0);               // fuselage
    add(new THREE.ConeGeometry(2.0, 6, 8), white, 0, 0, -18, -along, 0, 0);                      // nose
    add(new THREE.ConeGeometry(2.0, 8, 8), white, 0, 0.4, 19, along, 0, 0);                      // tail cone
    add(new THREE.BoxGeometry(2.2, 0.7, 1.2), dark, 0, 0.9, -17.5);                              // cockpit glass
    add(new THREE.BoxGeometry(2.1, 0.12, 30), blue, 0, -0.35, 0).scale.set(1.8, 1, 0.9);         // cheat line
    for (const s of [-1, 1]) {
      add(new THREE.BoxGeometry(17, 0.35, 5), grey, s * 9.5, -0.9, 3, 0, s * 0.45, s * -0.05);   // swept wing
      add(new THREE.CylinderGeometry(1.0, 1.0, 4, 8), grey, s * 8, -2.1, -0.5, along, 0, 0);      // engine
      add(new THREE.BoxGeometry(0.2, 2.2, 3), blue, s * 18, 0.1, 7.5, 0, 0, s * 0.2);              // winglet
      add(new THREE.BoxGeometry(6, 0.25, 3), grey, s * 4, 0.5, 22, 0, s * 0.4, 0);                // tailplane
    }
    add(new THREE.BoxGeometry(0.35, 6, 5), blue, 0, 3.8, 21, 0.25, 0, 0);                          // fin
    for (const [x, z] of [[0, -13], [-2.4, 2], [2.4, 2]]) add(new THREE.CylinderGeometry(0.55, 0.55, 0.5, 8), dark, x, -GEAR + 0.55, z, 0, 0, along);
  }

  /** black stealth fighter: faceted fuselage, delta wings, canted twin tails, afterburner glow */
  private buildJet() {
    const body = this.mat('#15171b'), wing = this.mat('#1d2025'), glass = this.mat('#33465f', { emissive: new THREE.Color('#0b1522') });
    const hot = this.mat('#333', { emissive: new THREE.Color('#222') });
    const along = Math.PI / 2, add = this.add.bind(this);
    const fus = add(new THREE.CylinderGeometry(1.0, 1.15, 13, 6), body, 0, 0, 1, along, 0, 0); fus.scale.set(1.35, 1, 0.8);
    add(new THREE.ConeGeometry(0.95, 7, 6), body, 0, -0.05, -8.2, -along, 0, 0).scale.set(1.35, 1, 0.7);   // pointed nose
    add(new THREE.SphereGeometry(1, 8, 6), glass, 0, 0.75, -3.6).scale.set(0.62, 0.5, 2.0);                // canopy
    const sh = new THREE.Shape(); sh.moveTo(0, -3); sh.lineTo(6.8, 5); sh.lineTo(6.8, 6.2); sh.lineTo(0, 6.5); sh.closePath();
    const wg = new THREE.ExtrudeGeometry(sh, { depth: 0.22, bevelEnabled: false });
    for (const s of [-1, 1]) {
      const w = add(wg, wing, 0, -0.1, 0.5, along, 0, 0); w.scale.x = s;                                    // delta wing (shape y -> world z)
      add(new THREE.BoxGeometry(0.16, 2.6, 2.4), body, s * 1.45, 1.3, 5.2, 0.2, 0, s * -0.38);              // canted tail
      add(new THREE.BoxGeometry(1.0, 0.7, 4.2), body, s * 1.15, -0.35, -2.2);                               // intake
      add(new THREE.CylinderGeometry(0.62, 0.5, 1.6, 8), hot, s * 0.75, 0, 8, along, 0, 0);                 // nozzle
    }
    this.flame = add(new THREE.ConeGeometry(0.5, 5, 8), new THREE.MeshBasicMaterial({ color: '#ff8a2a', transparent: true, opacity: 0.85, fog: false }), 0, 0, 11, along, 0, 0);
    this.flame.scale.set(1.6, 1, 1);
    this.flame.visible = false;
  }

  /** Put the plane on the ground at (x,z) facing yaw (radians, 0 = north). */
  park(x: number, z: number, ground: number, yaw: number) {
    this.group.position.set(x, ground + this.spec.gear, z);
    this.q.setFromEuler(this.e.set(0, yaw, 0, 'YXZ'));
    this.group.quaternion.copy(this.q);
    this.speed = 0; this.throttle = 0; this.onGround = true; this.crashed = false; this.placed = true;
    if (this.flame) this.flame.visible = false;
  }

  forward(out: THREE.Vector3) { return out.set(0, 0, -1).applyQuaternion(this.q); }
  headingRad() { this.forward(this.f); return Math.atan2(this.f.x, -this.f.z); }
  pitchDeg() { this.forward(this.f); return (Math.asin(this.f.y) * 180) / Math.PI; }
  bankDeg() { this.e.setFromQuaternion(this.q, 'YXZ'); return (this.e.z * 180) / Math.PI; }

  /** ground: terrain/sea height under the plane (or null if unknown). windAt: wind in m/s at altitude. */
  update(dt: number, inp: PlaneInput, ground: number | null, wind: THREE.Vector3) {
    const S = this.spec;
    this.wind.copy(wind);
    this.throttle = Math.min(1, Math.max(0, this.throttle + inp.throttleDelta * dt * (S === JET ? 0.6 : 0.35)));
    const auth = Math.min(1, Math.max(0, (this.speed - S.authFrom) / S.authSpan)); // control authority grows with airspeed
    const hiSpeed = S === JET ? Math.min(1, Math.max(0.3, 260 / Math.max(this.speed, 1))) : 1; // stiffer controls when very fast

    // --- speed: thrust toward throttle*vmax, gravity along the flight path, drag ---
    this.forward(this.f);
    const target = this.throttle * S.vmax;
    const thrust = Math.max(-S.accelMax, Math.min(S.accelMax, (target - this.speed) * S.accelGain));
    let a = thrust - G * this.f.y * (this.f.y > 0 ? S.climbUp : S.climbDown);
    if (this.onGround && inp.brake) a -= S.brake;
    if (this.onGround && this.throttle < 0.02) a -= 2;
    this.speed = Math.min(S.cap, Math.max(0, this.speed + a * dt));

    // --- rotations (local axes) ---
    this.e.setFromQuaternion(this.q, 'YXZ');
    const roll = this.e.z;
    let pitchRate = inp.pitch * S.pitchRate * auth * hiSpeed;        // + = nose up
    let rollRate = -inp.roll * S.rollRate * auth * hiSpeed;          // + roll = left wing down; D (roll right) -> negative
    if (!inp.roll && Math.abs(this.e.x) < 0.9) rollRate += -roll * 0.5 * auth; // wings-level assist
    const yawRate = inp.yaw * (this.onGround ? 0.6 * Math.min(1, this.speed / 8) : S.yawRate);
    if (!this.onGround && this.speed < S.stall) pitchRate -= 0.45 * (1 - this.speed / S.stall); // stall: nose drops
    if (!this.onGround && !inp.pitch) pitchRate += -this.e.x * 0.05 * auth;                      // gentle pitch stability
    this.q.multiply(this.tmpQ2.setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitchRate * dt));
    this.q.multiply(this.tmpQ2.setFromAxisAngle(new THREE.Vector3(0, 0, 1), rollRate * dt));
    this.q.multiply(this.tmpQ2.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawRate * dt));
    if (!this.onGround && this.speed > 20) { // coordinated turn: bank -> heading change about world Y
      const tanB = Math.max(-2.5, Math.min(2.5, Math.sin(roll) / Math.max(0.35, Math.cos(roll))));
      const lim = 0.5 * S.turnGain / (S === JET ? 2 : 1);
      const turn = Math.max(-lim, Math.min(lim, (G * tanB * S.turnGain) / Math.max(this.speed, 60)));
      this.q.premultiply(this.tmpQ2.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, turn * dt));
    }
    this.q.normalize();

    // --- translate ---
    this.forward(this.f);
    this.v.copy(this.f).multiplyScalar(this.speed).add(this.wind);
    let sink = 0;
    if (!this.onGround && this.speed < S.stall) sink = (1 - this.speed / S.stall) * 25;
    this.v.y -= sink;
    const prevY = this.group.position.y;
    this.group.position.addScaledVector(this.v, dt);

    // --- ground contact ---
    const wasAirborne = !this.onGround;
    this.onGround = false;
    if (ground !== null) {
      const floor = Math.max(0, ground) + S.gear;
      if (this.group.position.y <= floor) {
        // only a hard arrival from the air can crash: fast sink rate, steep nose-down or heavily banked
        if (wasAirborne && !this.crashed && this.speed > 45 && (this.v.y < -14 || this.f.y < -0.3 || Math.abs(roll) > 0.6)) this.crashed = true;
        this.group.position.y = floor;
        this.onGround = true;
        // level out on the ground: no roll, nose not into the dirt
        this.e.setFromQuaternion(this.q, 'YXZ');
        this.e.z *= 0.8;
        this.e.x = Math.min(Math.max(this.e.x, 0), this.speed > S.rotate ? 0.45 : 0);
        this.q.setFromEuler(this.e);
      }
    }
    this.vs = (this.group.position.y - prevY) / Math.max(dt, 1e-4);
    this.group.quaternion.copy(this.q);
    if (this.flame) { // afterburner glow grows with throttle, flickers
      this.flame.visible = this.throttle > 0.15;
      const k = (0.4 + this.throttle * 1.4) * (0.9 + Math.random() * 0.2);
      this.flame.scale.set(1.6, k, 1);
      this.flame.position.z = 8.6 + 2.5 * k;
    }
  }

  /** after a crash: stop dead, upright, on the ground */
  recover(ground: number) {
    this.e.setFromQuaternion(this.q, 'YXZ');
    this.q.setFromEuler(this.e.set(0, this.e.y, 0));
    this.group.quaternion.copy(this.q);
    this.group.position.y = Math.max(0, ground) + this.spec.gear;
    this.speed = 0; this.throttle = 0; this.onGround = true; this.crashed = false;
  }
}
