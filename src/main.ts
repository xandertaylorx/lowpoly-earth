import * as THREE from 'three';
import { world } from './world';
import { Terrain } from './terrain';
import { Sky, describe } from './weather';
import { Minimap } from './minimap';
import { Plane, AIRLINER, JET, type PlaneInput } from './plane';
import { Car } from './car';
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
const airliner = new Plane(scene, AIRLINER);
const jet = new Plane(scene, JET);
const car = new Car(scene);
const minimap = new Minimap($('minimap') as HTMLCanvasElement);
const q = new URLSearchParams(location.search);
if (q.has('hours')) sky.timeOffsetH = parseFloat(q.get('hours')!);

// ---- state ------------------------------------------------------------------------------
type Mode = 'walk' | 'fly' | 'drive';
let mode: Mode = 'walk';
type VehicleId = 'airliner' | 'jet' | 'car';
const VEHICLES: Record<VehicleId, { v: Plane | Car; label: string }> = {
  airliner: { v: airliner, label: 'Airliner' }, jet: { v: jet, label: 'Stealth jet' }, car: { v: car, label: 'Car' },
};
let selected: VehicleId = 'airliner';
let veh: Plane | Car = airliner; // the vehicle you are in (when mode != walk)
const player = { pos: new THREE.Vector3(0, 6000, 0), yaw: -0.6, pitch: 0, vy: 0, needsGround: true, swimming: false };
let cockpit = false;
const keys = new Set<string>();
const camPos = new THREE.Vector3();
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), windV = new THREE.Vector3();
let crashTimer = 0;

(window as any).__rw = { maps, cities, terrain, world, camera, player, airliner, jet, car, sky, keys, get veh() { return veh; }, get mode() { return mode; }, teleport: (a: number, b: number) => teleport(a, b) };

const groundAt = (x: number, z: number) => terrain.heightAt(x, z);

