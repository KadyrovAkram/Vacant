// Offline. The doors, the join that finds them, and the arithmetic that walks
// to them.
//
// Three separate things can break here and they fail in different ways. The
// JOIN can go quiet: both codes in the source layer are zero padded and neither
// is padded the way the building table is, so a wrong normalisation resolves a
// handful of buildings and looks like a thin dataset rather than a bug. The
// GEOMETRY can go quiet too: js/engine.js adds metre offsets onto a vector
// instead of measuring to a coordinate, and if those two ever stop agreeing the
// app quotes walks that are wrong by a little, everywhere, forever. And the
// DATA can go stale, which is the one a test can only notice by holding the
// committed file to what it claims about itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildEntrances, canonicalCodes, joinCode, unpad } from '../fetch-entrances.mjs';
import { smallIndex } from '../fetch-buildings.mjs';
import { approachMetres, distanceMetres } from '../../js/engine.js';
import { decodeShape, toLonLat } from '../../js/campus.js';
import { haversineMetres } from '../lib/geo.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const ENTRANCES = read('data/entrances.json');
const FULL = read('data/buildings.json').buildings;
const SLICE = read('data/buildings-1268.json').buildings;
const ROOMS = read('data/rooms-1268.json');
const CAMPUS = read('data/campus.json');

const point = (lat, lon, attributes = {}) => ({
  geometry: { x: lon, y: lat },
  attributes: { BLDG_NUM: '0279', ...attributes },
});

// --- the join

test('a code is normalised by width, not by trimming it to taste', () => {
  // The three widths that actually appear. BLDG_NUM pads to four, the building
  // table keys on three, and a four-digit code is already at its own width.
  assert.equal(unpad('0279'), '279');
  assert.equal(unpad('003'), '3');
  assert.equal(unpad('1018'), '1018');
  // "0000" is a code, not an empty string. Stripping it to "" and treating that
  // as absent is the obvious off-by-one in this function.
  assert.equal(unpad('0000'), '0');
  assert.equal(unpad(''), null);
  assert.equal(unpad(null), null);
  assert.equal(unpad('  0279  '), '279');
  // Not a number is not a code. The layer carries blanks and the odd stray.
  assert.equal(unpad('DL'), null);
  assert.equal(unpad('27A'), null);
});

test('the unpadded form is a lookup key and never the answer', () => {
  // The whole trap in one assertion: "279" unpadded is still "279" and the
  // building table has it, so reading BLDG_NUM literally looks like it works.
  // "003" unpadded is "3" and the table has no "3", so the same code path that
  // resolved Dreese silently loses Agricultural Administration.
  const canonical = canonicalCodes({ '003': {}, '279': {} });
  assert.equal(joinCode({ BLDG_NUM: '0279' }, canonical), '279');
  assert.equal(joinCode({ BLDG_NUM: '0003' }, canonical), '003');
  assert.equal(canonical.get('3'), '003', 'the map hands back the padded key');
});

test('buildingNumber is the fallback, not the first read', () => {
  const canonical = canonicalCodes({ '279': {}, '146': {} });
  // Populated on 42 of 2,181 points, so BLDG_NUM leads.
  assert.equal(joinCode({ BLDG_NUM: '0279', buildingNumber: '146' }, canonical), '279');
  assert.equal(joinCode({ BLDG_NUM: null, buildingNumber: '146' }, canonical), '146');
  assert.equal(joinCode({ BLDG_NUM: '', buildingNumber: '' }, canonical), null);
  // A code neither field resolves is not an error, it is a door on a building
  // the index does not carry.
  assert.equal(joinCode({ BLDG_NUM: '9999' }, canonical), null);
});

test('two codes that differ only by padding are fatal, not silently merged', () => {
  // Nothing in the shipped table does this, and if it ever starts, every door
  // of one building would be handed to the other.
  assert.throws(() => canonicalCodes({ '003': {}, 3: {} }), /both reduce to 3/);
});

