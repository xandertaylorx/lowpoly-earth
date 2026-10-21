import * as THREE from 'three';
import { world } from './world';
import { Terrain } from './terrain';
import { Sky, describe } from './weather';
import { Minimap } from './minimap';
import { Plane, type PlaneInput } from './plane';
import { Cities } from './cities';
import { MapData } from './mapdata';

const $ = (id: string) => document.getElementById(id)!;
const canvas = $('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.5, 600000);
const resize = () => { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); };
addEventListener('resize', resize); resize();

const START = { lat: 53.45, lon: -2.27 }; // Manchester, UK
world.setOrigin(START.lat, START.lon);
const terrain = new Terrain(scene);
const sky = new Sky(scene);
const maps = new MapData();
terrain.mapProvider = maps;
const cities = new Cities(scene, terrain, maps);
const plane = new Plane(scene);
const minimap = new Minimap($('minimap') as HTMLCanvasElement);
const q = new URLSearchParams(location.search);
if (q.has('hours')) sky.timeOffsetH = parseFloat(q.get('hours')!);

// ---- state ------------------------------------------------------------------------------
type Mode = 'walk' | 'fly';
let mode: Mode = 'walk';
const player = { pos: new THREE.Vector3(0, 6000, 0), yaw: -0.6, pitch: 0, vy: 0, needsGround: true, swimming: false };
let cockpit = false;
const keys = new Set<string>();
const camPos = new THREE.Vector3();
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), windV = new THREE.Vector3();
let crashTimer = 0;

(window as any).__rw = { maps, cities, terrain, world, camera, player, plane, sky, keys, get mode() { return mode; }, teleport: (a: number, b: number) => teleport(a, b) };

const groundAt = (x: number, z: number) => terrain.heightAt(x, z);

// ---- input ------------------------------------------------------------------------------
const typing = () => document.activeElement instanceof HTMLInputElement;
addEventListener('keydown', (e) => {
  if (typing()) { if (e.code === 'Escape') (document.activeElement as HTMLElement).blur(); return; }
  if (e.repeat) { keys.add(e.code); return; }
  keys.add(e.code);
  if (e.code === 'KeyF') toggleVehicle();
  if (e.code === 'KeyM') minimap.toggleZoom();
  if (e.code === 'KeyC' && mode === 'fly') cockpit = !cockpit;
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
let dragging = false;
canvas.addEventListener('click', () => { if (!document.pointerLockElement) canvas.requestPointerLock?.(); });
canvas.addEventListener('mousedown', () => (dragging = true));
addEventListener('mouseup', () => (dragging = false));
addEventListener('mousemove', (e) => {
  if (mode !== 'walk' || (!document.pointerLockElement && !dragging)) return;
  player.yaw -= e.movementX * 0.0022;
  player.pitch = Math.max(-1.5, Math.min(1.5, player.pitch - e.movementY * 0.0022));
});

function notify(text: string, ms = 2500) {
  const m = $('msg'); m.textContent = text; m.style.display = 'block';
  clearTimeout((notify as any).t); (notify as any).t = setTimeout(() => (m.style.display = 'none'), ms);
}

// ---- teleport -----------------------------------------------------------------------------
function parseCoords(s: string) {
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*°?\s*([NSns])?[\s,;/]+(-?\d+(?:\.\d+)?)\s*°?\s*([EWew])?/);
  if (!m) return null;
  let lat = parseFloat(m[1]), lon = parseFloat(m[3]);
  if (m[2]?.toLowerCase() === 's') lat = -Math.abs(lat);
  if (m[4]?.toLowerCase() === 'w') lon = -Math.abs(lon);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}
function teleport(lat: number, lon: number) {
  world.setOrigin(lat, lon);
  sky.cloudOff.set(0, 0);
  terrain.reposition();
  cities.reposition();
  if (mode === 'fly') {
    plane.pos.set(0, Math.max(plane.pos.y, 1500), 0);
    player.pos.copy(plane.pos);
  } else {
    player.pos.set(0, 6000, 0); player.vy = 0; player.needsGround = true;
    $('load').classList.remove('hide');
  }
  plane.placed = mode === 'fly';
  sky.refresh(lat, lon);
  notify(`Teleported to ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
}
const tpin = $('tpin') as HTMLInputElement;
async function geocode(name: string) {
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(name)}`);
  const j = await r.json();
  if (j.length) return { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon), label: String(j[0].display_name).split(',').slice(0, 2).join(',') };
  const r2 = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(name)}`);
  const j2 = await r2.json();
  const p = j2.results?.[0];
  return p ? { lat: p.latitude, lon: p.longitude, label: `${p.name}, ${p.country ?? ''}` } : null;
}
const goTeleport = async () => {
  const text = tpin.value.trim();
  if (!text) return;
  const c = parseCoords(text);
  if (c) { teleport(c.lat, c.lon); tpin.blur(); return; }
  notify(`Searching for "${text}"…`);
  try {
    const g = await geocode(text);
    if (!g || Math.abs(g.lat) > 85) { notify(`Couldn't find "${text}"`); return; }
    teleport(g.lat, g.lon); notify(`Teleported to ${g.label}`); tpin.blur();
  } catch { notify('Place search failed (offline?) — try coordinates like 36.1, -112.1'); }
};
$('tpgo').addEventListener('click', goTeleport);
tpin.addEventListener('keydown', (e) => { if (e.key === 'Enter') goTeleport(); });
minimap.onTeleport = (lat, lon) => teleport(lat, lon);

