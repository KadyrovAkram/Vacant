// Offline. Pure functions, no fixtures, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import {
  DAY_END,
  DAY_START,
  DETOUR,
  LADDER_QUORUM,
  MAX_WALK,
  MIN_RELAXED_USABLE,
  PACKUP,
  PREFERRED_TYPES,
  RELAX_LADDER,
  RUNGS,
  SCREEN_ROWS,
  SECONDARY_TYPES,
  SILENT_SHARE,
  SURPLUS_CAP,
  SURPLUS_WEIGHT,
  WALK_MPM,
  activeMask,
  activeSessions,
  approachMetres,
  bestGap,
  calendarOn,
  distanceMetres,
  freeGaps,
  leaveBy,
  query,
  rank,
  refusalFor,
  scheduleCoverage,
  scoreOf,
  shape,
  tally,
  tierOf,
  typeRank,
  usableMinutes,
  walkMetres,
  walkMinutes,
} from '../../js/engine.js';
// The rung sentences live in js/state.js: js/app.js touches the DOM at import
// and cannot be loaded here, and js/state.js is already the file that holds the
// row phrasing for exactly that reason.
import { rungPhrase } from '../../js/state.js';
import { haversineMetres } from '../lib/geo.mjs';

const at = (h, m = 0) => h * 60 + m;

test('the usable-minutes formula does not count corridor waiting as study time', () => {
  // The case that decides the whole differentiator. Gap 14:00-16:00, now 13:50,
  // a 6 minute walk. You arrive at 13:56 and wait 4 minutes for the previous
  // class to clear, so you get 120 minutes, not 124.
  const metres = 6 * WALK_MPM; // exactly a 6 minute walk, in metres WALKED
  const usable = usableMinutes({
    now: at(13, 50),
    gapStart: at(14),
    gapEnd: at(16),
    metres,
    packup: 0,
  });
  assert.equal(usable, 120);

  // The formula the README reached for. Kept as an explicit counter-assertion so
  // nobody quietly reintroduces it.
  const readmeAnswer = at(16) - at(13, 50) - walkMinutes(metres);
  assert.equal(readmeAnswer, 124);
  assert.notEqual(usable, readmeAnswer);
});

test('arriving after the gap has already started costs only the walk', () => {
  // now 14:30, gap 14:00-16:00, 6 minute walk: you arrive at 14:36 and the room
  // is already free, so there is no waiting to discount.
  const metres = 6 * WALK_MPM;
  assert.equal(
    usableMinutes({ now: at(14, 30), gapStart: at(14), gapEnd: at(16), metres, packup: 0 }),
    84,
  );
});

test('packup comes off the end, not the start', () => {
  const usable = usableMinutes({ now: at(14), gapStart: at(14), gapEnd: at(16), metres: 0 });
  assert.equal(usable, 120 - PACKUP);
});

test('a gap you cannot reach in time yields a non-positive number', () => {
  const metres = 60 * WALK_MPM; // an hour of walking
  assert.ok(usableMinutes({ now: at(15, 30), gapStart: at(14), gapEnd: at(16), metres }) <= 0);
});

test('walk time is pace and nothing else, and rounds up', () => {
  // walkMinutes takes the metres you will WALK. It held the detour constant
  // until #115, which is what made the two impossible to fit separately.
  assert.equal(walkMinutes(0), 0);
  assert.equal(walkMinutes(78), 1, 'a minute of walking is a minute');
  assert.equal(walkMinutes(79), 2, 'and every rounding here breaks pessimistic');
  assert.equal(walkMinutes(1), 1, 'never zero for a non-zero distance');
});

test('without a graph the walk is the straight line times the detour, as before', () => {
  // The fallback has to reproduce the old number exactly, because it IS the old
  // number: every origin off the sidewalk network still gets this one.
  const building = { lat: ORIGIN.lat, lon: ORIGIN.lon, d: [0, 100] };
  const straight = approachMetres(ORIGIN, building);
  assert.ok(Math.abs(straight - 100) < 0.5, `${straight} m`);
  const walked = walkMetres(ORIGIN, building, '279', null);
  assert.ok(Math.abs(walked - straight * DETOUR) < 1e-9);
  assert.ok(walked > straight, 'the detour makes it longer than the straight line');
  // 130 m walked at 78 m/min is 1.67 minutes, which ceils to 2.
  assert.equal(walkMinutes(walked), 2);
});

test('a field that answers replaces the detour rather than compounding it', () => {
  const building = { lat: ORIGIN.lat, lon: ORIGIN.lon, d: [0, 100] };
  const field = { metresTo: (code) => (code === '279' ? 250 : null) };
  assert.equal(walkMetres(ORIGIN, building, '279', field), 250, 'routed metres, untouched');
  // A building the field cannot reach falls back on its own.
  const missed = walkMetres(ORIGIN, building, '003', field);
  assert.ok(Math.abs(missed - approachMetres(ORIGIN, building) * DETOUR) < 1e-9);
});

test('equirectangular distance matches haversine at campus scale', () => {
  const oval = { lat: 39.9995, lon: -83.013 };
  for (const b of [
    { lat: 40.002295, lon: -83.015831 }, // Dreese
    { lat: 39.9986, lon: -83.0087 },
    { lat: 40.0075, lon: -83.0301 },
  ]) {
    const fast = distanceMetres(oval, b);
    const exact = haversineMetres(oval, b);
    assert.ok(Math.abs(fast - exact) < 1, `off by ${Math.abs(fast - exact).toFixed(3)} m`);
  }
});

test('distance is zero on itself and symmetric', () => {
  const a = { lat: 39.9995, lon: -83.013 };
  assert.equal(distanceMetres(a, a), 0);
  const b = { lat: 40.002295, lon: -83.015831 };
  assert.ok(Math.abs(distanceMetres(a, b) - distanceMetres(b, a)) < 1e-9);
});

test('free gaps are the complement of the busy blocks inside opening hours', () => {
  const busy = [
    [1, at(9), at(10)],
    [1, at(13), at(14)],
  ];
  assert.deepEqual(freeGaps(busy, 1, at(8), at(18)), [
    [at(8), at(9)],
    [at(10), at(13)],
    [at(14), at(18)],
  ]);
});

test('back-to-back classes do not produce a zero-length gap between them', () => {
  const busy = [
    [1, at(8), at(9)],
    [1, at(9), at(10)],
  ];
  assert.deepEqual(freeGaps(busy, 1, at(8), at(12)), [[at(10), at(12)]]);
});

test('overlapping bookings in the same room are merged, not double counted', () => {
  // Two sections booked over each other is real, and treating them as separate
  // blocks invents a gap between them.
  const busy = [
    [1, at(9), at(11)],
    [1, at(10), at(12)],
  ];
  assert.deepEqual(freeGaps(busy, 1, at(8), at(13)), [
    [at(8), at(9)],
    [at(12), at(13)],
  ]);
});

test('busy blocks are not assumed sorted', () => {
  const busy = [
    [1, at(13), at(14)],
    [1, at(9), at(10)],
  ];
  assert.deepEqual(freeGaps(busy, 1, at(8), at(18))[0], [at(8), at(9)]);
});

test('blocks are clipped to opening hours, and other days are ignored', () => {
  const busy = [
    [1, at(6), at(9)], // starts before open
    [2, at(10), at(11)], // a different day
  ];
  assert.deepEqual(freeGaps(busy, 1, at(8), at(18)), [[at(9), at(18)]]);
});

test('a room with no bookings is free for the whole opening window', () => {
  assert.deepEqual(freeGaps([], 1, at(7), at(22)), [[at(7), at(22)]]);
});

test('a gap you can walk straight into beats a longer one you must wait for', () => {
  // This test used to assert the opposite, and the opposite is a bug: it sends
  // someone on a walk to a room that has a class in it, because that room's
  // afternoon gap is longer than the one free right now.
  const room = { busy: [[1, at(9), at(10)], [1, at(11), at(12)]] };
  const gap = bestGap(room, { now: at(8), day: 1, open: at(8), close: at(18), metres: 0 });
  assert.equal(gap.gapStart, at(8), 'the 8-9 window is open now');
  assert.equal(gap.wait, 0);
});

test('when nothing is open on arrival, the best later gap is offered with its wait', () => {
  const room = { busy: [[1, at(8), at(13)]] };
  const gap = bestGap(room, { now: at(9), day: 1, open: at(8), close: at(18), metres: 0 });
  assert.equal(gap.gapStart, at(13));
  assert.equal(gap.wait, at(13) - at(9), 'four hours of waiting, reported not hidden');
});

test('among gaps open on arrival, the one that meets the need wins, then length', () => {
  const room = { busy: [[1, at(9), at(10)], [1, at(14), at(15)]] };
  const gap = bestGap(room, {
    now: at(8), day: 1, open: at(8), close: at(18), metres: 0, needed: 30,
  });
  assert.equal(gap.wait, 0);
  assert.equal(gap.meetsNeed, true);
});

test('bestGap ignores gaps that have already passed', () => {
  const room = { busy: [] };
  const gap = bestGap(room, { now: at(17), day: 1, open: at(8), close: at(18), metres: 0 });
  assert.equal(gap.usable, 60 - PACKUP);
  assert.equal(bestGap(room, { now: at(18), day: 1, open: at(8), close: at(18), metres: 0 }), null);
});

test('meetsNeed reflects the requested duration without filtering the room out', () => {
  const room = { busy: [] };
  const opts = { now: at(8), day: 1, open: at(8), close: at(9), metres: 0 };
  assert.equal(bestGap(room, { ...opts, needed: 30 }).meetsNeed, true);
  assert.equal(bestGap(room, { ...opts, needed: 120 }).meetsNeed, false, 'still returned, just flagged');
});

const BUILDINGS = {
  279: { name: 'Dreese Laboratories', lat: 40.002295, lon: -83.015831 },
  26: { name: 'Caldwell Laboratory', lat: 40.0018, lon: -83.0157 },
  999: { name: 'Nowhere Hall', lat: 40.0, lon: -83.0 },
};
const ORIGIN = { lat: 39.9995, lon: -83.013 };

test('a room whose building has no coordinates is dropped, never ranked', () => {
  const out = rank([{ id: 'XX0100', b: '404', busy: [] }], {
    origin: ORIGIN, now: at(9), day: 1, buildings: BUILDINGS,
  });
  assert.deepEqual(out, [], 'no coordinates means no walk time means no answer');
});

test('a building published as CLOSED removes the room; unknown hours does not', () => {
  const rooms = [{ id: 'DL0357', b: '279', busy: [] }];
  const base = { origin: ORIGIN, now: at(9), day: 6, buildings: BUILDINGS };

  const closed = rank(rooms, { ...base, hoursFor: () => null });
  assert.deepEqual(closed, [], 'published closed is a fact and it wins');

  const unknown = rank(rooms, { ...base, hoursFor: () => undefined });
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].hoursKnown, false, 'shown, and labelled as not published');
});

test('unknown hours never outrank a known-open building on the same walk', () => {
  // The ranking does the honesty here, not a label. 565 of 612 buildings have
  // no published hours, so this ordering is the majority path.
  const rooms = [
    { id: 'NW0100', b: '999', busy: [] },
    { id: 'DL0357', b: '279', busy: [] },
  ];
  const out = rank(rooms, {
    origin: ORIGIN,
    now: at(9),
    day: 1,
    buildings: BUILDINGS,
    hoursFor: (code) => (code === '279' ? [at(7), at(22)] : undefined),
  });
  assert.equal(out[0].building, '279', 'the building we know is open comes first');
  assert.equal(out[0].hoursKnown, true);
  assert.equal(out[1].hoursKnown, false);
});

// The screen built to say "we do not know" must not also announce a count of
// free rooms. This is reason 2 of the audit on
// github.com/EnesYilmazcode/Vacant/issues/45, which was never filed anywhere
// and never fixed: the printed strip counted `hoursKnown && wait === 0` and the
// live region, three hundred lines away in js/app.js, counted `wait === 0`
// alone. Two rules for one word.
//
// Reproduced at 216ba00 by driving the real app with data/buildings-hours.json
// blocked at the network, so every building reads as unpublished: the strip
// printed "Every building we have hours for is closed." over 34 of 38 rows
// reading "hours not published", and #say announced "103 rooms free, 38 shown."
//
// The fixture carries an unknown-hours room because otherwise this test is
// dead. The room safety filter cut every unpublished building out of the
// shipped index: measured over data/rooms-1268.json against the autumn table in
// data/buildings-hours.json, all 46 buildings the index names publish hours, so
// no arrangement of the committed data reaches the branch under test.
const FREE_ROOMS = [
  { id: 'DL0357', b: '279', busy: [] }, // published open, free now
  { id: 'CL0177', b: '26', busy: [] }, // published open, free now
  { id: 'NW0100', b: '999', busy: [] }, // nobody publishes this door
];
const freeAsk = {
  origin: ORIGIN, now: at(9), day: 1, needed: 60, buildings: BUILDINGS,
  hoursFor: (code) => (code === '999' ? undefined : [at(7), at(22)]),
};

test('print and speech count free by one rule, and it never counts an unpublished door', () => {
  const rows = rank(FREE_ROOMS, freeAsk);
  assert.equal(rows.length, 3, 'all three rooms are offered');
  assert.equal(rows.filter((r) => !r.hoursKnown).length, 1, 'the fixture carries an unknown-hours room');
  assert.equal(rows.every((r) => r.wait === 0), true, 'and all three are free this minute');

  // Over ONE set of rows, the number the strip prints and the number the live
  // region speaks have to be the same number. Give either of them back its own
  // predicate and this line goes red.
  const t = tally(rows, rows);
  assert.equal(t.free, t.shorter, 'print and speech disagree about how many rooms are free');
  assert.equal(t.free, 2, 'a door nobody publishes is not a free room');
  assert.equal(t.meets, 2);
  assert.equal(t.waiting, 0);
});

