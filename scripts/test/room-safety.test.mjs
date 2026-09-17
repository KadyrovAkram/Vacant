// Offline. Hand-built rooms plus the two committed data files, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  KNOWN_HIDDEN,
  MAX_CAMPUS_M,
  MIN_WEEKLY_MEETINGS,
  OFF_CAMPUS,
  TYPE_VISIBILITY,
  classify,
} from '../lib/room-safety.mjs';
import { applySafety, invert } from '../build-index.mjs';
import { parseFacilityIds, findTermLink } from '../fetch-ga-rooms.mjs';

const url = (p) => new URL(p, import.meta.url);
const read = (p) => JSON.parse(readFileSync(url(p), 'utf8'));

const room = (over = {}) => ({ facilityId: 'DL0357', facilityType: '1B', buildingCode: '279', ...over });

test('the five shown codes and the six secondary codes, and nothing else', () => {
  assert.deepEqual(
    Object.keys(TYPE_VISIBILITY).filter((k) => TYPE_VISIBILITY[k] === 'shown').sort(),
    ['1A', '1B', '1C', 'LCTR', 'SMNR'],
  );
  assert.deepEqual(
    Object.keys(TYPE_VISIBILITY).filter((k) => TYPE_VISIBILITY[k] === 'secondary').sort(),
    ['2J', '2P', '2Q', '5C', '5K', '6L'],
  );
});

test('an unrecognised facilityType is hidden, never shown', () => {
  // The code space is not closed and the failure mode of guessing is routing
  // someone into a cadaver lab.
  assert.equal(classify(room({ facilityType: 'ZZ' })), null);
  assert.equal(classify(room({ facilityType: null })), null);
  assert.equal(classify(room({ facilityType: undefined })), null);
  assert.equal(classify(room({ facilityType: '1b' })), null, 'the key is exact, not case folded');
});

test('a fabricated ZZ room is absent from a built index', () => {
  const meeting = (over) => ({
    m: {
      facilityId: 'ZZ0001',
      facilityType: 'ZZ',
      buildingCode: '279',
      room: '1',
      facilityCapacity: 30,
      startTime: '8:00 am',
      endTime: '8:55 am',
      startDate: '2026-08-25',
      endDate: '2026-12-09',
      monday: true,
      ...over,
    },
  });
  const safe = { ...meeting().m, facilityId: 'DL0357', facilityType: '1B' };
  const { rooms } = invert([meeting(), { m: safe }], { safety: {} });
  assert.deepEqual(Object.keys(rooms), ['DL0357']);
});

test('a wet lab, a gym and a dissection lab never reach the index', () => {
  // 2A is Jennings and Celeste bench labs, 2H is the RPAC gym floor, 2K holds
  // HM0260 where ANATOMY 4300 does dissection.
  for (const type of ['2A', '2H', '2K', '2M', '6F', 'PERF', '7A']) {
    assert.equal(classify(room({ facilityType: type })), null, type);
    assert.ok(KNOWN_HIDDEN.has(type), `${type} should be a known exclusion, not a surprise`);
  }
});

test('the three Wooster rooms are excluded by name', () => {
  assert.deepEqual([...OFF_CAMPUS].sort(), ['SY0203', 'WAB0130', 'WSB300']);
  for (const id of OFF_CAMPUS) {
    // All three are type 1B and report campus Columbus. Only the name catches
    // them.
    assert.equal(classify(room({ facilityId: id, facilityType: '1B' })), null, id);
  }
});

test('a room off the GA list ships ga:false and is never dropped', () => {
  // The parked decision in BACKLOG.md, implemented. 255 of the 581 kept rooms
  // are in this state, so hiding them would delete nearly half the inventory.
  const gaRooms = new Set(['DL0357']);
  const on = classify(room({ facilityId: 'DL0357' }), { gaRooms });
  const off = classify(room({ facilityId: 'SB0210' }), { gaRooms });
  assert.equal(on.ga, true);
  assert.equal(off.ga, false);
  assert.equal(off.vis, 'shown', 'still shown, just flagged');
});

test('ga is false rather than undefined when no list is supplied', () => {
  // A missing flag reads as "we did not check", and the app must not have to
  // tell that apart from "not general assignment".
  assert.equal(classify(room()).ga, false);
});