// ---- plane boarding ---------------------------------------------------------------------------
function toggleVehicle() {
  if (mode === 'walk') {
    if (player.needsGround) return;
    const dx = plane.pos.x - player.pos.x, dz = plane.pos.z - player.pos.z;
    if (!plane.placed || Math.hypot(dx, dz) > 120) {
      const g = groundAt(player.pos.x - Math.sin(player.yaw) * 45, player.pos.z - Math.cos(player.yaw) * 45);
      const fx = player.pos.x - Math.sin(player.yaw) * 45, fz = player.pos.z - Math.cos(player.yaw) * 45;
      plane.park(fx, fz, Math.max(0, g?.h ?? player.pos.y - 1.7), player.yaw);
      notify('Plane brought to you');
    }
    mode = 'fly'; cockpit = false;
    camPos.copy(plane.pos);
    notify('Boarded — ↑/↓ throttle, S pull up, W push down, A/D roll, Q/E rudder, C cockpit view, F leave', 5000);
  } else {
    if (!plane.onGround || plane.speed > 12) { notify('Land and slow below 12 m/s to leave the plane'); return; }
    const right = tmpV.set(1, 0, 0).applyQuaternion(plane.q); right.y = 0; right.normalize();
    player.pos.set(plane.pos.x + right.x * -12, 0, plane.pos.z + right.z * -12);
    const g = groundAt(player.pos.x, player.pos.z);
    player.pos.y = Math.max(0, g?.h ?? 0);
    player.yaw = plane.headingRad() * -1; player.pitch = 0; player.vy = 0;
    mode = 'walk';
  }
}