test('the spoken count is wider than the printed one, and that is the only difference', () => {
  // The sets differ on purpose. The strip describes the rows on screen and the
  // spoken line describes the whole answer, which is how it can honestly read
  // "297 rooms free, 0 shown" under a heading saying nothing was close enough.
  // What may never differ is the rule.
  const rows = rank(FREE_ROOMS, freeAsk);
  const t = tally(rows.slice(0, 1), rows);
  assert.equal(t.shorter, 1, 'the strip counts the one row it is printing');
  assert.equal(t.free, 2, 'the live region counts every room inside the wait bound');
  assert.equal(tally(rows).free, tally(rows).shorter, 'one set, one answer');
});

test('rooms meeting the requested duration outrank closer rooms that do not', () => {
  const rooms = [
    { id: 'CL0177', b: '26', busy: [[1, at(9), at(17)]] }, // closer, barely free
    { id: 'DL0357', b: '279', busy: [] }, // further, wide open
  ];
  const out = rank(rooms, {
    origin: ORIGIN, now: at(9), day: 1, needed: 120, buildings: BUILDINGS,
    hoursFor: () => [at(8), at(18)],
  });
  assert.equal(out[0].id, 'DL0357');
  assert.equal(out[0].meetsNeed, true);
  assert.equal(out[1].meetsNeed, false);
});

test('a ranked row carries everything the result screen needs', () => {
  const out = rank([{ id: 'DL0357', b: '279', cap: 46, busy: [] }], {
    origin: ORIGIN, now: at(9), day: 1, buildings: BUILDINGS, hoursFor: () => [at(7), at(22)],
  });
  const row = out[0];
  assert.equal(row.id, 'DL0357');
  assert.equal(row.name, 'Dreese Laboratories');
  assert.equal(row.seats, 46);
  assert.ok(row.walk >= 1 && row.metres > 0);
  assert.equal(row.nextClassAt, at(22));
  assert.equal(row.availableAt, at(7), 'already open when the query runs');
  assert.equal(row.wait, 0);
  // The room is already free at 9:00, so usable is the window minus packup
  // minus the walk. Forgetting the walk here is the same mistake the README
  // formula makes, one level up.
  assert.equal(row.usable, at(22) - at(9) - PACKUP - row.walk);
  assert.ok(row.usable < at(22) - at(9) - PACKUP, 'the walk really is taken off');
});

test('a room with no seat count reports null rather than inventing one', () => {
  const [row] = rank([{ id: 'DL0357', b: '279', busy: [] }], {
    origin: ORIGIN, now: at(9), day: 1, buildings: BUILDINGS,
  });
  assert.equal(row.seats, null);
});

// --- regressions found by the PR #36 review ---

test('a room occupied right now never outranks one that is free now', () => {
  // The failure: you ask for two hours at 9:00, and are sent on a seven minute
  // walk to Dreese, which has a class in it until 13:00, because its afternoon
  // gap is longer than Caldwell's morning one.
  const rooms = [
    { id: 'CL0177', b: '26', busy: [[1, at(10, 45), at(18)]] }, // free now, 105 min
    { id: 'DL0357', b: '279', busy: [[1, at(9), at(13)]] }, // occupied now
  ];
  const out = rank(rooms, {
    origin: ORIGIN, now: at(9), day: 1, needed: 120, buildings: BUILDINGS,
    hoursFor: () => [at(8), at(18)],
  });
  assert.equal(out[0].id, 'CL0177', 'the room you can actually walk into');
  assert.equal(out[0].wait, 0);
  assert.ok(out[1].wait > 0, 'the occupied room is still offered, with its wait');
  assert.ok(out[0].tier < out[1].tier);
});

test('every row carries when the room opens and how long you would wait', () => {
  const [row] = rank([{ id: 'DL0357', b: '279', busy: [[1, at(9), at(13)]] }], {
    origin: ORIGIN, now: at(9), day: 1, buildings: BUILDINGS, hoursFor: () => [at(8), at(18)],
  });
  assert.equal(row.availableAt, at(13));
  assert.ok(row.wait > 0);
  // Without these two a result screen cannot tell "available now" from
  // "available from 1:00 PM" -- the rows are otherwise identical.
  assert.ok('availableAt' in row && 'wait' in row);
});

test('a geolocation fix that never resolved returns nothing, not NaN rooms', () => {
  // NaN <= 0 is false, so the old guard let every room through with NaN
  // minutes, and a NaN comparator makes Array.sort return arbitrary order.
  for (const origin of [{ lat: NaN, lon: NaN }, { lat: undefined, lon: -83 }, {}]) {
    const out = rank([{ id: 'DL0357', b: '279', busy: [] }], {
      origin, now: at(9), day: 1, buildings: BUILDINGS, hoursFor: () => [at(8), at(18)],
    });
    assert.deepEqual(out, [], JSON.stringify(origin));
  }
});

test('a building row with a null coordinate is dropped like a missing one', () => {
  const buildings = { ...BUILDINGS, 500: { name: 'Broken Hall', lat: null, lon: null } };
  const out = rank([{ id: 'BR0100', b: '500', busy: [] }], {
    origin: ORIGIN, now: at(9), day: 1, buildings, hoursFor: () => [at(8), at(18)],
  });
  assert.deepEqual(out, []);
});

test('an unknown-hours room never reports a usable figure', () => {
  // At 3am the old code said "free for 1243 minutes" in a building nobody knows
  // is open. A 0-1440 fallback IS an assumed window, and the most generous one
  // available, which the project decided explicitly against.
  const [row] = rank([{ id: 'X', b: '279', busy: [] }], {
    origin: ORIGIN, now: at(3), day: 1, buildings: BUILDINGS, hoursFor: () => undefined,
  });
  assert.equal(row.hoursKnown, false);
  assert.equal(row.usable, null, 'we cannot know when it locks, so we do not say');
  assert.equal(row.usableUntil, null);
  assert.equal(row.meetsNeed, null);
  assert.ok(row.nextClassAt != null, 'what we DO know is when the next class is');
});

test('usableUntil and usable agree; nextClassAt is the raw end', () => {
  const [row] = rank([{ id: 'DL0357', b: '279', busy: [] }], {
    origin: ORIGIN, now: at(9), day: 1, buildings: BUILDINGS, hoursFor: () => [at(8), at(18)],
  });
  assert.equal(row.nextClassAt, at(18));
  assert.equal(row.usableUntil, at(18) - PACKUP);
  // The inconsistency that made a countdown hand back the packup buffer.
  assert.equal(row.usable, row.usableUntil - at(9) - row.walk);
});

test('an inverted busy block is treated as busy, never as free', () => {
  // freeGaps([[1,840,600]], ...) used to return the whole day free. A meeting
  // crossing midnight, or any upstream time-parse glitch, produces this shape,
  // and reporting it free sends someone to a room with a class in it.
  const gaps = freeGaps([[1, at(14), at(10)]], 1, at(8), at(18));
  assert.notDeepEqual(gaps, [[at(8), at(18)]], 'the whole day is NOT free');
  assert.deepEqual(gaps, [[at(8), at(14)]], 'read conservatively as running to end of day');
  assert.equal(gaps.malformed, 1, 'and counted, so a build can assert on it');
});

test('a non-numeric busy time is counted and dropped rather than trusted', () => {
  const gaps = freeGaps([[1, NaN, at(10)], [1, at(12), at(13)]], 1, at(8), at(18));
  assert.equal(gaps.malformed, 1);
  assert.deepEqual(gaps, [[at(8), at(12)], [at(13), at(18)]]);
});

test('a day arriving as a string still matches its blocks', () => {
  // freeGaps is browser-facing and `day` comes out of a <select> or a query
  // string. A strict === matched nothing and reported the whole day free.
  assert.deepEqual(freeGaps([[1, at(9), at(10)]], '1', at(8), at(12)), [
    [at(8), at(9)],
    [at(10), at(12)],
  ]);
});

test('the tier order encodes all three decisions the project already made', () => {
  const t = (hoursKnown, wait, meetsNeed, ga = true) => tierOf({ hoursKnown, wait, meetsNeed, ga });
  assert.equal(t(true, 0, true), 0);
  assert.equal(t(true, 0, false), 2);
  assert.equal(t(true, 60, true), 4);
  assert.equal(t(false, 0, null), 6);
  assert.equal(t(false, 60, null), 8);
  // Published hours beat unknown hours even when the unknown room is free now
  // and the published one is not.
  assert.ok(t(true, 60, true) < t(false, 0, null));

  // A departmental room sits one step below its own general-assignment twin and
  // nowhere else. It is the innermost term, so it never crosses the window or
  // the wait: a departmental room that is free when you arrive still beats a
  // general-assignment one you would wait an hour for.
  assert.equal(t(true, 0, true, false), 1);
  assert.ok(t(true, 0, true, false) < t(true, 0, false, true));
  assert.ok(t(true, 0, true, false) < t(true, 60, true, true));
  assert.ok(t(true, 60, true, false) < t(false, 0, null, true));

  // An index built before the general-assignment pull carries `ga` on nothing,
  // and a missing flag is not a departmental room.
  assert.equal(tierOf({ hoursKnown: true, wait: 0, meetsNeed: true }), 0);
  assert.equal(tierOf({ hoursKnown: true, wait: 0, meetsNeed: true, ga: null }), 0);
});

// --- regressions found by the PR #38 review ---

test('a block from a session that is not running today is not busy today', () => {
  // Measured on the shipped index: 287 busy tuples on a November date belong to
  // a session that has already ended, and 3 rooms have their ENTIRE busy list
  // drawn from a session that is not running, so they read fully booked while
  // free all day.
  const sessions = [['2026-08-25', '2026-10-12'], ['2026-10-19', '2026-12-09']];
  const busy = [[1, 480, 540, 0], [1, 600, 660, 1]];

  const sept = activeSessions(sessions, '2026-09-01');
  assert.deepEqual(sept, [true, false]);
  assert.deepEqual(freeGaps(busy, 1, 420, 720, sept), [[420, 480], [540, 720]]);

  const nov = activeSessions(sessions, '2026-11-15');
  assert.deepEqual(nov, [false, true]);
  assert.deepEqual(freeGaps(busy, 1, 420, 720, nov), [[420, 600], [660, 720]]);
});

test('with no mask every session counts, which is the old behaviour', () => {
  const busy = [[1, 480, 540, 0], [1, 600, 660, 1]];
  assert.deepEqual(freeGaps(busy, 1, 420, 720), [[420, 480], [540, 600], [660, 720]]);
});

test('activeSessions is inclusive at both ends', () => {
  const s = [['2026-08-25', '2026-10-12']];
  assert.deepEqual(activeSessions(s, '2026-08-25'), [true], 'first day counts');
  assert.deepEqual(activeSessions(s, '2026-10-12'), [true], 'last day counts');
  assert.deepEqual(activeSessions(s, '2026-08-24'), [false]);
  assert.deepEqual(activeSessions(s, '2026-10-13'), [false]);
  assert.deepEqual(activeSessions(undefined, '2026-09-01'), []);
});

test('rank applies the session mask when given sessions and a date', () => {
  const sessions = [['2026-08-25', '2026-10-12'], ['2026-10-19', '2026-12-09']];
  const rooms = [{ id: 'DL0357', b: '279', busy: [[1, 0, 1440, 1]] }];
  const base = { origin: ORIGIN, now: at(9), day: 1, buildings: BUILDINGS, hoursFor: () => [at(8), at(18)] };

  // In September, session 1 has not started, so the room is free all day.
  const sept = rank(rooms, { ...base, sessions, date: '2026-09-01' });
  assert.equal(sept.length, 1);
  assert.ok(sept[0].usable > 400, 'free, because the block belongs to a later session');

  // In November it is running, so the room is booked solid.
  const nov = rank(rooms, { ...base, sessions, date: '2026-11-15' });
  assert.deepEqual(nov, [], 'no gap at all');
});

test('cap 0 means unknown and must not render as a confident zero', () => {
  // 44 of 871 rooms carry it, and `?? null` passes 0 straight through.
  const [zero] = rank([{ id: 'X', b: '279', cap: 0, busy: [] }], {
    origin: ORIGIN, now: at(9), day: 1, buildings: BUILDINGS, hoursFor: () => [at(8), at(18)],
  });
  assert.equal(zero.seats, null, '0 is the index sentinel for unknown, not a seat count');

  const [real] = rank([{ id: 'Y', b: '279', cap: 46, busy: [] }], {
    origin: ORIGIN, now: at(9), day: 1, buildings: BUILDINGS, hoursFor: () => [at(8), at(18)],
  });
  assert.equal(real.seats, 46, 'a real capacity still comes through');
});

// --- issue #15: the twelve edge cases from docs/research/query-engine.md, section 4 ---
//
// Standing at the room, so the walk is zero. Tuesday, 12:00, asking for one
// minute, so the only thing that can remove a room is the arithmetic itself.

const TUE = 2;
const NOON = at(12);
const standingAt = (busy, opts = {}) =>
  bestGap(
    { busy },
    { now: NOON, day: TUE, open: DAY_START, close: DAY_END, metres: 0, needed: 1, ...opts },
  );
const usableOf = ([start, end]) => end - PACKUP - Math.max(NOON, start);

const EDGE_CASES = [
  ['no classes today at all', [], [DAY_START, DAY_END]],
  ['now is inside a class', [[TUE, at(11, 40), at(12, 40)]], [at(12, 40), DAY_END]],
  ['a class that already ended', [[TUE, at(11), at(11, 55)]], [at(11, 55), DAY_END]],
  ['now is before the first class', [[TUE, at(13), at(13, 55)]], [DAY_START, at(13)]],
  ['now is after the last class', [[TUE, at(9), at(9, 55)]], [at(9, 55), DAY_END]],
  [
    'back to back with no gap between them',
    [[TUE, at(11), at(11, 55)], [TUE, at(11, 55), at(12, 50)]],
    [at(12, 50), DAY_END],
  ],
  [
    'exact duplicate intervals',
    [[TUE, at(11), at(11, 55)], [TUE, at(11), at(11, 55)]],
    [at(11, 55), DAY_END],
  ],
  [
    'overlapping combined sections',
    [[TUE, at(11), at(12, 20)], [TUE, at(11), at(12)]],
    [at(12, 20), DAY_END],
  ],
  [
    'a contained interval',
    [[TUE, at(10), at(13)], [TUE, at(11), at(11, 40)]],
    [at(13), DAY_END],
  ],
  [
    'unsorted input',
    [[TUE, at(13), at(13, 55)], [TUE, at(10), at(10, 55)], [TUE, at(11, 30), at(12, 25)]],
    [at(12, 25), at(13)],
  ],
];

