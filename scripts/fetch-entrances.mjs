#!/usr/bin/env node
// Build data/entrances.json from Ohio State's own GIS entrance layer.
//
// data/buildings.json carries one point per building and that point is a
// polygon CENTROID, which data/buildings.draft.json has said in a note since
// the layer was first pulled: "The published Latitude/Longitude is a polygon
// CENTROID, not an entrance." Every walk the app quotes ends at it, so every
// walk ends somewhere inside a wall. js/engine.js names the cost in the comment
// above DETOUR and scripts/test/walk-bias.test.mjs keeps the figure honest: the
// far corner of a shipped building sits a median 44 m from that point, 62 m at
// the 90th percentile and 85 m at PAES.
//
// OSU publishes the doors. Layer 10 of Data/ReferenceData_RO is the same
// read-only data family that MapServer/11 already supplies the building table
// from, under the same attribution, and it carries Accessible, Automated, Ramp,
// Button and Status per point.
//
// Usage:  node scripts/fetch-entrances.mjs
//         node scripts/fetch-entrances.mjs --dry-run
//
// Two requests: the layer is 2,181 features against a 2,000 maxRecordCount.
//
// Run this BEFORE scripts/fetch-buildings.mjs. That script folds the offsets
// into data/buildings-<term>.json, which is what the app actually boots with,
// and it reads whatever this one last wrote.

import { gzipSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchJson, requests } from './lib/fetch.mjs';
import { haversineMetres } from './lib/geo.mjs';

const SERVICE =
  'https://gissvc.osu.edu/arcgis/rest/services/Data/ReferenceData_RO/MapServer/10/query';

// Description is NOT a point type, and reading it as one is the mistake this
// comment exists to stop. The values look like a taxonomy -- "Building",
// "Sidewalk", "Stairs", "Parking Lot", "North Entrance" -- so the obvious move
// is to keep the entrance-shaped ones and drop the rest.
//
// They are all doors. MEASURED over the 217 points on the 46 shipped buildings,
// as distance to the building outline drawn in data/campus.json:
//
//     named entrance   82   median 0.7 m   p90 2.9 m   max 17.8 m
//     Building         57          0.7 m       1.5 m       3.6 m
//     Sidewalk         51          0.5 m       1.6 m       3.1 m
//     other            18          0.8 m       1.3 m       2.4 m
//     blank             9          0.5 m       2.3 m       2.3 m
//
// A "Sidewalk" point sits half a metre from the wall, not out on the pavement.
// Description says what the door faces or how you reach it, and filtering on it
// would have deleted 78 real doors, more than a third of them, from buildings
// that in several cases have no other kind.
//
// The one point that is not within a few metres of a wall is a named entrance
// at Knowlton Hall, 17.8 m inside its own drawn outline, which is a building
// with a covered ramp running up through the middle of it.
const OUT_FIELDS = [
  'buildingNumber',
  'BLDG_NUM',
  'BLDG_NAME',
  'Accessible',
  'Automated',
  'Ramp',
  'Button',
  'Description',
  'Status',
].join(',');

// The service caps a page at 2,000 and the layer is 2,181, so this pages. The
// cap is not ours to raise: resultRecordCount above maxRecordCount is silently
// clamped, and a script that asked for 5,000 and checked nothing would ship
// two thirds of the doors and no error.
const PAGE = 2000;
const MAX_PAGES = 10;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = join(ROOT, 'data', 'entrances.json');

// A door that is not there yet is not a door. Both non-Active values in the
// layer are real: the four Theatre, Film and Media Arts Building points are all
// "Under Construction" while that building is being rebuilt, and sending
// somebody to a door behind hoarding is the exact failure the building-hours
// table exists to prevent. A NULL Status is kept: 20 of the doors on shipped
// buildings have one, they sit on the footprint like every other point, and
// treating unknown as absent would delete them.
const NOT_BUILT = new Set(['Under Construction', 'Pending']);

// Of the 46 buildings the Autumn 2026 room index references, 44 have at least
// one standing door. The two that do not are named in the funnel and fall back
// to the centroid, which is exactly what every building did before this file
// existed, so the floor is about detecting a collapsed pull rather than
// demanding completeness.
const MIN_CLASS_BUILDINGS_WITH_DOORS_FALLBACK = 40;