// ---- per-mode update -------------------------------------------------------------------------
function walk(dt: number) {
  const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const fwd = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const str = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const g = groundAt(player.pos.x, player.pos.z);
  if (player.needsGround) {
    if (g && g.z >= 13) {
      player.needsGround = false; player.pos.y = Math.max(0, g.h); player.vy = 0;
      $('load').classList.add('hide');
      if (!plane.placed) { // park the plane a short walk from the spawn point
        const px = 35, pz = -30, pg = groundAt(px, pz);
        plane.park(px, pz, Math.max(0, pg?.h ?? g.h), 0.9);
      }
    }
    return;
  }
  const ground = g ? Math.max(0, g.h) : player.pos.y;
  player.swimming = !!g && g.h < -0.3;
  const speed = (sprint ? 28 : 6) * (player.swimming ? 0.35 : 1);
  const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
  let mx = -sy * fwd + cy * str, mz = -cy * fwd - sy * str;
  const len = Math.hypot(mx, mz);
  if (len > 0) { mx /= len; mz /= len; }
  player.pos.x += mx * speed * dt; player.pos.z += mz * speed * dt;
  const g2 = groundAt(player.pos.x, player.pos.z);
  const target = g2 ? Math.max(0, g2.h) : ground;
  // jump + gravity; otherwise glide smoothly over LOD changes
  if (keys.has('Space') && player.pos.y <= target + 0.15 && !player.swimming) player.vy = 6.5;
  player.vy -= 20 * dt;
  player.pos.y += player.vy * dt;
  if (player.pos.y <= target) {
    player.vy = 0;
    player.pos.y = THREE.MathUtils.lerp(player.pos.y, target, 1 - Math.exp(-18 * dt));
    if (Math.abs(target - player.pos.y) < 0.01) player.pos.y = target;
  }
}

function fly(dt: number) {
  const k = (c: string) => (keys.has(c) ? 1 : 0);
  const inp: PlaneInput = {
    pitch: k('KeyS') - k('KeyW'),
    roll: k('KeyD') - k('KeyA'),
    yaw: k('KeyQ') + k('ArrowLeft') - k('KeyE') - k('ArrowRight'),
    throttleDelta: k('ArrowUp') - k('ArrowDown'),
    brake: keys.has('Space') || keys.has('KeyB'),
  };
  const g = groundAt(plane.pos.x, plane.pos.z);
  sky.windAt(plane.pos.y, windV);
  plane.update(dt, inp, g ? g.h : null, windV);
  if (plane.crashed && crashTimer <= 0) { crashTimer = 1.5; notify('Crashed! Recovering…', 2000); }
  if (crashTimer > 0) { crashTimer -= dt; if (crashTimer <= 0) plane.recover(g?.h ?? 0); }
  player.pos.copy(plane.pos);
}

function placeCamera(dt: number) {
  if (mode === 'walk') {
    camera.position.set(player.pos.x, player.pos.y + 1.7, player.pos.z);
    camera.up.set(0, 1, 0);
    camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
    camPos.copy(camera.position);
    return;
  }
  if (cockpit) {
    camera.position.copy(tmpV.set(0, 2.2, -16).applyQuaternion(plane.q).add(plane.pos));
    camera.quaternion.copy(plane.q);
    camPos.copy(camera.position);
    return;
  }
  const want = tmpV.set(0, 9, 40).applyQuaternion(plane.q).add(plane.pos);
  camPos.lerp(want, 1 - Math.exp(-9 * dt));
  camera.position.copy(camPos);
  camera.up.lerp(tmpV2.set(0, 1, 0).applyQuaternion(plane.q), 1 - Math.exp(-3 * dt)).normalize();
  camera.lookAt(tmpV2.set(0, 2, -60).applyQuaternion(plane.q).add(plane.pos));
}