test('a restricted building drops a room the type filter would have kept', () => {
  const restricted = new Set(['049']);
  assert.equal(classify(room({ buildingCode: '049' }), { restricted }), null);
  assert.ok(classify(room({ buildingCode: '279' }), { restricted }));
});

test('unknown codes are collected with a count and an example, known ones are not', () => {
  const unknown = new Map();
  classify(room({ facilityId: 'AA0001', facilityType: 'ZZ' }), { unknown });
  classify(room({ facilityId: 'BB0002', facilityType: 'ZZ' }), { unknown });
  classify(room({ facilityType: '2A' }), { unknown });
  assert.deepEqual([...unknown.keys()], ['ZZ']);
  assert.deepEqual(unknown.get('ZZ'), { rooms: 2, example: 'AA0001' });
});

test('applySafety runs after group propagation, so a hidden parent still blocks its halves', () => {
  // MALC0100 is a facilityGroup parent typed 6F, which is hidden. Its halves are
  // typed 1B. Filtering before propagation would drop the parent's booking and
  // leave both halves reading free during a class held in the whole room.
  const at = (facilityId, facilityType, over = {}) => ({
    m: {
      facilityId,
      facilityType,
      buildingCode: '1321',
      room: facilityId,
      facilityCapacity: 120,
      startTime: '8:00 am',
      endTime: '8:55 am',
      startDate: '2026-08-25',
      endDate: '2026-12-09',
      monday: true,
      ...over,
    },
  });
  const records = [
    at('MALC0100', '6F', { facilityGroup: true }),
    at('MALC0100N', '1B', { startTime: '2:00 pm', endTime: '2:55 pm' }),
    at('MALC0100S', '1B', { startTime: '3:00 pm', endTime: '3:55 pm' }),
  ];
  const { rooms } = invert(records, { safety: {} });
  assert.deepEqual(Object.keys(rooms).sort(), ['MALC0100N', 'MALC0100S']);
  const covers = (id, minute) => rooms[id].busy.some((b) => b[1] <= minute && minute < b[2]);
  assert.equal(covers('MALC0100N', 490), true, 'the parent booking reached the north half');
  assert.equal(covers('MALC0100S', 490), true, 'and the south half');
});

test('applySafety reports what it dropped and why, once per room', () => {
  const rooms = {
    DL0357: { b: '279', type: '1B', busy: [] },
    HM0260: { b: '038', type: '2K', busy: [] },
    DI0244: { b: '049', type: '1B', busy: [] },
    WSB300: { b: '8002', type: '1B', busy: [] },
    AH0500: { b: '306', type: '2A', busy: [] },
  };
  const { kept, dropped } = applySafety(rooms, { restricted: new Set(['049', '306']) });
  assert.deepEqual(kept, { shown: 1, secondary: 0 });
  assert.deepEqual(dropped, { type: 2, restricted: 1, offCampus: 1, farFromCampus: 0, thin: 0, noHours: 0 });
  assert.deepEqual(Object.keys(rooms), ['DL0357']);
  assert.equal(rooms.DL0357.vis, 'shown');
});

test('a room the Registrar does not list needs a week of evidence, a GA room does not', () => {
  // The whole rule. A department's own conference room reaches the harvest by
  // being named in one booking; a general assignment room is already certified
  // as central pool space, so its booking count says nothing about access.
  const gaRooms = new Set(['EC0018']);
  const thin = (over) => ({ ...room(over), weeklyMeetings: MIN_WEEKLY_MEETINGS - 1 });

  assert.equal(classify(thin({ facilityId: 'TO0038', facilityType: '5K' }), { gaRooms }), null);
  assert.ok(classify(thin({ facilityId: 'EC0018' }), { gaRooms }), 'a GA room is exempt');
  assert.ok(
    classify({ ...room({ facilityId: 'TO0038' }), weeklyMeetings: MIN_WEEKLY_MEETINGS }, { gaRooms }),
    'one more meeting and it is a classroom',
  );
});

test('the evidence rule is skipped when no GA list was supplied at all', () => {
  // "Not general assignment" with no list is a missing input, not a fact, and
  // applying the rule to it would delete the whole index. The build refuses to
  // run without data/ga-rooms.json, so this only protects hand-built callers.
  assert.ok(classify({ ...room(), weeklyMeetings: 0 }));
  assert.ok(classify({ ...room(), weeklyMeetings: 1 }, { restricted: new Set() }));
});

