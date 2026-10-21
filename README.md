# lowpoly-earth 🌍

A low-poly, **real-scale** explorer of the actual planet, in your browser. Walk around Manchester, jump in an airliner and fly to New York, or teleport to the Grand Canyon, with real terrain, real satellite imagery, real buildings and the **real weather and time of day** at wherever you are.

**▶ Play it: https://xandertaylorx.github.io/lowpoly-earth/**

Built with [Three.js](https://threejs.org), Vite and TypeScript. No API keys, no backend: everything streams from free public data.

## Features

- **Real terrain, everywhere.** Streams [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium PNG, `height = R*256 + G + B/256 - 32768`) in a quadtree (zoom 7 to 15) around you. Chunky flat-shaded 32x32 meshes, higher detail near you, lower further away.
- **1 unit = 1 metre.** Longitude is scaled by cos(latitude). The world origin is rebased around you as you move, so there is no float jitter, even after hours of flying.
- **Satellite ground.** Sentinel-2 imagery draped on the terrain, with OpenStreetMap roads, parks, rivers, lakes and runways rasterised on top so streets look like streets.
- **3D cities.** OSM buildings at their real heights with three facade styles (houses, offices, glass towers), pitched roofs on houses, rooftop units, trees, lampposts and pavements. Visible from the air too.
- **Knows where you are.** The HUD shows the city and country under you and announces border crossings.
- **Sun shadows.** Buildings, trees, lampposts and vehicles cast real shadows that follow the sun, softer on overcast days. Off at high altitude or speed, and in the lowest quality tier.
- **Looks good, runs everywhere.** Normal-mapped terrain, detail textures, tone mapping, and automatic quality tiers that adapt to your frame rate (`?quality=0|1|2` to force one).
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

## Your own vehicle models (glTF)

The car is a glTF model. Drop `.glb` files in `public/models/` and they replace the built-in low-poly vehicles automatically:

| File | Replaces | Scaled to |
|---|---|---|
| `public/models/car.glb` | car | 4.5 m long |
| `public/models/airliner.glb` | airliner | 38 m long |
| `public/models/jet.glb` | stealth jet | 19 m long |

Models should face **+Z** (the glTF convention), any size or origin. Free sources: [Poly Pizza](https://poly.pizza), [Kenney](https://kenney.nl/assets), [Quaternius](https://quaternius.com) (CC0). Draco-compressed files work.

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
- **Car model:** "Ferrari 458 Italia" by vicent091036, CC BY 4.0, from the three.js examples (`public/models/car.glb`).
- **Weather:** [Open-Meteo](https://open-meteo.com) (CC BY 4.0, free for non-commercial use).
- **Place search:** [Nominatim](https://nominatim.org) (OSM), subject to the [usage policy](https://operations.osmfoundation.org/policies/nominatim/); falls back to Open-Meteo geocoding.

## Limitations and ideas

- Buildings are extruded footprints with generated facades, not the real ones; only simple houses get pitched roofs.
- Roads are painted on the ground rather than 3D; no people or traffic yet. Mountains don't cast shadows (only buildings, trees and vehicles do).
- No free aircraft glTF models are bundled (the plane and jet are low-poly); add your own as above.
- Water exists only at sea level, so inland lakes appear as painted ground.
- No time acceleration or autopilot, so Manchester to New York is about 6 real hours.

Pull requests welcome.