for (const [name, busy, expected] of EDGE_CASES) {
  test(`edge case: ${name}`, () => {
    const gap = standingAt(busy);
    assert.deepEqual([gap.gapStart, gap.gapEnd], expected);
    assert.equal(gap.usable, usableOf(expected));
  });
}

test('edge case: an inactive session blocks nothing', () => {
  // The 11:00 class belongs to the second half of the term, and today is in the
  // first half, so the room is free all day.
  const busy = [[TUE, at(11), at(11, 55), 1]];
  const active = activeMask([['2026-08-25', '2026-10-12'], ['2026-10-19', '2026-12-09']], '2026-09-01');
  const gap = standingAt(busy, { active });
  assert.deepEqual([gap.gapStart, gap.gapEnd], [DAY_START, DAY_END]);
  assert.equal(gap.usable, usableOf([DAY_START, DAY_END]));
});

test('edge case: the 15 minute passing period is not an answer', () => {
  // OSU's standard passing period is 15 minutes and 69.3% of the 2711 measured
  // inter-class gaps are exactly that. PACKUP is what makes them self-eliminate.
  assert.equal(
    usableMinutes({ now: at(11, 55), gapStart: at(11, 55), gapEnd: at(12, 10), metres: 0 }),
    5,
    'a 15 minute gap is 5 usable minutes, which is no duration a human asks for',
  );
  // A room whose only free window today is that passing period. Five minutes
  // after the previous class lets out there is nothing left of it at all.
  const corridor = [[TUE, at(11), at(11, 55)], [TUE, at(12, 10), DAY_END]];
  assert.equal(standingAt(corridor), null);
  // Standing at the door as the class lets out it still exists, and it is
  // flagged as too short rather than hidden. The ladder is what refuses it: no
  // rung goes below 20 minutes.
  const gap = standingAt(corridor, { now: at(11, 55), needed: MIN_RELAXED_USABLE });
  assert.equal(gap.usable, 5);
  assert.equal(gap.meetsNeed, false);
});

test('the passing period never becomes the answer just because you are standing in it', () => {
  // At 12:00 the room is inside a 15 minute gap that runs out before you could
  // use it, and the next real window is at 13:05. The engine has to skip the
  // one you are in rather than report 0 usable minutes.
  const gap = standingAt([[TUE, at(11), at(11, 55)], [TUE, at(12, 10), at(13, 5)]]);
  assert.equal(gap.gapStart, at(13, 5));
  assert.equal(gap.wait, at(13, 5) - NOON);
});

// --- the walk subtraction, which the naive formula gets wrong in both directions ---

test('a room that frees in 5 minutes and is a 6 minute walk away is free when you get there', () => {
  const metres = 6 * WALK_MPM; // exactly a 6 minute walk, in metres WALKED
  const now = at(10);
  const room = { busy: [[TUE, DAY_START, now + 5]] };
  const gap = bestGap(room, {
    now, day: TUE, open: DAY_START, close: at(16), metres, needed: 60,
  });
  assert.equal(gap.wait, 0, 'the wait is spent walking, so there is no wait');
  assert.equal(gap.usable, at(16) - PACKUP - (now + 6));
});

test('the naive formulas bracket the truth, one over and one under', () => {
  // Gap 13:20-16:00, now 13:00, a 6 minute walk. You arrive at 13:06 and wait
  // 14 minutes, so you get 160 minutes with no packup buffer.
  const metres = 6 * WALK_MPM;
  const now = at(13);
  const gapStart = at(13, 20);
  const gapEnd = at(16);
  const truth = usableMinutes({ now, gapStart, gapEnd, metres, packup: 0 });
  assert.equal(truth, 160);

  const overstates = gapEnd - now - walkMinutes(metres); // the README's formula
  assert.equal(overstates, 174, 'counts the 14 minutes in the corridor as study time');

  const understates = gapEnd - gapStart - walkMinutes(metres); // window minus walk
  assert.equal(understates, 154, 'charges you for a walk you did while waiting');

  assert.ok(understates < truth && truth < overstates);
});

test('walk time rounds up, so a 79 metre walk is two minutes and not one', () => {
  assert.equal(walkMinutes(78), 1);
  assert.equal(walkMinutes(79), 2, 'every rounding in this engine breaks pessimistic');
});

test('leaveBy is now when the room is free and the gap start minus the walk when it is not', () => {
  const metres = 6 * WALK_MPM;
  assert.equal(leaveBy({ now: at(13), gapStart: at(12), metres }), at(13), 'already free, so go');
  assert.equal(leaveBy({ now: at(13), gapStart: at(14), metres }), at(13, 54), 'no need to sprint');
});

test('every ranked row carries leaveBy', () => {
  const rooms = [{ id: 'DL0357', b: '279', busy: [[1, at(9), at(13)]] }];
  const [row] = rank(rooms, {
    origin: ORIGIN, now: at(9), day: 1, buildings: BUILDINGS, hoursFor: () => [at(8), at(18)],
  });
  assert.equal(row.availableAt, at(13));
  assert.equal(row.leaveBy, at(13) - row.walk);
  assert.ok(row.leaveBy < row.availableAt, 'you have to set off before the room frees');
});

// --- zero-length gaps, back to back, and the building's close time ---

test('no arrangement of blocks ever produces a zero-length gap', () => {
  const arrangements = [
    [[1, at(9), at(10)], [1, at(10), at(11)]],
    [[1, at(9), at(11)], [1, at(10), at(11)]],
    [[1, at(8), at(9)], [1, at(9), at(9)]],
    [[1, at(8), at(18)]],
    [[1, at(8), at(9)], [1, at(9), at(10)], [1, at(10), at(18)]],
  ];
  for (const busy of arrangements) {
    for (const [start, end] of freeGaps(busy, 1, at(8), at(18))) {
      assert.ok(end > start, `${JSON.stringify(busy)} produced [${start}, ${end}]`);
    }
  }
});

test('a gap that would run past the building close is cut off at the door, not the class', () => {
  const room = { busy: [[1, at(9), at(14)]] };
  const gap = bestGap(room, { now: at(14), day: 1, open: at(8), close: at(17), metres: 0 });
  assert.equal(gap.gapEnd, at(17), 'the window ends when the building locks');
  assert.equal(gap.usable, at(17) - PACKUP - at(14));
});

test('a class running past the close time does not leave a phantom gap behind it', () => {
  // The building publishes a 17:00 close and a class runs 16:00 to 19:00. The
  // room is busy until the door locks and there is nothing left to offer.
  const room = { busy: [[1, at(16), at(19)]] };
  assert.equal(bestGap(room, { now: at(16, 30), day: 1, open: at(8), close: at(17), metres: 0 }), null);
});

test('an hours pair that does not run forwards is refused, not inverted', () => {
  // An overnight building would arrive as close <= open, and the complement of
  // nothing is a free day, which is the one answer this app must never give.
  assert.deepEqual(freeGaps([], 1, at(20), at(2)), []);
  assert.deepEqual(freeGaps([], 1, at(9), at(9)), []);
  assert.deepEqual(freeGaps([], 1, NaN, at(17)), []);
});

test('a room is dropped once the building has closed, not offered until midnight', () => {
  const rooms = [{ id: 'DL0357', b: '279', busy: [] }];
  const base = { origin: ORIGIN, day: 1, buildings: BUILDINGS, hoursFor: () => [at(8), at(17)] };
  assert.equal(rank(rooms, { ...base, now: at(16) }).length, 1);
  assert.deepEqual(rank(rooms, { ...base, now: at(17) }), [], 'closed is closed');
});

test('before the building opens the room is offered with the wait, not as free now', () => {
  const [row] = rank([{ id: 'DL0357', b: '279', busy: [] }], {
    origin: ORIGIN, now: at(6), day: 1, buildings: BUILDINGS, hoursFor: () => [at(8), at(17)],
  });
  assert.equal(row.availableAt, at(8));
  assert.ok(row.wait > 0);
  assert.equal(row.tier, 4, 'known hours, but you would be waiting');
});

// --- hours: published, published closed, and not published at all ---

test('the three hours answers never collapse into two', () => {
  const rooms = [
    { id: 'AA0001', b: '279', busy: [] },
    { id: 'BB0001', b: '26', busy: [] },
    { id: 'CC0001', b: '999', busy: [] },
  ];
  const out = rank(rooms, {
    origin: ORIGIN,
    now: at(12),
    day: 6,
    buildings: BUILDINGS,
    hoursFor: (code) => (code === '279' ? [at(8), at(18)] : code === '26' ? null : undefined),
  });
  assert.deepEqual(out.map((r) => r.id), ['AA0001', 'CC0001']);
  const [known, unknown] = out;
  assert.equal(known.hoursKnown, true);
  assert.ok(known.usable > 0, 'a published window is a number we can stand behind');
  assert.equal(unknown.hoursKnown, false);
  assert.equal(unknown.usable, null, 'not published is not a window');
  assert.ok(known.tier < unknown.tier);
});

test('unknown hours are swept over the schedule bounds, not the whole 24 hours', () => {
  // The old fallback was 0 to 1440, which is an assumed window and the most
  // generous one available. "Free since midnight" is true and useless.
  const room = [{ id: 'X', b: '279', busy: [] }];
  const base = { origin: ORIGIN, day: 1, buildings: BUILDINGS, hoursFor: () => undefined };
  const [daytime] = rank(room, { ...base, now: at(9) });
  assert.equal(daytime.availableAt, DAY_START);
  assert.equal(daytime.nextClassAt, DAY_END);
  assert.equal(daytime.usable, null);
});

test('an unknown-hours room is never made to wait for an hour nobody published', () => {
  // At 03:00 the schedule bound is 07:00, and a row that waits for it reads
  // "from 7:00 AM". Nobody published 7:00 for that door. It is a bound on the
  // class grid, so it can shorten what we offer and it can never become an
  // opening time.
  const [row] = rank([{ id: 'X', b: '279', busy: [] }], {
    origin: ORIGIN, now: at(3), day: 1, buildings: BUILDINGS, hoursFor: () => undefined,
  });
  assert.equal(row.wait, 0);
  assert.equal(row.availableAt, at(3));
  assert.equal(row.usable, null, 'and still no window, because we still do not know');
});

test('a malformed hours pair reads as not published rather than as a window', () => {
  const [row] = rank([{ id: 'X', b: '279', busy: [] }], {
    origin: ORIGIN, now: at(9), day: 1, buildings: BUILDINGS, hoursFor: () => [NaN, at(17)],
  });
  assert.equal(row.hoursKnown, false, 'a parse failure must not become a door time');
  assert.equal(row.usable, null);
});

// --- the session mask ---

test('a Uint8Array mask is read as a mask, not as a row of falses', () => {
  // `0 === false` is false, so an engine that tested for `false` would ignore a
  // typed mask entirely and report every room booked solid.
  const sessions = [['2026-08-25', '2026-10-12'], ['2026-10-19', '2026-12-09']];
  const busy = [[1, 480, 540, 0], [1, 600, 660, 1]];
  const sept = activeMask(sessions, '2026-09-01');
  assert.ok(sept instanceof Uint8Array);
  assert.deepEqual([...sept], [1, 0]);
  assert.deepEqual(freeGaps(busy, 1, 420, 720, sept), [[420, 480], [540, 720]]);
  assert.deepEqual(
    freeGaps(busy, 1, 420, 720, sept),
    freeGaps(busy, 1, 420, 720, activeSessions(sessions, '2026-09-01')),
    'both mask shapes give the same answer',
  );
});

test('a session index the mask does not cover stays busy', () => {
  // Not knowing which half of the term a class belongs to is not a licence to
  // call the room free.
  const mask = activeMask([['2026-08-25', '2026-10-12']], '2026-09-01');
  assert.deepEqual(freeGaps([[1, 480, 540, 7]], 1, 420, 720, mask), [[420, 480], [540, 720]]);
});

test('activeMask agrees with activeSessions on every boundary', () => {
  const sessions = [['2026-08-25', '2026-10-12'], ['2026-10-19', '2026-12-09']];
  for (const date of ['2026-08-24', '2026-08-25', '2026-10-12', '2026-10-13', '2026-10-19', '2026-12-10']) {
    assert.deepEqual(
      [...activeMask(sessions, date)],
      activeSessions(sessions, date).map(Number),
      date,
    );
  }
  assert.deepEqual([...activeMask(undefined, '2026-09-01')], []);
});

// --- daylight saving, which Ohio observes ---

test('the engine takes wall-clock minutes, which is what DST cannot break', () => {
  // 2026-11-01 is the Sunday Ohio falls back. Local midnight is 04:00 UTC and
  // local 03:00 is 08:00 UTC, so 240 real minutes pass while the clock moves
  // 180. A `now` computed by subtracting midnight from the epoch is an hour
  // ahead of the wall clock for the rest of that 25 hour day, and every busy
  // interval in the index is wall clock.
  const epochElapsed = (Date.UTC(2026, 10, 1, 13) - Date.UTC(2026, 10, 1, 4)) / 60000;
  assert.equal(epochElapsed, 540, 'nine hours have really passed');
  assert.equal(at(8), 480, 'and the clock on the wall says eight');

  const room = { busy: [[0, at(8, 30), at(10)]] };
  const opts = { day: 0, open: DAY_START, close: DAY_END, metres: 0 };
  const wall = bestGap(room, { ...opts, now: at(8) });
  const epoch = bestGap(room, { ...opts, now: epochElapsed });
  assert.equal(wall.gapEnd, at(8, 30), 'half an hour before the class starts');
  assert.equal(epoch.gapStart, at(10), 'the epoch clock has already walked past it');
});