// --- the funnel

const BUILDINGS = { 279: { name: 'Dreese Laboratories', lat: 40.002295, lon: -83.015831 } };

test('a door that is not built yet is dropped and counted', () => {
  const { entrances, funnel } = buildEntrances(
    [
      point(40.00213, -83.01595, { Status: 'Active' }),
      point(40.00207, -83.01593, { Status: 'Under Construction' }),
      point(40.00249, -83.01598, { Status: 'Pending' }),
      // NULL is kept: 20 doors on shipped buildings have one, and reading
      // unknown as absent would delete them.
      point(40.00242, -83.01572, { Status: null }),
    ],
    BUILDINGS,
  );
  assert.equal(funnel.notBuilt, 2);
  assert.equal(entrances['279'].length, 2);
});

test('the same door recorded twice is deduped', () => {
  const twice = point(40.00213531216748, -83.01595165182341);
  const { entrances, funnel } = buildEntrances([twice, twice, twice], BUILDINGS);
  assert.equal(funnel.duplicatePoint, 2);
  assert.equal(entrances['279'].length, 1);
});

test('a door far from its own building is a broken join and is reported', () => {
  // Not dropped quietly: the caller refuses to write the file at all, because
  // a 500 m door is a code collision and the rest of that code's doors are
  // wrong too.
  const { funnel, farFromBuilding } = buildEntrances(
    [point(40.02, -83.05)],
    BUILDINGS,
  );
  assert.equal(funnel.tooFarFromBuilding, 1);
  assert.equal(farFromBuilding[0].code, '279');
  assert.ok(farFromBuilding[0].metres > 200);
});

test('the funnel adds up to the feature count', () => {
  const { funnel } = buildEntrances(
    [
      point(40.00213, -83.01595),
      point(40.00213, -83.01595),
      point(40.00207, -83.01593, { Status: 'Pending' }),
      point(40.02, -83.05),
      point(40.0, -83.0, { BLDG_NUM: '9999' }),
      point(40.0, -83.0, { BLDG_NUM: '' }),
      { geometry: null, attributes: { BLDG_NUM: '0279' } },
    ],
    BUILDINGS,
  );
  const counted =
    funnel.noBuildingCode +
    funnel.noCoordinate +
    funnel.notBuilt +
    funnel.unknownBuilding +
    funnel.duplicatePoint +
    funnel.tooFarFromBuilding +
    funnel.kept;
  assert.equal(counted, funnel.features);
});

test('doors come out nearest first', () => {
  const { entrances } = buildEntrances(
    [point(40.00249, -83.01598), point(40.00213, -83.01595), point(40.00264, -83.01623)],
    BUILDINGS,
  );
  const metres = entrances['279'].map((d) => d.metres);
  assert.deepEqual(metres, [...metres].sort((a, b) => a - b));
});

test('a surveyed flag has three states and never collapses to false', () => {
  const { entrances } = buildEntrances(
    [point(40.00213, -83.01595, { Accessible: 1, Automated: 'No', Ramp: null })],
    BUILDINGS,
  );
  const door = entrances['279'][0];
  assert.equal(door.accessible, true);
  assert.equal(door.automated, false);
  // Nobody has surveyed it. Reading that as "no ramp" is a claim the layer
  // does not make, and it is the claim a wheelchair user would act on.
  assert.equal(door.ramp, null);
});

// --- the geometry

