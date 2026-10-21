import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { world, M_PER_DEG } from './world';
import type { Terrain } from './terrain';
import type { MapData, VT, Feat } from './mapdata';

// Instanced street furniture and vegetation from OSM: trees in woods/parks and along streets, lampposts along roads.
const Z = 14;
const mercLat = (v: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * v))) * 180) / Math.PI;
const hash = (a: number, b: number, c = 0) => { const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453; return s - Math.floor(s); };

const TREE_RADIUS = 1800, LAMP_RADIUS = 650;
const LAMP_ROADS: Record<string, number> = { primary: 6.5, secondary: 5.5, tertiary: 4.5, minor: 3.5, service: 2.5 };
const STREET_TREE_ROADS = new Set(['tertiary', 'minor']);

function geom(parts: { g: THREE.BufferGeometry; color: string; y?: number }[]) {
  const list = parts.map(({ g, color, y = 0 }) => {
    const n = g.toNonIndexed(); n.translate(0, y, 0);
    const col = new THREE.Color(color), a = new Float32Array(n.getAttribute('position').count * 3);
    for (let i = 0; i < a.length; i += 3) { a[i] = col.r; a[i + 1] = col.g; a[i + 2] = col.b; }
    n.setAttribute('color', new THREE.BufferAttribute(a, 3));
    n.deleteAttribute('uv');
    return n;
  });
  return mergeGeometries(list)!;
}
const BROADLEAF = geom([
  { g: new THREE.CylinderGeometry(0.22, 0.32, 2.6, 5), color: '#5b4330', y: 1.3 },
  { g: new THREE.IcosahedronGeometry(2.4, 0), color: '#4f8a3a', y: 4.4 },
  { g: new THREE.IcosahedronGeometry(1.6, 0), color: '#5d9a43', y: 5.9 },
]);
const CONIFER = geom([
  { g: new THREE.CylinderGeometry(0.2, 0.28, 1.6, 5), color: '#4e3b2b', y: 0.8 },
  { g: new THREE.ConeGeometry(2.1, 4.2, 6), color: '#2f5f38', y: 3.4 },
  { g: new THREE.ConeGeometry(1.6, 3.6, 6), color: '#356b3d', y: 5.6 },
  { g: new THREE.ConeGeometry(1.0, 3.0, 6), color: '#3b7544', y: 7.4 },
]);
const POLE = geom([
  { g: new THREE.CylinderGeometry(0.07, 0.11, 7.2, 5), color: '#3d4148', y: 3.6 },
  { g: new THREE.BoxGeometry(1.5, 0.1, 0.1), color: '#3d4148', y: 7.2 },
]);
const HEAD = (() => { const g = new THREE.BoxGeometry(0.7, 0.14, 0.3).toNonIndexed(); g.translate(0.7, 7.1, 0); return g; })();

const treeMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
const poleMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
const headMat = new THREE.MeshBasicMaterial({ color: '#ffe6a8', toneMapped: false });

interface PTile { x: number; y: number; meshes: THREE.InstancedMesh[]; builtVer: number; terrZ: number; lonW: number; lonE: number; latN: number; latS: number; cLat: number; cLon: number }

