import * as THREE from 'three';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

// OpenStreetMap vector tiles (OpenFreeMap, no key). Used for (a) building footprints/heights
// and (b) rasterising roads, parks, water, runways etc. into crisp ground textures that are
// draped on the terrain over the satellite photo.
export interface Feat { props: Record<string, any>; type: number; parts: Float32Array[] }
export interface VT { extent: number; layers: Record<string, Feat[]> }
const LAYERS = ['building', 'transportation', 'water', 'waterway', 'landcover', 'landuse', 'park', 'aeroway'];
const MAX_TEX: Record<number, number> = { 12: 12, 13: 14, 14: 20 }; // per zoom level
const RADIUS: Record<number, number> = { 12: 26000, 13: 12000, 14: 6000 };
const mercLat = (v: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * v))) * 180) / Math.PI;

type VEntry = { state: 'idle' | 'loading' | 'ready'; data?: VT; last: number; score: number; retryAt: number; wantAt: number };
export interface SatSrc { bmp: ImageBitmap; sx: number; sy: number; sw: number; sh: number }
interface TileLike { z: number; x: number; y: number }

// road class -> [width m, fill, casing, rank]
const ROADS: Record<string, [number, string, string, number]> = {
  motorway: [17, '#74716e', '#3f3d3b', 9], trunk: [14, '#787572', '#3f3d3b', 8], primary: [12, '#7d7a77', '#46433f', 7],
  secondary: [10, '#868380', '#4b4845', 6], tertiary: [8, '#8d8a87', '#514e4b', 5], minor: [6, '#94918d', '#57544f', 4],
  service: [3.6, '#9a9792', '#5e5b56', 3], pedestrian: [4, '#b2aca0', '#7a746a', 2], track: [2.6, '#a39679', '#7a6f58', 1],
  path: [1.5, '#bdb092', '#8e8266', 0],
};
const LANDCOVER: Record<string, [string, number]> = {
  grass: ['#78ab57', 0.6], wood: ['#3f7d3e', 0.7], forest: ['#3f7d3e', 0.7], farmland: ['#a8b866', 0.4], sand: ['#e0d3a0', 0.7],
  wetland: ['#6fa38a', 0.6], rock: ['#9a948a', 0.6], ice: ['#f2f6fa', 0.8], glacier: ['#f2f6fa', 0.8],
};
const LANDUSE: Record<string, [string, number]> = {
  residential: ['#b9b3a7', 0.28], suburb: ['#b9b3a7', 0.28], commercial: ['#c9b8b0', 0.4], retail: ['#cbbcae', 0.4], industrial: ['#a5a29e', 0.5],
  railway: ['#8d8984', 0.5], cemetery: ['#78ab57', 0.7], school: ['#c9c3b3', 0.35], university: ['#c9c3b3', 0.35], hospital: ['#d2c8c4', 0.4],
  pitch: ['#6fb04f', 0.85], playground: ['#6fb04f', 0.6], stadium: ['#a9a59f', 0.6], garages: ['#9b9893', 0.5], quarry: ['#b3a58b', 0.7],
};

export class MapData {
  url = '';
  private vt = new Map<string, VEntry>();
  private tex = new Map<string, { tex: THREE.CanvasTexture; mat: THREE.Material; last: number }>();
  private wanted: string[] = [];
  private inflight = 0;
  private built = 0;
  stats = { vt: 0, tex: 0 };

  constructor() {
    fetch('https://tiles.openfreemap.org/planet').then((r) => r.json()).then((j) => (this.url = j.tiles[0])).catch(() => {});
  }

  // ---- vector tile cache ---------------------------------------------------------------------
  peek(z: number, x: number, y: number): VT | undefined { const e = this.vt.get(`${z}/${x}/${y}`); if (e) e.last = performance.now(); return e?.data; }

  want(z: number, x: number, y: number, score: number) {
    const k = `${z}/${x}/${y}`;
    let e = this.vt.get(k);
    if (!e) { e = { state: 'idle', last: performance.now(), score, retryAt: 0, wantAt: 0 }; this.vt.set(k, e); }
    e.last = performance.now();
    if (e.state === 'idle') { e.wantAt = e.last; e.score = score; if (!this.wanted.includes(k)) this.wanted.push(k); }
  }

