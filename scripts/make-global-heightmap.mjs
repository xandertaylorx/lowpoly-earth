// Stitches AWS Terrarium zoom-2 tiles into one 1024x1024 Web-Mercator PNG (still Terrarium-encoded).
import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';

const Z = 2, n = 1 << Z, T = 256;
const out = new PNG({ width: n * T, height: n * T });
for (let y = 0; y < n; y++) {
  for (let x = 0; x < n; x++) {
    const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`);
    const tile = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
    PNG.bitblt(tile, out, 0, 0, T, T, x * T, y * T);
  }
}
const buf = PNG.sync.write(out, { colorType: 2 });
writeFileSync('public/global-heightmap.png', buf);
console.log('wrote public/global-heightmap.png', buf.length, 'bytes');