test('a room with no meeting count is judged on everything else and kept', () => {
  // A caller that does not know how often the room meets must not have that
  // read as zero.
  const gaRooms = new Set();
  assert.ok(classify(room(), { gaRooms }));
  assert.ok(classify({ ...room(), weeklyMeetings: null }, { gaRooms }));
});

test('a building past the campus radius is dropped whatever type its rooms are', () => {
  const far = { ...room(), metresFromOval: MAX_CAMPUS_M + 1, weeklyMeetings: 40 };
  assert.equal(classify(far), null);
  assert.ok(classify({ ...far, metresFromOval: MAX_CAMPUS_M }));
  // No distance at all is no opinion, not "infinitely far".
  assert.ok(classify({ ...room(), metresFromOval: null }));
});

test('applySafety counts the two new rules separately and names what they took', () => {
  const rooms = {
    // kept: general assignment, so the meeting count is not evidence about it
    EC0018: { b: '072', type: '1B', busy: [[1, 480, 535, 0]] },
    // kept: not GA but a full teaching week
    DL0357: { b: '279', type: '1B', busy: [[1, 480, 535, 0], [3, 480, 535, 0], [5, 480, 535, 0]] },
    // dropped: not GA, one booking a week
    TO0038: { b: '087', type: '5K', busy: [[1, 480, 535, 0]] },
    // dropped: at the airfield, and the distance rule wins over the thin rule
    AARL100: { b: '199', type: '1B', busy: [[1, 480, 535, 0]] },
  };
  const metres = { '072': 300, '279': 500, '087': 700, '199': 9942 };
  const { kept, dropped, cut } = applySafety(rooms, {
    gaRooms: new Set(['EC0018']),
    restricted: new Set(),
    metresFor: (code) => metres[code] ?? null,
  });
  assert.deepEqual(Object.keys(rooms).sort(), ['DL0357', 'EC0018']);
  assert.deepEqual(kept, { shown: 2, secondary: 0 });
  assert.deepEqual(dropped, { type: 0, restricted: 0, offCampus: 0, farFromCampus: 1, thin: 1, noHours: 0 });
  assert.deepEqual(cut.farFromCampus, [{ id: 'AARL100', b: '199', m: 9942 }]);
  assert.deepEqual(cut.thin, [{ id: 'TO0038', b: '087', type: '5K', week: 1 }]);
});

test('a building with no published hours takes its rooms out of the index', () => {
  // The rule the owner asked for in one line: "if the hours of a place isn't
  // published, don't include it". It is a filter and not a label, because a
  // label cost four blocks of prose across three screens to say the same thing.
  const published = new Set(['072']);
  const opts = {
    gaRooms: new Set(['EC0018']),
    restricted: new Set(),
    publishesHours: (code) => published.has(code),
  };
  const rooms = {
    EC0018: { b: '072', type: '1B', busy: [[1, 480, 535, 0]] },
    HM0100: { b: '038', type: '1B', busy: [[1, 480, 535, 0], [3, 480, 535, 0], [5, 480, 535, 0]] },
  };
  const { dropped, cut } = applySafety(rooms, opts);
  assert.deepEqual(Object.keys(rooms), ['EC0018'], 'the undocumented building lost its room');
  assert.equal(dropped.noHours, 1);
  assert.deepEqual(cut.noHours, [{ id: 'HM0100', b: '038' }]);
});

test('with no hours table at all the rule does not fire', () => {
  // An archived term has no Registrar table and never will, so applying the
  // rule against nothing would drop every room and call it a filter. Same
  // fail-open the GA rule takes for the same reason.
  const rooms = { HM0100: { b: '038', type: '1B', busy: [[1, 480, 535, 0], [3, 480, 535, 0], [5, 480, 535, 0]] } };
  const { dropped } = applySafety(rooms, { gaRooms: new Set(), restricted: new Set() });
  assert.deepEqual(Object.keys(rooms), ['HM0100']);
  assert.equal(dropped.noHours, 0);
});

test('every shipped room sits in a building the hours table names', () => {
  const idx = read('../../data/rooms-1268.json');
  const hours = read('../../data/buildings-hours.json');
  const term = hours.terms['autumn-2026-classroom-pool-building-schedule'];
  const orphans = new Set();
  for (const r of Object.values(idx.rooms)) {
    if (!term.buildings[r.b]) orphans.add(r.b);
  }
  assert.deepEqual([...orphans], [], 'shipped buildings with no published hours');
});

