import * as THREE from 'three';
import { world, M_PER_DEG } from './world';
import { skyUniforms } from './weather';
import type { MapData, SatSrc } from './mapdata';

// Terrain streaming: a quadtree of AWS Terrarium tiles. Tiles near the player are split into
// higher zoom levels; each tile becomes a flat-shaded 32x32 low-poly mesh with skirts.
export const MIN_Z = 7;
export const MAX_Z = 15;
const N = 32;
const MAX_INFLIGHT = 48;
// Satellite imagery draped on the terrain: Sentinel-2 cloudless by EOX (native detail ~zoom 13).
const IMG_URL = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/g/';
const IMG_MAX_Z = 13;
const IMG_INFLIGHT = 32;
// Several hostnames for the same bucket => 6 HTTP/1.1 connections each, so tiles stream in parallel.
const HOSTS = [
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/',
  'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/',
  'https://s3.us-east-1.amazonaws.com/elevation-tiles-prod/terrarium/',
  'https://elevation-tiles-prod.s3.us-east-1.amazonaws.com/terrarium/',
  'https://elevation-tiles-prod.s3.dualstack.us-east-1.amazonaws.com/terrarium/',
  'https://s3.dualstack.us-east-1.amazonaws.com/elevation-tiles-prod/terrarium/',
];

const mercLat = (v: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * v))) * 180) / Math.PI;
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const waterShift = { value: new THREE.Vector2() };

