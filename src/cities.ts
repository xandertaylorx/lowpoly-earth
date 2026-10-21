import * as THREE from 'three';
import { world, M_PER_DEG } from './world';
import type { Terrain } from './terrain';
import type { MapData, VT } from './mapdata';

// 3D buildings from OpenStreetMap (zoom-14 vector tiles), extruded to their real heights with a
// window-grid facade and flat roofs, merged into two meshes (walls/roofs) per tile.
const Z = 14;
const mercLat = (v: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * v))) * 180) / Math.PI;
const hash = (n: number) => { const s = Math.sin(n * 12.9898) * 43758.5453; return s - Math.floor(s); };

const WALLS = ['#e6e0d4', '#d6c3a8', '#c9a98f', '#c4beb4', '#e4d8c4', '#b59f8c', '#d1d6dc', '#bd9a82'].map((c) => new THREE.Color(c));
const GLASS = new THREE.Color('#9db8d0');
const ROOFS = ['#7d6f66', '#8b8782', '#6f7479', '#a5705a', '#5f646a', '#9b9690'].map((c) => new THREE.Color(c));
const FLOOR_H = 3.4, WIN_W = 3.3;

type Style = 0 | 1 | 2; // 0 residential (punched windows), 1 office (window bands), 2 glass curtain wall
function facadeTexture(style: Style) {
  const S = 96, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, S, S);
  if (style === 0) { // plaster/brick wall with a framed window and sill
    g.fillStyle = 'rgba(0,0,0,0.05)'; for (let y = 0; y < S; y += 6) g.fillRect(0, y, S, 1);          // brick courses
    g.fillStyle = '#e9e6e0'; g.fillRect(26, 14, 44, 56);                                                 // frame
    g.fillStyle = '#34465a'; g.fillRect(30, 18, 36, 48);                                                 // glass
    g.fillStyle = '#5d7a99'; g.fillRect(30, 18, 36, 18);                                                 // sky reflection
    g.fillStyle = '#e9e6e0'; g.fillRect(47, 18, 2, 48); g.fillRect(30, 40, 36, 2);                       // mullions
    g.fillStyle = '#cfcac2'; g.fillRect(22, 70, 52, 5);                                                  // sill
  } else if (style === 1) { // continuous glazing band with spandrel panels
    g.fillStyle = '#d9d9d6'; g.fillRect(0, 0, S, 30);                                                    // spandrel
    const gr = g.createLinearGradient(0, 30, 0, S); gr.addColorStop(0, '#6d89a8'); gr.addColorStop(1, '#2c3d52');
    g.fillStyle = gr; g.fillRect(0, 30, S, 56);
    g.fillStyle = '#e4e4e1'; g.fillRect(0, 30, 3, 56); g.fillRect(S - 3, 30, 3, 56); g.fillRect(S / 2 - 1, 30, 2, 56);
    g.fillStyle = '#bdbdb9'; g.fillRect(0, 86, S, 10);
  } else { // curtain wall: blue-green glass in a thin grid
    const gr = g.createLinearGradient(0, 0, S, S); gr.addColorStop(0, '#9fc3dd'); gr.addColorStop(0.5, '#4f7699'); gr.addColorStop(1, '#27425d');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    g.fillStyle = '#c9d2da'; g.fillRect(0, 0, S, 3); g.fillRect(0, 0, 3, S); g.fillRect(S / 2 - 1, 0, 2, S);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}
const BAY = [3.6, 4.2, 2.4], FLOOR = [3.1, 3.7, 3.7];

interface Building { ring: number[]; h: number; minH: number; colour?: string }
interface CityTile {
  x: number; y: number; state: 'idle' | 'data'; data?: Building[]; extent: number; farness: number;
  walls: THREE.Mesh[]; roofs?: THREE.Mesh; builtVer: number; terrZ: number; count?: number;
  lonW: number; lonE: number; latN: number; latS: number; cLat: number; cLon: number;
}