// ---- main loop -----------------------------------------------------------------------------------
let last = performance.now(), tAcc = 0, hudAcc = 0;
const hud = $('hud'), help = $('help');
const fmt = (v: number, d = 0) => v.toFixed(d);

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (mode === 'walk') walk(dt); else fly(dt);

  // rebase the world origin around the vehicle/player to keep float precision
  const pivot = mode === 'fly' ? plane.pos : player.pos;
  if (!player.needsGround && Math.hypot(pivot.x, pivot.z) > (mode === 'fly' ? 4000 : 2500)) {
    const remap = world.rebase(pivot.x, pivot.z);
    for (const p of [player.pos, plane.pos, camPos]) { const r = remap(p.x, p.z); p.x = r.x; p.z = r.z; }
    sky.rebase(remap);
    terrain.reposition(remap);
    cities.reposition();
  }
  placeCamera(dt);

  const geo = world.toGeo(camera.position.x, camera.position.z);
  tAcc += dt;
  if (tAcc > 0.1) {
    tAcc = 0;
    const f = tmpV.set(0, 0, -1).applyQuaternion(mode === 'fly' ? plane.q : camera.quaternion);
    terrain.update(camera.position.x, camera.position.y, camera.position.z, f.x, f.z, Math.min(sky.fogFar * 1.05, 150000));
    const cg0 = groundAt(camera.position.x, camera.position.z);
    cities.update(camera.position.x, camera.position.z, camera.position.y - Math.max(0, cg0?.h ?? 0));
  }
  const cg = groundAt(camera.position.x, camera.position.z);
  sky.update(dt, camera, geo.lat, geo.lon, camera.position.y - Math.max(0, cg?.h ?? 0));
  if (sky.ageMs > 10 * 60 * 1000) { const g = world.toGeo(player.pos.x, player.pos.z); sky.refresh(g.lat, g.lon); }
  renderer.render(scene, camera);

  hudAcc += dt;
  if (hudAcc > 0.1) {
    hudAcc = 0;
    const pg = world.toGeo(player.pos.x, player.pos.z);
    const fwd = tmpV.set(0, 0, -1).applyQuaternion(mode === 'fly' ? plane.q : camera.quaternion);
    const heading = ((Math.atan2(fwd.x, -fwd.z) * 180) / Math.PI + 360) % 360;
    minimap.draw(pg.lat, pg.lon, heading);
    const g = groundAt(player.pos.x, player.pos.z);
    const w = sky.w, lt = sky.localTime;
    const vehicle = mode === 'fly'
      ? `FLYING  ${fmt(plane.speed)} m/s (${fmt(plane.speed * 3.6)} km/h)  thr ${fmt(plane.throttle * 100)}%\n` +
        `V/S ${fmt(plane.vs)} m/s  pitch ${fmt(plane.pitchDeg())}°  bank ${fmt(-plane.bankDeg())}°${plane.onGround ? '  [on ground]' : plane.speed < 65 ? '  STALL' : ''}`
      : (player.needsGround ? 'Loading terrain…' : `ON FOOT${player.swimming ? ' (swimming)' : ''}   F: board plane`);
    hud.textContent =
      `${Math.abs(pg.lat).toFixed(4)}°${pg.lat >= 0 ? 'N' : 'S'}  ${Math.abs(pg.lon).toFixed(4)}°${pg.lon >= 0 ? 'E' : 'W'}\n` +
      `Alt ${fmt(player.pos.y)} m ASL` + (g ? `   AGL ${fmt(player.pos.y - Math.max(0, g.h))} m` : '') + `   HDG ${fmt(heading)}°\n` +
      vehicle + '\n' +
      `${describe(w)} ${fmt(w.temp, 1)}°C  cloud ${fmt(w.cloud)}%  wind ${fmt(w.wind, 1)} m/s @${fmt(w.windDir)}°\n` +
      `vis ${fmt(w.vis / 1000, 1)} km  fog ${fmt(sky.fogFar / 1000, 1)} km  [${sky.status}]\n` +
      `Local ${lt.toISOString().slice(11, 16)}  sun ${fmt(sky.sunAlt)}°\n` +
      `tiles ${terrain.stats.shown} shown · ${terrain.stats.ready} cached · ${terrain.stats.inflight} loading\n` +
      `${cities.stats.tiles} city tiles · ${cities.stats.buildings} buildings`;
    help.textContent = mode === 'walk'
      ? 'WASD walk · Shift sprint · Space jump\nMouse look (click to capture, Esc frees)\nF board plane · M map zoom\nDouble-click map to teleport'
      : 'TAKEOFF: hold ↑ to full throttle, at 70+ m/s\ntap S gently to lift off. Avoid diving into the ground.\n↑/↓ throttle · S pull up · W push down\nA/D roll · Q/E rudder · Space brake\nC cockpit/chase · F leave (on ground)\nM map zoom';
  }
}
requestAnimationFrame(frame);
sky.refresh(START.lat, START.lon);