// ---- input ------------------------------------------------------------------------------
const typing = () => document.activeElement instanceof HTMLInputElement;
addEventListener('keydown', (e) => {
  if (typing()) { if (e.code === 'Escape') (document.activeElement as HTMLElement).blur(); return; }
  if (e.repeat) { keys.add(e.code); return; }
  keys.add(e.code);
  if (e.code === 'KeyF') toggleVehicle();
  if (e.code === 'KeyM') minimap.toggleZoom();
  if (e.code === 'KeyC' && mode !== 'walk') cockpit = !cockpit;
  if (mode === 'walk' && ['Digit1', 'Digit2', 'Digit3'].includes(e.code)) select((['airliner', 'jet', 'car'] as VehicleId[])[+e.code.slice(5) - 1]);
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
    veh.pos.set(0, Math.max(veh.pos.y, 1500), 0);
    player.pos.copy(veh.pos);
  } else if (mode === 'drive') {
    veh.pos.set(0, 6000, 0); (veh as Car).grounded = false; player.pos.copy(veh.pos);
  } else {
    player.pos.set(0, 6000, 0); player.vy = 0; player.needsGround = true;
    $('load').classList.remove('hide');
  }
  for (const o of Object.values(VEHICLES)) if (o.v !== veh || mode === 'walk') o.v.placed = false;
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

// ---- vehicle selection + boarding -------------------------------------------------------------
function select(id: VehicleId) {
  selected = id;
  for (const k of Object.keys(VEHICLES)) $('veh-' + k).classList.toggle('on', k === id);
  notify(`${VEHICLES[id].label} selected — press F to summon it`, 1800);
}
for (const id of Object.keys(VEHICLES) as VehicleId[]) $('veh-' + id).addEventListener('click', () => { if (mode === 'walk') select(id); });

const HELP_FLY = 'TAKEOFF: hold ↑ to full throttle, at rotate speed\ntap S gently to lift off.\n↑/↓ throttle · S pull up · W push down\nA/D roll · Q/E rudder · Space brake\nC cockpit/chase · F leave (on ground)\nM map zoom';
function toggleVehicle() {
  if (mode === 'walk') {
    if (player.needsGround) return;
    const v = VEHICLES[selected].v;
    if (!v.placed || Math.hypot(v.pos.x - player.pos.x, v.pos.z - player.pos.z) > 120) {
      const fx = player.pos.x - Math.sin(player.yaw) * 45, fz = player.pos.z - Math.cos(player.yaw) * 45;
      const g = groundAt(fx, fz);
      v.park(fx, fz, Math.max(0, g?.h ?? player.pos.y), player.yaw);
      notify(`${VEHICLES[selected].label} brought to you`);
    }
    veh = v; mode = v instanceof Car ? 'drive' : 'fly'; cockpit = false;
    camPos.copy(v.pos);
    notify(mode === 'drive' ? 'Driving — W/S throttle, A/D steer, Space handbrake, C view, F get out' : `Boarded the ${VEHICLES[selected].label.toLowerCase()} — ${HELP_FLY.split('\n')[2]}`, 4500);
  } else {
    const slow = veh instanceof Car ? Math.abs(veh.speed) < 8 : veh.onGround && veh.speed < 12;
    if (!slow) { notify(veh instanceof Car ? 'Slow down to get out' : 'Land and slow below 12 m/s to leave'); return; }
    const right = tmpV.set(1, 0, 0).applyQuaternion(veh.q); right.y = 0; right.normalize();
    const side = veh instanceof Car ? -3 : -12;
    player.pos.set(veh.pos.x + right.x * side, 0, veh.pos.z + right.z * side);
    const g = groundAt(player.pos.x, player.pos.z);
    player.pos.y = Math.max(0, g?.h ?? 0);
    player.yaw = veh.headingRad() * -1; player.pitch = 0; player.vy = 0;
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
      // park each vehicle a short walk from the spawn point (only ones not already placed)
      const spots: [Plane | Car, number, number, number][] = [[airliner, 35, -30, 0.9], [jet, 60, 6, 0.5], [car, 12, -18, -0.4]];
      for (const [v, px, pz, yaw] of spots) {
        if (v.placed) continue;
        const pg = groundAt(px, pz);
        v.park(px, pz, Math.max(0, pg?.h ?? g.h), yaw);
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
  const plane = veh as Plane;
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

function drive(dt: number) {
  const c = veh as Car, k = (code: string) => (keys.has(code) ? 1 : 0);
  c.update(dt, { throttle: k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown'), steer: k('KeyA') + k('ArrowLeft') - k('KeyD') - k('ArrowRight'), brake: keys.has('Space') }, (x, z) => groundAt(x, z)?.h ?? null);
  player.pos.copy(c.pos);
}

function placeCamera(dt: number) {
  if (mode === 'walk') {
    camera.position.set(player.pos.x, player.pos.y + 1.7, player.pos.z);
    camera.up.set(0, 1, 0);
    camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
    camPos.copy(camera.position);
    return;
  }
  const cm = veh.cam;
  if (cockpit) {
    camera.position.copy(tmpV.set(cm.cockpit[0], cm.cockpit[1], cm.cockpit[2]).applyQuaternion(veh.q).add(veh.pos));
    camera.quaternion.copy(veh.q);
    camPos.copy(camera.position);
    return;
  }
  const stiff = mode === 'drive' ? 7 : 9;
  const want = tmpV.set(0, cm.up, cm.back).applyQuaternion(veh.q).add(veh.pos);
  camPos.lerp(want, 1 - Math.exp(-stiff * dt));
  camera.position.copy(camPos);
  camera.up.lerp(tmpV2.set(0, 1, 0).applyQuaternion(veh.q), 1 - Math.exp(-3 * dt)).normalize();
  camera.lookAt(tmpV2.set(0, cm.up * 0.25, -cm.back * 1.5).applyQuaternion(veh.q).add(veh.pos));
}

// ---- main loop -----------------------------------------------------------------------------------
let last = performance.now(), tAcc = 0, hudAcc = 0;
const hud = $('hud'), help = $('help');
const fmt = (v: number, d = 0) => v.toFixed(d);

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (mode === 'walk') walk(dt); else if (mode === 'fly') fly(dt); else drive(dt);
  const speedNow = mode === 'walk' ? (keys.has('ShiftLeft') ? 28 : 6) : Math.abs((veh as Plane | Car).speed);

  // rebase the world origin around the vehicle/player to keep float precision
  const pivot = mode === 'walk' ? player.pos : veh.pos;
  if (!player.needsGround && Math.hypot(pivot.x, pivot.z) > (mode === 'walk' ? 2500 : 4000 + Math.min(speedNow * 4, 14000))) {
    const remap = world.rebase(pivot.x, pivot.z);
    for (const p of [player.pos, airliner.pos, jet.pos, car.pos, camPos]) { const r = remap(p.x, p.z); p.x = r.x; p.z = r.z; }
    sky.rebase(remap);
    terrain.reposition(remap);
    cities.reposition();
  }
  placeCamera(dt);

  const geo = world.toGeo(camera.position.x, camera.position.z);
  tAcc += dt;
  if (tAcc > 0.1) {
    tAcc = 0;
    const f = tmpV.set(0, 0, -1).applyQuaternion(mode === 'walk' ? camera.quaternion : veh.q);
    maps.enabled = speedNow < (maps.enabled ? 220 : 150);          // hysteresis; ground paint is off at high speed
    terrain.update(camera.position.x, camera.position.y, camera.position.z, f.x, f.z, Math.min(sky.fogFar * 1.05, 150000), speedNow);
    const cg0 = groundAt(camera.position.x, camera.position.z);
    cities.update(camera.position.x, camera.position.z, speedNow > 330 ? 99999 : camera.position.y - Math.max(0, cg0?.h ?? 0));
  }
  const cg = groundAt(camera.position.x, camera.position.z);
  sky.update(dt, camera, geo.lat, geo.lon, camera.position.y - Math.max(0, cg?.h ?? 0));
  if (sky.ageMs > 10 * 60 * 1000) { const g = world.toGeo(player.pos.x, player.pos.z); sky.refresh(g.lat, g.lon); }
  renderer.render(scene, camera);

  hudAcc += dt;
  if (hudAcc > 0.1) {
    hudAcc = 0;
    const pg = world.toGeo(player.pos.x, player.pos.z);
    const fwd = tmpV.set(0, 0, -1).applyQuaternion(mode === 'walk' ? camera.quaternion : veh.q);
    const heading = ((Math.atan2(fwd.x, -fwd.z) * 180) / Math.PI + 360) % 360;
    minimap.draw(pg.lat, pg.lon, heading);
    const g = groundAt(player.pos.x, player.pos.z);
    const w = sky.w, lt = sky.localTime;
    let vehicle: string;
    if (mode === 'fly') {
      const pl = veh as Plane;
      vehicle = `${pl.spec.name.toUpperCase()}  ${fmt(pl.speed)} m/s (${fmt(pl.speed * 3.6)} km/h` + (pl.speed > 200 ? `, Mach ${fmt(pl.speed / 340, 2)}` : '') + `)  thr ${fmt(pl.throttle * 100)}%\n` +
        `V/S ${fmt(pl.vs)} m/s  pitch ${fmt(pl.pitchDeg())}°  bank ${fmt(-pl.bankDeg())}°${pl.onGround ? '  [on ground]' : pl.speed < pl.spec.stall ? '  STALL' : ''}`;
    } else if (mode === 'drive') {
      const c = veh as Car;
      vehicle = `CAR  ${fmt(Math.abs(c.speed) * 3.6)} km/h${c.speed < -0.5 ? ' (reverse)' : ''}\nW/S throttle · A/D steer · Space handbrake`;
    } else vehicle = player.needsGround ? 'Loading terrain…' : `ON FOOT${player.swimming ? ' (swimming)' : ''}   F: summon ${VEHICLES[selected].label.toLowerCase()}`;
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
      ? 'WASD walk · Shift sprint · Space jump\nMouse look (click to capture, Esc frees)\n1/2/3 pick vehicle · F summon & board\nM map zoom · double-click map to teleport'
      : mode === 'drive' ? 'W/S throttle · A/D steer · Space handbrake\nC cockpit/chase · F get out (when slow)\nM map zoom'
      : HELP_FLY.replace('at rotate speed', `at ${(veh as Plane).spec.rotate}+ m/s`);
  }
}
requestAnimationFrame(frame);
sky.refresh(START.lat, START.lon);
