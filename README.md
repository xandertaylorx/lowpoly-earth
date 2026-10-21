# lowpoly-earth 🌍

A low-poly, **real-scale** explorer of the actual planet, in your browser. Walk around Manchester, jump in an airliner and fly to New York, or teleport to the Grand Canyon, with real terrain, real satellite imagery, real buildings and the **real weather and time of day** at wherever you are.

Built with [Three.js](https://threejs.org), Vite and TypeScript. No API keys, no backend: everything streams from free public data.

## Features

- **Real terrain, everywhere.** Streams [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium PNG, `height = R*256 + G + B/256 - 32768`) in a quadtree (zoom 7 to 15) around you. Chunky flat-shaded 32x32 meshes, higher detail near you, lower further away.
- **1 unit = 1 metre.** Longitude is scaled by cos(latitude). The world origin is rebased around you as you move, so there is no float jitter, even after hours of flying.
- **Satellite ground.** Sentinel-2 imagery draped on the terrain, with OpenStreetMap roads, parks, rivers, lakes and runways rasterised on top so streets look like streets.
- **3D cities.** OSM buildings extruded to their real heights with window facades (New York has tens of thousands).
- **Real weather** from [Open-Meteo](https://open-meteo.com), refreshed every 10 minutes: fog/visibility, cloud cover, rain, snow, thunderstorms and wind all drive the scene.
- **Real time of day.** Sun position is computed from your real lat/lon and the real clock, with sunsets, twilight and stars.
- **Water.** Flat sea-level water with depth tint, animated waves, sky reflection and sun glint.
- **Walk, drive or fly.** First-person walking, a car, an airliner (~250 m/s cruise) or a black stealth jet (Mach 3+, afterburner and all). Pick with `1`/`2`/`3`, summon with `F`.
- **Streams ahead of you.** Terrain tiles and imagery are prefetched along your heading, detail drops with speed, and tiles wait for their satellite image before appearing, so the world is there before you arrive, even at Mach 3.
- **Minimap** with a global heightmap, your dot and heading, scale bar and lat/lon readout. Double-click it to teleport.
- **Teleport** by coordinates or by **place name** ("Grand Canyon", "Tokyo", "Mount Fuji").

## Run it

```bash
git clone https://github.com/xandertaylorx/lowpoly-earth.git
cd lowpoly-earth
npm install
npm run dev
```

Open http://localhost:5173. Click the canvas to capture the mouse (Esc releases it). Needs a modern browser with WebGL2 and an internet connection.

## Controls

| On foot | |
|---|---|
| `W A S D` | walk |
| `Shift` | sprint |
| `Space` | jump |
| Mouse | look |
| `1` `2` `3` | pick vehicle: airliner, stealth jet, car |
| `F` | summon the picked vehicle and get in |

| Car | |
|---|---|
| `W` `S` | throttle / brake-reverse |
| `A` `D` | steer |
| `Space` | handbrake |
| `F` | get out (when slow) |

| In an aircraft | |
|---|---|
| `↑` / `↓` | throttle up / down |
| `S` / `W` | pitch up / down |
| `A` / `D` | roll left / right |
| `Q` / `E` (or `←` `→`) | rudder |
| `Space` / `B` | brake |
| `C` | cockpit / chase camera |
| `F` | leave (on the ground, below 12 m/s) |

Anywhere: `M` zooms the minimap. Type coordinates (`27.99, 86.93`, `35.68N 139.69E`) or a place name in the teleport box.

**Taking off:** hold `↑` to full throttle, and once you pass ~70 m/s tap `S` gently. The flight model is arcade-style: real speeds, but faster acceleration and tighter handling than a real airliner.

Add `?hours=6` to the URL to shift the clock by 6 hours (handy for seeing night or sunrise).

## How it works

| File | What it does |
|---|---|
| `src/terrain.ts` | quadtree tile streaming, mesh building, skirts, water shader, satellite textures, exact ground height lookup |
| `src/mapdata.ts` | OSM vector tiles, rasterises roads/parks/water into ground textures |
| `src/cities.ts` | extrudes OSM buildings |
| `src/weather.ts` | Open-Meteo, sky dome, sun, fog, clouds, rain, snow |
| `src/plane.ts` | airliner model and flight physics |
| `src/minimap.ts` | minimap |
| `src/world.ts` | geo maths, rebasing, sun position |
| `scripts/make-global-heightmap.mjs` | builds `public/global-heightmap.png` for the minimap |

## Data sources and licences

The code is MIT. The data it loads is not, so please respect each source:

- **Elevation:** [Mapzen / AWS Terrain Tiles](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) (multiple sources, see link).
- **Satellite imagery:** [Sentinel-2 cloudless](https://s2maps.eu) by [EOX IT Services GmbH](https://eox.at) (contains modified Copernicus Sentinel data 2021), licensed **CC BY-NC-SA 4.0, non-commercial use only**. Swap in another imagery source in `src/terrain.ts` (`IMG_URL`) if you need commercial use.
- **Map data and buildings:** © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL), served by [OpenFreeMap](https://openfreemap.org).
- **Weather:** [Open-Meteo](https://open-meteo.com) (CC BY 4.0, free for non-commercial use).
- **Place search:** [Nominatim](https://nominatim.org) (OSM), subject to the [usage policy](https://operations.osmfoundation.org/policies/nominatim/); falls back to Open-Meteo geocoding.

## Limitations and ideas

- Buildings are extruded footprints, not the real shapes; roofs are flat.
- No trees yet; roads are painted on the ground rather than 3D.
- Water exists only at sea level, so inland lakes appear as painted ground.
- No time acceleration or autopilot, so Manchester to New York is about 6 real hours.

Pull requests welcome.