test('walking to an offset is walking to the coordinate it came from', () => {
  // The load-bearing one. js/engine.js adds whole-metre offsets onto the
  // origin-to-building vector rather than measuring to each door, which is
  // only correct because both live in the same equirectangular plane. If this
  // drifts, every walk in the app is wrong by a little and nothing says so.
  //
  // Checked over every door of every shipped building, from four origins
  // spread across and beyond campus, against a direct distanceMetres call.
  const origins = [
    { lat: 39.9995, lon: -83.013 }, // the Oval
    { lat: 40.0075, lon: -83.0295 }, // north west, off the slice
    { lat: 39.9612, lon: -82.9988 }, // downtown, the issue #60 origin
    { lat: 40.0023, lon: -83.0158 }, // standing on Dreese itself
  ];
  const R = 6371008.8;
  const deg = (metres) => (metres / R) * (180 / Math.PI);

  let checked = 0;
  let worst = 0;
  for (const origin of origins) {
    for (const [code, b] of Object.entries(SLICE)) {
      if (!b.d) continue;
      let best = Infinity;
      for (let i = 0; i < b.d.length; i += 2) {
        // The offsets back to a coordinate, which is what they were made from.
        const lat = b.lat + deg(b.d[i + 1]);
        const lon = b.lon + deg(b.d[i]) / Math.cos(((b.lat + lat) / 2) * (Math.PI / 180));
        best = Math.min(best, distanceMetres(origin, { lat, lon }));
        checked += 1;
      }
      worst = Math.max(worst, Math.abs(approachMetres(origin, b) - best));
      assert.ok(
        Math.abs(approachMetres(origin, b) - best) < 0.01,
        `${code} disagrees by ${(approachMetres(origin, b) - best).toFixed(4)} m`,
      );
    }
  }
  assert.ok(checked > 800, `only ${checked} door/origin pairs checked`);
  // MEASURED worst case is 5 mm, and all of it is the cos term being evaluated
  // at the building rather than at the door. A centimetre is the bound because
  // a centimetre is already absurd next to a walking pace of 78 m a minute.
  assert.ok(worst < 0.01, `worst disagreement is ${worst.toFixed(6)} m`);
});

test('a building with no doors is measured to its published point', () => {
  const b = { lat: 40.002295, lon: -83.015831 };
  const origin = { lat: 39.9995, lon: -83.013 };
  // The fallback is the OLD behaviour: a missing `d`, an empty one and an
  // explicit undefined all mean the same thing.
  for (const shape of [b, { ...b, d: [] }, { ...b, d: undefined }]) {
    assert.ok(Math.abs(approachMetres(origin, shape) - distanceMetres(origin, b)) < 1e-9);
  }

  // Not bit-identical, and the reason is worth a sentence rather than a
  // tolerance nobody can explain. distanceMetres squares two radian components
  // and scales the root by R; approachMetres scales each component by R first,
  // because the door offsets it adds are in metres. Same quantity, different
  // order of operations, so the last bits differ. MEASURED over every door-less
  // building in the slice from six origins: 2.3e-13 m, which is a fifth of a
  // picometre, against a walk quoted in whole minutes.
  const differing = [];
  for (const lat of [39.96, 39.9995, 40.0075]) {
    for (const lon of [-83.04, -83.013, -82.99]) {
      const o = { lat, lon };
      const delta = Math.abs(approachMetres(o, b) - distanceMetres(o, b));
      if (delta !== 0) differing.push(delta);
    }
  }
  assert.ok(Math.max(0, ...differing) < 1e-9, 'the fallback drifted past floating-point noise');
});

test('the nearest door is the one that counts, not the first listed', () => {
  const b = { lat: 40.0, lon: -83.0, d: [500, 0, 10, 0] };
  const origin = { lat: 40.0, lon: -83.0 };
  assert.ok(Math.abs(approachMetres(origin, b) - 10) < 0.5);
});