test('the committed GA list is a real Registrar pull with a term and a date', () => {
  const ga = read('../../data/ga-rooms.json');
  assert.equal(ga._meta.term, '1268');
  assert.match(ga._meta.pulled, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(ga._meta.source, /^https:\/\/registrar\.osu\.edu\//);
  assert.equal(ga.rooms.length, 327);
  assert.equal(ga._meta.count, ga.rooms.length);
  assert.equal(new Set(ga.rooms).size, ga.rooms.length, 'no duplicates');
  for (const id of ga.rooms) assert.match(id, /^[A-Z0-9]+$/, id);
});

test('the restricted building list ships a pulled date and real building codes', () => {
  const rb = read('../../data/restricted-buildings.json');
  assert.match(rb._meta.pulled, /^\d{4}-\d{2}-\d{2}$/);
  const buildings = read('../../data/buildings.json').buildings;
  for (const [code, entry] of Object.entries(rb.buildings)) {
    assert.ok(buildings[code], `${code} is not in buildings.json`);
    assert.equal(entry.name, buildings[code].name, code);
    assert.ok(entry.why.length > 10, `${code} has no reason`);
  }
});

test('the shipped index carries a visibility on every room and hides every other code', () => {
  const idx = read('../../data/rooms-1268.json');
  const seen = new Set();
  for (const [id, r] of Object.entries(idx.rooms)) {
    assert.ok(r.vis === 'shown' || r.vis === 'secondary', `${id} has vis ${r.vis}`);
    assert.equal(TYPE_VISIBILITY[r.type], r.vis, id);
    assert.equal(typeof r.ga, 'boolean', id);
    seen.add(r.type);
  }
  for (const type of seen) assert.ok(TYPE_VISIBILITY[type], `${type} should not be in the index`);
});

test('parseFacilityIds reads the Registrar markup and sorts, without fuzzy matching', () => {
  const html = `
    <p><a href="/x/dl0357/" title="DL0357" class="btn">Facility ID: DL0357</a></p>
    <p>Capacity: 46</p>
    <p><a href="/x/ea0160/" title="EA0160" class="btn">Facility ID:EA0160</a></p>
    <p><a class="btn">Facility ID: DL0357</a></p>`;
  assert.deepEqual(parseFacilityIds(html), ['DL0357', 'EA0160']);
  assert.deepEqual(parseFacilityIds('<p>no rooms here</p>'), []);
});

test('the term page is discovered from the index, never built as a slug', () => {
  const index = `
    <a href="/staff-resources/class-catalog-and-space/general-assignment-rooms/">GA rooms</a>
    <a href="/staff-resources/class-catalog-and-space/general-assignment-rooms/autumn-2026-general-assignment-rooms/">Autumn 2026</a>
    <a href="/staff-resources/class-catalog-and-space/general-assignment-rooms/spring-2027-general-assignment-rooms/">Spring 2027</a>`;
  const hit = findTermLink(index, 'Autumn 2026');
  assert.equal(hit.slug, 'autumn-2026-general-assignment-rooms');
  assert.match(hit.url, /^https:\/\/registrar\.osu\.edu\//);
  // A term the Registrar has not published yet fails loudly with the list it
  // did publish, rather than fetching a constructed URL and getting a 404 page.
  // Offsite, and a host the Registrar's own name is a prefix of. Neither is
  // followed: whatever this picks is fetched and cached as a Registrar page.
  const offsite = `
    <a href="https://example.com/general-assignment-rooms/autumn-2029-general-assignment-rooms/">no</a>
    <a href="https://registrar.osu.edu.example.com/general-assignment-rooms/autumn-2028-general-assignment-rooms/">no</a>`;
  assert.deepEqual(findTermLink(offsite, 'Autumn 2029').all, []);
  assert.equal(findTermLink(offsite, 'Autumn 2028').url, null);

  const miss = findTermLink(index, 'Summer 2029');
  assert.equal(miss.url, null);
  assert.deepEqual(miss.all, [
    'autumn-2026-general-assignment-rooms',
    'spring-2027-general-assignment-rooms',
  ]);
});