test('a window spanning the spring-forward hour is short by that hour', () => {
  // 2026-03-08. The clock jumps from 02:00 to 03:00, so a window the clock
  // calls three hours long really holds two. This is the only place wall-clock
  // arithmetic overstates, so it is the only place a correction is applied.
  const window = { now: at(1), gapStart: at(1), gapEnd: at(4), metres: 0, packup: 0 };
  const spring = { at: at(2), lost: 60 };
  assert.equal(usableMinutes(window), 180, 'the clock alone overstates');
  assert.equal(usableMinutes({ ...window, dst: spring }), 120);
  assert.equal(
    usableMinutes({ ...window, gapEnd: at(2), dst: spring }),
    60,
    'a window that ends at the jump loses nothing',
  );
  assert.equal(
    usableMinutes({ ...window, now: at(3), gapStart: at(3), dst: spring }),
    60,
    'a window that starts after the jump loses nothing',
  );
});

test('the extra hour in November is never handed back', () => {
  // The clock repeats 01:00 to 02:00, so that window really holds 120 minutes.
  // Reporting 120 would be the only optimistic rounding in the engine, so the
  // engine reports what the clock says and under-promises by an hour.
  const window = { now: at(1), gapStart: at(1), gapEnd: at(2), metres: 0, packup: 0 };
  assert.equal(usableMinutes({ ...window, dst: { at: at(1, 30), lost: -60 } }), 60);
});

test('the engine never touches a Date, so it cannot be wrong about a timezone', () => {
  const src = readFileSync(new URL('../../js/engine.js', import.meta.url), 'utf8');
  assert.deepEqual(src.match(/new Date|Date\./g) ?? [], []);
});

// --- ranking ---

test('for fixed-duration requests, walk is primary and surplus is a tie-break; for rest of day, surplus can buy a longer walk', () => {
  const near = { walk: 3, usable: 60 };
  const far = { walk: 4, usable: 120 };
  
  // fixed duration
  assert.ok(scoreOf(near, 60) < scoreOf(far, 60), 'nearer walk wins even if further room has a longer window');
  
  const sameWalkLessSurplus = { walk: 3, usable: 60 };
  const sameWalkMoreSurplus = { walk: 3, usable: 120 };
  assert.ok(scoreOf(sameWalkMoreSurplus, 60) < scoreOf(sameWalkLessSurplus, 60), 'surplus acts as a tie-break for equal walk times');
  
  assert.equal(
    scoreOf({ walk: 5, usable: 60 + SURPLUS_CAP }, 60),
    scoreOf({ walk: 5, usable: 60 + SURPLUS_CAP + 300 }, 60),
    'the cap is a cap',
  );
  assert.equal(scoreOf({ walk: 4, usable: 60 }, 60), 4 - 0.001 * 0);

  // rest of day (need = 0)
  const short_window = { walk: 3, usable: 0 };
  const long_window = { walk: 4, usable: 60 };
  assert.ok(scoreOf(long_window, 0) < scoreOf(short_window, 0), 'an extra hour is worth a minute of walking for rest-of-day');
  
  // Six minutes further needs a full hour of surplus to win, and no more than
  // an hour ever counts.
  const distant = { walk: 10, usable: 600 };
  assert.ok(scoreOf(near, 0) < scoreOf(distant, 0), 'surplus past the cap does not drag you across campus');
  // The rest-of-day branch is the only one SURPLUS_WEIGHT still prices, and it
  // was left asserted by ordering alone when #116 split the two branches: the
  // import went unused and nothing pinned the exchange rate any more. Half an
  // hour of surplus buys three minutes of walking, and an hour is the ceiling.
  assert.equal(scoreOf({ walk: 6, usable: 30 }, 0), 6 - SURPLUS_WEIGHT * 30);
  assert.equal(scoreOf({ walk: 9, usable: 600 }, 0), 9 - SURPLUS_WEIGHT * SURPLUS_CAP);
});

test('an unknown-hours room scores on distance alone, because it has no window to trade', () => {
  assert.equal(scoreOf({ walk: 7, usable: null }, 60), 7);
});

test('the type tie-break is classroom, then seminar room, then lecture hall', () => {
  assert.ok(typeRank('1B') < typeRank('1A'));
  // The lecture hall moved below the seminar room. Every one of the committed
  // index's 55 of them is general assignment, so the row is not a lie, but they
  // run 48 to 727 seats against a median of 34 for a classroom and one person
  // asking for an hour is not who they are for.
  assert.ok(typeRank('1A') < typeRank('1C'));
  assert.ok(typeRank('1C') < typeRank('2A'), 'a wet lab is not a study room');
  assert.equal(typeRank('LCTR'), typeRank('1C'));
  assert.equal(typeRank('SMNR'), typeRank('1A'));
  assert.equal(typeRank(null), typeRank('2A'), 'no type is treated like an unpreferred one');
});

test('rows tie-break down to the room id, so two identical queries cannot reshuffle', () => {
  const rooms = ['DL0101', 'DL0102', 'DL0103'].map((id) => ({ id, b: '279', cap: 40, type: '1B', busy: [] }));
  const opts = {
    origin: ORIGIN, now: at(9), day: 1, needed: 60, buildings: BUILDINGS, hoursFor: () => [at(8), at(18)],
  };
  const first = rank(rooms, opts);
  const second = rank([...rooms].reverse(), opts);
  assert.deepEqual(first.map((r) => r.id), ['DL0101', 'DL0102', 'DL0103']);
  assert.deepEqual(first.map((r) => r.id), second.map((r) => r.id), 'input order cannot leak into output order');
});

test('capacity breaks a tie the type cannot, toward the room one person asked for', () => {
  // This used to run the other way, largest first. Issue #62 caught what that
  // costs on the real index: from the Oval on a Saturday, Independence Hall 100
  // and its 727 seats on row one.
  const rooms = [
    { id: 'DL0101', b: '279', cap: 20, type: '1B', busy: [] },
    { id: 'DL0102', b: '279', cap: 90, type: '1B', busy: [] },
  ];
  const out = rank(rooms, {
    origin: ORIGIN, now: at(9), day: 1, needed: 60, buildings: BUILDINGS, hoursFor: () => [at(8), at(18)],
  });
  assert.deepEqual(out.map((r) => r.id), ['DL0101', 'DL0102']);

  // A room the index publishes no capacity for still sorts last, where the old
  // descending order also put it: an unknown is not evidence of a small room.
  const unknown = rank([
    { id: 'DL0111', b: '279', cap: 0, type: '1B', busy: [] },
    { id: 'DL0112', b: '279', cap: 90, type: '1B', busy: [] },
  ], {
    origin: ORIGIN, now: at(9), day: 1, needed: 60, buildings: BUILDINGS, hoursFor: () => [at(8), at(18)],
  });
  assert.deepEqual(unknown.map((r) => r.id), ['DL0112', 'DL0111']);
  // But a preferred type outranks any number of seats, because a 727 seat
  // lecture hall is likelier to be locked or held for an event than a 34 seat
  // classroom.
  const mixed = rank([
    { id: 'DL0201', b: '279', cap: 400, type: '2A', busy: [] },
    { id: 'DL0202', b: '279', cap: 12, type: '1B', busy: [] },
  ], {
    origin: ORIGIN, now: at(9), day: 1, needed: 60, buildings: BUILDINGS, hoursFor: () => [at(8), at(18)],
  });
  assert.equal(mixed[0].id, 'DL0202');
});

// --- the Registrar's general-assignment pool ---

test('a general-assignment room outranks a departmental one at the same walk', () => {
  // The case docs/BACKLOG.md's parked decision is about, and the one issue #89
  // asks for by name: same building, same window, same type, same seats, one on
  // the Registrar's general-assignment list and one not.
  const rooms = [
    { id: 'DL0101', b: '279', cap: 40, type: '1B', busy: [], ga: false },
    { id: 'DL0102', b: '279', cap: 40, type: '1B', busy: [], ga: true },
  ];
  const opts = {
    origin: ORIGIN, now: at(9), day: 1, needed: 60, buildings: BUILDINGS, hoursFor: () => [at(8), at(18)],
  };
  const out = rank(rooms, opts);
  assert.deepEqual(out.map((r) => r.id), ['DL0102', 'DL0101']);
  assert.deepEqual(out.map((r) => r.ga), [true, false], 'the flag reaches the row the screen renders');
  // Not the id tiebreak doing it: DL0101 sorts first on every other key.
  assert.deepEqual(rank([...rooms].reverse(), opts).map((r) => r.id), ['DL0102', 'DL0101']);
  assert.ok(out[0].tier < out[1].tier, 'it is a tier, decided before walk and window');
});

test('the general-assignment tier never crosses the window or the wait', () => {
  const opts = {
    origin: ORIGIN, now: at(9), day: 1, needed: 60, buildings: BUILDINGS, hoursFor: () => [at(8), at(18)],
  };
  // A departmental room free for the full hour beats a general-assignment room
  // that does not open until 10:00. Who holds the key is a smaller fact than
  // whether the door is open at all.
  const out = rank([
    { id: 'DL0101', b: '279', cap: 40, type: '1B', busy: [], ga: false },
    { id: 'DL0102', b: '279', cap: 40, type: '1B', busy: [[1, at(9), at(10)]], ga: true },
  ], opts);
  assert.equal(out[0].id, 'DL0101');
  assert.equal(out[0].wait, 0);
  assert.ok(out[1].wait > 0);
});

test('a room the index says nothing about is not treated as departmental', () => {
  // Every room of an index built before the 2026-08-27 general-assignment pull
  // carries no `ga` at all, and demoting all of them would be a worse answer
  // than the one this replaces.
  const opts = {
    origin: ORIGIN, now: at(9), day: 1, needed: 60, buildings: BUILDINGS, hoursFor: () => [at(8), at(18)],
  };
  const [silent] = rank([{ id: 'DL0101', b: '279', cap: 40, type: '1B', busy: [] }], opts);
  const [named] = rank([{ id: 'DL0101', b: '279', cap: 40, type: '1B', busy: [], ga: true }], opts);
  assert.equal(silent.ga, null, 'silence is reported as silence, not as false');
  assert.equal(silent.tier, named.tier);
});

// --- the fallback ladder ---