test('a door never makes a walk longer than the centroid did by more than its own reach', () => {
  // Sanity in the other direction: approachMetres is a minimum over the doors
  // and the centroid is not one of them, so it CAN come out longer, but only
  // when every door faces away, and never by more than the furthest door's
  // offset. A larger gap means an offset landed on the wrong building.
  const origin = { lat: 39.9995, lon: -83.013 };
  for (const [code, b] of Object.entries(SLICE)) {
    if (!b.d) continue;
    let reach = 0;
    for (let i = 0; i < b.d.length; i += 2) reach = Math.max(reach, Math.hypot(b.d[i], b.d[i + 1]));
    const delta = approachMetres(origin, b) - distanceMetres(origin, b);
    assert.ok(delta <= reach + 0.01, `${code} gained ${delta.toFixed(1)} m against a ${reach.toFixed(1)} m reach`);
    assert.ok(delta >= -reach - 0.01, `${code} lost ${(-delta).toFixed(1)} m against a ${reach.toFixed(1)} m reach`);
  }
});

// --- the committed file

test('every committed door belongs to a building the full index carries', () => {
  for (const [code, doors] of Object.entries(ENTRANCES.entrances)) {
    assert.ok(FULL[code], `${code} has doors and no building`);
    assert.ok(doors.length > 0, `${code} has an empty door list`);
    for (const door of doors) {
      assert.ok(Number.isFinite(door.lat) && Number.isFinite(door.lon), `${code} has a door with no coordinate`);
      // Recomputed rather than trusted: the stored `metres` is what the far-door
      // guard was applied to, so a wrong one hides a broken join.
      const metres = haversineMetres(FULL[code], door);
      assert.ok(Math.abs(metres - door.metres) < 1, `${code} door says ${door.metres} m, is ${metres.toFixed(1)} m`);
      assert.ok(metres <= 200, `${code} has a door ${metres.toFixed(0)} m out`);
    }
  }
});

test('the committed funnel adds up and the count matches the doors', () => {
  const f = ENTRANCES.funnel;
  const counted =
    f.noBuildingCode + f.noCoordinate + f.notBuilt + f.unknownBuilding +
    f.duplicatePoint + f.tooFarFromBuilding + f.kept;
  assert.equal(counted, f.features);
  const doors = Object.values(ENTRANCES.entrances).reduce((n, l) => n + l.length, 0);
  assert.equal(doors, ENTRANCES.count);
  assert.equal(doors, f.kept);
  assert.equal(Object.keys(ENTRANCES.entrances).length, ENTRANCES.buildings);
  // Nothing was written that the guard should have caught.
  assert.equal(f.tooFarFromBuilding, 0);
});

test('the term slice carries the doors the entrance file has for it', () => {
  const codes = [...new Set(Object.values(ROOMS.rooms).map((r) => r.b))];
  for (const code of codes) {
    const doors = ENTRANCES.entrances[code];
    const d = SLICE[code]?.d;
    if (!doors) {
      assert.equal(d, undefined, `${code} carries offsets with no doors behind them`);
      continue;
    }
    assert.ok(d, `${code} has ${doors.length} doors and no offsets in the slice`);
    assert.equal(d.length / 2, doors.length, `${code} ships ${d.length / 2} offsets for ${doors.length} doors`);
  }
  // The two that fall back, named so a change has to be deliberate. 276 is
  // absent from OSU's layer; 1025's four doors are all under construction.
  const without = codes.filter((c) => !ENTRANCES.entrances[c]);
  assert.deepEqual(without.sort(), ['1025', '276']);
});