// A door further than this from its own building's published point is a join
// that has gone wrong, not a large building. MEASURED over the 46 shipped
// buildings: the furthest real door is 72 m out, at PAES, and the 90th
// percentile is 44 m. 200 m is loose enough that a genuinely enormous building
// does not trip it and tight enough that a code collision is caught.
const MAX_DOOR_METRES = 200;

// Local date, not UTC, for the same reason fetch-buildings.mjs uses one.
const localDate = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const gz = (text) => gzipSync(Buffer.from(text), { level: 9 }).length;

function die(message) {
  console.error(`\nFATAL  ${message}`);
  process.exit(1);
}

// Every building code in this repo is a zero-padded string, and the padding
// WIDTH is not agreed on across sources. data/footprints.draft.json already
// writes the reason down -- "BLDG_NUM is zero padded to 4, buildingNumber is
// padded to 3" -- and this layer carries BOTH fields, disagreeing with each
// other. buildingNumber is populated on 42 of the 2,181 points and null on the
// rest; BLDG_NUM is populated on nearly all of them, padded to four.
// data/buildings.json and the room index are keyed on the three-wide form.
//
// So neither field is the key, and neither is a trimmed version of it. Reading
// BLDG_NUM literally resolves 2 of the 46 shipped buildings; stripping the
// padding and stopping there resolves 0, because "279" is in the index and "279"
// unpadded is what the index already had while "003" unpadded is "3" and is not.
// Strip to compare, then hand back the key the building table actually uses.
export function unpad(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return null;
  // "0000" is a code, not an empty string, so the fallback is "0" and not "".
  return trimmed.replace(/^0+/, '') || '0';
}

// unpadded code -> the key data/buildings.json is keyed on. Fatal on a
// collision rather than silently picking one: two buildings whose codes differ
// only by padding would send every door of one to the other.
export function canonicalCodes(buildings) {
  const map = new Map();
  for (const key of Object.keys(buildings)) {
    const bare = unpad(key);
    if (bare === null) continue;
    const seen = map.get(bare);
    if (seen !== undefined && seen !== key) {
      throw new Error(`building codes ${seen} and ${key} both reduce to ${bare}`);
    }
    map.set(bare, key);
  }
  return map;
}

export function joinCode(attributes, canonical) {
  for (const raw of [attributes.BLDG_NUM, attributes.buildingNumber]) {
    const bare = unpad(raw);
    if (bare === null) continue;
    const key = canonical.get(bare);
    if (key !== undefined) return key;
  }
  return null;
}

// ArcGIS returns 0/1 for these, but a null means nobody has surveyed the door
// rather than "no". Three states, and the difference matters to anyone who
// later wants to route a wheelchair to a door the app claims is accessible.
const flag = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value === 1;
  const s = String(value).trim().toLowerCase();
  if (s === 'yes' || s === 'true' || s === '1') return true;
  if (s === 'no' || s === 'false' || s === '0') return false;
  return null;
};

