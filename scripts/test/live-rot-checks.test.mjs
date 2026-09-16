// Offline. Canned pages copied out of real responses on 2026-08-27, fields and
// values untouched. No network. This is where the rot detector's assertions are
// proved; the live file only feeds them today's pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ONLINE_CAPACITY,
  REQUIRED_FIELDS,
  buildingJoin,
  distanceLearningMode,
  fieldShape,
  harvestAxis,
  onlineStillExists,
} from '../live-rot-checks.mjs';

// Enarson Classroom Building 248, the first real room on page 1 of Autumn 2026.
const REAL = {
  meetingNumber: 2,
  facilityId: 'EC0248',
  facilityType: '1B',
  facilityDescription: 'Enarson Classroom Building',
  facilityDescriptionShort: 'EnrsnClsrm',
  facilityGroup: false,
  facilityCapacity: 22,
  buildingCode: '072',
  room: '248',
  buildingDescription: 'Enarson Classroom Bldg 248',
  buildingDescriptionShort: 'EC 248',
  startTime: '9:05 am',
  endTime: '11:00 am',
  startDate: '2026-08-25',
  endDate: '2026-12-09',
  monday: true, tuesday: true, wednesday: false, thursday: true, friday: true, saturday: false, sunday: false,
  standingMeetingPattern: null,
};

// The pseudo-room. Real weekday keys, null clock fields, 998 seats.
const ONLINE = {
  meetingNumber: 1,
  facilityId: 'ONLINE',
  facilityType: '6F',
  facilityDescription: 'ONLINE',
  facilityDescriptionShort: 'ONLINE',
  facilityGroup: false,
  facilityCapacity: 998,
  buildingCode: 'ONLINE',
  room: null,
  buildingDescription: 'Online',
  buildingDescriptionShort: 'ONLINE',
  startTime: null,
  endTime: null,
  startDate: '2026-08-25',
  endDate: '2026-12-09',
  monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: false, sunday: false,
  standingMeetingPattern: null,
};

const FILTERS = [
  { slug: 'campus', items: [{ term: 'col', title: 'Columbus', count: 26298 }] },
  {
    slug: 'instruction-mode',
    items: [
      { term: 'p', title: 'In Person', count: 20000 },
      { term: 'dl', title: 'Distance Learning', count: 2632 },
      { term: 'hy', title: 'Hybrid Delivery', count: 900 },
      { term: 'dh', title: 'Distance Enhanced', count: 400 },
    ],
  },
  {
    slug: 'catalog-number',
    items: ['1xxx', '2xxx', '3xxx', '4xxx', '5xxx', '6xxx', '7xxx', '8xxx'].map((t) => ({ term: t, count: 3000 })),
  },
];

const page = (meetings, filters = FILTERS) => ({
  data: {
    totalItems: 26298,
    totalPages: 132,
    filters,
    courses: [{ course: { subject: 'CSE' }, sections: [{ classNumber: 1, meetings }] }],
  },
});

const clone = (o) => JSON.parse(JSON.stringify(o));
const BUILDINGS = { '072': { name: 'Enarson Classroom Bldg', lat: 39.99, lon: -83.01 } };
const run = (p, buildings = BUILDINGS) => ({
  fieldShape: fieldShape(p),
  onlineStillExists: onlineStillExists(p),
  buildingJoin: buildingJoin(p, buildings),
  harvestAxis: harvestAxis(p),
});
const failedNames = (results) =>
  Object.entries(results).filter(([, r]) => !r.ok).map(([n]) => n).sort();

test('a healthy page passes all four checks', () => {
  for (const [name, r] of Object.entries(run(page([REAL, ONLINE])))) {
    assert.ok(r.ok, `${name}: ${r.detail}`);
  }
});

test('deleting a field fails the check that reads it, and the detail names the field', () => {
  // facilityId and buildingCode are read by two checks because they are the two
  // join keys: lose either and the row stops being a room AND stops resolving
  // to a building. Every other field belongs to one check only.
  const expected = {
    facilityId: ['buildingJoin', 'fieldShape'],
    buildingCode: ['buildingJoin', 'fieldShape'],
    facilityType: ['fieldShape'],
    facilityCapacity: ['fieldShape'],
    room: ['fieldShape'],
    startTime: ['fieldShape'],
    endTime: ['fieldShape'],
  };
  assert.deepEqual(Object.keys(expected).sort(), [...REQUIRED_FIELDS].sort(), 'every required field is covered');

  for (const field of REQUIRED_FIELDS) {
    const broken = clone(REAL);
    delete broken[field];
    const results = run(page([broken, ONLINE]));
    assert.deepEqual(failedNames(results), expected[field], `deleting ${field}`);
    assert.match(results.fieldShape.detail, new RegExp(field), `the message must name ${field}`);
  }
});

test('deleting a weekday flag fails only the field shape check, and names the day', () => {
  for (const day of ['monday', 'saturday', 'sunday']) {
    const broken = clone(REAL);
    delete broken[day];
    const results = run(page([broken, ONLINE]));
    assert.deepEqual(failedNames(results), ['fieldShape'], `deleting ${day}`);
    assert.match(results.fieldShape.detail, new RegExp(day));
  }
});

