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

function facadeTexture() {
  const S = 64, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, S, S);
  g.fillStyle = '#3b4a5c'; g.fillRect(14, 12, 36, 34);
  g.fillStyle = '#6f8aa6'; g.fillRect(14, 12, 36, 14);
  g.fillStyle = '#d9d6d0'; g.fillRect(14, 46, 36, 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}

interface Building { ring: number[]; h: number; minH: number }
interface CityTile {
  x: number; y: number; state: 'idle' | 'data'; data?: Building[]; extent: number;
  walls?: THREE.Mesh; roofs?: THREE.Mesh; builtVer: number; terrZ: number; count?: number;
  lonW: number; lonE: number; latN: number; latS: number; cLat: number; cLon: number;
}

export class Cities {
  group = new THREE.Group();
  radius = 0;
  stats = { tiles: 0, buildings: 0 };
  private tiles = new Map<string, CityTile>();
  private wallMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, map: facadeTexture(), side: THREE.DoubleSide });
  private roofMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });

  constructor(scene: THREE.Scene, private terrain: Terrain, private maps: MapData) { scene.add(this.group); }

  private tile(x: number, y: number): CityTile {
    const k = `${x}/${y}`;
    let t = this.tiles.get(k);
    if (!t) {
      const n = 2 ** Z;
      const lonW = (x / n) * 360 - 180, lonE = ((x + 1) / n) * 360 - 180, latN = mercLat(y / n), latS = mercLat((y + 1) / n);
      t = { x, y, state: 'idle', extent: 4096, builtVer: -1, terrZ: 0, lonW, lonE, latN, latS, cLat: (latN + latS) / 2, cLon: (lonW + lonE) / 2 };
      this.tiles.set(k, t);
    }
    return t;
  }

  reposition() {
    for (const t of this.tiles.values()) {
      const c = world.toWorld(t.cLat, t.cLon);
      t.walls?.position.set(c.x, 0, c.z); t.roofs?.position.set(c.x, 0, c.z);
    }
  }

  private dispose(t: CityTile) {
    for (const m of [t.walls, t.roofs]) if (m) { this.group.remove(m); m.geometry.dispose(); }
    t.walls = t.roofs = undefined;
  }

  /** Call ~4x/s with the camera position and height above ground. */
  update(px: number, pz: number, agl: number) {
    this.radius = agl > 3000 ? 0 : agl > 1200 ? 2500 : agl > 400 ? 3500 : 4500;
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
        const needs = !t.walls || t.builtVer !== world.scaleVer || (g && g.z > t.terrZ && this.dist(t, px, pz) < 2500);
        if (g && g.z >= 13 && needs) { this.build(t, g.z); built++; }
      }
    }
    for (const [k, t] of this.tiles) {
      if (this.dist(t, px, pz) > this.radius * 1.4 + 500) { this.dispose(t); this.tiles.delete(k); }
    }
    this.stats.tiles = this.group.children.length / 2;
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
      for (const r of f.parts) {
        const m = r.length / 2 - 1; // drop duplicate closing point
        if (m < 3) continue;
        let area = 0;
        for (let k = 0; k < m; k++) { const k2 = (k + 1) % m; area += r[k * 2] * r[k2 * 2 + 1] - r[k2 * 2] * r[k * 2 + 1]; }
        if (area <= 0) continue; // holes (courtyards) are skipped; outer rings only
        out.push({ ring: Array.from(r.subarray(0, m * 2)), h, minH });
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

    const wp: number[] = [], wc: number[] = [], wu: number[] = [];
    const rp: number[] = [], rc: number[] = [];
    const v2: THREE.Vector2[] = [];
    let count = 0;
    for (const b of t.data) {
      const ring = b.ring, m = ring.length / 2;
      let area = 0;
      for (let k = 0; k < m; k++) { const k2 = (k + 1) % m; area += ring[k * 2] * ring[k2 * 2 + 1] - ring[k2 * 2] * ring[k * 2 + 1]; }
      if ((area / 2) * mpu * mpu < 12) continue;
      let ground = Infinity;
      for (let k = 0; k < m; k += Math.max(1, Math.floor(m / 4))) {
        const g = this.terrain.heightAt(c.x + lx(ring[k * 2]), c.z + lz(ring[k * 2 + 1]));
        if (g) ground = Math.min(ground, g.h);
      }
      if (!isFinite(ground)) continue;
      ground = Math.max(ground, 0);
      const seed = ring[0] * 0.013 + ring[1] * 0.007;
      const height = b.h > 1 ? b.h : 5 + hash(seed) * 5;
      const top = ground + Math.max(height, b.minH + 2);
      const bottom = b.minH > 0 ? ground + b.minH : ground - 6;
      const tall = height > 45;
      const wall = tall ? GLASS.clone().multiplyScalar(0.8 + hash(seed + 1) * 0.35) : WALLS[Math.floor(hash(seed + 2) * WALLS.length)];
      const roof = ROOFS[Math.floor(hash(seed + 3) * ROOFS.length)];
      for (let k = 0; k < m; k++) {
        const k2 = (k + 1) % m;
        const ax = lx(ring[k * 2]), az = lz(ring[k * 2 + 1]), bx = lx(ring[k2 * 2]), bz = lz(ring[k2 * 2 + 1]);
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.5) continue;
        const u1 = Math.max(1, Math.round(len / WIN_W)), v0 = bottom / FLOOR_H, v1 = top / FLOOR_H;
        wp.push(ax, bottom, az, bx, bottom, bz, bx, top, bz, ax, bottom, az, bx, top, bz, ax, top, az);
        wu.push(0, v0, u1, v0, u1, v1, 0, v0, u1, v1, 0, v1);
        for (let q = 0; q < 6; q++) wc.push(wall.r, wall.g, wall.b);
      }
      v2.length = 0;
      for (let k = 0; k < m; k++) v2.push(new THREE.Vector2(lx(ring[k * 2]), lz(ring[k * 2 + 1])));
      for (const tr of THREE.ShapeUtils.triangulateShape(v2, [])) for (const idx of tr) { rp.push(v2[idx].x, top, v2[idx].y); rc.push(roof.r, roof.g, roof.b); }
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
    t.walls = mk(wp, wc, this.wallMat, wu);
    t.roofs = mk(rp, rc, this.roofMat);
    t.builtVer = world.scaleVer; t.terrZ = terrZ;
    this.stats.buildings = 0;
    t.count = count;
    for (const o of this.tiles.values()) this.stats.buildings += o.count ?? 0;
  }
}