  begin() { this.built = 0; }
  end() {
    const t0 = performance.now();
    this.wanted = this.wanted.filter((k) => { const e = this.vt.get(k); return e && e.state === 'idle' && t0 - e.wantAt < 2000; });
    this.wanted.sort((a, b) => this.vt.get(a)!.score - this.vt.get(b)!.score);
    const now = performance.now();
    while (this.inflight < 8 && this.wanted.length && this.url) {
      const k = this.wanted.shift()!, e = this.vt.get(k)!;
      if (e.state === 'idle' && now >= e.retryAt) this.load(k, e);
    }
    this.stats = { vt: this.vt.size, tex: this.tex.size };
    if (this.vt.size > 400) for (const [k, e] of this.vt) if (e.state === 'ready' && now - e.last > 60000) this.vt.delete(k);
  }

  private async load(key: string, e: VEntry) {
    e.state = 'loading'; this.inflight++;
    try {
      const [z, x, y] = key.split('/');
      const res = await fetch(this.url.replace('{z}', z).replace('{x}', x).replace('{y}', y));
      if (!res.ok) throw new Error(String(res.status));
      const vt = new VectorTile(new PbfReader(new Uint8Array(await res.arrayBuffer())));
      const out: VT = { extent: 4096, layers: {} };
      for (const name of LAYERS) {
        const L = vt.layers[name];
        if (!L) continue;
        out.extent = L.extent;
        const feats: Feat[] = [];
        for (let i = 0; i < L.length; i++) {
          const f = L.feature(i);
          const parts = f.loadGeometry().map((r) => { const a = new Float32Array(r.length * 2); r.forEach((p, k) => { a[k * 2] = p.x; a[k * 2 + 1] = p.y; }); return a; });
          feats.push({ props: f.properties, type: f.type, parts });
        }
        out.layers[name] = feats;
      }
      e.data = out; e.state = 'ready';
    } catch { e.state = 'idle'; e.retryAt = performance.now() + 8000; }
    finally { this.inflight--; }
  }

  // ---- ground textures for terrain tiles -----------------------------------------------------------
  /** Map texture (satellite + roads/parks/water on top) covering terrain tile t, or null if not ready/too far. */
  provide(t: TileLike, dist: number, sat: (zi: number, vx: number, vy: number) => SatSrc | undefined) {
    const zi = Math.min(14, t.z);
    if (dist > (RADIUS[zi] ?? 0)) return null;
    const d = t.z - zi, vx = t.x >> d, vy = t.y >> d, key = `${zi}/${vx}/${vy}`;
    const hit = this.tex.get(key);
    if (hit) { hit.last = performance.now(); return { mat: hit.mat, zi }; }
    this.want(zi, vx, vy, dist / (40075016 / 2 ** zi));
    const e = this.vt.get(key);
    const s = sat(zi, vx, vy);
    if (!e?.data || !s || this.built >= 1) return null;
    this.built++;
    const tex = this.draw(zi, vx, vy, e.data, s);
    const mat = new THREE.MeshLambertMaterial({ map: tex, vertexColors: true, flatShading: true, side: THREE.DoubleSide });
    this.tex.set(key, { tex, mat, last: performance.now() });
    const same = [...this.tex].filter(([k]) => k.startsWith(`${zi}/`));
    if (same.length > MAX_TEX[zi]) {
      const now = performance.now();
      let oldest: string | null = null, ot = Infinity;
      for (const [k, v] of same) if (k !== key && v.last < ot && now - v.last > 2500) { oldest = k; ot = v.last; }
      if (oldest) { const v = this.tex.get(oldest)!; v.tex.dispose(); v.mat.dispose(); this.tex.delete(oldest); }
    }
    return { mat, zi };
  }