test('every door sits on its own building outline', () => {
  // This is why the fetch script does not filter on Description. The field
  // reads like a taxonomy -- "Building", "Sidewalk", "Stairs", "Parking Lot" --
  // and keeping only the entrance-shaped values would drop 78 of the 217 doors.
  // They are all doors: measured against the outlines in data/campus.json, a
  // "Sidewalk" point sits a median 0.5 m from the wall and a "Building" point
  // 0.7 m, which is the same wall.
  const shipped = new Set(Object.values(ROOMS.rooms).map((r) => r.b));
  const rings = new Map();
  CAMPUS.layers.building.forEach((feature, i) => {
    const code = CAMPUS.buildingCode[i];
    if (code && shipped.has(code)) rings.set(code, feature);
  });

  // To the nearest EDGE, not the nearest drawn corner. A corner check reads a
  // door in the middle of a long straight wall as tens of metres out -- Animal
  // Science has one 26.2 m from its nearest vertex and hard against the wall --
  // which would have forced a slack bound loose enough to pass anything.
  const segment = (p, a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  // A local metre plane, so point-to-segment is plain arithmetic.
  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;
  const plane = (lat, lon) => ({ x: rad(lon) * Math.cos(rad(40)) * R, y: rad(lat) * R });

  let checked = 0;
  let worst = 0;
  let worstElsewhere = 0;
  let elsewhere = 0;
  for (const [code, feature] of rings) {
    for (const door of ENTRANCES.entrances[code] ?? []) {
      const p = plane(door.lat, door.lon);
      let nearest = Infinity;
      for (const ring of feature) {
        const pts = decodeShape(ring).map((pt) => {
          const [lon, lat] = toLonLat(pt, CAMPUS);
          return plane(lat, lon);
        });
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          nearest = Math.min(nearest, segment(p, pts[j], pts[i]));
        }
      }
      assert.ok(nearest < 20, `${code} has a door ${nearest.toFixed(1)} m from its own outline`);
      worst = Math.max(worst, nearest);
      checked += 1;
      // Knowlton Hall is the one building that needs the loose bound, so it is
      // held out and everything else is held to a tight one. A new outlier
      // somewhere else fails here rather than hiding under Knowlton's slack.
      if (code !== '017') {
        worstElsewhere = Math.max(worstElsewhere, nearest);
        elsewhere += 1;
      }
    }
  }
  assert.ok(checked > 200, `only ${checked} doors checked against a footprint`);
  // The median is 0.7 m and the 90th percentile 2.9 m. The loose bound above is
  // there for one point: a Knowlton Hall entrance 17.8 m inside its own
  // outline, on a building with a covered ramp running up through it.
  assert.ok(worst < 20, `worst door sits ${worst.toFixed(1)} m off its outline`);
  assert.ok(elsewhere > 200, 'the tight bound below is checking almost nothing');
  assert.ok(worstElsewhere < 8, `worst door outside Knowlton sits ${worstElsewhere.toFixed(1)} m off its outline`);
});

test('the offsets in the slice are whole metres and small', () => {
  const { small } = smallIndex(
    { 279: { name: 'Dreese Laboratories', lat: 40.002295, lon: -83.015831 } },
    new Set(['279']),
    { 279: [{ lat: 40.00213531216748, lon: -83.01595165182341 }] },
  );
  assert.ok(small['279'].d.every(Number.isInteger));
  // Whole metres is a 0.7 m worst case, half a second at WALK_MPM.
  const [dx, dy] = small['279'].d;
  assert.ok(Math.hypot(dx, dy) < 30);
});

test('a door is not measured against a building that has no coordinate', () => {
  // NaN metres passes `metres > MAX_DOOR_METRES`, so the door shipped with
  // `metres: null` and the 200 m sanity check never ran on it. A null lat is
  // worse in the other direction: it reads as 0,0 and the door is filed as
  // eleven thousand kilometres from its own building.
  const feature = {
    attributes: { BLDG_NUM: '0148', Status: 'Existing' },
    geometry: { x: -83.013, y: 39.9995 },
  };
  for (const building of [{ name: 'S' }, { name: 'S', lat: null, lon: null }]) {
    const out = buildEntrances([feature], { 148: building });
    assert.deepEqual(out.entrances, {});
    assert.equal(out.funnel.noBuildingCoordinate, 1);
    assert.equal(out.funnel.kept, 0);
  }
  const ok = buildEntrances([feature], { 148: { name: 'S', lat: 39.9995, lon: -83.013 } });
  assert.equal(ok.funnel.kept, 1);
  assert.equal(ok.entrances['148'][0].metres, 0);
});
