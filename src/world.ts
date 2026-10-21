// Real-world scale: 1 unit = 1 metre. x = east, y = up, z = south.
// The origin (lat0, lon0) is re-centred on the player (rebase) to keep float32 positions small.
export const R_EARTH = 6371008.8;
export const M_PER_DEG = (R_EARTH * Math.PI) / 180;
export const wrapLon = (l: number) => ((((l + 540) % 360) + 360) % 360) - 180;
const rad = Math.PI / 180;

class World {
  lat0 = 53.45;
  lon0 = -2.27;
  scaleLat = 53.45; // latitude used for the cos(lat) longitude scale
  cosLat = Math.cos(53.45 * rad);
  scaleVer = 0; // bumped when the longitude scale changes (tile meshes must be rebuilt)

  get mLon() { return M_PER_DEG * this.cosLat; }

  toWorld(lat: number, lon: number) {
    return { x: wrapLon(lon - this.lon0) * this.mLon, z: -(lat - this.lat0) * M_PER_DEG };
  }
  toGeo(x: number, z: number) {
    return { lat: this.lat0 - z / M_PER_DEG, lon: wrapLon(this.lon0 + x / this.mLon) };
  }
  setOrigin(lat: number, lon: number) {
    this.lat0 = lat; this.lon0 = wrapLon(lon);
    this.scaleLat = lat; this.cosLat = Math.cos(lat * rad);
    this.scaleVer++;
  }
  /** Move origin to world point (px,pz). Returns a function that remaps old world coords to new ones. */
  rebase(px: number, pz: number) {
    const old = { lat0: this.lat0, lon0: this.lon0, mLon: this.mLon };
    const g = this.toGeo(px, pz);
    this.lat0 = g.lat; this.lon0 = g.lon;
    if (Math.abs(g.lat - this.scaleLat) > 0.25) {
      this.scaleLat = g.lat; this.cosLat = Math.cos(g.lat * rad); this.scaleVer++;
    }
    return (x: number, z: number) => {
      const lat = old.lat0 - z / M_PER_DEG;
      const lon = wrapLon(old.lon0 + x / old.mLon);
      return this.toWorld(lat, lon);
    };
  }
}
export const world = new World();

/** Sun position (azimuth from north clockwise, altitude) in degrees for a UTC time. */
export function sunPosition(t: number, lat: number, lon: number) {
  const d = t / 86400000 - 10957.5;
  const L = 280.46 + 0.9856474 * d;
  const g = (357.528 + 0.9856003 * d) * rad;
  const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 4e-7 * d) * rad;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const H = ((280.46061837 + 360.98564736629 * d + lon) * rad) - ra;
  const phi = lat * rad;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)) + Math.PI;
  return { az, alt }; // radians
}
