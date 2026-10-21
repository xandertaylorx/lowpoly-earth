import * as THREE from 'three';

// Aircraft: quaternion-based flight. Forward = -Z, up = +Y, right = +X.
export const G = 9.81;

export interface PlaneInput {
  pitch: number; roll: number; yaw: number; throttleDelta: number; brake: boolean;
  lift?: number;                 // spaceship hover: +1 up, -1 down
  autoHeading?: number | null;   // spaceship: steer toward this heading (rad, clockwise from north)
}

export const PULSE_SPEED = 280000; // m/s: ~1 minute from Australia to the UK
export const PULSE_ALT = 70000;    // m: pulse drive cruises near the edge of space

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
  space?: boolean;     // spaceship flight model (no stall, speed-independent controls, hover, pulse drive)
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

export const SHIP: PlaneSpec = {
  name: 'Spaceship', vmax: 4200, cap: 4300, cruise: 4200, stall: 0, rotate: 0, accelGain: 0.5, accelMax: 420,
  climbUp: 0, climbDown: 0, pitchRate: 0.9, rollRate: 1.8, yawRate: 0.6, turnGain: 1,
  gear: 2.8, authFrom: 0, authSpan: 1, brake: 80, space: true, camBack: 36, camUp: 8, cockpit: [0, 1.4, -7],
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
  pulse = false;       // spaceship pulse drive engaged
  private engines: THREE.Mesh[] = [];
  private ring?: THREE.Mesh;

  get pos() { return this.group.position; }
  get cam() { return { back: this.spec.camBack, up: this.spec.camUp, cockpit: this.spec.cockpit }; }

  constructor(scene: THREE.Scene, public spec: PlaneSpec) {
    if (spec === JET) this.buildJet(); else if (spec === SHIP) this.buildShip(); else this.buildAirliner();
    this.group.traverse((o) => { if (o !== this.flame && !this.engines.includes(o as THREE.Mesh)) o.castShadow = true; });
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

  /** sleek white spaceship with blue engine glow and a pulse-drive ring */
  private buildShip() {
    const hull = this.mat('#d9dde4'), dark = this.mat('#2a2f3b'), accent = this.mat('#2f63d6');
    const glass = this.mat('#7cc4ff', { emissive: new THREE.Color('#1b5aa0') });
    const along = Math.PI / 2, add = this.add.bind(this);
    add(new THREE.CylinderGeometry(1.7, 2.1, 17, 8), hull, 0, 0, 2, along, 0, 0).scale.set(1.35, 1, 0.85);      // fuselage
    add(new THREE.ConeGeometry(1.7, 11, 8), hull, 0, -0.05, -12.5, -along, 0, 0).scale.set(1.35, 1, 0.7);        // nose
    add(new THREE.SphereGeometry(1, 10, 8), glass, 0, 1.1, -6).scale.set(0.95, 0.7, 2.8);                        // canopy
    const sh = new THREE.Shape(); sh.moveTo(0, -5); sh.lineTo(11.5, 6); sh.lineTo(11.5, 8.2); sh.lineTo(0, 8.5); sh.closePath();
    const wg = new THREE.ExtrudeGeometry(sh, { depth: 0.32, bevelEnabled: false });
    for (const s of [-1, 1]) {
      const w = add(wg, hull, 0, -0.35, 1.5, along, 0, 0); w.scale.x = s;                                         // swept wings
      add(new THREE.BoxGeometry(0.16, 2.8, 3.2), accent, s * 11.3, 1.1, 7, 0.15, 0, s * -0.25);                    // wingtip fins
      add(new THREE.BoxGeometry(5.4, 0.12, 0.7), accent, s * 6.2, -0.14, 5.3, 0, s * -0.55, 0);                    // wing stripe
      add(new THREE.CylinderGeometry(1.05, 1.2, 7, 10), dark, s * 3.3, -0.2, 7.5, along, 0, 0);                    // engine nacelles
      const fl = add(new THREE.ConeGeometry(0.95, 6, 10), new THREE.MeshBasicMaterial({ color: '#6fb8ff', transparent: true, opacity: 0.85, fog: false }), s * 3.3, -0.2, 14.5, along, 0, 0);
      this.engines.push(fl);
    }
    this.ring = add(new THREE.TorusGeometry(3.4, 0.2, 8, 28), new THREE.MeshBasicMaterial({ color: '#7fe9ff', fog: false }), 0, 0, 10.5);
    add(new THREE.BoxGeometry(0.3, 2.6, 5), dark, 0, 1.9, 8.5, 0.25, 0, 0);                                         // dorsal fin
  }

  /** swap the built-in model for a loaded glTF (the jet keeps its afterburner glow) */
  useModel(model: THREE.Object3D) {
    for (const c of [...this.group.children]) if (c !== this.flame) this.group.remove(c);
    model.traverse((o) => { o.castShadow = true; });
    this.group.add(model);
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
    if (S.space) { this.updateShip(dt, inp, ground, wind); return; }
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

  /** Spaceship: no stall, controls independent of speed, hover, and a pulse drive that cruises at PULSE_SPEED. */
  private updateShip(dt: number, inp: PlaneInput, ground: number | null, wind: THREE.Vector3) {
    const S = this.spec;
    this.throttle = Math.min(1, Math.max(0, this.throttle + inp.throttleDelta * dt * 0.6));
    const target = this.throttle * S.vmax;
    if (this.pulse) this.speed += (PULSE_SPEED - this.speed) * (1 - Math.exp(-dt * 1.1));        // ~3 s to full pulse
    else if (this.speed > S.cap) this.speed += (target - this.speed) * (1 - Math.exp(-dt * 2.2)); // drop out of pulse
    else {
      let a = Math.max(-S.accelMax * 1.5, Math.min(S.accelMax, (target - this.speed) * S.accelGain));
      if (this.onGround && inp.brake) a -= S.brake;
      this.speed = Math.max(0, this.speed + a * dt);
    }

    // orientation: constant-rate controls, auto-levelling roll, bank turns that don't depend on speed
    this.e.setFromQuaternion(this.q, 'YXZ');
    const roll = this.e.z;
    let pitchRate = inp.pitch * S.pitchRate, rollRate = -inp.roll * S.rollRate, yawRate = inp.yaw * S.yawRate;
    if (!inp.roll) rollRate += -roll * 1.6;
    if (this.pulse) pitchRate = -this.e.x * 1.4 + inp.pitch * 0.15; // pulse drive flies level
    if (inp.autoHeading != null && !inp.yaw && !inp.roll) {
      let err = inp.autoHeading - this.headingRad();
      err = Math.atan2(Math.sin(err), Math.cos(err));
      yawRate = -Math.max(-0.8, Math.min(0.8, err * 1.8));
      rollRate += yawRate * 0.9; // lean into the turn (yawRate < 0 turns right, rollRate < 0 banks right)
    }
    this.q.multiply(this.tmpQ2.setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitchRate * dt));
    this.q.multiply(this.tmpQ2.setFromAxisAngle(new THREE.Vector3(0, 0, 1), rollRate * dt));
    this.q.multiply(this.tmpQ2.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawRate * dt));
    if (!this.onGround) {
      const tanB = Math.max(-2, Math.min(2, Math.sin(roll) / Math.max(0.35, Math.cos(roll))));
      this.q.premultiply(this.tmpQ2.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, tanB * 0.55 * dt));
    }
    this.q.normalize();

    // translate
    this.forward(this.f);
    if (this.pulse) { this.f.y = 0; this.f.normalize(); }
    this.v.copy(this.f).multiplyScalar(this.speed);
    if (!this.pulse) this.v.add(wind);
    if (!this.pulse && this.speed < 400) this.v.y += (inp.lift ?? 0) * 90; // hover thrusters
    const prevY = this.group.position.y;
    this.group.position.addScaledVector(this.v, dt);
    if (this.pulse) this.group.position.y += (PULSE_ALT - this.group.position.y) * (1 - Math.exp(-dt * 0.9));
    else if (this.speed > S.cap * 1.2) this.group.position.y += (12000 - this.group.position.y) * (1 - Math.exp(-dt * 0.8)); // settle at 12 km after pulse

    // ground: soft landings are fine, only a very hard fast arrival crashes
    const wasAirborne = !this.onGround;
    this.onGround = false;
    if (ground !== null) {
      const floor = Math.max(0, ground) + S.gear;
      if (this.group.position.y <= floor) {
        if (wasAirborne && !this.crashed && this.speed > 300 && this.v.y < -160) this.crashed = true;
        this.group.position.y = floor;
        this.onGround = true;
        this.e.setFromQuaternion(this.q, 'YXZ'); this.e.z *= 0.8; this.e.x = Math.max(this.e.x, 0);
        this.q.setFromEuler(this.e);
        if (this.throttle < 0.02 && !this.pulse) this.speed *= Math.max(0, 1 - dt * 1.5);
      }
    }
    this.vs = (this.group.position.y - prevY) / Math.max(dt, 1e-4);
    this.group.quaternion.copy(this.q);

    // engine glow: grows with throttle, huge and white-hot in pulse
    const k = this.pulse ? 3.2 : 0.35 + this.throttle * 1.5;
    for (const m of this.engines) { m.scale.set(1, k * (0.92 + Math.random() * 0.16), 1); m.position.z = 11.5 + 3 * k; (m.material as THREE.MeshBasicMaterial).color.set(this.pulse ? '#ffffff' : '#6fb8ff'); }
    if (this.ring) { this.ring.scale.setScalar(this.pulse ? 1.25 + Math.sin(performance.now() / 60) * 0.1 : 1); (this.ring.material as THREE.MeshBasicMaterial).color.set(this.pulse ? '#ffffff' : '#7fe9ff'); }
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