test('a clock format toMinutes cannot parse is caught, and the value is printed', () => {
  for (const bad of ['9.05 am', '905am', '25:00 am', '9:60 am', null]) {
    const broken = { ...clone(REAL), startTime: bad };
    const r = fieldShape(page([broken, ONLINE]));
    assert.equal(r.ok, false, `${JSON.stringify(bad)} should not parse`);
    assert.match(r.detail, /startTime is/);
    assert.match(r.detail, /toMinutes cannot parse/);
  }
  // And a form the parser DOES read is not a breakage. '09:05' and '9:05 AM'
  // were on the list above, and toMinutes has always taken both, so the rot
  // detector would have raised an ops issue over a change that breaks nothing.
  for (const fine of ['9:05 am', '11:00 pm', '09:05 am', '9:05 AM']) {
    const r = fieldShape(page([{ ...clone(REAL), startTime: fine }, ONLINE]));
    assert.equal(r.ok, true, `${JSON.stringify(fine)} parses, so it is not rot`);
  }
});

test('renaming ONLINE turns it into a phantom room, and that is what gets reported', () => {
  // The whole reason this file exists. The row keeps its 998 seats and its real
  // weekday flags, the funnel stops excluding it, and no count in the build
  // moves far enough to refuse.
  const renamed = { ...clone(ONLINE), facilityId: 'WEB0001', buildingCode: 'WEB' };
  const r = onlineStillExists(page([REAL, renamed]));
  assert.equal(r.ok, false);
  assert.match(r.detail, /998 seat online capacity/);
  assert.match(r.detail, /"WEB0001"/, 'the observed facilityId must be in the message');
  assert.match(r.detail, /"WEB"/, 'the observed buildingCode must be in the message');
  assert.equal(ONLINE_CAPACITY, 998);
});

test('ONLINE simply disappearing from a page is reported with the codes that were there', () => {
  const r = onlineStillExists(page([REAL]));
  assert.equal(r.ok, false);
  assert.match(r.detail, /no row on this page has buildingCode "ONLINE"/);
  assert.match(r.detail, /072/, 'the codes actually seen must be listed');
});

test('an unresolved building code is named, with how many meetings it carries', () => {
  const orphan = { ...clone(REAL), facilityId: 'ZZ0001', buildingCode: '999' };
  const r = buildingJoin(page([REAL, orphan, ONLINE]), BUILDINGS);
  assert.equal(r.ok, false);
  assert.match(r.detail, /"999" \(1 meetings\)/);
  assert.match(r.detail, /1 of 2 building codes/);
});

test('the distance learning slug is read off the facet, never hardcoded', () => {
  // Hardcoded to "dl", this check would be the one that breaks when the slug
  // changes, which is the test blaming itself for the drift it exists to find.
  assert.equal(distanceLearningMode(page([], FILTERS)).slug, 'dl');

  const renamed = clone(FILTERS);
  renamed[1].items = [{ term: 'rm', title: 'Remote Delivery' }, { term: 'p', title: 'In Person' }];
  assert.equal(distanceLearningMode(page([], renamed)).slug, 'rm');

  const gone = clone(FILTERS).filter((f) => f.slug !== 'instruction-mode');
  const missing = distanceLearningMode(page([], gone));
  assert.equal(missing.slug, null);
  assert.deepEqual(missing.observed, [], 'nothing observed when the facet itself is gone');

  const unrecognised = clone(FILTERS);
  unrecognised[1].items = [{ term: 'x', title: 'Mode X' }];
  assert.equal(distanceLearningMode(page([], unrecognised)).slug, null);
  assert.deepEqual(distanceLearningMode(page([], unrecognised)).observed, ['x="Mode X"']);
});

test('the catalog-number facet is the harvest axis, so one bucket is a failure', () => {
  assert.equal(harvestAxis(page([], FILTERS)).ok, true);
  assert.match(harvestAxis(page([], FILTERS)).detail, /8 buckets/);

  const gone = clone(FILTERS).filter((f) => f.slug !== 'catalog-number');
  const r = harvestAxis(page([], gone));
  assert.equal(r.ok, false);
  assert.match(r.detail, /no catalog-number facet/);
  assert.match(r.detail, /campus, instruction-mode/, 'the facets that ARE there must be listed');

  const collapsed = clone(FILTERS);
  collapsed[2].items = [{ term: '1xxx', count: 26298 }];
  const one = harvestAxis(page([], collapsed));
  assert.equal(one.ok, false);
  assert.match(one.detail, /returned 1 bucket/);
  assert.match(one.detail, /1xxx/);
});

test('an empty page fails rather than passing vacuously', () => {
  // A page with nothing in it must never read as four green checks. That is the
  // shape of every wrong answer this project exists to avoid.
  const results = run(page([]));
  assert.equal(results.fieldShape.ok, false);
  assert.equal(results.onlineStillExists.ok, false);
  assert.equal(results.buildingJoin.ok, false);
  assert.equal(results.harvestAxis.ok, true, 'the facets are still there, so this one is honestly fine');
});