export class Cities {
  group = new THREE.Group();
  radius = 0;
  scale = 1; // quality multiplier on radius
  stats = { tiles: 0, buildings: 0 };
  private tiles = new Map<string, CityTile>();
  private wallMats = ([0, 1, 2] as Style[]).map((st) => new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, map: facadeTexture(st), side: THREE.DoubleSide }));
  private roofMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });

  constructor(scene: THREE.Scene, private terrain: Terrain, private maps: MapData) { scene.add(this.group); }

  private tile(x: number, y: number): CityTile {
    const k = `${x}/${y}`;
    let t = this.tiles.get(k);
    if (!t) {
      const n = 2 ** Z;
      const lonW = (x / n) * 360 - 180, lonE = ((x + 1) / n) * 360 - 180, latN = mercLat(y / n), latS = mercLat((y + 1) / n);
      t = { x, y, state: 'idle', extent: 4096, farness: 0, walls: [], builtVer: -1, terrZ: 0, lonW, lonE, latN, latS, cLat: (latN + latS) / 2, cLon: (lonW + lonE) / 2 };
      this.tiles.set(k, t);
    }
    return t;
  }

  reposition() {
    for (const t of this.tiles.values()) {
      const c = world.toWorld(t.cLat, t.cLon);
      for (const m of t.walls) m.position.set(c.x, 0, c.z);
      t.roofs?.position.set(c.x, 0, c.z);
    }
  }

  private dispose(t: CityTile) {
    for (const m of [...t.walls, t.roofs]) if (m) { this.group.remove(m); m.geometry.dispose(); }
    t.walls = []; t.roofs = undefined;
  }

  /** Call ~4x/s with the camera position and height above ground. */
  update(px: number, pz: number, agl: number) {
    this.radius = (agl > 6000 ? 0 : agl > 3000 ? 3000 : agl > 1200 ? 4500 : 5500) * this.scale; // still visible from the cockpit
    const { lat, lon } = world.toGeo(px, pz);
    const n = 2 ** Z;
    const dLat = this.radius / M_PER_DEG, dLon = this.radius / world.mLon;
    const want: CityTile[] = [];
    if (this.radius > 0) {
      const xs = [Math.floor(((lon - dLon + 180) / 360) * n), Math.floor(((lon + dLon + 180) / 360) * n)];
      const ys = [lat + dLat, lat - dLat].map((la) => Math.floor(((1 - Math.asinh(Math.tan((la * Math.PI) / 180)) / Math.PI) / 2) * n));
      for (let y = ys[0]; y <= ys[1]; y++) for (let x = xs[0]; x <= xs[1]; x++) {
        const t = this.tile(x, y), d = this.dist(t, px, pz);
        if (d < this.radius) { want.push(t); this.maps.want(Z, x, y, d / 1460 - 5); }
      }
      this.maps.end();
    }
    want.sort((a, b) => this.dist(a, px, pz) - this.dist(b, px, pz));
    let built = 0;
    for (const t of want) {
      if (t.state === 'idle') { const vt = this.maps.peek(Z, t.x, t.y); if (vt) this.parse(t, vt); }
      if (t.state === 'data' && built < 1) {
        const c = world.toWorld(t.cLat, t.cLon), g = this.terrain.heightAt(c.x, c.z);
        const needs = !t.walls.length || t.builtVer !== world.scaleVer || (g && g.z > t.terrZ && this.dist(t, px, pz) < 2500);
        if (g && g.z >= 13 && needs) { t.farness = this.dist(t, px, pz); this.build(t, g.z); built++; }
      }
    }
    for (const [k, t] of this.tiles) {
      if (this.dist(t, px, pz) > this.radius * 1.4 + 500) { this.dispose(t); this.tiles.delete(k); }
    }
    this.stats.tiles = this.tiles.size;
  }

  private dist(t: CityTile, px: number, pz: number) {
    const c = world.toWorld(t.cLat, t.cLon);
    const hw = ((t.lonE - t.lonW) / 2) * world.mLon, hd = ((t.latN - t.latS) / 2) * M_PER_DEG;
    return Math.hypot(Math.max(Math.abs(px - c.x) - hw, 0), Math.max(Math.abs(pz - c.z) - hd, 0));
  }

  private parse(t: CityTile, vt: VT) {
    t.extent = vt.extent;
    const out: Building[] = [];
    for (const f of vt.layers.building ?? []) {
      if (f.type !== 3) continue;
      const h = Number(f.props.render_height) || 0, minH = Number(f.props.render_min_height) || 0;
      const colour = typeof f.props.colour === 'string' ? f.props.colour : undefined;
      for (const r of f.parts) {
        const m = r.length / 2 - 1; // drop duplicate closing point
        if (m < 3) continue;
        let area = 0;
        for (let k = 0; k < m; k++) { const k2 = (k + 1) % m; area += r[k * 2] * r[k2 * 2 + 1] - r[k2 * 2] * r[k * 2 + 1]; }
        if (area <= 0) continue; // holes (courtyards) are skipped; outer rings only
        out.push({ ring: Array.from(r.subarray(0, m * 2)), h, minH, colour });
      }
    }
    t.data = out; t.state = 'data';
  }

  private build(t: CityTile, terrZ: number) {
    if (!t.data) return;
    this.dispose(t);
    const c = world.toWorld(t.cLat, t.cLon);
    const E = t.extent, n = 2 ** Z;
    const W = (t.lonE - t.lonW) * world.mLon;
    const lx = (px: number) => (px / E - 0.5) * W;
    const lz = (py: number) => -(mercLat((t.y + py / E) / n) - t.cLat) * M_PER_DEG;
    const mpu = W / E;
    // far tiles drop small buildings: keeps the triangle count sane when flying
    const minArea = t.farness > 3500 ? 250 : t.farness > 2200 ? 110 : 14, minHeight = t.farness > 3500 ? 18 : t.farness > 2200 ? 9 : 0;

    const wp: number[][] = [[], [], []], wc: number[][] = [[], [], []], wu: number[][] = [[], [], []];
    const rp: number[] = [], rc: number[] = [];
    const v2: THREE.Vector2[] = [];
    const tint = new THREE.Color();
    let count = 0;
    for (const b of t.data) {
      const ring = b.ring, m = ring.length / 2;
      let area = 0, cx = 0, cz = 0;
      const X: number[] = [], Zs: number[] = [];
      for (let k = 0; k < m; k++) { X.push(lx(ring[k * 2])); Zs.push(lz(ring[k * 2 + 1])); cx += X[k]; cz += Zs[k]; }
      cx /= m; cz /= m;
      for (let k = 0; k < m; k++) { const k2 = (k + 1) % m; area += X[k] * Zs[k2] - X[k2] * Zs[k]; }
      area = Math.abs(area) / 2;
      const height = b.h > 1 ? b.h : 5 + hash(ring[0] * 0.013 + ring[1] * 0.007) * 5;
      if (area < minArea || height < minHeight) continue;
      let ground = Infinity;
      for (let k = 0; k < m; k += Math.max(1, Math.floor(m / 4))) {
        const g = this.terrain.heightAt(c.x + X[k], c.z + Zs[k]);
        if (g) ground = Math.min(ground, g.h);
      }
      if (!isFinite(ground)) continue;
      ground = Math.max(ground, 0);
      const seed = ring[0] * 0.013 + ring[1] * 0.007;
      const pitched = height <= 14 && area < 380 && m <= 6 && hash(seed + 9) < 0.85 && !b.minH;
      // roof geometry: eave height and ridge (hip roof along the footprint's long axis) for houses
      let ridge: { ax: number; az: number; bx: number; bz: number; h: number } | null = null;
      if (pitched) {
        let sxx = 0, szz = 0, sxz = 0;
        for (let k = 0; k < m; k++) { const dx = X[k] - cx, dz = Zs[k] - cz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
        const th = 0.5 * Math.atan2(2 * sxz, sxx - szz), ux = Math.cos(th), uz = Math.sin(th);
        let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
        for (let k = 0; k < m; k++) { const dx = X[k] - cx, dz = Zs[k] - cz, u = dx * ux + dz * uz, v = -dx * uz + dz * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
        const Lu = u1 - u0, Lv = v1 - v0;
        if (area / (Lu * Lv) > 0.8 && Math.min(Lu, Lv) > 3) {
          const half = Math.max(0, (Math.max(Lu, Lv) - Math.min(Lu, Lv)) / 2);
          const ax = Lu >= Lv ? ux : -uz, az = Lu >= Lv ? uz : ux; // long axis
          const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2, mxc = cx + ux * mu - uz * mv, mzc = cz + uz * mu + ux * mv;
          ridge = { ax: mxc - ax * half, az: mzc - az * half, bx: mxc + ax * half, bz: mzc + az * half, h: Math.min(Math.min(Lu, Lv) * 0.32, 3.8) };
        }
      }
      const eave = ground + Math.max(height, b.minH + 2) - (ridge ? ridge.h * 0.5 : 0);
      const bottom = b.minH > 0 ? ground + b.minH : ground - 6;

      // facade style by height; colour from the OSM tag when present
      const style: Style = height > 60 ? (hash(seed + 4) < 0.7 ? 2 : 1) : height > 20 ? (hash(seed + 4) < 0.65 ? 1 : 0) : 0;
      let wall: THREE.Color;
      if (style === 2) wall = tint.set('#ffffff').multiplyScalar(0.85 + hash(seed + 1) * 0.3).clone();
      else { wall = WALLS[Math.floor(hash(seed + 2) * WALLS.length)].clone(); if (b.colour) { try { wall = new THREE.Color(b.colour).lerp(new THREE.Color('#ffffff'), 0.25); } catch { /* keep palette colour */ } } }
      const roof = ROOFS[Math.floor(hash(seed + 3) * ROOFS.length)];
      const bay = BAY[style], floor = FLOOR[style];
      const P = wp[style], C = wc[style], U = wu[style];
      for (let k = 0; k < m; k++) {
        const k2 = (k + 1) % m, ax = X[k], az = Zs[k], bx = X[k2], bz = Zs[k2];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.5) continue;
        const u1 = Math.max(1, Math.round(len / bay)), v0 = bottom / floor, v1 = eave / floor;
        P.push(ax, bottom, az, bx, bottom, bz, bx, eave, bz, ax, bottom, az, bx, eave, bz, ax, eave, az);
        U.push(0, v0, u1, v0, u1, v1, 0, v0, u1, v1, 0, v1);
        for (const f of [0.55, 0.55, 1, 0.55, 1, 1]) C.push(wall.r * f, wall.g * f, wall.b * f); // darker at the base: fake ambient occlusion
      }
      if (ridge) {
        const rh = eave + ridge.h;
        const proj = (x: number, z: number) => {
          const dx = ridge!.bx - ridge!.ax, dz = ridge!.bz - ridge!.az, l2 = dx * dx + dz * dz || 1;
          const t01 = Math.max(0, Math.min(1, ((x - ridge!.ax) * dx + (z - ridge!.az) * dz) / l2));
          return [ridge!.ax + dx * t01, ridge!.az + dz * t01];
        };
        const tile = new THREE.Color(roof).multiplyScalar(0.9 + hash(seed + 5) * 0.25);
        for (let k = 0; k < m; k++) {
          const k2 = (k + 1) % m, [pax, paz] = proj(X[k], Zs[k]), [pbx, pbz] = proj(X[k2], Zs[k2]);
          rp.push(X[k], eave, Zs[k], X[k2], eave, Zs[k2], pbx, rh, pbz);
          rp.push(X[k], eave, Zs[k], pbx, rh, pbz, pax, rh, paz);
          for (let q = 0; q < 6; q++) rc.push(tile.r, tile.g, tile.b);
        }
      } else {
        v2.length = 0;
        for (let k = 0; k < m; k++) v2.push(new THREE.Vector2(X[k], Zs[k]));
        for (const tr of THREE.ShapeUtils.triangulateShape(v2, [])) for (const idx of tr) { rp.push(v2[idx].x, eave, v2[idx].y); rc.push(roof.r, roof.g, roof.b); }
        // rooftop plant (lift housing, AC units) on bigger flat roofs
        if (area > 180 && hash(seed + 6) < 0.7) {
          const sz = 2.5 + hash(seed + 7) * 3, hh = 2 + hash(seed + 8) * 2, ox = cx + (hash(seed + 10) - 0.5) * Math.sqrt(area) * 0.3, oz = cz + (hash(seed + 11) - 0.5) * Math.sqrt(area) * 0.3;
          const box = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b2]) => [ox + a * sz / 2, oz + b2 * sz / 2]);
          const unit = new THREE.Color('#8d8f93'), top = eave + hh;
          for (let k = 0; k < 4; k++) {
            const [ax, az] = box[k], [bx, bz] = box[(k + 1) % 4];
            rp.push(ax, eave, az, bx, eave, bz, bx, top, bz, ax, eave, az, bx, top, bz, ax, top, az);
            for (let q = 0; q < 6; q++) rc.push(unit.r * 0.85, unit.g * 0.85, unit.b * 0.85);
          }
          rp.push(box[0][0], top, box[0][1], box[2][0], top, box[2][1], box[1][0], top, box[1][1], box[0][0], top, box[0][1], box[3][0], top, box[3][1], box[2][0], top, box[2][1]);
          for (let q = 0; q < 6; q++) rc.push(unit.r, unit.g, unit.b);
        }
      }
      count++;
    }
    const mk = (pos: number[], col: number[], mat: THREE.Material, uv?: number[]) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      if (uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.computeVertexNormals(); geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(c.x, 0, c.z);
      this.group.add(mesh);
      return mesh;
    };
    for (let st = 0; st < 3; st++) if (wp[st].length) t.walls.push(mk(wp[st], wc[st], this.wallMats[st], wu[st]));
    t.roofs = mk(rp, rc, this.roofMat);
    t.builtVer = world.scaleVer; t.terrZ = terrZ;
    t.count = count;
    this.stats.buildings = 0;
    for (const o of this.tiles.values()) this.stats.buildings += o.count ?? 0;
  }
}