function makeWaterMaterial() {
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]) as Record<string, { value: unknown }>;
  Object.assign(uniforms, { top: skyUniforms.top, horizon: skyUniforms.horizon, sunDir: skyUniforms.sunDir, sunCol: skyUniforms.sunCol, time: skyUniforms.time, cover: skyUniforms.cover, rough: skyUniforms.rough, shift: waterShift });
  return new THREE.ShaderMaterial({
    uniforms, fog: true, transparent: true, depthWrite: false,
    vertexShader: `
      attribute float depth; varying float vDepth; varying vec3 vWorld;
      #include <common>
      #include <fog_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vDepth = depth;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform vec3 top, horizon, sunDir, sunCol; uniform float time, cover, rough; uniform vec2 shift;
      varying float vDepth; varying vec3 vWorld;
      #include <common>
      #include <fog_pars_fragment>
      #include <logdepthbuf_pars_fragment>
      // sum of directional sine waves -> surface slope (xz)
      vec2 slope(vec2 p, float t, float dist) {
        vec2 g = vec2(0.0);
        vec4 w1 = vec4(0.94, 0.34, 0.105, 0.9), w2 = vec4(-0.5, 0.87, 0.27, 1.3), w3 = vec4(0.2, -0.98, 0.7, 1.9), w4 = vec4(-0.9, -0.44, 1.8, 2.7);
        float a1 = 0.35 * (1.0 - smoothstep(600.0, 3000.0, dist)), a2 = 0.2 * (1.0 - smoothstep(100.0, 600.0, dist)), a3 = 0.1 * (1.0 - smoothstep(25.0, 150.0, dist)), a4 = 0.05 * (1.0 - smoothstep(6.0, 45.0, dist));
        g += w1.xy * a1 * cos(dot(p, w1.xy) * w1.z + t * w1.w) * w1.z;
        g += w2.xy * a2 * cos(dot(p, w2.xy) * w2.z + t * w2.w) * w2.z;
        g += w3.xy * a3 * cos(dot(p, w3.xy) * w3.z + t * w3.w) * w3.z;
        g += w4.xy * a4 * cos(dot(p, w4.xy) * w4.z + t * w4.w) * w4.z;
        return g * rough;
      }
      void main() {
        #include <logdepthbuf_fragment>
        vec2 p = vWorld.xz - shift;
        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        vec3 v = toCam / dist;
        vec2 g = slope(p, time, dist);
        vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
        vec3 r = reflect(-v, n); r.y = abs(r.y);
        vec3 skyRefl = mix(horizon, top, pow(clamp(r.y, 0.0, 1.0), 0.5));
        float sd = max(dot(r, sunDir), 0.0);
        vec3 glint = sunCol * (pow(sd, 90.0) * 0.9 + pow(sd, 14.0) * 0.08) * (1.0 - cover) * (1.0 - 0.6 * smoothstep(300.0, 3000.0, dist));
        float dayF = clamp(sunDir.y * 3.0 + 0.3, 0.12, 1.0);
        float dd = smoothstep(0.0, 250.0, vDepth);
        vec3 body = mix(vec3(0.02, 0.22, 0.26), vec3(0.003, 0.025, 0.07), sqrt(dd)) * dayF;
        vec3 col = mix(body, skyRefl, fres) + glint;
        // shore foam
        float nz = sin(p.x * 0.35 + time * 0.6) * sin(p.y * 0.41 - time * 0.5) + sin(p.x * 1.3 - p.y * 0.9 + time) * 0.5;
        float foam = (1.0 - smoothstep(0.3, 2.2, vDepth)) * smoothstep(0.1, 0.6, vDepth) * smoothstep(-0.2, 0.9, nz) * dayF;
        col = mix(col, vec3(0.9, 0.95, 1.0) * dayF, foam * 0.0);
        float a = mix(0.62 + 0.36 * smoothstep(0.0, 60.0, vDepth), 1.0, fres);
        a = mix(0.6, a, smoothstep(0.0, 1.5, vDepth)) + foam * 0.0;
        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

class Tile {
  key: string;
  state: 'idle' | 'loading' | 'ready' = 'idle';
  heights?: Float32Array; // (N+1)^2 grid
  minH = 0; maxH = 0;
  mesh?: THREE.Mesh; water?: THREE.Mesh;
  builtVer = -1;
  lastShown = 0; wasSplit = false; textured = false; imgKey = ''; mapMat?: THREE.Material; uvZ = -1;
  want = -1; score = 0; retryAt = 0; readyAt = 0;
  lonW: number; lonE: number; latN: number; latS: number; cLat: number; cLon: number;
  constructor(public z: number, public x: number, public y: number) {
    this.key = `${z}/${x}/${y}`;
    const n = 2 ** z;
    this.lonW = (x / n) * 360 - 180;
    this.lonE = ((x + 1) / n) * 360 - 180;
    this.latN = mercLat(y / n);
    this.latS = mercLat((y + 1) / n);
    this.cLat = (this.latN + this.latS) / 2;
    this.cLon = (this.lonW + this.lonE) / 2;
  }
  get widthM() { return (this.lonE - this.lonW) * world.mLon; }
}

// Colour palette (sRGB hex -> linear Colors).
const C = (h: string) => new THREE.Color(h);
const SAND = C('#d9c690'), DEEP = C('#16284a'), SHALLOW = C('#7c9a8c');
const GRASS = C('#5f9444'), GRASS2 = C('#7d9a49'), MOOR = C('#8a7e56'), ROCK = C('#8a8479'), SNOW = C('#f2f5f8');

function faceColor(h: number, ny: number, snowline: number, rnd: number, out: THREE.Color) {
  if (h < 0.5) {
    const t = Math.min(1, -h / 250);
    out.copy(SHALLOW).lerp(DEEP, Math.sqrt(t));
    if (h > -3) out.copy(SAND).lerp(SHALLOW, Math.max(0, -h / 3));
  } else if (h < 6) out.copy(SAND);
  else if (h < 300) out.copy(GRASS).lerp(GRASS2, h / 300);
  else if (h < 900) out.copy(GRASS2).lerp(MOOR, (h - 300) / 600);
  else out.copy(MOOR).lerp(ROCK, Math.min(1, (h - 900) / 700));
  if (h >= 0.5) {
    out.lerp(ROCK, smooth(0.86, 0.6, ny));
    out.lerp(SNOW, smooth(snowline - 250, snowline + 50, h) * smooth(0.45, 0.8, ny));
  }
  out.multiplyScalar(0.92 + rnd * 0.16);
}

export class Terrain {
  group = new THREE.Group();
  tiles = new Map<string, Tile>();
  shown = new Map<string, Tile>();
  viewDist = 60000;
  stats = { ready: 0, inflight: 0, queued: 0, shown: 0 };
  private queue: Tile[] = [];
  private inflight = 0;
  private stamp = 0;
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  private terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
  private waterMat = makeWaterMaterial();
  private lastEvict = 0;
  private images = new Map<string, { state: 'idle' | 'loading' | 'ready'; tex?: THREE.Texture; mat?: THREE.Material; bmp?: ImageBitmap; last: number; score: number; stamp: number; retryAt: number }>();
  private imgQueue: string[] = [];
  private imgInflight = 0;
  anisotropy = 4;
  maxZ = MAX_Z;   // dynamic: lowered at high speed so detail we can't use isn't fetched
  mapProvider?: MapData;
  private p = { x: 0, y: 0, z: 0, fx: 0, fz: -1 };

  constructor(scene: THREE.Scene) {
    this.canvas.width = this.canvas.height = 256;
    scene.add(this.group);
  }

  /** Re-place meshes after the world origin moved. */
  reposition(remap?: (x: number, z: number) => { x: number; z: number }) {
    // keep the wave pattern fixed in the real world when the origin moves
    if (remap) { const r = remap(0, 0); waterShift.value.x -= r.x; waterShift.value.y -= r.z; } else waterShift.value.set(0, 0);
    for (const t of this.tiles.values()) if (t.mesh) this.place(t);
  }

  private place(t: Tile) {
    const c = world.toWorld(t.cLat, t.cLon);
    t.mesh!.position.set(c.x, 0, c.z);
    t.water?.position.set(c.x, 0, c.z);
  }

  private getTile(z: number, x: number, y: number) {
    const k = `${z}/${x}/${y}`;
    let t = this.tiles.get(k);
    if (!t) { t = new Tile(z, x, y); this.tiles.set(k, t); }
    return t;
  }

  /** Terrain height under (x,z) from the *displayed* mesh (exact triangle interpolation). */
  heightAt(x: number, z: number): { h: number; z: number } | null {
    const { lat, lon } = world.toGeo(x, z);
    const u = (lon + 180) / 360;
    const v = (1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2;
    for (let zl = MAX_Z; zl >= MIN_Z; zl--) {
      const n = 2 ** zl;
      const tx = Math.floor(u * n), ty = Math.floor(v * n);
      const t = this.shown.get(`${zl}/${tx}/${ty}`);
      if (!t || !t.heights) continue;
      const fx = (u * n - tx) * N, fy = (v * n - ty) * N;
      const i = Math.min(N - 1, Math.floor(fx)), j = Math.min(N - 1, Math.floor(fy));
      const a = t.heights, s = N + 1;
      const h00 = a[j * s + i], h10 = a[j * s + i + 1], h01 = a[(j + 1) * s + i], h11 = a[(j + 1) * s + i + 1];
      const dx = fx - i, dy = fy - j;
      const h = dx + dy <= 1 ? h00 + dx * (h10 - h00) + dy * (h01 - h00) : h11 + (1 - dx) * (h01 - h11) + (1 - dy) * (h10 - h11);
      return { h, z: zl };
    }
    return null;
  }

  // ---- streaming -------------------------------------------------------------------------

  /** Call ~10x/s. Decides which tiles to show / fetch for a viewer at world pos with heading (fx,fz).
   *  `speed` (m/s) lowers the max detail and drives look-ahead prefetching along the heading. */
  update(px: number, py: number, pz: number, fx: number, fz: number, viewDist: number, speed = 0) {
    this.viewDist = viewDist;
    this.stamp++;
    this.queue.length = 0;
    this.imgQueue.length = 0;
    this.maxZ = speed > 700 ? 12 : speed > 350 ? 13 : speed > 150 ? 14 : MAX_Z;

    // 1) prefetch: walk the same quadtree from points ahead of us (requests only, nothing displayed)
    if (speed > 40) {
      const fl = Math.hypot(fx, fz) || 1;
      for (const T of [1.5, 3.5, 7, 12]) {
        const dd = Math.min(speed * T, 30000);
        this.p = { x: px + (fx / fl) * dd, y: py, z: pz + (fz / fl) * dd, fx, fz };
        this.traverse(true);
      }
    }
    // 2) the real view
    this.p = { x: px, y: py, z: pz, fx, fz };
    const out = this.traverse(false);
    this.apply(out);

    this.queue.sort((a, b) => a.score - b.score);
    this.pump();
    this.imgQueue.sort((a, b) => this.images.get(a)!.score - this.images.get(b)!.score);
    this.pumpImages();
    this.stats = { ready: 0, inflight: this.inflight, queued: this.queue.length, shown: this.shown.size };
    for (const t of this.tiles.values()) if (t.state === 'ready') this.stats.ready++;
    if (this.tiles.size > 1100 && performance.now() - this.lastEvict > 4000) this.evict();
  }

  private traverse(pre: boolean): Tile[] {
    const { lat, lon } = world.toGeo(this.p.x, this.p.z);
    const n = 2 ** MIN_Z;
    const u = (lon + 180) / 360;
    const v = (1 - Math.asinh(Math.tan((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180)) / Math.PI) / 2;
    const cx = Math.floor(u * n), cy = Math.floor(v * n);
    const out: Tile[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const y = cy + dy;
      if (y < 0 || y >= n) continue;
      this.visit(this.getTile(MIN_Z, (((cx + dx) % n) + n) % n, y), out, pre);
    }
    return out;
  }

  private dist(t: Tile) {
    const { x, y, z } = this.p;
    const c = world.toWorld(t.cLat, t.cLon);
    const hw = (t.widthM) / 2, hd = ((t.latN - t.latS) / 2) * M_PER_DEG;
    const dx = Math.max(Math.abs(x - c.x) - hw, 0);
    const dz = Math.max(Math.abs(z - c.z) - hd, 0);
    const dy = Math.max(y - t.maxH, 0);
    return { d: Math.hypot(dx, dy, dz), cx: c.x, cz: c.z };
  }

  /** Tile can be displayed once its heights are in and (shortly after) its satellite image too, so tiles don't pop in grey. */
  private displayable(t: Tile) {
    if (t.state !== 'ready') return false;
    const e = this.images.get(this.imageKeyFor(t).key);
    return e?.state === 'ready' || performance.now() - t.readyAt > 2500;
  }

  /** Returns true if tile's area is fully covered (or culled); appends the tiles to display to `out`.
   *  With `pre` it only issues requests (look-ahead pass) and leaves split state alone. */
  private visit(t: Tile, out: Tile[], pre: boolean): boolean {
    const { d, cx, cz } = this.dist(t);
    if (d > this.viewDist) return true;
    const ready = this.displayable(t);
    if (t.state === 'idle' || !ready) {
      const dir = Math.hypot(cx - this.p.x, cz - this.p.z) || 1;
      const ahead = Math.max(0, ((cx - this.p.x) * this.p.fx + (cz - this.p.z) * this.p.fz) / dir);
      const score = d / t.widthM - 0.4 * ahead + (pre ? 0.3 : 0);
      if (t.state === 'idle') {
        if (t.want !== this.stamp) { t.want = this.stamp; t.score = score; this.queue.push(t); } else t.score = Math.min(t.score, score);
      }
      this.wantImage(t, score);
    }
    if (t.z < this.maxZ) {
      const split = d < t.widthM * (t.wasSplit ? 1.4 : 1.1);
      if (!pre) t.wasSplit = split;
      if (split) {
        const tmpOut: Tile[] = [];
        let all = true;
        const x2 = t.x * 2, y2 = t.y * 2, z1 = t.z + 1;
        for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          if (!this.visit(this.getTile(z1, x2 + ox, y2 + oy), tmpOut, pre)) all = false;
        }
        if (all) { for (const k of tmpOut) out.push(k); return true; }
      }
    }
    if (ready) { out.push(t); return true; }
    return false;
  }

  private wantImage(t: Tile, score: number) {
    const key = this.imageKeyFor(t).key;
    let e = this.images.get(key);
    if (!e) { e = { state: 'idle', last: performance.now(), score, stamp: 0, retryAt: 0 }; this.images.set(key, e); }
    if (e.state !== 'idle') return;
    if (e.stamp !== this.stamp) { e.stamp = this.stamp; e.score = score; this.imgQueue.push(key); } else e.score = Math.min(e.score, score);
  }

  private apply(out: Tile[]) {
    const now = performance.now();
    const next = new Map<string, Tile>();
    for (const t of out) {
      if (t.builtVer !== world.scaleVer) this.build(t);
      t.lastShown = now;
      next.set(t.key, t);
      if (!this.shown.has(t.key)) {
        this.group.add(t.mesh!);
        if (t.water) this.group.add(t.water);
      }
    }
    for (const [k, t] of this.shown) {
      if (!next.has(k)) { this.group.remove(t.mesh!); if (t.water) this.group.remove(t.water); }
    }
    this.shown = next;
    this.updateImagery(out);
  }

  // ---- satellite imagery ---------------------------------------------------------------------

  private imageKeyFor(t: Tile) {
    const d = Math.max(0, t.z - IMG_MAX_Z), zi = t.z - d;
    return { key: `${zi}/${t.x >> d}/${t.y >> d}`, d, zi };
  }

  private updateImagery(shown: Tile[]) {
    const now = performance.now();
    this.mapProvider?.begin();
    for (const t of shown) {
      if (!t.imgKey) t.imgKey = this.imageKeyFor(t).key;
      let e = this.images.get(t.imgKey);
      if (!e) { e = { state: 'idle', last: now, score: 0, stamp: 0, retryAt: 0 }; this.images.set(t.imgKey, e); }
      e.last = now;
      const mapped = this.tryMap(t);
      if (e.state === 'ready') { if (!t.textured && !mapped) this.applyTexture(t, e); continue; }
    }
    this.mapProvider?.end();
  }

  private pumpImages() {
    const now = performance.now();
    while (this.imgInflight < IMG_INFLIGHT && this.imgQueue.length) {
      const k = this.imgQueue.shift()!;
      const e = this.images.get(k);
      if (!e || e.state !== 'idle' || now < e.retryAt) continue;
      this.loadImage(k, e);
    }
  }

  private async loadImage(key: string, e: NonNullable<ReturnType<typeof this.images.get>>) {
    e.state = 'loading'; this.imgInflight++;
    try {
      const [z, x, y] = key.split('/');
      const res = await fetch(`${IMG_URL}${z}/${y}/${x}.jpg`);
      if (!res.ok) throw new Error(String(res.status));
      const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none' });
      const tex = new THREE.Texture(bmp as any);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = false;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.anisotropy = this.anisotropy;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.needsUpdate = true;
      e.bmp = bmp; e.tex = tex;
      e.mat = new THREE.MeshLambertMaterial({ map: tex, vertexColors: true, flatShading: true, side: THREE.DoubleSide });
      e.state = 'ready';
    } catch {
      e.state = 'idle'; e.retryAt = performance.now() + 5000;
    } finally {
      this.imgInflight--;
      this.pumpImages();
    }
  }

  /** UVs of tile t into a (coarser or equal) texture tile at zoom zi */
  private setUV(t: Tile, geo: THREE.BufferGeometry, pos: ArrayLike<number>, zi: number) {
    const d = t.z - zi, div = 2 ** d, nz = 2 ** t.z, W = geo.userData.W as number;
    const ox = t.x - (t.x >> d) * div, oy = t.y - (t.y >> d) * div;
    const cnt = pos.length / 3;
    const uv = new Float32Array(cnt * 2);
    for (let k = 0; k < cnt; k++) {
      const u = pos[k * 3] / W + 0.5;
      const lat = t.cLat - pos[k * 3 + 2] / M_PER_DEG;
      const v = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * nz - t.y;
      uv[k * 2] = (ox + u) / div; uv[k * 2 + 1] = (oy + v) / div;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    t.uvZ = zi;
  }

  /** satellite bitmap (and sub-rect) covering the zoom-zi tile (vx,vy), if loaded */
  satFor = (zi: number, vx: number, vy: number): SatSrc | undefined => {
    if (zi <= IMG_MAX_Z) { const e = this.images.get(`${zi}/${vx}/${vy}`); return e?.bmp ? { bmp: e.bmp, sx: 0, sy: 0, sw: 256, sh: 256 } : undefined; }
    const e = this.images.get(`${IMG_MAX_Z}/${vx >> 1}/${vy >> 1}`);
    return e?.bmp ? { bmp: e.bmp, sx: (vx & 1) * 128, sy: (vy & 1) * 128, sw: 128, sh: 128 } : undefined;
  };

  private tryMap(t: Tile): boolean {
    if (!this.mapProvider || t.z < 12) return false;
    const m = this.mapProvider.provide(t, this.dist(t).d, this.satFor);
    if (m) {
      if (t.mapMat !== m.mat && t.mesh) {
        t.mesh.material = m.mat;
        const geo = t.mesh.geometry;
        this.setUV(t, geo, geo.getAttribute('position').array, m.zi);
        const col = geo.getAttribute('color') as THREE.BufferAttribute;
        (col.array as Float32Array).fill(1); col.needsUpdate = true;
        t.mapMat = m.mat; t.textured = true;
      }
      return true;
    }
    if (t.mapMat) { t.mapMat = undefined; t.textured = false; }
    return false;
  }

  private applyTexture(t: Tile, e: { mat?: THREE.Material }) {
    if (!t.mesh || !e.mat) return;
    const sz = this.imageKeyFor(t).zi;
    if (t.uvZ !== sz) { const geo = t.mesh.geometry; this.setUV(t, geo, geo.getAttribute('position').array, sz); }
    t.mesh.material = e.mat;
    const col = t.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    (col.array as Float32Array).fill(1);
    col.needsUpdate = true;
    t.textured = true;
  }

  private pump() {
    const now = performance.now();
    while (this.inflight < MAX_INFLIGHT && this.queue.length) {
      const t = this.queue.shift()!;
      if (t.state !== 'idle' || now < t.retryAt) continue;
      this.load(t);
    }
  }

  private async load(t: Tile) {
    t.state = 'loading';
    this.inflight++;
    try {
      const res = await fetch(`${HOSTS[(t.x * 7 + t.y * 3 + t.z) % HOSTS.length]}${t.z}/${t.x}/${t.y}.png`);
      if (!res.ok) throw new Error(String(res.status));
      const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      this.ctx.drawImage(bmp, 0, 0, 256, 256);
      bmp.close();
      const px = this.ctx.getImageData(0, 0, 256, 256).data;
      const H = new Float32Array(256 * 256);
      for (let i = 0; i < 65536; i++) H[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
      const g = new Float32Array((N + 1) * (N + 1));
      let mn = Infinity, mx = -Infinity;
      for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
        const sx = (i / N) * 255, sy = (j / N) * 255;
        const x0 = Math.min(254, Math.floor(sx)), y0 = Math.min(254, Math.floor(sy));
        const fx = sx - x0, fy = sy - y0;
        const a = H[y0 * 256 + x0], b = H[y0 * 256 + x0 + 1], c = H[(y0 + 1) * 256 + x0], d = H[(y0 + 1) * 256 + x0 + 1];
        const h = a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
        g[j * (N + 1) + i] = h;
        if (h < mn) mn = h; if (h > mx) mx = h;
      }
      t.heights = g; t.minH = mn; t.maxH = mx;
      t.state = 'ready'; t.readyAt = performance.now();
      this.build(t);
    } catch {
      t.state = 'idle';
      t.retryAt = performance.now() + 4000;
    } finally {
      this.inflight--;
      this.pump();
    }
  }

  // ---- meshing ---------------------------------------------------------------------------

  private build(t: Tile) {
    if (!t.heights) return;
    this.disposeMesh(t);
    const H = t.heights, s = N + 1;
    const W = t.widthM;
    const lx = new Float32Array(s), lz = new Float32Array(s);
    for (let i = 0; i < s; i++) lx[i] = (i / N - 0.5) * W;
    for (let j = 0; j < s; j++) lz[j] = -(mercLat((t.y + j / N) / 2 ** t.z) - t.cLat) * M_PER_DEG;
    const snowline = 5000 - 75 * Math.max(0, Math.abs(t.cLat) - 10);
    const skirt = Math.max(15, W * 0.02);

    const quads = N * N * 2 + 4 * N * 2;
    const pos = new Float32Array(quads * 9), col = new Float32Array(quads * 9);
    let o = 0;
    const c = new THREE.Color();
    const pushTri = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, r: number, g: number, b: number) => {
      pos[o] = ax; pos[o + 1] = ay; pos[o + 2] = az; pos[o + 3] = bx; pos[o + 4] = by; pos[o + 5] = bz; pos[o + 6] = cx; pos[o + 7] = cy; pos[o + 8] = cz;
      for (let k = 0; k < 3; k++) { col[o + k * 3] = r; col[o + k * 3 + 1] = g; col[o + k * 3 + 2] = b; }
      o += 9;
    };
    const face = (i0: number, j0: number, i1: number, j1: number, i2: number, j2: number) => {
      const ax = lx[i0], ay = H[j0 * s + i0], az = lz[j0];
      const bx = lx[i1], by = H[j1 * s + i1], bz = lz[j1];
      const cx = lx[i2], cy = H[j2 * s + i2], cz = lz[j2];
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const ny1 = ny / (Math.hypot(nx, ny, nz) || 1);
      const rnd = Math.abs(Math.sin((i0 * 127.1 + j0 * 311.7 + i2 * 74.7) * 43758.5453) % 1);
      faceColor((ay + by + cy) / 3, ny1, snowline, rnd, c);
      pushTri(ax, ay, az, bx, by, bz, cx, cy, cz, c.r, c.g, c.b);
      return c;
    };
    // wall under edge segment (p -> q), colour copied from the adjacent face
    const wall = (i0: number, j0: number, i1: number, j1: number, flip: boolean, r: number, g: number, b: number) => {
      const ax = lx[i0], ay = H[j0 * s + i0], az = lz[j0], bx = lx[i1], by = H[j1 * s + i1], bz = lz[j1];
      if (flip) {
        pushTri(ax, ay, az, bx, by, bz, ax, ay - skirt, az, r, g, b);
        pushTri(bx, by, bz, bx, by - skirt, bz, ax, ay - skirt, az, r, g, b);
      } else {
        pushTri(ax, ay, az, ax, ay - skirt, az, bx, by, bz, r, g, b);
        pushTri(bx, by, bz, ax, ay - skirt, az, bx, by - skirt, bz, r, g, b);
      }
    };
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      // a(i,j) b(i+1,j) c(i,j+1) d(i+1,j+1); triangles (a,c,b) and (b,c,d), diagonal b-c
      const c1 = face(i, j, i, j + 1, i + 1, j);
      if (j === 0) wall(i, 0, i + 1, 0, false, c1.r, c1.g, c1.b);
      if (i === 0) wall(0, j, 0, j + 1, true, c1.r, c1.g, c1.b);
      const c2 = face(i + 1, j, i, j + 1, i + 1, j + 1);
      if (j === N - 1) wall(i, N, i + 1, N, true, c2.r, c2.g, c2.b);
      if (i === N - 1) wall(N, j, N, j + 1, false, c2.r, c2.g, c2.b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, o), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, o), 3));
    geo.userData.W = W;
    this.setUV(t, geo, pos, this.imageKeyFor(t).zi);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    t.mesh = new THREE.Mesh(geo, this.terrainMat);
    t.textured = false; t.mapMat = undefined;
    const ie = this.images.get(this.imageKeyFor(t).key);
    if (ie?.state === 'ready') this.applyTexture(t, ie);

    if (t.minH < 0.5) {
      const wp = new Float32Array(s * s * 3), wd = new Float32Array(s * s);
      for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) {
        const k = j * s + i, depth = Math.max(0, -H[k]);
        wp[k * 3] = lx[i]; wp[k * 3 + 1] = 0.12; wp[k * 3 + 2] = lz[j]; // 12 cm above datum: stops z-fighting with flat 0 m terrain data
        wd[k] = depth;
      }
      const idx: number[] = [];
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const a = j * s + i, b = a + 1, cc = a + s, d = cc + 1;
        idx.push(a, cc, b, b, cc, d);
      }
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.BufferAttribute(wp, 3));
      wg.setAttribute('depth', new THREE.BufferAttribute(wd, 1));
      wg.setIndex(idx);
      wg.computeVertexNormals();
      wg.computeBoundingSphere();
      t.water = new THREE.Mesh(wg, this.waterMat);
      t.water.renderOrder = 1;
    }
    t.builtVer = world.scaleVer;
    this.place(t);
    if (this.shown.has(t.key)) { // rebuilt while visible
      this.group.add(t.mesh); if (t.water) this.group.add(t.water);
    }
  }

  private disposeMesh(t: Tile) {
    for (const m of [t.mesh, t.water]) if (m) { this.group.remove(m); m.geometry.dispose(); }
    t.mesh = t.water = undefined;
  }

  private evict() {
    this.lastEvict = performance.now();
    for (const [k, t] of this.tiles) {
      if (t.state === 'ready' && !this.shown.has(k) && this.lastEvict - t.lastShown > 30000) {
        this.disposeMesh(t);
        this.tiles.delete(k);
      }
    }
    if (this.images.size > 400) {
      for (const [k, e] of this.images) {
        if (e.state === 'ready' && this.lastEvict - e.last > 90000) {
          e.tex?.dispose(); e.mat?.dispose(); e.bmp?.close();
          this.images.delete(k);
          for (const t of this.tiles.values()) if (t.imgKey === k) { t.textured = false; if (t.mesh) t.mesh.material = this.terrainMat; }
        }
      }
    }
  }
}