export function buildEntrances(features, buildings) {
  const funnel = {
    features: features.length,
    noBuildingCode: 0,
    noCoordinate: 0,
    notBuilt: 0,
    unknownBuilding: 0,
    noBuildingCoordinate: 0,
    duplicatePoint: 0,
    tooFarFromBuilding: 0,
    kept: 0,
  };
  const canonical = canonicalCodes(buildings);
  const entrances = {};
  const farFromBuilding = [];
  const seen = new Set();

  for (const feature of features) {
    const a = feature.attributes ?? feature;
    if (unpad(a.BLDG_NUM) === null && unpad(a.buildingNumber) === null) {
      funnel.noBuildingCode++;
      continue;
    }
    const code = joinCode(a, canonical);
    // A door on a building the index has never heard of is not an error, it is
    // most of this layer: 2,181 points cover parking garages, the medical
    // centre and every outbuilding on campus. Counted, not warned about.
    if (!code) {
      funnel.unknownBuilding++;
      continue;
    }

    const lat = Number(feature.geometry?.y);
    const lon = Number(feature.geometry?.x);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      funnel.noCoordinate++;
      continue;
    }

    if (NOT_BUILT.has(String(a.Status ?? '').trim())) {
      funnel.notBuilt++;
      continue;
    }

    const building = buildings[code];
    // The building's OWN coordinate, checked before it is measured against.
    // Without this the door was measured from a building with no lat/lon:
    // absent, it is NaN metres, and `NaN > MAX_DOOR_METRES` is false, so the
    // door shipped with `metres: null` and no sanity check ever ran on it;
    // null, it is a distance from 0,0 and the door was reported as 11,000 km
    // too far from its own building. sweep() in js/engine.js drops a room on a
    // building like this for the same reason.
    if (!Number.isFinite(building.lat) || !Number.isFinite(building.lon)) {
      funnel.noBuildingCoordinate++;
      continue;
    }

    // Six decimal places is about 10 cm, finer than any door is wide, so two
    // points agreeing to six places are the same door recorded twice.
    const key = `${code}:${lat.toFixed(6)},${lon.toFixed(6)}`;
    if (seen.has(key)) {
      funnel.duplicatePoint++;
      continue;
    }
    seen.add(key);

    const metres = haversineMetres(building, { lat, lon });
    if (metres > MAX_DOOR_METRES) {
      funnel.tooFarFromBuilding++;
      farFromBuilding.push({ code, name: building.name, metres: Math.round(metres) });
      continue;
    }

    (entrances[code] ??= []).push({
      lat,
      lon,
      metres: Math.round(metres),
      accessible: flag(a.Accessible),
      automated: flag(a.Automated),
      ramp: flag(a.Ramp),
      button: flag(a.Button),
      // Trimmed, because the layer holds "Building ", "building " and "Building"
      // as three separate values. Kept verbatim beyond that: it is a human note
      // about the door and nothing reads it as data.
      description: String(a.Description ?? '').trim() || null,
    });
    funnel.kept++;
  }

  // Nearest first, so a reader opening the file sees the door the engine will
  // pick for somebody standing on the building's own point.
  for (const list of Object.values(entrances)) list.sort((x, y) => x.metres - y.metres);

  return { entrances, funnel, farFromBuilding };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const buildingsPath = join(ROOT, 'data', 'buildings.json');
  if (!existsSync(buildingsPath)) {
    die('no data/buildings.json. Run scripts/fetch-buildings.mjs first: a door needs a building to belong to.');
  }
  const buildings = JSON.parse(readFileSync(buildingsPath, 'utf8')).buildings;

  const features = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      `${SERVICE}?` +
      new URLSearchParams({
        where: '1=1',
        outFields: OUT_FIELDS,
        returnGeometry: 'true',
        outSR: '4326',
        f: 'json',
        resultOffset: String(page * PAGE),
        resultRecordCount: String(PAGE),
      });
    const layer = await fetchJson(url);

    // The dead CampusMap_AGOL_RO service answers HTTP 200 with an error body,
    // so the status code is not the check here either. Read the body.
    if (layer?.error) die(`GIS service returned an error body: ${JSON.stringify(layer.error)}`);

    const batch = layer?.features ?? [];
    features.push(...batch);
    if (batch.length < PAGE) break;

    if (page === MAX_PAGES - 1) {
      die(`still paging after ${MAX_PAGES} pages and ${features.length} features. The layer has grown past what this script will walk.`);
    }
  }

  if (!features.length) die('GIS query returned zero features.');

  const { entrances, funnel, farFromBuilding } = buildEntrances(features, buildings);

  if (farFromBuilding.length) {
    die(
      `${farFromBuilding.length} door(s) sit further than ${MAX_DOOR_METRES} m from the building they claim: ` +
        farFromBuilding.map((f) => `${f.code} ${f.name} ${f.metres} m`).join('; ') +
        '. That is a broken join, not a big building.',
    );
  }

  // The floor is measured against the term's own rooms rather than the whole
  // 612-building index, because those 46 are the only buildings anybody is ever
  // sent to and a collapse elsewhere in the layer cannot reach a student.
  const classCodes = termBuildingCodes();
  const withDoors = classCodes.filter((code) => entrances[code]?.length);
  const withoutDoors = classCodes.filter((code) => !entrances[code]?.length);

  console.log(`${funnel.features} features from the layer`);
  console.log(`  - ${funnel.noBuildingCode} with no building code`);
  console.log(`  - ${funnel.noCoordinate} with no coordinate`);
  console.log(`  - ${funnel.notBuilt} not built yet`);
  console.log(`  - ${funnel.unknownBuilding} on a building outside the index`);
  console.log(`  - ${funnel.noBuildingCoordinate} on a building with no coordinate of its own`);
  console.log(`  - ${funnel.tooFarFromBuilding} further than ${MAX_DOOR_METRES} m from their building`);
  console.log(`  - ${funnel.duplicatePoint} the same door twice`);
  console.log(`  = ${funnel.kept} doors on ${Object.keys(entrances).length} buildings`);

  if (classCodes.length) {
    console.log(`\n${withDoors.length} of ${classCodes.length} class-hosting buildings have a door.`);
    if (withoutDoors.length) {
      console.log(
        `  falling back to the centroid: ` +
          withoutDoors.map((c) => `${c} ${buildings[c]?.name ?? '?'}`).join(', '),
      );
    }
    let minClassBuildingsWithDoors = MIN_CLASS_BUILDINGS_WITH_DOORS_FALLBACK;
    if (existsSync(OUT_PATH)) {
      const previous = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
      const previousWithDoorsCount = Object.values(previous.entrances ?? {}).filter(arr => arr.length > 0).length;
      if (previousWithDoorsCount > 0) {
        minClassBuildingsWithDoors = Math.floor(previousWithDoorsCount * 0.8);
      }
    }

    if (withDoors.length < minClassBuildingsWithDoors) {
      die(
        `only ${withDoors.length} class-hosting buildings resolved a door, ` +
          `under the ${minClassBuildingsWithDoors} floor.`,
      );
    }
  }

  if (existsSync(OUT_PATH)) {
    const previous = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
    const before = Object.values(previous.entrances ?? {}).reduce((n, l) => n + l.length, 0);
    if (funnel.kept < before) {
      die(`${funnel.kept} doors is fewer than the ${before} already committed. Refusing.`);
    }
  }

  console.log(`\n${requests()} requests.`);

  if (dryRun) {
    console.log('DRY RUN, nothing written.');
    return;
  }

  const out = {
    generated: localDate(),
    source: SERVICE,
    layer: 'Data/ReferenceData_RO/MapServer/10 (Entrance)',
    attribution: 'Ohio State University Facilities Information and Technology Services, GIS',
    joinKey: 'building code as an unpadded decimal string, the same key data/buildings.json uses',
    note: 'every point in the source layer sits on its building outline, so Description is what the door faces and not a point type. accessible/automated/ramp/button are null where nobody has surveyed the door.',
    count: funnel.kept,
    buildings: Object.keys(entrances).length,
    funnel,
    entrances: Object.fromEntries(
      Object.entries(entrances).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  const text = `${JSON.stringify(out, null, 1)}\n`;
  await writeFile(OUT_PATH, text);
  console.log(`wrote data/entrances.json  ${gz(text)} bytes gzipped`);
  console.log('\nNow run scripts/fetch-buildings.mjs to fold the offsets into the term subset.');
}

// Which buildings the live term actually sends people to. Absent on a first
// run, and that is not fatal: the doors are still worth writing.
function termBuildingCodes() {
  const currentPath = join(ROOT, 'data', 'current.json');
  if (!existsSync(currentPath)) return [];
  const term = JSON.parse(readFileSync(currentPath, 'utf8')).term;
  const roomsPath = join(ROOT, 'data', `rooms-${term}.json`);
  if (!existsSync(roomsPath)) return [];
  const rooms = JSON.parse(readFileSync(roomsPath, 'utf8')).rooms;
  return [...new Set(Object.values(rooms).map((r) => r.b))].sort();
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('fetch-entrances.mjs');
if (invokedDirectly) main().catch((err) => die(err.message));
