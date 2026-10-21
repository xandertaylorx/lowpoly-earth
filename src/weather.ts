import * as THREE from 'three';
import { sunPosition } from './world';

// Real weather from Open-Meteo (no key) + sky / sun / fog / clouds / rain / snow driven by it.
export interface Weather {
  temp: number; cloud: number; precip: number; snow: boolean;
  wind: number; windDir: number; vis: number; code: number; humidity: number;
  utcOffset: number; live: boolean;
}
const DEFAULT: Weather = { temp: 12, cloud: 40, precip: 0, snow: false, wind: 4, windDir: 220, vis: 24000, code: 2, humidity: 70, utcOffset: 0, live: false };

const WMO: Record<number, string> = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers', 81: 'Rain showers', 82: 'Violent showers',
  85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail',
};
export const describe = (w: Weather) => WMO[w.code] ?? `Code ${w.code}`;

// Uniforms shared by the sky dome and the water shader (water reflects the sky).
export const skyUniforms = {
  top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) },
  sunCol: { value: new THREE.Color('#fff4d8') }, night: { value: 0 }, cover: { value: 0 },
  time: { value: 0 }, rough: { value: 1 },
};
const rad = Math.PI / 180;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const hash = (a: number, b: number, c = 0) => { const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453; return s - Math.floor(s); };

// Sky colour ramps keyed by sun altitude (deg).
const ALT = [-18, -8, 0, 6, 20, 45];
const TOP = ['#02040c', '#081530', '#1c3a6e', '#2f63b3', '#3b78d0', '#4a86d8'].map((c) => new THREE.Color(c));
const HOR = ['#05070f', '#1b2440', '#e08a5a', '#a9c4e0', '#b9d3ea', '#c6dcef'].map((c) => new THREE.Color(c));
function ramp(ramps: THREE.Color[], alt: number, out: THREE.Color) {
  if (alt <= ALT[0]) return out.copy(ramps[0]);
  for (let i = 1; i < ALT.length; i++) if (alt <= ALT[i]) return out.copy(ramps[i - 1]).lerp(ramps[i], (alt - ALT[i - 1]) / (ALT[i] - ALT[i - 1]));
  return out.copy(ramps[ramps.length - 1]);
}

const RAIN_N = 6000, SNOW_N = 4000, BOX = 90;
const CLOUD_CELL = 2600, CLOUD_R = 11, CLOUD_MAX = 7000;

export class Sky {
  w: Weather = { ...DEFAULT };
  target: Weather = { ...DEFAULT };
  sunAlt = 0; sunDir = new THREE.Vector3(0, 1, 0);
  fogFar = 60000;
  localTime = new Date();
  status = 'default weather';
  timeOffsetH = 0;
  sun = new THREE.DirectionalLight('#fff3dd', 2);
  cover = 0; // smoothed overcast amount 0..1 (used to soften shadows)
  hemi = new THREE.HemisphereLight('#dfeaff', '#6b5d4a', 1);
  private dome: THREE.Mesh;
  private domeU: Record<string, { value: any }>;
  private clouds: THREE.Mesh;
  private cloudU = {
    map: { value: null as THREE.Texture | null }, litCol: { value: new THREE.Color() }, shadeCol: { value: new THREE.Color() },
    fogCol: { value: new THREE.Color() }, fogNear: { value: 1 }, fogFar: { value: 2 }, opacity: { value: 0.9 },
  };
  private cAttr!: { pos: THREE.InstancedBufferAttribute; size: THREE.InstancedBufferAttribute; rot: THREE.InstancedBufferAttribute; shade: THREE.InstancedBufferAttribute };
  private cTmp = { x: new Float32Array(CLOUD_MAX), y: new Float32Array(CLOUD_MAX), z: new Float32Array(CLOUD_MAX), s: new Float32Array(CLOUD_MAX), r: new Float32Array(CLOUD_MAX), h: new Float32Array(CLOUD_MAX), d: new Float32Array(CLOUD_MAX) };
  private cOrder = new Uint32Array(CLOUD_MAX);
  private rain: THREE.LineSegments; private snow: THREE.Points;
  private rainBase = new Float32Array(RAIN_N * 3); private snowBase = new Float32Array(SNOW_N * 3);
  private wind = new THREE.Vector3(); // m/s, blowing direction (world x=east, z=south)
  cloudOff = new THREE.Vector2();
  private t = 0; private flash = 0;
  private topC = new THREE.Color(); private horC = new THREE.Color();
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private sc = new THREE.Vector3(); private ps = new THREE.Vector3();
  private lastFetch = 0;