  private draw(z: number, _x: number, y: number, vt: VT, sat: SatSrc) {
    const S = z >= 14 ? 1536 : z === 13 ? 1024 : 512;
    const c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d')!;
    g.drawImage(sat.bmp, sat.sx, sat.sy, sat.sw, sat.sh, 0, 0, S, S);
    const k = S / vt.extent, n = 2 ** z;
    const mpp = (40075016.7 * Math.cos((mercLat((y + 0.5) / n) * Math.PI) / 180)) / n / S;
    const px = (m: number, min = 1) => Math.max(min, m / mpp);
    const L = vt.layers;

    const poly = (f: Feat) => {
      g.beginPath();
      for (const p of f.parts) { g.moveTo(p[0] * k, p[1] * k); for (let i = 2; i < p.length; i += 2) g.lineTo(p[i] * k, p[i + 1] * k); g.closePath(); }
      g.fill('evenodd');
    };
    const line = (f: Feat) => {
      g.beginPath();
      for (const p of f.parts) { g.moveTo(p[0] * k, p[1] * k); for (let i = 2; i < p.length; i += 2) g.lineTo(p[i] * k, p[i + 1] * k); }
      g.stroke();
    };
    const fillClass = (feats: Feat[] | undefined, table: Record<string, [string, number]>) => {
      for (const f of feats ?? []) {
        const t = table[f.props.class] ?? table[f.props.subclass];
        if (!t || f.type !== 3) continue;
        g.fillStyle = t[0]; g.globalAlpha = t[1]; poly(f);
      }
      g.globalAlpha = 1;
    };
    fillClass(L.landcover, LANDCOVER);
    fillClass(L.landuse, LANDUSE);
    g.fillStyle = '#6fae5c'; g.globalAlpha = 0.6;
    for (const f of L.park ?? []) if (f.type === 3) poly(f);
    g.globalAlpha = 1;
    g.fillStyle = '#4f86b8';
    for (const f of L.water ?? []) if (f.type === 3) poly(f);
    g.fillStyle = '#6b6966';
    for (const f of L.aeroway ?? []) if (f.type === 3) poly(f);
    if (z >= 14) { g.fillStyle = '#8f8b86'; g.globalAlpha = 0.6; for (const f of L.building ?? []) if (f.type === 3) poly(f); g.globalAlpha = 1; }

    g.lineJoin = 'round'; g.lineCap = 'round';
    g.strokeStyle = '#4f86b8';
    for (const f of L.waterway ?? []) {
      if (f.type !== 2) continue;
      g.lineWidth = px(f.props.class === 'river' ? 14 : f.props.class === 'canal' ? 9 : 3, 1.4); line(f);
    }
    for (const f of L.aeroway ?? []) {
      if (f.type !== 2) continue;
      g.strokeStyle = '#6b6966'; g.lineWidth = px(f.props.class === 'runway' ? 45 : 22, 1.5); line(f);
    }
    const roads = (L.transportation ?? []).filter((f) => f.type === 2 && f.props.brunnel !== 'tunnel' && (ROADS[f.props.class] || f.props.class === 'rail' || f.props.class === 'transit'));
    const rank = (f: Feat) => ROADS[f.props.class]?.[3] ?? -1;
    roads.sort((a, b) => rank(a) - rank(b));
    for (const f of roads) { // casings first so junctions merge cleanly
      const r = ROADS[f.props.class]; if (!r) continue;
      g.strokeStyle = r[2]; g.lineWidth = px(r[0] + 1.8, 1.6); g.lineCap = r[3] <= 1 ? 'butt' : 'round'; line(f);
    }
    for (const f of roads) {
      const r = ROADS[f.props.class];
      if (!r) { g.strokeStyle = '#5a5651'; g.lineWidth = px(3, 1); g.lineCap = 'butt'; line(f); continue; }
      g.strokeStyle = r[1]; g.lineWidth = px(r[0], 1.1); g.lineCap = r[3] <= 1 ? 'butt' : 'round'; line(f);
    }
    if (mpp < 2.2) { // lane markings on bigger roads
      g.setLineDash([px(5, 2), px(9, 3)]); g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineCap = 'butt';
      for (const f of roads) { const r = ROADS[f.props.class]; if (r && r[3] >= 6) { g.lineWidth = px(0.35, 0.7); line(f); } }
      g.setLineDash([]);
    }

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 8; tex.minFilter = THREE.LinearMipmapLinearFilter;
    return tex;
  }
}
