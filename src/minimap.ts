// Minimap: colourised global Terrarium heightmap (Web-Mercator) with player dot, heading arrow,
// scale bar and lat/lon readout. M toggles zoom; double-click teleports.
const C_EARTH = 40075016.7;
const ZOOMS = [1, 6, 30];

export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private map = document.createElement('canvas');
  private ready = false;
  zoomIdx = 0;
  onTeleport?: (lat: number, lon: number) => void;
  private last = { lat: 0, lon: 0 };

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.load();
    canvas.addEventListener('dblclick', (e) => {
      const r = canvas.getBoundingClientRect();
      const g = this.pick(((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height);
      this.onTeleport?.(g.lat, g.lon);
    });
  }

  toggleZoom() { this.zoomIdx = (this.zoomIdx + 1) % ZOOMS.length; }

  private async load() {
    const img = new Image();
    img.src = import.meta.env.BASE_URL + 'global-heightmap.png';
    await img.decode();
    const S = img.width;
    this.map.width = this.map.height = S;
    const c = this.map.getContext('2d', { willReadFrequently: true })!;
    c.drawImage(img, 0, 0);
    const d = c.getImageData(0, 0, S, S);
    const px = d.data;
    for (let i = 0; i < S * S; i++) {
      const h = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
      let r: number, g: number, b: number;
      if (h < 0) { const t = Math.min(1, -h / 5000); r = 40 - 30 * t; g = 110 - 80 * t; b = 170 - 70 * t; }
      else if (h < 300) { const t = h / 300; r = 90 + 40 * t; g = 150 - 10 * t; b = 80; }
      else if (h < 1500) { const t = (h - 300) / 1200; r = 130 + 30 * t; g = 140 - 20 * t; b = 80 + 30 * t; }
      else { const t = Math.min(1, (h - 1500) / 3500); r = 160 + 90 * t; g = 120 + 130 * t; b = 110 + 140 * t; }
      px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255;
    }
    c.putImageData(d, 0, 0);
    this.ready = true;
  }

  private static uv(lat: number, lon: number) {
    const l = Math.max(-85.05, Math.min(85.05, lat));
    return { u: (lon + 180) / 360, v: (1 - Math.asinh(Math.tan((l * Math.PI) / 180)) / Math.PI) / 2 };
  }

  private view() {
    const zoom = ZOOMS[this.zoomIdx], S = this.map.width || 1024, vs = S / zoom; // visible map pixels
    const { u, v } = Minimap.uv(this.last.lat, this.last.lon);
    let sx = u * S - vs / 2, sy = v * S - vs / 2;
    if (zoom === 1) { sx = 0; sy = 0; }
    sy = Math.max(0, Math.min(S - vs, sy));
    return { S, vs, sx, sy, zoom };
  }

  private pick(cx: number, cy: number) {
    const { S, vs, sx, sy } = this.view();
    const u = (sx + (cx / this.canvas.width) * vs) / S, v = (sy + (cy / this.canvas.height) * vs) / S;
    return { lat: (Math.atan(Math.sinh(Math.PI * (1 - 2 * v))) * 180) / Math.PI, lon: u * 360 - 180 };
  }

  draw(lat: number, lon: number, headingDeg: number) {
    this.last = { lat, lon };
    const { ctx, canvas } = this, W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#0a1420'; ctx.fillRect(0, 0, W, H);
    const { S, vs, sx, sy, zoom } = this.view();
    if (this.ready) { ctx.imageSmoothingEnabled = true; ctx.drawImage(this.map, sx, sy, vs, vs, 0, 0, W, H); }

    // graticule
    ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 1; ctx.beginPath();
    const step = zoom === 1 ? 30 : zoom === 6 ? 10 : 2;
    for (let lo = -180; lo <= 180; lo += step) { const x = ((Minimap.uv(0, lo).u * S - sx) / vs) * W; if (x >= 0 && x <= W) { ctx.moveTo(x, 0); ctx.lineTo(x, H); } }
    for (let la = -80; la <= 80; la += step) { const y = ((Minimap.uv(la, 0).v * S - sy) / vs) * H; if (y >= 0 && y <= H) { ctx.moveTo(0, y); ctx.lineTo(W, y); } }
    ctx.stroke();

    // player
    const p = Minimap.uv(lat, lon);
    const px = ((p.u * S - sx) / vs) * W, py = ((p.v * S - sy) / vs) * H;
    ctx.save(); ctx.translate(px, py); ctx.rotate((headingDeg * Math.PI) / 180);
    ctx.fillStyle = '#ff3b30'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(6, 6); ctx.lineTo(0, 3); ctx.lineTo(-6, 6); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(px, py, 2.2, 0, 7); ctx.fill();

    // scale bar (metres per display pixel at this latitude)
    const mpp = (C_EARTH * Math.cos((lat * Math.PI) / 180)) / (W * zoom);
    const target = mpp * 70, pow = 10 ** Math.floor(Math.log10(target));
    const nice = [1, 2, 5, 10].map((m) => m * pow).find((m) => m >= target * 0.7) ?? 10 * pow;
    const len = nice / mpp;
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(6, H - 38, 128, 32);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath();
    ctx.moveTo(12, H - 24); ctx.lineTo(12 + len, H - 24); ctx.moveTo(12, H - 29); ctx.lineTo(12, H - 19); ctx.moveTo(12 + len, H - 29); ctx.lineTo(12 + len, H - 19); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = '11px ui-monospace, Menlo, monospace'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, 12, H - 11);
    ctx.fillText(`${zoom}x`, 12 + len + 8, H - 21);

    // readout
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, 0, W, 18);
    ctx.fillStyle = '#fff';
    ctx.fillText(`${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}  ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`, 6, 13);
  }
}