  constructor(private scene: THREE.Scene) {
    scene.add(this.sun, this.sun.target, this.hemi);
    this.sun.castShadow = true;
    Object.assign(this.sun.shadow, { bias: -0.0004, normalBias: 0.5, radius: 3 });
    this.sun.shadow.mapSize.set(2048, 2048);
    scene.fog = new THREE.Fog('#a9c4e0', 5000, 60000);

    this.domeU = skyUniforms;
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(1000, 24, 12),
      new THREE.ShaderMaterial({
        uniforms: this.domeU, side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false,
        vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
        fragmentShader: `varying vec3 vDir; uniform vec3 top, horizon, sunDir, sunCol; uniform float night, cover;
          float h3(vec3 p){ return fract(sin(dot(p, vec3(127.1,311.7,74.7)))*43758.5453); }
          void main(){
            vec3 d = normalize(vDir);
            float h = clamp(d.y, 0.0, 1.0);
            vec3 col = mix(horizon, top, pow(h, 0.55));
            float s = max(dot(d, sunDir), 0.0);
            float clear = 1.0 - cover;
            col += sunCol * (pow(s, 1500.0) * 3.0 + pow(s, 12.0) * 0.28) * clear;
            vec3 g = floor(d * 260.0);
            float star = step(0.9965, h3(g)) * night * clear * smoothstep(0.02, 0.2, d.y);
            col += vec3(star);
            gl_FragColor = vec4(col, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      }),
    );
    this.dome.frustumCulled = false; this.dome.renderOrder = -1000;
    scene.add(this.dome);

    this.cloudU.map.value = makePuffTexture();
    const bg = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    bg.index = quad.index; bg.setAttribute('position', quad.getAttribute('position')); bg.setAttribute('uv', quad.getAttribute('uv'));
    const mk = (n: number) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(CLOUD_MAX * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.cAttr = { pos: mk(3), size: mk(1), rot: mk(1), shade: mk(1) };
    bg.setAttribute('aPos', this.cAttr.pos); bg.setAttribute('aSize', this.cAttr.size); bg.setAttribute('aRot', this.cAttr.rot); bg.setAttribute('aShade', this.cAttr.shade);
    bg.instanceCount = 0;
    this.clouds = new THREE.Mesh(bg, new THREE.ShaderMaterial({
      uniforms: this.cloudU, transparent: true, depthWrite: false,
      vertexShader: `
        attribute vec3 aPos; attribute float aSize, aRot, aShade; varying vec2 vUv; varying float vShade, vDist;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main() {
          vec4 mv = viewMatrix * vec4(aPos, 1.0);
          float c = cos(aRot), s = sin(aRot);
          mv.xy += vec2(position.x * c - position.y * s, position.x * s + position.y * c) * aSize;
          vDist = -mv.z; vUv = uv; vShade = aShade;
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `
        uniform sampler2D map; uniform vec3 litCol, shadeCol, fogCol; uniform float fogNear, fogFar, opacity;
        varying vec2 vUv; varying float vShade, vDist;
        #include <common>
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          float a = texture2D(map, vUv).a * opacity * smoothstep(120.0, 600.0, vDist);
          if (a < 0.01) discard;
          vec3 col = mix(shadeCol, litCol, vShade);
          col = mix(col, fogCol, smoothstep(fogNear, fogFar, vDist));
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    this.clouds.frustumCulled = false; this.clouds.renderOrder = 2;
    scene.add(this.clouds);

    for (let i = 0; i < RAIN_N * 3; i++) this.rainBase[i] = Math.random() * BOX;
    for (let i = 0; i < SNOW_N * 3; i++) this.snowBase[i] = Math.random() * BOX;
    const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAIN_N * 6), 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: '#b8c8e0', transparent: true, opacity: 0.55 }));
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SNOW_N * 3), 3));
    this.snow = new THREE.Points(sg, new THREE.PointsMaterial({ color: '#ffffff', size: 0.22, transparent: true, opacity: 0.9 }));
    for (const o of [this.rain, this.snow]) { o.frustumCulled = false; o.visible = false; scene.add(o); }
  }

  /** Fetch current conditions for lat/lon (Open-Meteo, no key). */
  async refresh(lat: number, lon: number) {
    this.lastFetch = performance.now();
    try {
      const url = 'https://api.open-meteo.com/v1/forecast' +
        `?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
        '&current=temperature_2m,relative_humidity_2m,precipitation,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m' +
        '&hourly=visibility&forecast_days=2&wind_speed_unit=ms&timezone=auto';
      const j = await (await fetch(url)).json();
      const c = j.current;
      let vis = 24000;
      const hi = j.hourly?.time?.indexOf(String(c.time).slice(0, 13) + ':00');
      if (hi >= 0 && j.hourly.visibility?.[hi] != null) vis = j.hourly.visibility[hi];
      const code = c.weather_code;
      const snowCode = (code >= 71 && code <= 77) || code === 85 || code === 86;
      const rainCode = (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;
      let precip = c.precipitation ?? 0; // mm over last interval (~15 min) -> use as mm/h-ish
      if ((snowCode || rainCode) && precip < 0.3) precip = snowCode ? 0.6 : code >= 63 ? 2 : 0.8;
      this.target = {
        temp: c.temperature_2m, cloud: c.cloud_cover, precip, snow: c.snowfall > 0 || snowCode,
        wind: c.wind_speed_10m, windDir: c.wind_direction_10m, vis, code, humidity: c.relative_humidity_2m,
        utcOffset: j.utc_offset_seconds ?? 0, live: true,
      };
      this.status = `live ${new Date().toLocaleTimeString()}`;
      if (!this.w.live) this.w = { ...this.target };
    } catch (e) {
      this.status = 'offline – default weather';
    }
  }
  get ageMs() { return performance.now() - this.lastFetch; }

  update(dt: number, cam: THREE.Camera, lat: number, lon: number, agl: number) {
    this.t += dt;
    skyUniforms.time.value = this.t;
    skyUniforms.rough.value = 0.6 + this.w.wind * 0.12;
    const w = this.w, tg = this.target, k = 1 - Math.exp(-dt / 8);
    for (const key of ['temp', 'cloud', 'precip', 'wind', 'vis', 'humidity'] as const) w[key] = lerp(w[key], tg[key], k);
    w.windDir = tg.windDir; w.snow = tg.snow; w.code = tg.code; w.utcOffset = tg.utcOffset; w.live = tg.live;

    // --- sun / time of day (real clock) ---
    const now = Date.now() + this.timeOffsetH * 3600000;
    this.localTime = new Date(now + w.utcOffset * 1000);
    const sp = sunPosition(now, lat, lon);
    const alt = sp.alt / rad;
    this.sunAlt = alt;
    this.sunDir.set(Math.sin(sp.az) * Math.cos(sp.alt), Math.sin(sp.alt), -Math.cos(sp.az) * Math.cos(sp.alt));

    const cover = Math.min(1, w.cloud / 100);
    const wet = Math.min(1, w.precip / 3) + ((w.code >= 51 && w.code <= 99) ? 0.35 : 0);
    const dayF = smooth(-4, 12, alt);
    ramp(TOP, alt, this.topC); ramp(HOR, alt, this.horC);
    const gray = (c: THREE.Color, amt: number, bright: number) => {
      const l = (c.r + c.g + c.b) / 3 * bright;
      c.r = lerp(c.r, l, amt); c.g = lerp(c.g, l, amt); c.b = lerp(c.b, l, amt);
    };
    const over = Math.min(1, cover * 0.85 + Math.min(1, wet) * 0.2);
    this.cover = over;
    gray(this.topC, over, 0.78 - 0.25 * Math.min(1, wet));
    gray(this.horC, over * 0.8, 0.9 - 0.2 * Math.min(1, wet));

    // lightning for storms
    if (w.code >= 95 && Math.random() < dt * 0.15) this.flash = 1;
    this.flash = Math.max(0, this.flash - dt * 4);

    this.sun.color.setHSL(0.11, lerp(0.9, 0.15, smooth(0, 14, alt)), lerp(0.6, 0.97, smooth(0, 14, alt)));
    this.sun.intensity = 3.4 * dayF * (1 - 0.7 * over);
    this.hemi.color.copy(this.topC).lerp(new THREE.Color('#ffffff'), 0.5);
    this.hemi.groundColor.set('#8a8d92');
    this.hemi.intensity = (lerp(0.3, 1.75, dayF) * (1 - 0.05 * over)) + this.flash * 2;
    this.sun.position.copy(cam.position).addScaledVector(this.sunDir, 1000);
    this.sun.target.position.copy(cam.position);

    // --- fog: visibility drives it, relaxed with altitude so you can see from a plane ---
    let far = Math.min(120000, Math.max(400, w.vis * 3));
    far /= 1 + Math.min(1, w.precip / 2.5) * 2.2;
    if (w.code === 45 || w.code === 48) far = Math.min(far, 900);
    const altAbove = Math.max(0, agl);
    far *= 1 + Math.min(altAbove, 12000) / (w.code === 45 || w.code === 48 ? 600 : 1500);
    this.fogFar = Math.min(far, 160000);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(this.horC).multiplyScalar(1 + this.flash * 0.6);
    fog.near = this.fogFar * 0.12; fog.far = this.fogFar;

    this.domeU.top.value.copy(this.topC); this.domeU.horizon.value.copy(this.horC);
    this.domeU.sunDir.value.copy(this.sunDir);
    this.domeU.night.value = 1 - smooth(-14, -4, alt);
    this.domeU.cover.value = Math.min(1, over * 1.1);
    this.dome.position.copy(cam.position);

    // --- wind ---
    const from = w.windDir * rad;
    this.wind.set(-Math.sin(from) * w.wind, 0, Math.cos(from) * w.wind); // toward (dir+180): east=-sin, north=-cos => z=+cos

    // --- clouds: world-fixed lattice of puff clusters, drifting with the wind ---
    this.cloudOff.x += this.wind.x * 2 * dt; this.cloudOff.y += this.wind.z * 2 * dt;
    const cx = cam.position.x - this.cloudOff.x, cz = cam.position.z - this.cloudOff.y;
    const gi = Math.floor(cx / CLOUD_CELL), gj = Math.floor(cz / CLOUD_CELL);
    const p = Math.min(1.0, cover * 1.12), T = this.cTmp;
    const overcast = cover > 0.8;
    let n = 0;
    for (let j = gj - CLOUD_R; j <= gj + CLOUD_R; j++) for (let i = gi - CLOUD_R; i <= gi + CLOUD_R; i++) {
      if (hash(i, j, 0) > p) continue;
      const bx = (i + hash(i, j, 1)) * CLOUD_CELL + this.cloudOff.x, bz = (j + hash(i, j, 2)) * CLOUD_CELL + this.cloudOff.y;
      const base = 1300 + hash(i, j, 3) * 600;
      const puffs = overcast ? 9 : 6 + Math.floor(hash(i, j, 4) * 4);
      const spread = (overcast ? 1500 : 900) * (0.7 + hash(i, j, 5) * 0.6);
      for (let k = 0; k < puffs && n < CLOUD_MAX; k++) {
        const ang = hash(i, j, 10 + k) * 6.283, rr = Math.sqrt(hash(i, j, 30 + k)) * spread;
        const hy = hash(i, j, 50 + k);
        const px = bx + Math.cos(ang) * rr, pz = bz + Math.sin(ang) * rr;
        const dx = px - cam.position.x, dz = pz - cam.position.z;
        if (dx * dx + dz * dz > this.fogFar * this.fogFar * 1.2) continue;
        const py = base + hy * (overcast ? 160 : 420) * (1 - rr / (spread * 1.3));
        T.x[n] = px; T.y[n] = py; T.z[n] = pz;
        T.s[n] = (overcast ? 2200 : 1100) * (0.7 + hash(i, j, 70 + k) * 0.7) * (1.15 - 0.5 * rr / spread);
        T.r[n] = hash(i, j, 90 + k) * 6.283;
        T.h[n] = Math.min(1, 0.15 + hy * 0.95);
        T.d[n] = dx * dx + dz * dz + (py - cam.position.y) ** 2;
        n++;
      }
    }
    const ord = this.cOrder;
    for (let k = 0; k < n; k++) ord[k] = k;
    const sorted = ord.subarray(0, n).sort((a, b) => T.d[b] - T.d[a]); // far -> near
    const A = this.cAttr;
    for (let k = 0; k < n; k++) {
      const s0 = sorted[k];
      A.pos.setXYZ(k, T.x[s0], T.y[s0], T.z[s0]); A.size.setX(k, T.s[s0]); A.rot.setX(k, T.r[s0]); A.shade.setX(k, T.h[s0]);
    }
    for (const a of [A.pos, A.size, A.rot, A.shade]) a.needsUpdate = true;
    (this.clouds.geometry as THREE.InstancedBufferGeometry).instanceCount = n;
    const cu = this.cloudU, dark = Math.min(1, wet) * 0.5;
    const light = (0.1 + 0.9 * dayF) * (1 - 0.45 * over) * (1 - dark) + 0.04;
    cu.litCol.value.copy(this.sun.color).lerp(new THREE.Color('#ffffff'), 0.55).multiplyScalar(light * 1.25);
    cu.shadeCol.value.copy(this.horC).lerp(new THREE.Color('#8a93a8'), 0.5).multiplyScalar(light * 0.55);
    cu.fogCol.value.copy(this.horC); cu.fogNear.value = this.fogFar * 0.12; cu.fogFar.value = this.fogFar;
    cu.opacity.value = 0.55 + 0.35 * Math.min(1, cover * 1.3);

    // --- precipitation ---
    const fade = smooth(2600, 1900, agl);
    const intensity = (w.precip > 0.02 || (w.code >= 51 && w.code <= 99 && w.code !== 45 && w.code !== 48)) ? Math.min(1, 0.2 + w.precip / 3.5) * fade : 0;
    const showSnow = w.snow && intensity > 0, showRain = !w.snow && intensity > 0;
    this.rain.visible = showRain; this.snow.visible = showSnow;
    if (showRain) {
      const cnt = Math.floor(RAIN_N * intensity), a = (this.rain.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
      const vx = this.wind.x * 0.8, vy = -9, vz = this.wind.z * 0.8, t = this.t;
      for (let i = 0; i < cnt; i++) {
        const x = rel(this.rainBase[i * 3] + vx * t - cam.position.x), y = rel(this.rainBase[i * 3 + 1] + vy * t - cam.position.y), z = rel(this.rainBase[i * 3 + 2] + vz * t - cam.position.z);
        const o = i * 6;
        a[o] = cam.position.x + x; a[o + 1] = cam.position.y + y; a[o + 2] = cam.position.z + z;
        a[o + 3] = a[o] - vx * 0.03; a[o + 4] = a[o + 1] - vy * 0.03; a[o + 5] = a[o + 2] - vz * 0.03;
      }
      this.rain.geometry.setDrawRange(0, cnt * 2);
      (this.rain.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }
    if (showSnow) {
      const cnt = Math.floor(SNOW_N * intensity), a = (this.snow.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
      const vx = this.wind.x * 0.6, vy = -1.6, vz = this.wind.z * 0.6, t = this.t;
      for (let i = 0; i < cnt; i++) {
        const wob = Math.sin(t * 1.3 + i) * 0.6;
        const x = rel(this.snowBase[i * 3] + vx * t + wob - cam.position.x), y = rel(this.snowBase[i * 3 + 1] + vy * t - cam.position.y), z = rel(this.snowBase[i * 3 + 2] + vz * t - cam.position.z);
        a[i * 3] = cam.position.x + x; a[i * 3 + 1] = cam.position.y + y; a[i * 3 + 2] = cam.position.z + z;
      }
      this.snow.geometry.setDrawRange(0, cnt);
      (this.snow.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  /** keep the cloud lattice fixed in the real world when the origin is rebased */
  rebase(remap: (x: number, z: number) => { x: number; z: number }) {
    const r = remap(this.cloudOff.x, this.cloudOff.y);
    this.cloudOff.set(r.x, r.z);
  }

  /** wind vector (m/s) at altitude, world axes */
  windAt(alt: number, out: THREE.Vector3) {
    return out.copy(this.wind).multiplyScalar(1 + Math.min(2, Math.max(0, alt) / 3000));
  }
}

const rel = (v: number) => (((v % BOX) + BOX) % BOX) - BOX / 2;

/** soft cumulus puff: a cluster of radial gradients with a fuzzy edge (alpha only) */
function makePuffTexture() {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!;
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 46; i++) {
    const a = rnd() * 6.283, r = Math.sqrt(rnd()) * S * 0.24, x = S / 2 + Math.cos(a) * r, y = S / 2 + Math.sin(a) * r * 0.8, rad = S * (0.1 + rnd() * 0.17);
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, 'rgba(255,255,255,0.32)'); gr.addColorStop(0.55, 'rgba(255,255,255,0.14)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