function inPoly(parts: Float32Array[], x: number, y: number) {
  let inside = false;
  for (const p of parts) {
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export class Props {
  group = new THREE.Group();
  scale = 1; // quality multiplier on radii
  stats = { trees: 0, lamps: 0 };
  private tiles = new Map<string, PTile>();

  constructor(scene: THREE.Scene, private terrain: Terrain, private maps: MapData) { scene.add(this.group); }

  private tile(x: number, y: number): PTile {
    const k = `${x}/${y}`;
    let t = this.tiles.get(k);
    if (!t) {
      const n = 2 ** Z;
      const lonW = (x / n) * 360 - 180, lonE = ((x + 1) / n) * 360 - 180, latN = mercLat(y / n), latS = mercLat((y + 1) / n);
      t = { x, y, meshes: [], builtVer: -1, terrZ: 0, lonW, lonE, latN, latS, cLat: (latN + latS) / 2, cLon: (lonW + lonE) / 2 };
      this.tiles.set(k, t);
    }
    return t;
  }

  reposition() {
    for (const t of this.tiles.values()) { const c = world.toWorld(t.cLat, t.cLon); for (const m of t.meshes) m.position.set(c.x, 0, c.z); }
  }

  private dispose(t: PTile) {
    for (const m of t.meshes) { this.group.remove(m); m.dispose(); }
    t.meshes = [];
  }

  private dist(t: PTile, px: number, pz: number) {
    const c = world.toWorld(t.cLat, t.cLon);
    const hw = ((t.lonE - t.lonW) / 2) * world.mLon, hd = ((t.latN - t.latS) / 2) * M_PER_DEG;
    return Math.hypot(Math.max(Math.abs(px - c.x) - hw, 0), Math.max(Math.abs(pz - c.z) - hd, 0));
  }

  /** ~4x/s. `maxRadius` is the cities radius (data for those tiles is already being fetched). */
  update(px: number, pz: number, maxRadius: number) {
    const R = Math.min(TREE_RADIUS * this.scale, maxRadius);
    const { lat, lon } = world.toGeo(px, pz);
    const n = 2 ** Z;
    const want: PTile[] = [];
    if (R > 100) {
      const dLat = R / M_PER_DEG, dLon = R / world.mLon;
      const xs = [Math.floor(((lon - dLon + 180) / 360) * n), Math.floor(((lon + dLon + 180) / 360) * n)];
      const ys = [lat + dLat, lat - dLat].map((la) => Math.floor(((1 - Math.asinh(Math.tan((la * Math.PI) / 180)) / Math.PI) / 2) * n));
      for (let y = ys[0]; y <= ys[1]; y++) for (let x = xs[0]; x <= xs[1]; x++) {
        const t = this.tile(x, y);
        if (this.dist(t, px, pz) < R) want.push(t);
      }
    }
    want.sort((a, b) => this.dist(a, px, pz) - this.dist(b, px, pz));
    let built = 0;
    for (const t of want) {
      const vt = this.maps.peek(Z, t.x, t.y);
      if (!vt || built >= 1) continue;
      const c = world.toWorld(t.cLat, t.cLon), g = this.terrain.heightAt(c.x, c.z);
      const needs = !t.meshes.length || t.builtVer !== world.scaleVer || (g && g.z > t.terrZ && this.dist(t, px, pz) < 1200);
      if (g && g.z >= 14 && needs) { this.build(t, vt, g.z, this.dist(t, px, pz) < LAMP_RADIUS * this.scale + 500); built++; }
    }
    for (const [k, t] of this.tiles) {
      if (this.dist(t, px, pz) > R * 1.4 + 300) { this.dispose(t); this.tiles.delete(k); }
    }
    this.stats.trees = 0; this.stats.lamps = 0;
    for (const t of this.tiles.values()) for (const m of t.meshes) { if (m.userData.kind === 'tree') this.stats.trees += m.count; else if (m.userData.kind === 'lamp') this.stats.lamps += m.count; }
  }

  private build(t: PTile, vt: VT, terrZ: number, withLamps: boolean) {
    this.dispose(t);
    const c = world.toWorld(t.cLat, t.cLon);
    const E = vt.extent, n = 2 ** Z, W = (t.lonE - t.lonW) * world.mLon, mpu = W / E;
    const lx = (px: number) => (px / E - 0.5) * W;
    const lz = (py: number) => -(mercLat((t.y + py / E) / n) - t.cLat) * M_PER_DEG;
    const ground = (x: number, z: number) => this.terrain.heightAt(c.x + x, c.z + z)?.h ?? null;
    const conifer = Math.abs(t.cLat) > 52 || (this.terrain.heightAt(c.x, c.z)?.h ?? 0) > 500;

    const broad: number[][] = [], cone: number[][] = [], poles: number[][] = []; // [x,y,z,rotY,scale]
    const push = (arr: number[][], x: number, z: number, rot: number, sc: number) => { const h = ground(x, z); if (h !== null && h > 0.5) arr.push([x, h, z, rot, sc]); };

    // woods and parks: jittered grid scatter inside the polygons
    const scatter = (f: Feat, spacingM: number, density: number) => {
      const sp = spacingM / mpu;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const p of f.parts) for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
      x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(E, x1); y1 = Math.min(E, y1);
      for (let gy = Math.floor(y0 / sp); gy * sp < y1; gy++) for (let gx = Math.floor(x0 / sp); gx * sp < x1; gx++) {
        if (broad.length + cone.length > 6500) return;
        const r1 = hash(gx, gy, t.x), r2 = hash(gx, gy, t.y + 5);
        if (r1 > density) continue;
        const ux = (gx + r1 / density) * sp, uy = (gy + r2) * sp;
        if (ux < 0 || uy < 0 || ux > E || uy > E || !inPoly(f.parts, ux, uy)) continue;
        const useCone = conifer ? hash(gx, gy, 9) < 0.8 : hash(gx, gy, 9) < 0.15;
        push(useCone ? cone : broad, lx(ux), lz(uy), hash(gx, gy, 3) * 6.28, 0.7 + hash(gx, gy, 4) * 0.8);
      }
    };
    for (const f of vt.layers.landcover ?? []) if (f.type === 3 && (f.props.class === 'wood' || f.props.class === 'forest')) scatter(f, 7, 0.75);
    for (const f of vt.layers.landcover ?? []) if (f.type === 3 && f.props.class === 'grass' && ['park', 'recreation_ground', 'garden'].includes(f.props.subclass)) scatter(f, 14, 0.5);
    for (const f of vt.layers.landuse ?? []) if (f.type === 3 && (f.props.class === 'cemetery' || f.props.class === 'recreation_ground')) scatter(f, 16, 0.45);

    // roads: lampposts every ~32 m on alternating sides, trees every ~26 m on residential streets
    if (withLamps) {
      for (const f of vt.layers.transportation ?? []) {
        const hw = LAMP_ROADS[f.props.class];
        if (f.type !== 2 || hw === undefined || f.props.brunnel === 'tunnel') continue;
        for (const part of f.parts) {
          let acc = 0, side = 1;
          for (let i = 0; i + 3 < part.length; i += 2) {
            const ax = lx(part[i]), az = lz(part[i + 1]), bx = lx(part[i + 2]), bz = lz(part[i + 3]);
            const len = Math.hypot(bx - ax, bz - az);
            if (len < 0.1) continue;
            const dx = (bx - ax) / len, dz = (bz - az) / len, nx = -dz, nz = dx;
            let d = 32 - acc;
            while (d < len) {
              const x = ax + dx * d + nx * (hw + 1.4) * side, z = az + dz * d + nz * (hw + 1.4) * side;
              if (poles.length < 2600) push(poles, x, z, Math.atan2(nz * side, -nx * side), 1);
              if (STREET_TREE_ROADS.has(f.props.class) && hash(x, z, 1) < 0.55) {
                const tx = ax + dx * (d + 13) + nx * (hw + 3.6) * -side, tz = az + dz * (d + 13) + nz * (hw + 3.6) * -side;
                push(conifer ? cone : broad, tx, tz, hash(tx, tz, 2) * 6.28, 0.6 + hash(tx, tz, 3) * 0.5);
              }
              d += 32; side = -side;
            }
            acc = len - (d - 32);
          }
        }
      }
    }

    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, arr: number[][], kind: string, tint = false) => {
      if (!arr.length) return;
      const im = new THREE.InstancedMesh(geo, mat, arr.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
      arr.forEach(([x, y, z, rot, s], i) => {
        q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rot); sc.setScalar(s); p.set(x, y - 0.1, z);
        im.setMatrixAt(i, m.compose(p, q, sc));
        if (tint) im.setColorAt(i, col.setHSL(0.27 + (hash(x, z, 7) - 0.5) * 0.08, 0.05 + hash(x, z, 8) * 0.12, 0.8 + hash(x, z, 6) * 0.2));
      });
      im.castShadow = kind !== 'lampHead'; im.receiveShadow = kind === 'tree';
      im.position.set(c.x, 0, c.z); im.userData.kind = kind; im.frustumCulled = true;
      im.computeBoundingSphere();
      this.group.add(im); t.meshes.push(im);
    };
    mk(BROADLEAF, treeMat, broad, 'tree', true);
    mk(CONIFER, treeMat, cone, 'tree', true);
    mk(POLE, poleMat, poles, 'lamp');
    mk(HEAD, headMat, poles, 'lampHead');
    t.builtVer = world.scaleVer; t.terrZ = terrZ;
  }
}