const METRES_PER_DEGREE_LAT = distanceMetres({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
const hallAt = (metres, name) => ({
  name,
  lat: ORIGIN.lat + metres / METRES_PER_DEGREE_LAT,
  lon: ORIGIN.lon,
});

// A campus laid out along one line north of the origin, so a room's walk time
// is exactly ceil(metres / 60) minutes and every scenario below is readable.
function campus(spec) {
  const buildings = {};
  const rooms = [];
  for (const [code, metres, count, room] of spec) {
    buildings[code] = hallAt(metres, `Hall ${code}`);
    for (let i = 0; i < count; i++) {
      rooms.push({ id: `${code}${String(i).padStart(4, '0')}`, b: code, cap: 30, type: '1B', busy: [], ...room });
    }
  }
  return { buildings, rooms };
}

const OPEN_ALL_DAY = () => [DAY_START, DAY_END];
const askFor = (needed, { buildings, rooms }, extra = {}) =>
  query(rooms, {
    origin: ORIGIN, now: at(12), day: TUE, needed, buildings, hoursFor: OPEN_ALL_DAY, ...extra,
  });

test('the ladder answers on the first rung when rooms are simply free', () => {
  const out = askFor(60, campus([['A', 300, 5]]));
  assert.equal(out.rung, 'asked');
  assert.equal(out.relaxed, false);
  assert.equal(out.rows.length, 5);
  assert.ok(out.rows.every((r) => r.wait === 0 && r.usable >= 60));
});

test('the ladder stops at the first rung with three rooms and does not keep walking', () => {
  const out = askFor(60, campus([['A', 300, LADDER_QUORUM]]));
  assert.equal(out.rung, 'asked');
  assert.equal(out.rows.length, LADDER_QUORUM);
});

test('two rooms is not a quorum, so the ladder keeps looking and takes the better rung', () => {
  // Two classrooms and a conference room, all free. The type filter answers with
  // two, which is under quorum, so the next rung offers the third as well.
  // 5K rather than 2P: the computer labs left the offerable set entirely, so a
  // 2P fixture now tests a room that can never appear rather than the rung.
  const out = askFor(60, campus([
    ['A', 300, 2],
    ['B', 300, 1, { type: '5K' }],
  ]));
  assert.equal(out.rung, 'any-type');
  assert.equal(out.rows.length, 3);
  assert.equal(out.relaxed, true, 'a departmental room is not the room that was asked for');
});

test('the room-type filter comes off before the duration does', () => {
  const out = askFor(60, campus([['B', 300, 4, { type: '5K' }]]));
  assert.equal(out.rung, 'any-type');
  assert.equal(out.need, 60, 'still the duration that was asked for');
  assert.equal(out.askedNeed, 60);
});

test('an answer made of departmental rooms is labelled relaxed on every rung that can reach one', () => {
  // The whole payload contract: if the rows are not the question the student
  // asked, `relaxed` says so. Only the first rung may answer with false.
  const spec = campus([['B', 300, 4, { type: '5K' }]]);
  for (const [needed, extra] of [[60, {}], [120, {}], [60, { maxWalk: 1 }]]) {
    const out = askFor(needed, spec, extra);
    if (!out.rows.length) continue;
    assert.notEqual(out.rung, 'asked');
    assert.equal(out.relaxed, true, `rung ${out.rung} handed back a departmental room without saying so`);
  }
});

test('a wet lab is never offered, however far down the ladder the answer comes from', () => {
  // docs/research/facility-types.md excludes 2A outright: dissection labs,
  // wet labs and the rooms where the cost of guessing wrong is somebody
  // sitting down in one. The last rung is the one to check, because it has no
  // radius, no duration and no preference left to drop.
  const spec = campus([['B', 300, 6, { type: '2A' }]]);
  for (const needed of [20, 60, 120]) {
    const out = askFor(needed, spec);
    assert.deepEqual(out.rows, [], `a 2A room reached the answer at need ${needed}`);
  }
  assert.equal(askFor(60, spec).rung, null);
});

test('an unrecognised facility type is excluded, not shown', () => {
  // The type space is not closed. A code nobody has decoded is not evidence
  // that the room is a room you can sit in.
  const unknown = campus([['B', 300, 5, { type: 'ZZ9' }]]);
  assert.deepEqual(askFor(60, unknown).rows, []);
  const untyped = campus([['B', 300, 5, { type: null }]]);
  assert.deepEqual(askFor(60, untyped).rows, []);
});

test('a shorter duration is a relaxed answer and says so', () => {
  // Every room closes at 13:00, so 60 minutes is impossible and 45 is not.
  const spec = campus([['A', 300, 4, { busy: [[TUE, at(13), DAY_END]] }]]);
  const out = askFor(60, spec);
  assert.equal(out.rung, 'shorter:45');
  assert.equal(out.relaxed, true);
  assert.equal(out.need, 45);
  assert.equal(out.askedNeed, 60);
  assert.ok(out.rows.every((r) => r.usable >= 45));
});

test('the ladder walks its rungs in order and takes the longest one that fits', () => {
  assert.deepEqual(RELAX_LADDER, [120, 90, 60, 45, 30, 20]);
  // The rooms are a 5 minute walk, so a class at 13:45 leaves 90 usable minutes.
  const spec = campus([['A', 300, 4, { busy: [[TUE, at(13, 45), DAY_END]] }]]);
  const out = askFor(120, spec);
  assert.equal(out.rung, 'shorter:90');
});

test('no relaxed row is ever a near miss under twenty minutes', () => {
  // The rooms free up for 15 usable minutes, which is not an answer to any
  // question, so the ladder returns nothing rather than something useless.
  const spec = campus([['A', 300, 5, { busy: [[TUE, at(12, 25), DAY_END]] }]]);
  const out = askFor(60, spec);
  assert.equal(out.rows.length, 0);
  assert.equal(out.rung, null);
  assert.equal(out.refused, null, 'not a refusal, just nothing to offer');
  assert.ok(out.reason, 'and it says why');
  assert.equal(MIN_RELAXED_USABLE, 20);
});

test('when nothing is free now, the answer is when something opens', () => {
  const spec = campus([['A', 300, 4, { busy: [[TUE, DAY_START, at(14)]] }]]);
  const out = askFor(60, spec);
  assert.equal(out.rung, 'opens-at');
  assert.equal(out.relaxed, true);
  assert.ok(out.rows.every((r) => r.wait > 0));
  assert.ok(out.rows.every((r) => r.availableAt === at(14)));
  assert.ok(out.rows.every((r) => r.leaveBy === at(14) - r.walk));
});

test('the opens-at rung ignores the lookahead horizon, because naming the hour is its job', () => {
  // Nothing opens for eight hours, which is past LOOKAHEAD. A horizon here
  // would hand back an empty screen instead of "the first one opens at 21:00".
  const spec = campus([['A', 300, 4, { busy: [[TUE, DAY_START, at(21)]] }]]);
  const out = askFor(60, spec);
  assert.equal(out.rung, 'opens-at');
  assert.ok(out.rows.every((r) => r.availableAt === at(21)));
});

test('a room further away is offered once nothing near is free', () => {
  const spec = campus([
    ['A', 300, 3, { busy: [[TUE, DAY_START, DAY_END]] }], // 5 minutes, booked solid
    ['F', 1200, 4], // 20 minutes, free
  ]);
  const out = askFor(60, spec);
  assert.equal(out.rung, 'further');
  assert.equal(out.relaxed, true);
  assert.ok(out.rows.every((r) => r.walk > MAX_WALK && r.walk <= MAX_WALK * 2));
});

test('the radius comes off entirely before the answer becomes nothing', () => {
  const spec = campus([['Z', 1800, 4]]); // a 30 minute walk
  const out = askFor(60, spec);
  assert.equal(out.rung, 'anywhere');
  assert.equal(out.relaxed, true);
  assert.equal(out.rows[0].walk, 30);
});

test('the last resort is one room and an honest headline, not a list', () => {
  // A single distant room that frees later for half an hour, against a request
  // for two hours. Every rung above this one has a reason to refuse it.
  const spec = campus([['Z', 1800, 2, { busy: [[TUE, DAY_START, at(14)], [TUE, at(14, 40), DAY_END]] }]]);
  const out = askFor(120, spec);
  assert.equal(out.rung, 'longest');
  assert.equal(out.relaxed, true);
  assert.equal(out.rows.length, 1);
  assert.ok(out.rows[0].usable >= MIN_RELAXED_USABLE);
});

test('an empty campus is an empty answer with a reason, never a blank screen', () => {
  const out = askFor(60, campus([]));
  assert.deepEqual(out.rows, []);
  assert.equal(out.rung, null);
  assert.equal(out.relaxed, false);
  assert.ok(out.reason);
});

test('the payload names the day bounds so the UI does not have to guess them', () => {
  const out = askFor(60, campus([['A', 300, 3]]));
  assert.equal(out.dayStart, DAY_START);
  assert.equal(out.dayEnd, DAY_END);
  assert.equal(out.maxWalk, MAX_WALK);
});

test('the payload counts what it dropped and why', () => {
  const spec = campus([['A', 300, 2], ['B', 300, 2]]);
  const out = query(spec.rooms, {
    origin: ORIGIN,
    now: at(12),
    day: TUE,
    needed: 60,
    buildings: spec.buildings,
    hoursFor: (code) => (code === 'B' ? null : OPEN_ALL_DAY()),
  });
  assert.equal(out.counts.rooms, 4);
  assert.equal(out.counts.considered, 2);
  assert.equal(out.counts.dropped.closed, 2, 'a published closure is a fact worth counting');
  assert.equal(out.known, 2);
  assert.equal(out.unknown, 0);
});

test('a screen full of unknown-hours rooms is countable, not disguised', () => {
  const spec = campus([['A', 300, 3]]);
  const out = query(spec.rooms, {
    origin: ORIGIN, now: at(12), day: TUE, needed: 60, buildings: spec.buildings,
    hoursFor: () => undefined,
  });
  assert.equal(out.known, 0);
  assert.equal(out.unknown, 3);
  // 6, not 3. tierOf gained the ga term as its innermost decision, so the five
  // tiers renumbered to 0,2,4,6,8 (+1 departmental) and unknown-hours moved from
  // ">= 3" to ">= 6". The old bound still passes here, and that is the problem:
  // it now also admits tiers 3, 4 and 5, every one of which is a room whose
  // hours ARE known, so it stopped asserting the thing it was written for.
  assert.ok(out.rows.every((r) => r.usable === null && r.tier >= 6));
});

// --- the rung reaches the screen ---
//
// The ladder computed `rung` and `relaxed` from the day it shipped and js/app.js
// read neither, so a list built by dropping the room-type filter was headed by
// the same words as a list of ordinary classrooms: 20 computer labs, 12
// conference rooms and a dental clinic under no sentence at all. That is issue
// #90, and these are the tests that stop it coming back.
//
// Two things in that sentence are history now. The labs left OFFERABLE, so the
// rung reaches conference rooms, a meeting room, a TV and radio facility and
// two rooms of a type nothing decodes. And the dental clinic was never on this
// index at all: PH3089A is real, it is in docs/research/facility-types.md, and
// zero PH rooms ship. It got repeated here from that document twice before
// anyone checked it against data/rooms-1268.json.
//
// The sentences live in js/state.js rather than in js/app.js because js/app.js
// touches the DOM at import and cannot be loaded under node. js/state.js is the
// file that already holds the row phrasing, for the same reason.

test('every rung the ladder can return has a sentence, and a new rung fails until it does', () => {
  // THE test this issue exists for. RUNGS is what `query` walks, so a rung
  // added to the ladder is a rung added here, and it arrives with no sentence
  // and fails this until somebody writes one. Without it the next rung is
  // silent the way `any-type` was silent.
  for (const rung of RUNGS) {
    if (rung === 'asked') continue;
    const phrase = rungPhrase(rung, { needed: 60, maxWalk: MAX_WALK });
    assert.ok(phrase, `the ladder can answer with rung "${rung}" and the app has no sentence for it`);
    assert.ok(phrase.text.length > 20, `the sentence for "${rung}" is too short to say anything`);
    assert.ok(phrase.say.length > 20, `the spoken sentence for "${rung}" is too short to say anything`);
    assert.doesNotMatch(phrase.text, /undefined|NaN|\[object/, `the sentence for "${rung}" prints a hole`);
    assert.doesNotMatch(phrase.say, /undefined|NaN|\[object/, `the spoken sentence for "${rung}" prints a hole`);
  }

  // The exact-answer rung gave nothing up and so has nothing to admit, and a
  // name the ladder does not have is not a licence to invent a sentence.
  assert.equal(rungPhrase('asked', { needed: 60 }), null);
  assert.equal(rungPhrase('rooftop', { needed: 60 }), null);
  assert.equal(rungPhrase(null, { needed: 60 }), null);
});

test('the ladder walks the names in RUNGS and keeps no second copy of them', () => {
  // RUNGS is the order `query` iterates, so the list the screen is tested
  // against and the list the ladder walks are one list. A rung added to the
  // runner object and not to RUNGS would never run at all, and this is what
  // says so rather than leaving it to a silent behaviour change.
  const src = readFileSync(new URL('../../js/engine.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('  const runs = {'), src.indexOf('  const rungs = RUNGS'));
  assert.ok(block.length > 200, 'the ladder no longer builds its rungs from a `runs` object');
  // Any key at any indentation, any characters a JS identifier or a quoted key
  // can hold. The first version of this line was /^ {4}'?([a-z-]+...)'?:/ and it
  // captured six literal names: the `shorter:${n}` entry sits deeper, inside
  // Object.fromEntries, so it never matched and the branch below that handles it
  // was dead code. Worse, [a-z-] rejects digits, so a rung called `roof2` could
  // be added to the runner and never to RUNGS and this test stayed green while
  // the rung never ran -- the exact failure it exists to catch.
  // Two shapes, because the ladder holds two. Most rungs are plain object keys;
  // the `shorter` family is a template literal spread in through
  // Object.fromEntries, which is a different line entirely and is why the first
  // version of this scan missed it.
  // Four spaces exactly: a rung key is a top-level property of `runs`, and
  // anything deeper is the options object being handed to rung() -- `mode:
  // 'soon'` inside the opens-at runner is not a rung. \s+ here captured it.
  const keys = [...block.matchAll(/^ {4}'?([A-Za-z0-9_$-]+)'?:\s/gm)].map((m) => m[1]);
  const built = [...block.matchAll(/`([A-Za-z0-9_$-]+):\$\{n\}`/g)].map((m) => `${m[1]}:\${n}`);
  const named = [...keys, ...built];
  assert.ok(keys.length >= 6, `only found ${keys.length} rung runners`);
  assert.ok(built.length >= 1, 'the shorter family is not being captured');
  for (const name of named) {
    const inRungs = name === 'shorter:${n}'
      ? RUNGS.some((r) => r.startsWith('shorter:'))
      : RUNGS.includes(name);
    assert.ok(inRungs, `the ladder can run "${name}" and RUNGS does not list it, so it never runs`);
  }
});

test('every relaxed answer the ladder actually produces has words for it', () => {
  // The names, run through the ladder rather than read off the constant. Each
  // scenario is one already covered above, kept here for the sentence rather
  // than for the rung.
  const cases = [
    campus([['A', 300, 2], ['B', 300, 1, { type: '5K' }]]), // any-type
    campus([['A', 300, 3, { busy: [[TUE, DAY_START, DAY_END]] }], ['F', 1200, 4]]), // further
    campus([['Z', 1800, 4]]), // anywhere
    campus([['Z', 1800, 2, { busy: [[TUE, DAY_START, at(14)], [TUE, at(14, 40), DAY_END]] }]]), // longest
  ];
  const seen = new Set();
  for (const spec of cases) {
    for (const needed of [60, 120]) {
      const out = askFor(needed, spec);
      if (!out.relaxed) continue;
      seen.add(out.rung);
      const phrase = rungPhrase(out.rung, { needed: out.askedNeed, maxWalk: out.maxWalk });
      assert.ok(phrase, `the ladder answered with "${out.rung}" and the app would print nothing`);
    }
  }
  // Four, not three. This was `>= 3` and the any-type fixture above was typed
  // 2P, so when the labs left OFFERABLE that case stopped relaxing at all --
  // the loop's `if (!out.relaxed) continue` skipped it, the count fell from 4
  // to 3, and the assertion passed on the threshold. The rung this file exists
  // to word was silently no longer being reached. The floor is the real count
  // now, so losing one is a failure rather than a shrug.
  assert.ok(seen.has('any-type'), 'the any-type rung is no longer exercised at all');
  assert.ok(seen.size >= 4, `only reached ${seen.size} relaxed rungs: ${[...seen].join(', ')}`);
});

test('the sentences count to the quorum, because a rung wins by finding three rooms', () => {
  // The wording is not decoration and it is not free to change. A rung is taken
  // when it finds LADDER_QUORUM rooms, so `further` does NOT mean nothing near
  // you is free: it means the ladder preferred three rooms further out to the
  // one or two close by. Replaying the shipped app's own rank() and shape()
  // beside query() over the committed index, 99 origins around the Oval, Mon to
  // Fri 2026-09-14 to 18, hourly 08:00 to 20:00, at a 30 and a 60 minute ask:
  // of 12,870 answers the ladder relaxed on 9,486 and the list still had rows
  // on 510, and on those the rooms a reader could count as free and long enough
  // inside the walk bound were 0, 1 or 2 and never three. "Nothing is free"
  // printed over a list showing two free rooms is the one way this disclosure
  // can lie.
  assert.equal(LADDER_QUORUM, 3, 'the sentences say "fewer than three" in words');
  for (const rung of RUNGS) {
    if (rung === 'asked' || rung === 'longest') continue;
    const { text } = rungPhrase(rung, { needed: 60, maxWalk: MAX_WALK });
    assert.match(text, /^Fewer than three /, `"${rung}" claims more than the quorum allows: ${text}`);
  }
  // `longest` is the exception because it is the only rung that can claim it:
  // it is reached only when every rung above it found nothing at all.
  assert.match(rungPhrase('longest', { needed: 60 }).text, /^Nothing Vacant can offer/);
});

test('the walk bound in the sentence is the bound the rows were cut to', () => {
  // The number a reader can check against the walk times in front of them. A
  // sentence naming 12 minutes over rows shaped to a different bound would be
  // the disclosure lying about the one fact it is easiest to check.
  const at12 = rungPhrase('further', { needed: 60, maxWalk: 12 });
  assert.match(at12.text, /within a 12 minute walk/);
  assert.match(rungPhrase('further', { needed: 60, maxWalk: 20 }).text, /within a 20 minute walk/);
  // `anywhere` quotes maxWalk too, not maxWalk * 2. 24 is where the LADDER
  // looked; 12 is where the rows were cut. js/app.js ranks with rank() +
  // shape(), shape() keeps only rows inside maxWalk, and these two rungs are by
  // definition the ones whose answer is outside it -- so a reader checking 24
  // against the walk times in front of them finds nothing above 12, every time.
  assert.match(rungPhrase('anywhere', { needed: 60, maxWalk: 12 }).text, /within a 12 minute walk/);
  assert.doesNotMatch(rungPhrase('anywhere', { needed: 60, maxWalk: 12 }).text, /24/);
  // And neither promises a search the list cannot show. These clauses shipped
  // over 108 of 108 such lists in the replay and were refuted by the rows on
  // every one of them.
  for (const rung of ['further', 'anywhere', 'opens-at']) {
    const said = rungPhrase(rung, { needed: 60, maxWalk: 12 });
    assert.doesNotMatch(said.text, /looked twice that far|across the whole campus|rooms that open later/,
      `${rung} still describes the ladder's search instead of the list under it`);
    assert.doesNotMatch(said.say, /looked twice that far|across the whole campus|rooms that open later/);
  }
  // Default is the engine's own bound, so a caller that passes nothing does not
  // get a sentence about a radius nobody used.
  assert.equal(rungPhrase('further', { needed: 60 }).text, rungPhrase('further', { needed: 60, maxWalk: MAX_WALK }).text);
});

test('the duration in the sentence is the one that was asked for, printed and spoken', () => {
  const seen = rungPhrase('shorter:45', { needed: 60 });
  assert.match(seen.text, /free for 1h00/, 'the strip gets the glyphs the rest of the list uses');
  assert.match(seen.text, /fell back to 45 min/);
  assert.match(seen.say, /free for 1 hour/, 'a screen reader gets words, not "1h00"');
  assert.match(seen.say, /fell back to 45 minutes/);
});

test('js/app.js reads the rung, and the live region says it out loud', () => {
  // The half of #90 that no import can reach: js/app.js touches the DOM at load
  // and cannot be required under node, so the wiring is checked as text. The
  // grep in the issue was `grep -n "relaxed\|rung" js/app.js` returning nothing.
  const app = readFileSync(new URL('../../js/app.js', import.meta.url), 'utf8');
  assert.match(app, /state\.rung = /, 'js/app.js never stores the rung the ladder returned');
  assert.match(app, /state\.relaxed = /, 'js/app.js never stores whether the answer was relaxed');
  assert.match(app, /rungPhrase\(state\.rung/, 'js/app.js never turns the rung into a sentence');

  // One strip, and the rung wins it. The row counts describe the rows; the rung
  // describes which question the whole list is answering, so it replaces the
  // row sentence rather than stacking a fourth paragraph over the list.
  const paint = app.slice(app.indexOf('function paintList('));
  const rowStrip = paint.indexOf('Nothing near you is free for');
  const rungStrip = paint.indexOf('if (relaxed) strip =');
  assert.ok(rowStrip > 0 && rungStrip > 0, 'paintList no longer builds both strips');
  assert.ok(rungStrip > rowStrip, 'the rung strip does not take precedence over the row counts');

  // And it is not a visual-only disclosure.
  assert.match(app, /const admitted = state\.results\.length \? relaxedLine\(\)\?\.say : null;/);
});

// --- the calendar, where the schedule is wrong in two opposite directions ---

test('during the exam window the engine refuses instead of guessing', () => {
  // From the last day of instruction to the end of finals the busy list is
  // empty for every room on campus, so a schedule-only engine reports 100% of
  // campus free during the week it matters most. OSU does not publish the exam
  // room assignments anywhere the app can read, so there is nothing to compute.
  const out = askFor(60, campus([['A', 300, 5]]), { calendar: { exams: true } });
  assert.equal(out.refused, 'exams');
  assert.deepEqual(out.rows, []);
  assert.match(out.reason, /exam/i);
});

test('a closed university is a different refusal from an exam window', () => {
  const out = askFor(60, campus([['A', 300, 5]]), {
    calendar: { buildingsClosed: true, reason: 'Thanksgiving Day. The university is closed.' },
  });
  assert.equal(out.refused, 'closed');
  assert.deepEqual(out.rows, []);
  assert.equal(out.reason, 'Thanksgiving Day. The university is closed.');
  assert.notEqual(out.refused, 'exams', 'the two never collapse into one answer');
});

test('on a no-class day the busy grid is ignored, and the doors still are not', () => {
  // 788 of 863 sampled Wednesday rows are still active on Veterans Day, so
  // trusting the grid hides 91% of campus on a day nobody is in class.
  const spec = campus([['A', 300, 3, { busy: [[TUE, DAY_START, DAY_END]] }]]);
  const busyDay = askFor(60, spec);
  assert.deepEqual(busyDay.rows, [], 'booked solid on an ordinary Tuesday');

  const holiday = askFor(60, spec, { calendar: { noClasses: true } });
  assert.equal(holiday.rows.length, 3);
  assert.ok(holiday.rows.every((r) => r.usable > 0));

  // The building hours still decide. A holiday does not unlock a closed door.
  const shut = query(spec.rooms, {
    origin: ORIGIN, now: at(12), day: TUE, needed: 60, buildings: spec.buildings,
    hoursFor: () => null, calendar: { noClasses: true },
  });
  assert.deepEqual(shut.rows, []);
});

// --- the real committed index ---

const readData = (file) => JSON.parse(readFileSync(new URL(`../../data/${file}`, import.meta.url), 'utf8'));

test('every room of the committed index carries the flag the ranking now reads', () => {
  // The build has written `ga` since 2026-08-27 and nothing read it. If a term
  // ever ships without it the ranking silently loses its strongest signal, so
  // the count is asserted rather than assumed: 327 general assignment, 98 not.
  const term = readData('current.json').term;
  const index = readData(`rooms-${term}.json`);
  const rooms = Object.values(index.rooms);
  assert.equal(rooms.length, 425);
  assert.equal(rooms.filter((r) => r.ga === undefined).length, 0);
  assert.equal(rooms.filter((r) => r.ga === true).length, 327);
  assert.equal(rooms.filter((r) => r.ga === false).length, 98);
  // 56 of the 98 are types the first rung offers by default, which is why the
  // tier is worth anything: without it they rank as ordinary classrooms.
  const preferred = rooms.filter((r) => PREFERRED_TYPES.includes(r.type));
  assert.equal(preferred.length, 382);
  assert.equal(preferred.filter((r) => r.ga === false).length, 56);
});

test('equirectangular distance matches haversine within a metre for every building on file', () => {
  const buildings = Object.values(readData('buildings.json').buildings);
  let worst = 0;
  for (const b of buildings) {
    worst = Math.max(worst, Math.abs(distanceMetres(ORIGIN, b) - haversineMetres(ORIGIN, b)));
  }
  assert.ok(buildings.length > 600, `${buildings.length} buildings checked`);
  assert.ok(worst < 1, `worst disagreement was ${worst.toFixed(4)} m over ${buildings.length} buildings`);
});

test('a query against the committed index answers, and answers the same way twice', () => {
  const term = readData('current.json').term;
  const index = readData(`rooms-${term}.json`);
  const buildings = readData(`buildings-${term}.json`).buildings;
  const hours = readData('buildings-hours.json').terms['autumn-2026-classroom-pool-building-schedule'];
  const rooms = Object.entries(index.rooms).map(([id, r]) => ({ id, ...r }));
  const hoursFor = (code, day) => hours.buildings[code]?.hours[day];

  const opts = {
    origin: ORIGIN,
    now: at(14),
    day: 2,
    date: '2026-09-15',
    needed: 60,
    buildings,
    hoursFor,
    sessions: index.sessions,
  };
  const first = query(rooms, opts);
  const second = query(rooms, opts);

  assert.ok(rooms.length > 300, `${rooms.length} rooms in the index`);
  assert.ok(first.rows.length > 0);
  assert.equal(first.rung, 'asked');
  assert.equal(
    JSON.stringify(first.rows),
    JSON.stringify(second.rows),
    'the same index and the same clock must give byte-identical rows',
  );
  for (const row of first.rows) {
    assert.ok(row.walk <= MAX_WALK, `${row.id} is a ${row.walk} minute walk`);
    assert.ok(row.usable === null || row.usable >= 60, `${row.id} promises ${row.usable}`);
    assert.ok(row.leaveBy >= at(14));
    assert.ok(row.usableUntil === null || row.usableUntil === row.nextClassAt - PACKUP);
  }
});

test('no rung sentence is contradicted by the rows the shipped list shows under it', () => {
  // The disclosure sits over rows the ladder did not choose. js/app.js builds
  // its list from rank() and shape(), which have no ladder in them, so the
  // strip and the rows are two answers to one question and the strip is only
  // honest while the rows cannot be counted against it.
  //
  // Every sentence says "fewer than three", because a rung is taken when it
  // finds LADDER_QUORUM rooms. So the thing that must never happen is a screen
  // holding three or more rooms a reader would count as free and long enough
  // inside the walk bound while the strip above says fewer than three are.
  //
  // This replays the app: rank() with the whole day in view, the 90 minute wait
  // filter js/app.js applies, then shape() for the radius and the fold.
  const term = readData('current.json').term;
  const index = readData(`rooms-${term}.json`);
  const buildings = readData(`buildings-${term}.json`).buildings;
  const hours = readData('buildings-hours.json').terms['autumn-2026-classroom-pool-building-schedule'];
  const rooms = Object.entries(index.rooms).map(([id, r]) => ({ id, ...r }));
  const type = new Map(rooms.map((r) => [r.id, r.type]));
  const preferred = new Set(PREFERRED_TYPES);
  const hoursFor = (code, day) => hours.buildings[code]?.hours[day];

  // A grid around the Oval, because from the Oval itself the ladder never
  // relaxes: over 250 answers there every one came back on `asked`. The rungs
  // only appear once the walk starts to bite.
  const origins = [];
  for (let dlat = -0.02; dlat <= 0.0201; dlat += 0.008) {
    for (let dlon = -0.02; dlon <= 0.0201; dlon += 0.01) origins.push({ lat: 39.9995 + dlat, lon: -83.013 + dlon });
  }

  let relaxed = 0;
  let withRows = 0;
  for (const origin of origins) {
    for (const [date, day] of [['2026-09-14', 1], ['2026-09-16', 3], ['2026-09-18', 5]]) {
      for (let m = 9 * 60; m <= 19 * 60; m += 120) {
        const opts = { origin, now: m, day, date, needed: 60, buildings, hoursFor, sessions: index.sessions };
        const out = query(rooms, opts);
        if (out.refused || !out.relaxed) continue;
        relaxed++;
        const shown = shape(rank(rooms, opts).filter((r) => r.wait <= 90)).rows;
        if (!shown.length) continue;
        withRows++;
        // What a reader counts: on screen, no wait, and long enough, or a room
        // whose hours nobody publishes, which the rows never call short.
        const fits = shown.filter((r) => r.walk <= MAX_WALK && r.wait === 0 && (r.hoursKnown ? r.meetsNeed : true));
        const countable = out.rung === 'any-type' ? fits.filter((r) => preferred.has(type.get(r.id))) : fits;
        const where = `${date} ${m} from ${origin.lat.toFixed(4)}, ${origin.lon.toFixed(4)}`;
        assert.ok(
          countable.length < LADDER_QUORUM,
          `"${rungPhrase(out.rung, { needed: 60 }).text}" printed over ${countable.length} rooms that answer it, at ${where}`,
        );
      }
    }
  }
  assert.ok(relaxed > 50, `only ${relaxed} relaxed answers in the probe, which is not enough to prove anything`);
  // 420 relaxed answers in this probe and 19 of them over a list with rows,
  // which is the whole of what there is to check: the other 401 print the
  // empty screen, which says the same thing in its own words.
  assert.ok(withRows > 0, 'the probe never once put a relaxed answer over a list with rows in it');
});

test('a Saturday on the real index is honest about what it does not know', () => {
  // 7 of 12,168 committed intervals fall on a Saturday, so the class schedule
  // says almost nothing and the building hours are carrying the whole answer.
  const term = readData('current.json').term;
  const index = readData(`rooms-${term}.json`);
  const buildings = readData(`buildings-${term}.json`).buildings;
  const hours = readData('buildings-hours.json').terms['autumn-2026-classroom-pool-building-schedule'];
  const rooms = Object.entries(index.rooms).map(([id, r]) => ({ id, ...r }));

  const out = query(rooms, {
    origin: ORIGIN,
    now: at(11),
    day: 6,
    date: '2026-09-19',
    needed: 60,
    buildings,
    hoursFor: (code, day) => hours.buildings[code]?.hours[day],
    sessions: index.sessions,
  });
  assert.ok(out.rows.length > 0);
  for (const row of out.rows) {
    if (!row.hoursKnown) assert.equal(row.usable, null, `${row.id} claimed a window nobody published`);
  }
  assert.ok(out.known + out.unknown === out.rows.length);
});

test('the engine marks the answer it produced, so a cold launch can be measured', () => {
  // The three things a cold launch spends time on are the fetch, the parse and
  // the first answer. The engine owns the last one and the session mask, and
  // exports mark and measure so the loader can name the other two the same way.
  performance.clearMeasures();
  const spec = campus([['A', 300, 3]]);
  query(spec.rooms, {
    origin: ORIGIN, now: at(12), day: TUE, needed: 60, buildings: spec.buildings,
    hoursFor: OPEN_ALL_DAY, sessions: [['2026-08-25', '2026-12-09']], date: '2026-09-15',
  });
  const named = performance.getEntriesByType('measure').map((m) => m.name);
  assert.ok(named.includes('vacant:query'), named.join(','));
  assert.ok(named.includes('vacant:answer'));
  assert.ok(named.includes('vacant:index'));

  performance.clearMeasures();
  rank(spec.rooms, {
    origin: ORIGIN, now: at(12), day: TUE, needed: 60, buildings: spec.buildings,
    hoursFor: OPEN_ALL_DAY,
  });
  assert.ok(performance.getEntriesByType('measure').map((m) => m.name).includes('vacant:answer'));
});

test('the payload reports how long it took, without a Date to do it', () => {
  const spec = campus([['A', 300, 3]]);
  const out = askFor(60, spec);
  assert.equal(typeof out.ms, 'number');
  assert.ok(out.ms >= 0);
});

test('a clock reading outside a wall-clock day is refused, not computed from', () => {
  // 1500 is what an epoch subtraction gives on the Sunday Ohio falls back, and
  // it is an hour wrong for the rest of that day. Every busy interval in the
  // index is wall clock, so there is nothing honest to do with it.
  const spec = campus([['A', 300, 3]]);
  for (const now of [1500, -1, NaN, undefined]) {
    const out = query(spec.rooms, {
      origin: ORIGIN, now, day: TUE, needed: 60, buildings: spec.buildings, hoursFor: OPEN_ALL_DAY,
    });
    assert.equal(out.refused, 'clock', String(now));
    assert.deepEqual(out.rows, []);
  }
  assert.equal(askFor(60, spec).refused, null, 'a real clock is fine');
});

test('not knowing where you are is a different answer from nothing being free', () => {
  const spec = campus([['A', 300, 3]]);
  const lost = query(spec.rooms, {
    origin: { lat: NaN, lon: NaN }, now: at(12), day: TUE, needed: 60,
    buildings: spec.buildings, hoursFor: OPEN_ALL_DAY,
  });
  assert.equal(lost.refused, 'location');
  assert.match(lost.reason, /where you are/);
  assert.deepEqual(lost.rows, []);

  // The same, on an index that also holds a room nothing offers. This is the
  // case the fixture above CANNOT reach: campus() types every room 1B, so a
  // filter that skipped unofferable rooms before the origin was tested left
  // this test green while the refusal was gone. query() reads
  // `dropped.badOrigin === rooms.length`, and a room dropped earlier never
  // reaches that count, so on the committed index -- which carries 27 computer
  // labs -- the refusal changed from "Vacant does not know where you are" to
  // "Nothing on campus is free for long enough today". A student whose fix had
  // simply not resolved was told to go home.
  const withLab = campus([['A', 300, 3]]);
  withLab.rooms.push({ ...withLab.rooms[0], id: 'A9999', type: '2P' });
  const stillLost = query(withLab.rooms, {
    origin: { lat: NaN, lon: NaN }, now: at(12), day: TUE, needed: 60,
    buildings: withLab.buildings, hoursFor: OPEN_ALL_DAY,
  });
  assert.equal(stillLost.refused, 'location', 'an unofferable room hid the geolocation refusal');
  assert.match(stillLost.reason, /where you are/);

  // A campus that is genuinely booked solid says something else entirely.
  const busy = campus([['A', 300, 3, { busy: [[TUE, DAY_START, DAY_END]] }]]);
  const nothing = askFor(60, busy);
  assert.equal(nothing.refused, null);
  assert.notEqual(nothing.reason, lost.reason);
});

// --- the week the schedule stops describing ---

test('the committed index refuses the finals week it cannot see', () => {
  // The worst answer this app can give, and it was live: a meeting's endDate is
  // the last day of INSTRUCTION, so on December 10 the session mask empties the
  // busy grid and a schedule-only engine reports all 871 rooms free for a week,
  // while finals are running in them.
  const term = readData('current.json').term;
  const index = readData(`rooms-${term}.json`);
  const buildings = readData(`buildings-${term}.json`).buildings;
  const hours = readData('buildings-hours.json').terms['autumn-2026-classroom-pool-building-schedule'];
  const rooms = Object.entries(index.rooms).map(([id, r]) => ({ id, ...r }));
  const opts = {
    origin: ORIGIN, now: at(14), day: 4, needed: 60, buildings,
    hoursFor: (code, day) => hours.buildings[code]?.hours[day],
    sessions: index.sessions,
  };

  const finals = query(rooms, { ...opts, date: '2026-12-10' });
  assert.equal(finals.refused, 'no-schedule');
  assert.deepEqual(finals.rows, []);
  assert.match(finals.reason, /finals week/i);

  // And an ordinary Thursday in the middle of term still answers.
  const teaching = query(rooms, { ...opts, date: '2026-09-17' });
  assert.equal(teaching.refused, null);
  assert.ok(teaching.rows.length > 0);
});

test('the two clusters the silence threshold sits between are three orders apart', () => {
  // The measurement the constant is set from. Every date classes meet, against
  // every date they do not, over the committed index.
  const term = readData('current.json').term;
  const index = readData(`rooms-${term}.json`);
  const rooms = Object.values(index.rooms);

  const share = (date) => scheduleCoverage(rooms, activeMask(index.sessions, date)).share;
  const teaching = ['2026-08-25', '2026-09-17', '2026-10-14', '2026-11-11', '2026-12-09'].map(share);
  const silent = ['2026-08-01', '2026-08-24', '2026-12-10', '2026-12-11', '2026-12-15'].map(share);

  assert.ok(Math.min(...teaching) > 0.94, `lowest teaching day was ${Math.min(...teaching)}`);
  assert.ok(Math.max(...silent) < 0.02, `highest silent day was ${Math.max(...silent)}`);
  assert.ok(SILENT_SHARE > Math.max(...silent) && SILENT_SHARE < Math.min(...teaching));
});

test('a small healthy index is not mistaken for a silent one', () => {
  // Share is null, not zero, when there is nothing to measure. An index with no
  // busy blocks at all, or a caller that passed no session mask, is missing
  // evidence rather than carrying evidence of an empty campus.
  const spec = campus([['A', 300, 3]]);
  assert.equal(scheduleCoverage(spec.rooms, undefined).share, null);
  assert.equal(scheduleCoverage(spec.rooms, new Uint8Array([1])).share, null);
  assert.equal(askFor(60, spec, { sessions: [['2026-08-25', '2026-12-09']], date: '2026-12-15' }).refused, null);

  // One room, one class, one dead session is still a real answer.
  const one = campus([['A', 300, 1, { busy: [[TUE, at(9), at(10), 0]] }]]);
  const out = askFor(60, one, { sessions: [['2026-08-25', '2026-09-30']], date: '2026-09-15' });
  assert.equal(out.refused, null);
  assert.equal(out.rows.length, 1);
});

test('a no-class day is answered, not refused, even when the mask is empty', () => {
  // Autumn Break is the best day of the term: no classes and the doors open.
  // The registrar saying so outranks the grid, so the silence check stands down.
  const spec = campus([['A', 300, 3, { busy: [[TUE, at(9), at(10), 0]] }]]);
  const extra = { sessions: [['2026-08-25', '2026-10-12']], date: '2026-10-15' };
  assert.equal(askFor(60, spec, extra).refused, 'no-schedule');
  const holiday = askFor(60, spec, { ...extra, calendar: { noClasses: true } });
  assert.equal(holiday.refused, null);
  assert.equal(holiday.rows.length, 3);
});

test('refusalFor is the same verdict the ladder uses, so a caller outside it agrees', () => {
  // js/app.js ranks without the ladder, so the refusal has to be reachable on
  // its own. A screen that asks this and a query that runs it must never
  // disagree about whether today can be answered.
  const spec = campus([['A', 300, 3, { busy: [[TUE, at(9), at(10), 0]] }]]);
  const args = { now: at(12), rooms: spec.rooms, sessions: [['2026-08-25', '2026-10-12']], date: '2026-12-15' };
  assert.equal(refusalFor(args).refused, 'no-schedule');
  assert.equal(askFor(60, spec, { sessions: args.sessions, date: args.date }).refused, 'no-schedule');

  assert.equal(refusalFor({ ...args, now: 1500 }).refused, 'clock');
  assert.equal(refusalFor({ ...args, calendar: { exams: true } }).refused, 'exams');
  assert.equal(refusalFor({ ...args, calendar: { buildingsClosed: true } }).refused, 'closed');
  assert.equal(refusalFor({ ...args, date: '2026-09-15' }), null);

  // The exam window is named ahead of the silence it causes, because "finals
  // are running" is a fact and "the schedule stopped" is only the symptom.
  assert.equal(refusalFor({ ...args, calendar: { exams: true } }).refused, 'exams');
});

test('rank refuses nothing on its own, which is why the caller has to ask', () => {
  // Kept deliberately: rank is the ordering primitive and returns rows. The
  // guard against shipping it raw is this test plus the one in the app.
  const spec = campus([['A', 300, 3, { busy: [[TUE, at(9), at(10), 0]] }]]);
  const rows = rank(spec.rooms, {
    origin: ORIGIN, now: at(12), day: TUE, needed: 60, buildings: spec.buildings,
    hoursFor: OPEN_ALL_DAY, sessions: [['2026-08-25', '2026-10-12']], date: '2026-12-15',
  });
  assert.equal(rows.length, 3);
  assert.equal(refusalFor({ now: at(12), rooms: spec.rooms, sessions: [['2026-08-25', '2026-10-12']], date: '2026-12-15' }).refused, 'no-schedule');
});

test('the calendar reads whatever shape the build put in the index', () => {
  // The pipeline emits [{date, state}] and {start, end}. The screens lane reads
  // a date-keyed object. Both have to work, because the refusal failing open is
  // the one outcome that puts a wrong answer on the screen.
  const asArray = {
    closed: [{ date: '2026-09-07', state: 'offices-closed', name: 'Labor Day' }, { date: '2026-10-15', state: 'no-classes' }],
    exams: { start: '2026-12-11', end: '2026-12-17' },
  };
  const asMap = {
    closed: { '2026-09-07': { state: 'offices-closed', name: 'Labor Day' }, '2026-10-15': 'no-classes' },
    exams: ['2026-12-11', '2026-12-17'],
  };

  for (const src of [asArray, asMap]) {
    assert.deepEqual(calendarOn('2026-12-15', src), { exams: true });
    assert.deepEqual(calendarOn('2026-09-07', src), { buildingsClosed: true, name: 'Labor Day' });
    assert.equal(calendarOn('2026-10-15', src).noClasses, true);
    assert.equal(calendarOn('2026-09-16', src), null, 'an ordinary day is an ordinary day');
    assert.equal(calendarOn('2026-12-10', src), null, 'the day before finals is not finals');
  }

  // A date with no state survives as the cautious half, and current.json is
  // read when the index carries nothing.
  assert.deepEqual(calendarOn('2026-11-11', { closed: ['2026-11-11'] }), { buildingsClosed: true, name: null });
  assert.deepEqual(calendarOn('2026-12-15', {}, { exams: { start: '2026-12-11', end: '2026-12-17' } }), { exams: true });
  assert.equal(calendarOn('2026-12-15', {}, {}), null);
});

test('a closed campus says which holiday it is when the build knows', () => {
  const named = refusalFor({ now: 600, calendar: calendarOn('2026-11-11', { closed: [{ date: '2026-11-11', state: 'offices-closed', name: 'Veterans Day' }] }) });
  assert.equal(named.refused, 'closed');
  assert.match(named.reason, /^Veterans Day\. /);
  assert.match(named.reason, /cannot get into/);
});

test('the day bounds still cover the committed index, including the late rooms', () => {
  // DAY_END is a clamp on what the engine will offer, not a reading of the
  // index, so it has to sit at or above the latest class the index still
  // carries. It used to sit exactly on it: before the room safety filter the
  // latest end was 23:00 in two Theatre, Film and Media Arts rooms. Both are
  // facilityType PERF, rehearsal studios rather than classrooms, so the filter
  // hides them and the latest end a student can be sent to is now 21:55.
  //
  // The clamp did not move with it. Dropping DAY_END to 21:55 would clip a real
  // class the moment one of those buildings opens a late section again, and the
  // cost of a clamp that is too generous is nothing: it only ever bounds a
  // window the schedule already closed.
  const term = readData('current.json').term;
  const index = readData(`rooms-${term}.json`);
  const blocks = Object.entries(index.rooms).flatMap(([id, r]) => (r.busy ?? []).map((b) => [id, ...b]));

  const latest = Math.max(...blocks.map((b) => b[3]));
  assert.ok(latest <= DAY_END, `the clamp has to cover the index: ${latest} > ${DAY_END}`);
  assert.equal(latest, 1315, 'the latest class end, 21:55');
  assert.equal(Math.min(...blocks.map((b) => b[2])), 345, 'the earliest class start, 05:45');

  // A 21:00 bound would clip these, which is why the clamp is not tightened to
  // the observed maximum. Eight rooms still run an evening section after the
  // published-hours rule took the index to 425 rooms, so this is ordinary
  // scheduling rather than one outlier.
  const late = blocks.filter((b) => b[3] > 1260);
  assert.equal(late.length, 10, 'intervals a 21:00 bound would have clipped');
  assert.equal(new Set(late.map((b) => b[0])).size, 8, 'rooms running past 21:00');
});

// ---- the walk bound and the fold

// shape() reads three fields off a row, the walk, the building and the wait, so
// a fixture carries those and an id to tell one from another.
const shaped = (building, walk, n = 0, wait = 0) => ({
  id: `${building}${n}`,
  building,
  name: building,
  walk,
  wait,
  usable: 100 - n,
});

// Twelve buildings, three rooms each, all inside the bound, in the order
// compareRows would have left them: a building's rooms are consecutive because
// walk is cached per building and the scores tie.
//
// The walk runs DOWN as the ranking runs down, deliberately. With it running up
// the two orders were the same list and the test below could not tell a shaped
// list from a list sorted by walk, which is the one sort its own comment names.
const twelve = () =>
  Array.from({ length: 12 }, (_, b) =>
    Array.from({ length: 3 }, (_, n) => shaped(`B${String(b).padStart(2, '0')}`, 12 - b, n)),
  ).flat();

// One walk, many rooms per building, which is the shape the fold is for.
const spread = (buildings, each = 6) =>
  Array.from({ length: buildings }, (_, b) =>
    Array.from({ length: each }, (_, n) => shaped(`B${b}`, 3, n)),
  ).flat();

test('shape never reorders the ranking and never moves row one', () => {
  const rows = twelve();
  const out = shape(rows);

  assert.equal(out.rows[0], rows[0], 'row one is the row rank() put first');
  // Every shown row is the same object the ranking handed over, in the same
  // order. A cap that sorted, even stably, would let a screen disagree with the
  // engine about which room is best.
  let last = -1;
  for (const row of out.rows) {
    const i = rows.indexOf(row);
    assert.ok(i > last, `${row.id} came back out of order`);
    last = i;
  }
  // And the fixture has to be able to catch that: ranking order and walk order
  // disagree, so a walk sort cannot pass the loop above by accident.
  const walks = out.rows.map((r) => r.walk);
  assert.deepEqual(walks, [...walks].sort((a, b) => b - a), 'the fixture walks run down the ranking');
  assert.notDeepEqual(walks, [...walks].sort((a, b) => a - b));
});

test('shape drops exactly the rows past the walk bound, and names the nearest one it dropped', () => {
  // One room per building so the fold cannot also be doing the cutting.
  const rows = Array.from({ length: 20 }, (_, i) => shaped(`B${i}`, i + 1));
  const out = shape(rows, { maxWalk: 12 });

  assert.deepEqual(out.rows.map((r) => r.walk), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(out.beyond.count, 8);
  assert.equal(out.beyond.buildings, 8);
  // The dropped rows are in ranking order, not walk order, so the nearest one
  // has to be found. The empty screen prints this number.
  assert.equal(out.beyond.nearest.walk, 13);

  // Nothing beyond the bound reaches the screen, which is the whole of #60.
  for (const row of out.rows) assert.ok(row.walk <= 12, `${row.id} is a ${row.walk} minute walk`);
  assert.equal(shape([], { maxWalk: 12 }).beyond.nearest, null);
  assert.equal(shape([], { maxWalk: 12 }).beyond.waiting.nearest, null);
});

test('past the bound, the rooms that are free and the rooms that open later are counted apart', () => {
  // The empty screen is the one place a count gets the word "free" spent on it,
  // so a room that does not open for another hour and a half cannot be in it.
  // Measured in the real app at 2026-09-15 09:00 from 40.0175, -83.013: the
  // nearest room past the bound was Schoenbaum Hall, a 25 minute walk, and it
  // did not open until 10:55am. The screen called it the nearest free one.
  const rows = [
    shaped('FREE-FAR', 30, 0),
    shaped('WAIT-NEAR', 20, 0, 90),
    shaped('WAIT-NEARER', 15, 0, 45),
    shaped('FREE-FARTHER', 40, 0),
  ];
  const out = shape(rows, { maxWalk: 12 });
  assert.equal(out.rows.length, 0);
  assert.equal(out.beyond.count, 2, 'only the rooms that are free right now');
  assert.equal(out.beyond.nearest.id, 'FREE-FAR0', 'the nearest room that is actually free');
  assert.equal(out.beyond.waiting.count, 2);
  assert.equal(out.beyond.waiting.nearest.id, 'WAIT-NEARER0');
  // The room the old screen named is nearer than the one it names now, which is
  // the whole point: nearer is not free.
  assert.ok(out.beyond.waiting.nearest.walk < out.beyond.nearest.walk);
});

test('every row shape removes is counted exactly once', () => {
  // rows + the ones held back inside the bound + the ones past it, free and
  // waiting. Without this the footer can double count, which is how "N more
  // further away" came to describe rooms at an identical walk in a building
  // already on screen.
  for (const [rows, opts] of [
    [twelve(), {}],
    [twelve(), { perBuilding: 2 }],
    [twelve(), { limit: 5 }],
    [twelve().map((r, i) => ({ ...r, walk: i })), {}],
    [spread(4, 15), {}],
    [Array.from({ length: 60 }, (_, i) => shaped(`B${i % 4}`, 3, i, i % 3 === 0 ? 0 : 45)), {}],
    [Array.from({ length: 60 }, (_, i) => shaped(`B${i % 4}`, 30, i, i % 3 === 0 ? 0 : 45)), {}],
    [[], {}],
  ]) {
    const out = shape(rows, opts);
    const counted = out.rows.length + out.cap.rest + out.beyond.count + out.beyond.waiting.count;
    assert.equal(counted, rows.length, `${rows.length} rows in, ${counted} out`);
    assert.equal(out.cap.buildings, new Set(rows.filter((r) => r.walk <= MAX_WALK).map((r) => r.building)).size);
  }
});

test('the fold is chosen by the list it makes, so a thinner campus never grows the screen', () => {
  // The truth table. One room per building fills the screen while there are
  // buildings to fill it with; below that the list is topped up to SCREEN_ROWS
  // and stops there. A number read off the building count did the opposite: at
  // ten buildings it showed 10 rows and at nine it showed 18.
  let last = Infinity;
  for (const buildings of [40, 20, 12, 11, 10, 9, 8, 5, 4, 3, 2, 1]) {
    const out = shape(spread(buildings, 20));
    assert.ok(out.rows.length <= last, `${buildings} buildings showed more rows than ${last}`);
    last = out.rows.length;
    const per = new Map();
    for (const row of out.rows) per.set(row.building, (per.get(row.building) ?? 0) + 1);
    for (const [b, n] of per) assert.ok(n <= out.cap.perBuilding, `${b} took ${n} rows past ${out.cap.perBuilding}`);
  }
  // The two the old thresholds fell between, which is where the step was.
  assert.equal(shape(spread(10, 20)).rows.length, 10);
  assert.equal(shape(spread(9, 20)).rows.length, 10);
  assert.equal(shape(spread(5, 20)).rows.length, 10);
  assert.equal(shape(spread(4, 20)).rows.length, 10);
  assert.equal(shape(spread(1, 60)).rows.length, SCREEN_ROWS);

  // Pass one is every building's best row and it is never trimmed to
  // SCREEN_ROWS: a campus with forty buildings open still fills the screen.
  assert.equal(shape(spread(40, 20)).rows.length, 40);
  assert.equal(shape(spread(20, 6)).rows.length, 20);

  // The limit binds in both directions: at one room each, and at no fold at all.
  assert.equal(shape(spread(60, 1)).rows.length, 40);
  assert.equal(shape(spread(45, 2)).rows.length, 40);
  assert.equal(shape(spread(1, 60), { perBuilding: Infinity }).rows.length, 40);
  assert.equal(shape(spread(20, 6), { perBuilding: 3 }).rows.length, 40);

  // A caller that names a fold gets that fold, and no top-up.
  assert.equal(shape(spread(20), { perBuilding: 3 }).cap.perBuilding, 3);
  assert.equal(shape(spread(4), { perBuilding: 1 }).rows.length, 4);
  assert.equal(shape(spread(4, 20), { perBuilding: 1 }).rows.length, 4);
});

test('shape holds the committed index to a walk you would actually make', () => {
  const term = readData('current.json').term;
  const index = readData(`rooms-${term}.json`);
  const buildings = readData(`buildings-${term}.json`).buildings;
  const hours = readData('buildings-hours.json').terms['autumn-2026-classroom-pool-building-schedule'];
  const rooms = Object.entries(index.rooms).map(([id, r]) => ({ id, ...r }));
  const opts = {
    day: 3,
    date: '2026-09-02',
    needed: 30,
    buildings,
    hoursFor: (code, day) => hours.buildings[code]?.hours[day],
    sessions: index.sessions,
  };

  // From the Oval the bound changes nothing about the answer, only about how
  // much of one building the screen spends. At this minute 3 distinct buildings
  // in the top ten become 10, and over the 525 samples named in js/app.js the
  // share of the old 40 that repeated a building was 69.5%.
  const oval = rank(rooms, { ...opts, origin: ORIGIN, now: at(14, 10) });
  const near = shape(oval.filter((r) => r.wait <= 90));
  assert.equal(near.rows[0].id, oval.filter((r) => r.wait <= 90)[0].id, 'the best room is still the best room');
  assert.equal(new Set(near.rows.slice(0, 10).map((r) => r.building)).size, 10);
  assert.ok(near.rows.every((r) => r.walk <= MAX_WALK));

  // Issue #60, the screenshot. Downtown at 14:10 rank() hands back a 70 minute
  // walk on row one, and the bound is what stops it. The room named on that row
  // is Jennings Hall 50 since the seat tiebreak flipped to fit-first; see the
  // note below the assertions, which is where the two rooms are pulled apart.
  //
  // 71 until 2026-09-15, when the walk stopped ending at the building's
  // centroid and started ending at its nearest published door. From four and a
  // half kilometres away the door that faces downtown is about a minute nearer
  // than the middle of the building, which is the whole of the change here.
  const downtown = rank(rooms, { ...opts, origin: { lat: 39.9612, lon: -82.9988 }, now: at(14, 10) });
  const usable = downtown.filter((r) => r.wait <= 90);
  assert.equal(usable[0].walk, 70, 'the unbounded ranking still leads with a 70 minute walk');
  const far = shape(usable);
  assert.equal(far.rows.length, 0);
  // The weekly room counts move. What matters is that the fold accounts for
  // every eligible room without showing one beyond the walking limit.
  assert.equal(far.beyond.count + far.beyond.waiting.count, usable.length,
    'every usable row is past the bound');
  assert.equal(far.beyond.count, usable.filter((r) => r.wait === 0).length,
    'only rooms free right now are named free');
  assert.equal(far.beyond.nearest.walk, 70);
  // The screenshot named Pomerene Hall, and until 2026-09-15 this was a note
  // about a tiebreak: 8 rooms tied at exactly 71 minutes across Pomerene Hall
  // and Jennings Hall, `nearest` kept whichever the ranking handed it first,
  // and the seat tiebreak picked Jennings Hall 50 at 35 seats over Pomerene
  // Hall 150 at 62.
  //
  // The tie is gone. Measuring to the nearest door instead of the centroid
  // moved Jennings to 70 minutes and left Pomerene at 71, so 4 Jennings rooms
  // now stand alone on row one and distance decides what a seat count used to.
  // That is the endpoint correction doing exactly what it is for, on the one
  // origin in this suite far enough away to show it.
  assert.match(far.beyond.nearest.name, /Jennings/);
  assert.equal(usable.filter((r) => r.walk === 70).length, 4, 'only Jennings sits at 70');
  assert.ok(usable.every((r) => r.walk !== 70 || /Jennings/.test(r.name)));
  assert.ok(usable.some((r) => r.walk === 71 && /Pomerene/.test(r.name)));
  // The count the screen prints is only rooms that are free, on the real index
  // and not just on a fixture.
  for (const r of usable) {
    if (r.wait === 0) continue;
    assert.notEqual(r.id, far.beyond.nearest.id, 'the named room is not free');
  }
  assert.equal(far.beyond.waiting.count, usable.filter((r) => r.wait > 0).length);
});

test('a rest-of-day ask is named, not priced, in the strip too', () => {
  // neededMinutes() renders "rest of day" as Math.max(30, latestEnd - now), so
  // dur() prints a figure nobody chose: 12h15 in the morning, and a flat
  // "30 min" in the last half hour of the index's day, which is the other
  // button's answer exactly. The list states the ask in words directly above
  // this strip, and two renderings of one ask on adjacent lines is the thing
  // that line exists to stop.
  const day = rungPhrase('any-type', { needed: 735, restOfDay: true });
  assert.match(day.text, /free for the rest of the day/);
  assert.match(day.say, /free for the rest of the day/);
  assert.doesNotMatch(day.text, /12h15|735/, 'the strip priced an ask the app only derived');
  // Clamped to the floor, where dur() and the 30 min button agree and the
  // reader cannot tell which one they pressed.
  assert.doesNotMatch(rungPhrase('any-type', { needed: 30, restOfDay: true }).text, /30 min/);
  // The three fixed lengths still print as lengths.
  assert.match(rungPhrase('any-type', { needed: 60 }).text, /free for 1h00/);
  assert.match(rungPhrase('any-type', { needed: 60 }).say, /free for 1 hour/);
});

test('a computer lab is never offered, on any rung', () => {
  // 26 of the 27 shipped labs are absent from the Registrar's general-assignment
  // list -- 96%, against 13% for ordinary classrooms -- so a lab is the room
  // most likely to be a locked door at the end of a walk. They left OFFERABLE
  // rather than being ranked low, because ranking low still shows them.
  assert.equal(SECONDARY_TYPES.includes('2P'), false, 'the computer labs are offerable again');
  assert.equal(SECONDARY_TYPES.includes('2Q'), false, 'the computer labs are offerable again');
  // A campus made of nothing but labs answers with nothing, rather than with
  // labs. The ladder runs out instead of reaching for them.
  const only = askFor(60, campus([['B', 300, 6, { type: '2P' }]]));
  assert.equal(only.rows.length, 0, 'the ladder still reaches a computer lab');
  // And a lab beside real classrooms does not appear once the rung relaxes.
  const mixed = askFor(60, campus([
    ['A', 300, 1],
    ['B', 300, 4, { type: '2Q' }],
  ]));
  assert.equal(mixed.rows.every((r) => !/^B/.test(r.id)), true, 'a lab came back on a relaxed rung');
});
