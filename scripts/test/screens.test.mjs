// Offline. Fixtures plus the committed data, no network and no DOM.
//
// These cover the screens' decisions, not their markup: which state the app is
// in, what a row is allowed to say, and what the diagnostics block gives a
// maintainer. The one thing they exist for above all is the exam-week refusal,
// which cannot be reached by opening the app in August.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  MINUTES_IN_DAY,
  allWeekCodes,
  busyDayOf,
  clock,
  closedDayFor,
  diagnosticsBlock,
  inScheduledHours,
  inTermOn,
  indexFloorCheck,
  isoDate,
  nextOpening,
  openDoorCount,
  openingPhrase,
  rankBuildings,
  resolveState,
  roomSearchOn,
  roomsPerBuilding,
  scheduleDarkOn,
  scheduleShareOn,
  staleness,
  unscheduledGate,
  windowPhrase,
} from '../../js/state.js';
import { roomClaim } from '../../js/claim.js';
import { filterRoomsByPreferences } from '../../js/preferences.js';
import { blocksOn, classesOn, dayClaim } from '../../js/day.js';
import {
  BACK_PX,
  COVER,
  DISMISS_PX,
  FULL as FULL_SHEET,
  PEEK,
  REST,
  bandFor,
  capFor,
  floorFor,
  lowPxFor,
  openAt,
  restFor,
  restPxFor,
  sheetAfterDrag,
} from '../../js/sheet.js';
import { DETOUR, MAX_WALK, PACKUP, WALK_MPM, activeSessions, calendarOn, distanceMetres, rank, refusalFor, usableMinutes, walkMinutes } from '../../js/engine.js';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));

const CURRENT = read('data/current.json');
const INDEX = read('data/rooms-1268.json');
const SLICE = read('data/buildings-1268.json').buildings;
const FULL = read('data/buildings.json').buildings;
const HOURS = read('data/buildings-hours.json');

// Local midnight, because every state decision is made against a wall clock the
// student is standing in, not against UTC.
const at = (iso, h = 12, m = 0) => {
  const [y, mo, d] = iso.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m);
};

// The calendar the term index is meant to carry once the harvest emits it. The
// dates are the real Autumn 2026 ones from the issue.
const CAL = {
  ...INDEX,
  exams: { start: '2026-12-11', end: '2026-12-17' },
  closed: {
    '2026-09-07': { state: 'offices-closed', name: 'Labor Day' },
    '2026-10-15': { state: 'no-classes', name: 'Autumn break' },
    '2026-10-16': { state: 'no-classes', name: 'Autumn break' },
  },
  lowConfidence: [{ start: '2026-10-13', end: '2026-10-16', why: 'session 1 finals' }],
  sessions: INDEX.sessions.map((s) => (s[1] === '2026-12-11' ? ['2026-08-10', '2026-12-09'] : s)),
};
const CUR = { ...CURRENT, instruction: ['2026-08-10', '2026-12-09'] };

// ------------------------------------------------------------------ #19 state

test('exam week refuses, and names the day it can answer again', () => {
  const s = resolveState({ now: at('2026-12-15'), current: CUR, index: CAL });
  assert.equal(s.kind, 'EXAM_REFUSAL');
  assert.equal(s.ranked, false);
  assert.match(s.body, /Dec 18/);
});

test('the exam check runs before the between-terms check', () => {
  // Finals sits outside every session range, so the naive order sends Dec 11 to
  // 17 to "campus is empty", which reads as every room being free.
  const withNext = { ...CUR, next: { termName: 'Spring 2027', instruction: ['2027-01-11', '2027-04-24'] } };
  for (const day of ['2026-12-11', '2026-12-13', '2026-12-17']) {
    assert.equal(resolveState({ now: at(day), current: withNext, index: CAL }).kind, 'EXAM_REFUSAL');
  }
});

test('a closed campus is one message and no ranked rows', () => {
  const s = resolveState({ now: at('2026-09-07'), current: CUR, index: CAL });
  assert.equal(s.kind, 'CAMPUS_CLOSED');
  assert.equal(s.ranked, false);
  assert.match(s.heading, /Labor Day/);
});

test('a no-classes day still ranks, and says why campus is quiet', () => {
  const s = resolveState({ now: at('2026-10-15'), current: CUR, index: CAL });
  assert.equal(s.kind, 'RANKED');
  assert.equal(s.ranked, true);
  assert.match(s.note, /quiet/);
  // Oct 15 sits in both tables. One message, not two stacked banners.
  assert.doesNotMatch(s.note, /Session 1/);
});

test('the low-confidence window names both failure modes', () => {
  for (const day of ['2026-10-13', '2026-10-14']) {
    const s = resolveState({ now: at(day), current: CUR, index: CAL });
    assert.equal(s.ranked, true);
    assert.match(s.note, /finals/i);
    assert.match(s.note, /full term/i);
  }
});

test('between terms names the last class, the next start and the gap', () => {
  const withNext = { ...CUR, next: { termName: 'Spring 2027', instruction: ['2027-01-11', '2027-04-24'] } };
  const s = resolveState({ now: at('2026-12-20'), current: withNext, index: CAL });
  assert.equal(s.kind, 'BETWEEN_TERMS');
  assert.equal(s.ranked, false);
  assert.match(s.body, /Dec 9/);
  assert.match(s.body, /Jan 11/);
  assert.match(s.body, /22 days/);
  assert.ok(s.action, 'between terms offers the nearest buildings');
});

test('with no next term it is TERM_ENDED, and it prints when it last checked', () => {
  const s = resolveState({ now: at('2026-12-20'), current: CUR, index: CAL });
  assert.equal(s.kind, 'TERM_ENDED');
  assert.equal(s.ranked, false);
  assert.match(s.detail, new RegExp(CUR.generated));
  // Between-terms is not staleness and must not borrow its words.
  const between = resolveState({
    now: at('2026-12-20'),
    current: { ...CUR, next: { instruction: ['2027-01-11', '2027-04-24'] } },
    index: CAL,
  });
  const shared = s.body.split('. ').filter((line) => between.body.includes(line));
  assert.deepEqual(shared, []);
});

test('an index under its term-digit floor refuses and prints observed against expected', () => {
  const rooms = Object.fromEntries(Object.entries(INDEX.rooms).slice(0, 198));
  const s = resolveState({ now: at('2026-09-04'), current: CUR, index: { ...CAL, rooms } });
  assert.equal(s.kind, 'INDEX_REFUSED');
  assert.equal(s.ranked, false);
  assert.equal(s.detail, 'rooms 198 < 400');
});

test('the floor is per term digit, so a Summer index is not held to a full term', () => {
  // Measured on the shipped builds: 871 rooms for 1268, 884 for 1262, 206 for
  // the much smaller Summer 1264.
  const rooms = Object.fromEntries(Object.entries(INDEX.rooms).slice(0, 206));
  assert.equal(indexFloorCheck({ term: '1264', rooms }).ok, true);
  assert.equal(indexFloorCheck({ term: '1262', rooms }).ok, false);
});

test('staleness climbs at 14 and 35 days, and past the term it gates', () => {
  const gen = (days) => {
    const d = new Date(2026, 8, 4);
    d.setDate(d.getDate() - days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T07:00:00Z`;
  };
  const level = (days) =>
    staleness({ now: at('2026-09-04'), current: { ...CUR, generated: gen(days) } }).level;
  assert.equal(level(13), 'silent');
  assert.equal(level(14), 'line');
  assert.equal(level(34), 'line');
  assert.equal(level(35), 'banner');
  assert.equal(staleness({ now: at('2026-12-20'), current: CUR }).level, 'gated');
});

test('resolveState is pure: the same inputs twice give the same answer', () => {
  const args = { now: at('2026-12-15'), current: CUR, index: CAL };
  assert.deepEqual(resolveState(args), resolveState(args));
});

// ------------------------------------------------------------ #20 unscheduled

test('the scheduled window is measured off the index when the build omits it', () => {
  // Re-measured on the shipped index after the published-hours rule cut it to
  // 425 rooms and 8,329 blocks. The weekday shares are Sun 0.00%, Mon 16.70%,
  // Tue 23.59%, Wed 21.34%, Thu 23.70%, Fri 14.61%, Sat 0.07%, so nothing sits
  // near the 1% line either side of it. latestEnd has moved twice now, 1230 to
  // 1225 to 1215, each time because rooms left and took part of the evening
  // tail with them. It is a quantile over the shipped file, not a constant.
  const busyDay = busyDayOf({}, INDEX);
  assert.deepEqual(busyDay.weekdays, [false, true, true, true, true, true, false]);
  assert.equal(busyDay.earliestStart, 480);
  assert.equal(busyDay.latestEnd, 1215);
});

test('current.json wins over the measurement when it carries busyDay', () => {
  const given = { earliestStart: 500, latestEnd: 1000, weekdays: [false, true, true, true, true, true, false] };
  assert.deepEqual(busyDayOf({ busyDay: given }, INDEX), given);
});

test('the unscheduled trigger flips when latestEnd moves', () => {
  const thu = at('2026-09-03', 21, 40);
  const early = { ...CUR, busyDay: { earliestStart: 480, latestEnd: 1290, weekdays: [false, true, true, true, true, true, false] } };
  const late = { ...CUR, busyDay: { ...early.busyDay, latestEnd: 1380 } };
  assert.equal(inScheduledHours({ now: thu, current: early, index: CAL }), false);
  assert.equal(inScheduledHours({ now: thu, current: late, index: CAL }), true);
});

test('a weekend evening is never in scheduled hours', () => {
  assert.equal(inScheduledHours({ now: at('2026-09-05', 20, 0), current: CUR, index: CAL }), false);
  assert.equal(inScheduledHours({ now: at('2026-09-03', 14, 2), current: CUR, index: CAL }), true);
});

test('weekend room search opens in daytime without bypassing refusals', () => {
  for (const date of ['2026-09-19', '2026-09-20']) {
    for (const [hour, expected] of [[6, false], [7, true], [12, true], [22, true], [23, false]]) {
      const now = at(date, hour);
      const ranked = resolveState({ now, current: CUR, index: CAL }).ranked;
      assert.equal(roomSearchOn({ now, current: CUR, index: CAL, ranked }), expected, `${date} ${hour}:00`);
    }
    assert.match(resolveState({ now: at(date), current: CUR, index: CAL }).note, /Weekend search:.*building hours/);
  }
  const closed = at('2026-09-06');
  const closedIndex = { ...CAL, closed: { ...CAL.closed, '2026-09-06': { state: 'offices-closed', name: 'Campus closure' } } };
  assert.equal(resolveState({ now: closed, current: CUR, index: closedIndex }).ranked, false);
  assert.equal(roomSearchOn({ now: closed, current: CUR, index: closedIndex }), false);
  const exams = at('2026-12-12');
  assert.equal(resolveState({ now: exams, current: CUR, index: CAL }).ranked, false);
  assert.equal(roomSearchOn({ now: exams, current: CUR, index: CAL }), false);
});

test('a shut campus is not scheduled hours, but a no-classes day still is', () => {
  // Autumn break really does leave the buildings open, so the ranked list is
  // still the right answer there and the quiet-campus line says why.
  assert.equal(inScheduledHours({ now: at('2026-09-07', 12, 0), current: CUR, index: CAL }), false);
  assert.equal(inScheduledHours({ now: at('2026-10-15', 12, 0), current: CUR, index: CAL }), true);
});

test('a day whose sessions have all ended is not a scheduled day', () => {
  // The measurement, on the shipped index, that the threshold sits on. Every
  // weekday between the first and last day of instruction is either a day the
  // sessions cover or a day they have all left, and there is nothing in the
  // middle.
  //
  // Re-measured after the published-hours rule cut the index to 425 rooms. The
  // gap is now total rather than merely wide: the seven-session term collapsed
  // to three, because the four odd windows belonged to rooms in buildings the
  // Registrar publishes no hours for, so a dark day is exactly 0.000000 and the
  // thinnest teaching day is 0.9549. The 0.5% line has nothing anywhere near
  // it in either direction.
  const share = (iso, h = 12) => scheduleShareOn({ now: at(iso, h), index: INDEX });
  for (const iso of ['2026-12-10', '2026-12-11', '2026-12-14', '2026-12-15', '2026-08-17']) {
    assert.ok(share(iso) <= 0.0012, `${iso} came out ${share(iso)}`);
    assert.equal(scheduleDarkOn({ now: at(iso), index: INDEX }), true, iso);
  }
  for (const iso of ['2026-09-03', '2026-10-15', '2026-11-11', '2026-12-09']) {
    assert.ok(share(iso) >= 0.9, `${iso} came out ${share(iso)}`);
    assert.equal(scheduleDarkOn({ now: at(iso), index: INDEX }), false, iso);
  }
  // The two days either side of the gap. Mon Aug 24 is the day before
  // instruction starts and now carries no block at all; it used to carry two
  // small sessions in rooms that no longer ship. Wed Oct 14 is the thinnest
  // teaching day, in the week between the two seven-week sessions.
  assert.equal(share('2026-08-24'), 0, `Aug 24 came out ${share('2026-08-24')}`);
  assert.equal(scheduleDarkOn({ now: at('2026-08-24'), index: INDEX }), true);
  assert.ok(share('2026-10-14') > 0.95 && share('2026-10-14') < 0.96, `Oct 14 came out ${share('2026-10-14')}`);
  assert.equal(scheduleDarkOn({ now: at('2026-10-14'), index: INDEX }), false);
});

test('finals week does not rank rooms even with no exam window in the data', () => {
  // The mechanism the exam refusal needs is a calendar the harvest emits, and
  // an index that has not got one yet must not fall through to "871 rooms free"
  // with a 727 seat lecture hall at the top. It cannot name the reason, but it
  // can see its own schedule has gone dark, and refusing on that is the whole
  // point: this used to rank and lean on inScheduledHours to route the answer
  // somewhere honest, which is two verdicts about one question.
  // The shipped index does carry one now, which is what the harvest was changed
  // to emit, so the fallback is tested against a copy with it taken back out.
  assert.ok(INDEX.exams, 'the shipped index is meant to carry an exam window');
  const NO_EXAMS = { ...INDEX };
  delete NO_EXAMS.exams;
  // What must hold on the shipped data is the REFUSAL. Which refusal it is
  // moved when the published-hours rule ran: the sessions that used to stretch
  // instruction to 2026-12-11 lived in rooms that no longer ship, so the term
  // now ends on the 9th and both dates below are out of term. TERM_ENDED is the
  // more specific answer and the app is right to give it.
  for (const iso of ['2026-12-10', '2026-12-11']) {
    const s = resolveState({ now: at(iso), current: CURRENT, index: NO_EXAMS });
    assert.equal(s.ranked, false, `${iso} still ranks`);
    assert.equal(s.kind, 'TERM_ENDED');
    assert.ok(s.action, `${iso} still offers the buildings screen`);
    assert.equal(inScheduledHours({ now: at(iso), current: CURRENT, index: NO_EXAMS }), false, `${iso} is scheduled`);
  }
  // The SCHEDULE_DARK fallback itself, which no date on the shipped calendar
  // can reach any more. It is the reason this test exists, so it is exercised
  // against an index whose term is wide and whose sessions have all ended,
  // rather than deleted along with the date that used to reach it.
  const WIDE = { ...NO_EXAMS, teaching: ['2026-08-25', '2027-01-31'] };
  const dark = resolveState({ now: at('2026-12-14'), current: { ...CURRENT, instruction: ['2026-08-25', '2027-01-31'] }, index: WIDE });
  assert.equal(dark.ranked, false);
  assert.equal(dark.kind, 'SCHEDULE_DARK');
  assert.ok(dark.action);
  // Midday on a real Thursday is untouched.
  assert.equal(resolveState({ now: at('2026-09-03', 12, 15), current: CURRENT, index: NO_EXAMS }).ranked, true);
  assert.equal(inScheduledHours({ now: at('2026-09-03', 12, 15), current: CURRENT, index: INDEX }), true);
});

test('resolveState refuses exactly when refusalFor does, and never on its own', () => {
  // The invariant the merge exists to hold. Two functions that each decide
  // whether the app may answer will drift, and the day they drift is the day
  // the question screen says nobody knows while the list behind it offers 450
  // rooms. Walked over every day of the shipped term, with the calendar the
  // harvest is meant to emit.
  const rooms = Object.values(CAL.rooms);
  let refusals = 0;
  for (let d = new Date(2026, 7, 1); d <= new Date(2026, 11, 31); d.setDate(d.getDate() + 1)) {
    const now = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0);
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const engine = refusalFor({
      now: 720,
      rooms,
      sessions: CAL.sessions,
      date: today,
      calendar: calendarOn(today, CAL, CUR),
      floor: indexFloorCheck(CAL),
      inTerm: inTermOn(today, CUR, CAL),
    });
    const screen = resolveState({ now, current: CUR, index: CAL });
    assert.equal(screen.ranked, engine === null, `${today}: engine ${engine?.refused ?? 'ok'}, screen ${screen.kind}`);
    if (engine) {
      refusals += 1;
      assert.ok(screen.heading, `${today} refused with no heading`);
      assert.ok(screen.body, `${today} refused with no reason`);
    }
  }
  assert.ok(refusals > 20, `only ${refusals} of 153 days refused, which is not the shipped term`);
});

test('the closed table reads in either shape the build might write it', () => {
  // The harvest emits a list of {date, state}; a hand-written fixture is easier
  // as a keyed object. Reading only the second one is how the campus-closed
  // refusal ends up wired to nothing, with no error anywhere: indexing a date
  // into an array gives undefined and the message never fires.
  const asList = { closed: [{ date: '2026-09-07', state: 'offices-closed', name: 'Labor Day' }] };
  const asMap = { closed: { '2026-09-07': { state: 'offices-closed', name: 'Labor Day' } } };
  for (const shape of [asList, asMap]) {
    assert.deepEqual(closedDayFor('2026-09-07', null, shape), { state: 'offices-closed', name: 'Labor Day' });
    assert.equal(closedDayFor('2026-09-08', null, shape), null);
    assert.equal(resolveState({ now: at('2026-09-07'), current: CUR, index: { ...CAL, ...shape } }).kind, 'CAMPUS_CLOSED');
  }
  // And the bare-string form the issue also allows.
  assert.deepEqual(closedDayFor('2026-10-15', null, { closed: [{ date: '2026-10-15', state: 'no-classes' }] }), {
    state: 'no-classes',
    name: null,
  });
});

test('no shipped building has unknown hours, and the grouping still holds', () => {
  const counts = roomsPerBuilding(INDEX);
  const term = HOURS.terms['autumn-2026-classroom-pool-building-schedule'];
  const hoursFor = (code, day) => term.buildings[code]?.hours[day];
  const groups = rankBuildings({
    origin: { lat: 39.99944, lon: -83.01502 },
    buildings: SLICE,
    counts,
    hoursFor,
    day: 4,
    nowMin: 14 * 60,
  });
  assert.ok(groups.open.length > 0);
  // The published-hours rule made this zero and has to keep it there. A
  // building the Registrar documents no doors for does not reach the index, so
  // the buildings screen has no unknown group to render and none of the prose
  // that used to explain one. If this ever goes above zero the index and the
  // hours table have drifted apart and the screen is hiding buildings.
  assert.equal(groups.unknown.length, 0, 'a shipped building has no published hours');
  for (const row of groups.open) assert.ok(Number.isFinite(row.closesAt));
  // Every building the screen lists carries a classroom count and a walk. The
  // count is no longer rendered, and rankBuildings still has to produce it: it
  // is in the spoken name of every row.
  for (const row of [...groups.open, ...groups.closed]) {
    assert.ok(row.rooms >= 1);
    assert.ok(Number.isFinite(row.walk));
  }
  assert.equal(
    groups.open.length + groups.unknown.length + groups.closed.length,
    Object.keys(counts).filter((c) => SLICE[c]).length,
  );
});

test('with no hours table at all every building reads unknown, never open', () => {
  const counts = roomsPerBuilding(INDEX);
  const groups = rankBuildings({
    origin: { lat: 39.99944, lon: -83.01502 },
    buildings: SLICE,
    counts,
    hoursFor: () => undefined,
    day: 6,
    nowMin: 21 * 60,
  });
  assert.equal(groups.open.length, 0);
  assert.equal(groups.closed.length, 0);
  assert.equal(groups.unknown.length, Object.keys(counts).filter((c) => SLICE[c]).length);
});

test('a building published as closed today is not a building with no hours', () => {
  // 43 of the 47 buildings in the Registrar pool publish at least one day as
  // closed, so on a Saturday this is the majority of the closed group. Calling
  // a published fact unknown throws away the one thing this screen carries.
  const term = HOURS.terms['autumn-2026-classroom-pool-building-schedule'];
  const hoursFor = (code, day) => term.buildings[code]?.hours[day];
  assert.equal(hoursFor('087', 6), null, 'Townshend publishes Saturday closed');
  const groups = rankBuildings({
    origin: { lat: 39.99944, lon: -83.01502 },
    buildings: SLICE,
    counts: roomsPerBuilding(INDEX),
    hoursFor,
    day: 6,
    nowMin: 20 * 60,
  });
  const townshend = groups.closed.find((b) => b.code === '087');
  assert.equal(townshend.when, 'closed-today');
  assert.ok(groups.closed.some((b) => b.when === 'closed-today'));
  for (const row of groups.unknown) assert.equal(row.when, 'unknown');
  for (const row of groups.open) assert.equal(row.when, 'open');
});

test('a closed building says which side of its window the clock is on', () => {
  // The one shared line used to read "open till 6:00pm" at 9:40pm, three hours
  // forty after the door locked.
  const hoursFor = () => [420, 1080];
  const grouped = (nowMin) =>
    rankBuildings({
      origin: { lat: 39.99944, lon: -83.01502 },
      buildings: { 900: { name: 'Nowhere Hall', lat: 39.9995, lon: -83.013 } },
      counts: { 900: 4 },
      hoursFor,
      day: 4,
      nowMin,
    });
  assert.equal(grouped(6 * 60).closed[0].when, 'before');
  assert.equal(grouped(12 * 60).open[0].when, 'open');
  assert.equal(grouped(21 * 60 + 40).closed[0].when, 'after');
});

test('the all-week list comes out of the hours table, not out of the source', () => {
  const term = HOURS.terms['autumn-2026-classroom-pool-building-schedule'];
  const codes = allWeekCodes(term);
  assert.ok(codes.length >= 4);
  for (const code of codes) {
    assert.ok(term.buildings[code].hours.every((d) => Array.isArray(d)));
  }
});

// Comments are stripped first. A comment naming Sullivant is a record of the
// measurement that produced a rule; a name in the code is a hardcoded building
// that survives a term rollover it should not have survived.
const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('no building name is typed into the app source', () => {
  const dir = join(ROOT, 'js');
  const names = ['Enarson', 'Hitchcock', 'Independence', 'Sullivant', '18th Avenue'];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const text = codeOnly(readFileSync(join(dir, file), 'utf8'));
    for (const name of names) {
      assert.equal(text.includes(name), false, `${file} names ${name}`);
    }
  }
});

test('the app source assumes nothing about an unpublished door', () => {
  // The whole word, not just "usually open". A hedge anywhere in this app is
  // one edit away from being a hedge about a door.
  const dir = join(ROOT, 'js');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    assert.doesNotMatch(readFileSync(join(dir, file), 'utf8'), /usually/i, `${file} hedges`);
  }
  assert.doesNotMatch(readFileSync(join(ROOT, 'index.html'), 'utf8'), /usually/i, 'index.html hedges');
});

// The two large-text rules, checked in the source because this suite has no
// layout engine. What they are worth is measured in a browser: at 393px with
// the root at 53px the buildings screen went from 53 of 53 rows clipped and
// #near scrolling sideways at 454 against 393, to 0 clipped and no sideways
// scroll, and the question screen's 30 minute button went from top -644 with
// no way to reach it to top 493.

test('every container-query rule sits below the plain rule it has to beat', () => {
  // A container query adds no specificity of its own, so a plain rule further
  // down the sheet wins on source order. This is the bug that shipped: .b-row
  // was given the container name, and the only rule inside the query was for
  // .row, which happens to be declared above it.
  const css = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const blocks = [...css.matchAll(/@container[^{]*\{([\s\S]*?)\n {2}\}/g)];
  assert.ok(blocks.length >= 1, 'no container query in the sheet');
  const seen = new Set();
  for (const block of blocks) {
    for (const rule of block[1].matchAll(/^ {4}(\.[\w-]+)/gm)) {
      const selector = rule[1];
      seen.add(selector);
      const plain = new RegExp(`^ {2}\\${selector}[\\s,{]`, 'gm');
      for (const hit of css.matchAll(plain)) {
        assert.ok(
          hit.index < block.index,
          `${selector} is declared at ${hit.index}, below the container query at ${block.index}`,
        );
      }
    }
  }
  for (const want of ['.row', '.b-row', '.pick-row']) {
    assert.ok(seen.has(want), `${want} has no large-text rule`);
  }
});

test('the question screen does not centre content it cannot scroll to', () => {
  // justify-content: center on a scroll container puts overflow above the
  // scroll origin, where scrollTop, scrollIntoView and Tab all cannot reach it.
  // safe falls back to flex-start the moment the content stops fitting.
  const css = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const ask = css.slice(css.indexOf('  #ask {'), css.indexOf('  #ask h1 {'));
  assert.match(ask, /justify-content: safe center;/);
  assert.match(ask, /overflow-y: auto;/);
  // The plain value has to stay above it for engines that drop the keyword.
  assert.ok(ask.indexOf('justify-content: center') < ask.indexOf('justify-content: safe center'));
});

// The wide-direction rules, checked in the source for the same reason as the
// two above: this suite has no layout engine. What they are worth was measured
// in headless Chrome at 1900x1000 on the ranked list, before and after. The
// row's name column went 1777.2 -> 389.2px, so "Psychology Building 115" and
// its "3 min" went from x=20.6 and x=1813.8 to x=714.6 and x=1119.8; the four
// duration chips went 459.3/445.5/445.5/508.2 -> 112.3/98.5/98.5/161.2; and
// #origin-where went 1823.4 -> 435.4px. Nothing moved at 320, 390 or 430px, or
// at 393px with the root at 53px, which is the check the cap has to keep
// passing: phone-first is the decision, phone-only was the accident.

test('the sheet holds a capped column instead of stretching to the window', () => {
  const css = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const col = css.match(/--col:\s*([\d.]+)rem;/);
  assert.ok(col, 'the sheet has no content column to cap');
  // In rem, so it grows with the reader's font size, and wide enough that no
  // phone can reach it: 32rem is 512px against the 430px of the widest one.
  assert.ok(Number(col[1]) * 16 > 430, `${col[1]}rem is ${Number(col[1]) * 16}px and binds on a phone`);
  // The SHEET carries the width, not its children.
  //
  // This assertion used to be the other way round -- the children capped, the
  // sheet full-bleed, on the argument that its border is a horizon line across
  // the map. Rendered at 1920x1000 that was a black slab the width of the
  // window with 512px of rows adrift in the middle of it and two dead margins
  // belonging to nothing. The sheet IS the card, so the card is what narrows.
  // Measured after the change: 390 -> x=0 w=390, 430 -> x=0 w=430, both
  // unchanged; 1280 -> x=384 w=512 and 1920 -> x=704 w=512, centred.
  const sheet = css.slice(css.indexOf('\n  #sheet {'), css.indexOf('#sheet.snap'));
  assert.match(sheet, /max-width: var\(--col\)/, 'the sheet does not carry the column width');
  assert.match(sheet, /margin-inline: auto/, 'the sheet is not centred');
  // Centred by margin, never by a transform. `left: 50%` with
  // translateX(-50%) centres just as well and at the 393px scripts/shoot.mjs
  // shoots at it translates by -196.5px, landing every glyph in the sheet on a
  // half pixel. All four frames came back re-antialiased on a diff that was
  // supposed to touch nothing below a laptop.
  assert.doesNotMatch(sheet, /translateX/, 'the sheet is centred with a transform, which blurs it on a phone');
  // And the children do NOT, because a cap inside a capped sheet is a second
  // number to keep in step, and it changed the width the four
  // container-type: inline-size panes measure their 18em reflow against.
  assert.doesNotMatch(css, /#sheet > \* \{[^}]*max-width/, 'the children are capped as well as the sheet');
  assert.equal(css.split('max-width: var(--col)').length - 1, 1, 'the column width is set twice');
  // And the back arrow rides the same column rather than the window corner.
  assert.match(css, /#back, #menu \{ left: max\(.+, calc\(50% - var\(--col\) \/ 2\)\); \}/);
});

test('every control answers a mouse before it has been clicked', () => {
  // `grep -c ":hover" index.html` returned 0 for the whole life of the app, so
  // the only press feedback anywhere was .opt:active, which is a touch gesture.
  const css = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const at = css.indexOf('@media (hover: hover)');
  assert.ok(at > 0, 'nothing in this app answers a pointer');
  const block = css.slice(at, css.indexOf('\n  }', at));
  // .opt is :enabled-guarded: the four duration buttons ship disabled and a
  // hover that lit them would contradict the .45 opacity dimming them.
  // No .chip. This block was written against a main that still had the duration
  // chips, and #85 deletes them in the same batch as this change. A hover rule
  // for a node nothing renders is CSS that outlives its control, which is
  // exactly what #85's own guard forbids -- and the two branches were green
  // apart and red together until this came out.
  for (const sel of ['.opt:enabled:hover', '.row:hover', '.bar-btn:hover', '.dstep:hover', '#back:hover',
    '.b-row:hover', '.pick-row:hover']) {
    assert.ok(block.includes(sel), `${sel} has no hover state`);
  }
  // The list is the one index.html:84 already keeps for every control in the
  // app: .b-row and .pick-row are the nearest-buildings and picker screens, and
  // a test called "every control" that checks six of eight is not that test.
  assert.doesNotMatch(block, /(?<![.\w-])\.opt:hover/, 'the disabled duration buttons light up again');
  // #origin-where is a .bar-btn and is covered by that one.
  assert.match(css.slice(at, at + 80), /pointer: fine/, 'a phone gets sticky hover');
  assert.match(css.slice(at, at + 80), /forced-colors: none/, 'high contrast gets author colours');
  // :hover carries no specificity of its own, so each rule it ties with is
  // spelled out and the whole block sits below every one of them.
  for (const [plain, paired] of [
    ['.row.on {', '.row.on:hover'],
    ['.opt.primary {', '.opt.primary:hover'],
  ]) {
    assert.ok(block.includes(paired), `${paired} is missing, so ${plain} wins on source order`);
    assert.ok(css.indexOf(plain) < at, `${plain} is declared below the hover block`);
  }
});

test('a mouse can open the sheet without first learning to drag', () => {
  // Dragging the grip is a thumb gesture and it was the only way out of peek,
  // so on a laptop the fifth row of the answer was behind a gesture nobody
  // does with a mouse.
  const app = readFileSync(join(ROOT, 'js', 'app.js'), 'utf8');
  const end = app.slice(app.indexOf('  const end = (e) => {'), app.indexOf("sheet.addEventListener('pointerup', end)"));
  assert.ok(end, 'no pointerup handler on the sheet');
  assert.match(end, /const moved = drag\.travelled;/);
  assert.match(end, /if \(!moved && released\) \{\s*setSheet\(sheetH >= full - 2 \? peek : full, true\);/);
  // Under the dismiss branch, or a grip pulled to the end of its travel would
  // toggle instead of throwing the list away.
  assert.ok(end.indexOf('toAsk();') < end.indexOf('if (!moved && released)'), 'the click branch eats the dismiss');
});

// ---------------------------------------------------------------- #18 the row

test('a room with no later class says so, and never invents an end time', () => {
  const row = {
    wait: 0,
    hoursKnown: true,
    nextClassAt: 1290,
    usableUntil: 1280,
    availableAt: 800,
    usable: 480,
  };
  assert.equal(windowPhrase(row, 1290).text, 'no class rest of today');
  assert.equal(windowPhrase(row, 1290).tier, 'medium');
  // The lock time is still in the accessible name, because it is the one fact
  // the phrase drops.
  assert.match(windowPhrase(row, 1290).say, /locks at 9:30 pm/);
});

test('a class-bounded room prints a clock time and no duration', () => {
  const row = { wait: 0, hoursKnown: true, nextClassAt: 835, usableUntil: 825, availableAt: 700, usable: 125 };
  const p = windowPhrase(row, 1290);
  assert.equal(p.tier, 'strong');
  assert.equal(p.text, 'free till 1:45pm');
  assert.doesNotMatch(p.text, /\dh\d\d/);
});

test('the 9h44 case: an unpublished door never gets a window', () => {
  // The room really is free from 14:16 to midnight as far as the schedule
  // knows, and the naive read of that is "9h44 free", which is a claim about a
  // door nobody publishes. rank() returns usable null here on purpose.
  const rooms = [{ id: 'XX0001', b: '900', cap: 40, busy: [[4, 600, 700]] }];
  const buildings = { 900: { name: 'Nowhere Hall', lat: 39.9995, lon: -83.013 } };
  const [row] = rank(rooms, {
    origin: { lat: 39.9995, lon: -83.013 },
    now: 856,
    day: 4,
    needed: 30,
    buildings,
    hoursFor: () => undefined,
  });
  assert.equal(row.hoursKnown, false);
  assert.equal(row.usable, null);
  assert.equal(row.usableUntil, null);
  const p = windowPhrase(row, null);
  assert.equal(p.text, 'hours not published');
  assert.doesNotMatch(p.text, /\dh\d\d/);
});

test('clock wraps, so the string a row prints is not the thing to assert on', () => {
  // The guard below used to parse the rendered text and check the minute came
  // out under 1440. Measured across clock(0..2999) with that same parse, the
  // highest value it can ever produce is 1439, from clock(1439) = 11:59pm.
  // clock(1440) renders 12:00am and clock(1500) renders 1:00am, so every
  // possible input passed and the assertion asserted nothing.
  let highest = -1;
  for (let m = 0; m < 3000; m += 1) {
    const hit = /(\d+):(\d\d)(am|pm)/.exec(clock(m));
    if (!hit) continue;
    const minute = ((Number(hit[1]) % 12) + (hit[3] === 'pm' ? 12 : 0)) * 60 + Number(hit[2]);
    highest = Math.max(highest, minute);
  }
  assert.equal(highest, 1439);
  assert.equal(clock(1440), '12:00am');
  assert.equal(clock(1500), '1:00am');
});

test('a window past the end of the day is refused, not wrapped into the morning', () => {
  // The negative control the old guard did not have. This row would have
  // printed "free till 1:00am" and passed.
  const past = {
    wait: 0, hoursKnown: true, availableAt: 700,
    usableUntil: MINUTES_IN_DAY + 50, nextClassAt: MINUTES_IN_DAY + 60, usable: 60,
  };
  const p = windowPhrase(past, MINUTES_IN_DAY + 60);
  assert.equal(p.tier, 'unknown');
  assert.doesNotMatch(p.text, /\d+:\d\d(am|pm)/);
  assert.doesNotMatch(p.say, /\d+:\d\d (am|pm)/);

  // The same row one minute inside the day still answers.
  const ok = {
    wait: 0, hoursKnown: true, availableAt: 700,
    usableUntil: MINUTES_IN_DAY - 10, nextClassAt: MINUTES_IN_DAY, usable: 60,
  };
  assert.equal(windowPhrase(ok, MINUTES_IN_DAY).tier, 'medium');
});

test('a strong row names the class time it is talking about, not a made up one', () => {
  // usableUntil is PACKUP before the class, so the old accessible name said
  // "free until 3:20 pm when a class starts" for a room whose class is at 3:30,
  // while the room screen for the same room said 3:30. Nothing starts at 3:20.
  const row = { wait: 0, hoursKnown: true, availableAt: 700, nextClassAt: 930, usableUntil: 930 - PACKUP, usable: 200 };
  const p = windowPhrase(row, 1140);
  assert.equal(p.tier, 'strong');
  assert.equal(p.text, 'free till 3:20pm');
  assert.match(p.say, /3:20 pm/);
  assert.match(p.say, /3:30 pm/);
  assert.doesNotMatch(p.say, /3:20 pm when a class starts/);
});

test('no row phrase ever names a time past the end of the day', () => {
  const counts = roomsPerBuilding(INDEX);
  const term = HOURS.terms['autumn-2026-classroom-pool-building-schedule'];
  const hoursFor = (code, day) => term.buildings[code]?.hours[day];
  const rows = rank(
    Object.entries(INDEX.rooms).map(([id, r]) => ({ id, ...r })),
    {
      origin: { lat: 39.99944, lon: -83.01502 },
      now: 735,
      day: 4,
      needed: 60,
      buildings: SLICE,
      hoursFor,
      sessions: INDEX.sessions,
      date: '2026-09-03',
    },
  );
  assert.ok(rows.length > 100, `expected a busy Thursday, got ${rows.length} rows`);
  assert.ok(Object.keys(counts).length > 0);
  for (const row of rows) {
    // The numbers, not the rendered string. Any of these past MINUTES_IN_DAY is what
    // clock() would quietly wrap, and it is the only thing that can go wrong.
    for (const [what, minute] of [
      ['availableAt', row.availableAt],
      ['usableUntil', row.usableUntil],
      ['nextClassAt', row.nextClassAt],
    ]) {
      if (minute == null) continue;
      assert.ok(minute >= 0 && minute <= MINUTES_IN_DAY, `${row.id} ${what} is ${minute}`);
    }
    const hours = hoursFor(row.building, 4);
    // 'window unknown' is the refusal the guard above produces. A real Thursday
    // must not reach it, or the guard is hiding a wrong window rather than
    // catching one.
    assert.notEqual(windowPhrase(row, Array.isArray(hours) ? hours[1] : null).text, 'window unknown', row.id);
  }
});

// The room screen at 12:15 on a Thursday, in a building open 7:00 to 19:30
// with one class from 15:30 to 17:00. This is the shape timelineRows() hands
// roomClaim(), written out rather than built, so the arithmetic under test is
// the only thing that can move.
//
// The Registrar publishes this building, so `known` is true and the verdict is
// allowed to talk about the door. js/claim.js returns the verdict and js/app.js
// writes the sentence, so what is asserted here is the number.
const TIMELINE = {
  known: true,
  open: 420,
  close: 1170,
  blocks: [[930, 1020]],
  rows: [
    { kind: 'edge', t: 420, text: 'Nowhere Hall opens' },
    { kind: 'free', t: 420, end: 930, len: 510, now: true },
    { kind: 'busy', t: 930 },
    { kind: 'free', t: 1020, end: 1170, len: 150, now: false },
    { kind: 'edge', t: 1170, text: 'Nowhere Hall closes' },
  ],
};

test('the room screen subtracts the walk, the way the engine says to', () => {
  // `gapEnd - PACKUP - now` is the expression engine.js documents as the bug it
  // exists to fix. It shipped here anyway and overstated every claim by exactly
  // the walk: measured headlessly on a Thursday at 12:15, all 23 rooms in the
  // top 40 that carried a claim were 5 minutes long.
  const nowMin = 735;
  const metres = 191; // metres WALKED since #115, which is the old 147 m straight line
  const engine = usableMinutes({ now: nowMin, gapStart: 420, gapEnd: 930, metres });
  const naive = 930 - PACKUP - nowMin;
  assert.equal(naive - engine, 3, 'the walk is 3 minutes, so the old formula was 3 minutes long');

  const claim = roomClaim({ ...TIMELINE, now: nowMin, metres });
  assert.equal(claim.kind, 'free');
  assert.equal(claim.until, 920, 'the class is at 3:30pm, so you are out at 3:20pm');
  assert.equal(claim.yours, engine);
  assert.notEqual(claim.yours, naive);
});

test('the room screen prints no duration when it does not know the walk', () => {
  // A shared link and the buildings screen both land here with no ranked row
  // behind them. A duration that assumes you are already at the door is the
  // same lie in a different place, so the verdict carries null and the screen
  // has nothing to print.
  const claim = roomClaim({ ...TIMELINE, now: 735, metres: null });
  assert.equal(claim.kind, 'free');
  assert.equal(claim.until, 920);
  assert.equal(claim.yours, null);
});

test('a walk that outlasts the window says so instead of printing zero', () => {
  const claim = roomClaim({ ...TIMELINE, now: 925, metres: 4000 });
  assert.ok(claim.yours <= 0, `a 4 km walk cannot leave ${claim.yours} minutes`);
  // And the screen has a sentence for it rather than a zero.
  const src = readFileSync(join(ROOT, 'js/app.js'), 'utf8');
  assert.match(src, /It closes before you could walk there/);
});

test('the before-open and in-class claims go through the same formula', () => {
  const early = roomClaim({ ...TIMELINE, now: 300, metres: 147 });
  assert.equal(early.kind, 'opens');
  assert.equal(early.at, 420, 'the door, not the first class');
  assert.equal(early.yours, usableMinutes({ now: 300, gapStart: 420, gapEnd: 930, metres: 147 }));

  const during = roomClaim({ ...TIMELINE, now: 950, metres: 147 });
  assert.equal(during.kind, 'in-class');
  assert.equal(during.until, 1020, 'in use till 5:00pm');
  assert.equal(during.next, 1020);
  assert.equal(during.yours, usableMinutes({ now: 950, gapStart: 1020, gapEnd: 1170, metres: 147 }));
});

test('the room deep link is gated on scheduled hours, not only on rankable', () => {
  // There is no DOM in this suite, so this reads the branch. What it guards:
  // boot() opened the ranked list behind a ?room= link at 3am on a Saturday,
  // leaving 40 rows one back press from a link, on a screen the front door
  // refuses to show at all.
  const src = readFileSync(join(ROOT, 'js/app.js'), 'utf8');
  const branch = src.slice(src.indexOf('function openWantedRoom()'));
  assert.ok(branch.length > 0, 'the deep link branch moved');
  const head = branch.slice(0, 1200);
  assert.match(head, /if \(state\.scheduled\)/);
  assert.match(head, /showNear\(\)/);
});

test('dev clock restoration retries a room link refused by the live date', () => {
  // Dev mode restores its saved clock after boot. When the live date is a
  // holiday, boot has to leave the link pending and devApply must retry it
  // after refresh() makes the simulated instructional date rankable.
  const src = readFileSync(join(ROOT, 'js/app.js'), 'utf8');
  const seam = src.slice(src.indexOf('export function devApply'), src.indexOf('export function devReadout'));
  assert.match(seam, /refresh\(\);[\s\S]*openWantedRoom\(\)/);
});

// ------------------------------------------------------------ #17 the picker

test('the picker list is the intersection of the harvest and buildings.json', () => {
  const counts = roomsPerBuilding(INDEX);
  const codes = Object.keys(counts).filter((c) => SLICE[c]);
  // The floor is the Registrar's hours table, not the schedule: a building
  // with no published doors no longer ships, so the picker can never list more
  // than the 46 buildings that table names.
  assert.ok(codes.length >= 30 && codes.length <= 60, `picker would list ${codes.length} buildings`);
  for (const code of codes) {
    assert.ok(SLICE[code], `${code} missing from the term slice`);
    assert.ok(FULL[code], `${code} missing from buildings.json`);
    assert.ok(counts[code] >= 1);
  }
});

test('every picked building resolves to a coordinate', () => {
  const counts = roomsPerBuilding(INDEX);
  for (const code of Object.keys(counts)) {
    const b = SLICE[code];
    if (!b) continue;
    assert.ok(Number.isFinite(b.lat) && Number.isFinite(b.lon), `${code} has no coordinate`);
  }
});

test('a picked origin ranks rooms from more than one building', () => {
  // Roomix seeds from a building and then expands outward until it breaks at
  // 200 m, so picking narrows the answer. A picked building here is only where
  // you are standing.
  const term = HOURS.terms['autumn-2026-classroom-pool-building-schedule'];
  const home = SLICE['279'];
  const rows = rank(
    Object.entries(INDEX.rooms).map(([id, r]) => ({ id, ...r })),
    {
      origin: { lat: home.lat, lon: home.lon, accuracy: 50, source: 'picked' },
      now: 735,
      day: 4,
      needed: 30,
      buildings: SLICE,
      hoursFor: (code, day) => term.buildings[code]?.hours[day],
      sessions: INDEX.sessions,
      date: '2026-09-03',
    },
  );
  const distinct = new Set(rows.slice(0, 20).map((r) => r.building));
  assert.ok(distinct.size >= 3, `top 20 came from ${distinct.size} buildings`);
});

// -------------------------------------------------------- #24 diagnostics

const DIAG = {
  build: 'a3f9c21',
  controlling: true,
  term: '1268',
  termName: 'Autumn 2026',
  generated: '2026-08-30T07:41:12Z',
  ageDays: 5,
  stateKind: 'RANKED',
  rooms: 871,
  buildings: 96,
  sessions: 10,
  originSource: 'gps',
  accuracy: 32,
  originAgeS: 14,
  lat: 40.0022951,
  lon: -83.0158317,
  hoursSource: 'registrar',
  hoursGenerated: '2026-08-26',
  clock: '2026-09-04 14:02',
  zone: 'America/New_York',
  caches: ['vacant-shell-a3f9c21', 'vacant-data-1268'],
  room: {
    id: 'DL0357',
    type: '1B',
    cap: 46,
    building: '279',
    metres: 412,
    walk: 6,
    gapStart: 835,
    gapEnd: 970,
    session: 0,
    usable: 123,
    nowMin: 842,
  },
  dayName: 'Thu',
  busy: [[480, 535], [550, 605], [780, 835], [970, 1025]],
};

test('the block prints what a maintainer needs to reproduce a wrong answer', () => {
  const block = diagnosticsBlock(DIAG);
  for (const want of ['a3f9c21', '1268', 'Autumn 2026', '5 days old', '871 rooms', '96 buildings', '10 sessions',
    'gps', '+/-32 m', 'age 14 s', 'America/New_York', 'vacant-data-1268', 'DL0357', 'type 1B', 'cap 46',
    'bldg 279', '412 m walked -> 6 min', 'straight line x 1.3', 'sess 0', 'usable 2h03', 'leaveBy']) {
    assert.ok(block.includes(want), `block is missing ${want}`);
  }
  assert.match(block, /busy Thu\s+8:00am-8:55am/);
});

test('leaveBy is the last minute you could have set off and still got that usable', () => {
  // usable = gapEnd - PACKUP - max(now + walk, gapStart). Leave any later than
  // this and the arrival, not the gap, sets the start, so the figure on the
  // same line shrinks minute for minute. Once the gap has already opened, that
  // deadline is simply the minute the row was tapped.
  const started = diagnosticsBlock(DIAG);
  assert.match(started, /usable 2h03, leaveBy 2:02pm/);

  // Same room, tapped at 12:30 for a gap that does not open until 13:55: the
  // deadline is the gap start less the seven minute walk.
  const waiting = diagnosticsBlock({ ...DIAG, room: { ...DIAG.room, nowMin: 750 } });
  assert.match(waiting, /leaveBy 1:49pm/);

  // A pick stored before this line existed carries no clock, and the line stops
  // rather than inventing one.
  const { nowMin, ...older } = DIAG.room;
  assert.equal(nowMin, 842);
  const old = diagnosticsBlock({ ...DIAG, room: older });
  assert.ok(old.includes('usable 2h03'));
  assert.ok(!old.includes('leaveBy'));
});

test('no coordinate leaves the device unless it is ticked, and then only to 4 places', () => {
  const withheld = diagnosticsBlock(DIAG);
  assert.ok(withheld.includes('[location withheld]'));
  assert.doesNotMatch(withheld, /[0-9]{2}\.[0-9]/);

  const shared = diagnosticsBlock({ ...DIAG, includeLocation: true });
  assert.ok(shared.includes('40.0023, -83.0158'), shared);
  for (const hit of shared.match(/-?\d+\.\d+/g) ?? []) {
    const places = hit.split('.')[1].length;
    assert.ok(places <= 4, `${hit} carries ${places} decimal places`);
  }
});

test('a room carrying 57 weekly intervals still fits under the cap whole', () => {
  const busy = Array.from({ length: 57 }, (_, i) => [480 + i * 10, 485 + i * 10]);
  const block = diagnosticsBlock({ ...DIAG, busy });
  assert.ok(block.length <= 4000, `block is ${block.length} characters`);
  assert.doesNotMatch(block, /\.\.\. \d+ more/);
  assert.equal((block.match(/-/g) ?? []).length >= 57, true);
});

test('past the cap the busy list is what loses entries, and it says how many', () => {
  // An issue URL carrying a 4000 character block is already at the edge of what
  // survives a redirect, so the unbounded line is the one that gives way.
  const busy = Array.from({ length: 400 }, (_, i) => [480 + (i % 90) * 10, 485 + (i % 90) * 10]);
  const block = diagnosticsBlock({ ...DIAG, busy });
  assert.ok(block.length <= 4000, `block is ${block.length} characters`);
  assert.match(block, /\.\.\. \d+ more/);
  assert.ok(block.startsWith('build'), 'the head survives the cap');
  assert.ok(block.includes('DL0357'), 'the room line survives the cap');
});

// ---- the day the room screen is drawing

// Checked out with CRLF on Windows, so the endings come out before anything
// goes looking for a closing brace in column 0.
const APP = readFileSync(join(ROOT, 'js/app.js'), 'utf8').replace(/\r\n/g, '\n');
const DAY_SRC = readFileSync(join(ROOT, 'js/day.js'), 'utf8').replace(/\r\n/g, '\n');

// One function's source, from its signature to the closing brace in column 0.
const bodyOf = (name) => {
  const at = APP.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} is gone from js/app.js`);
  const end = APP.indexOf('\n}\n', at);
  assert.ok(end > at, `${name} has no closing brace`);
  return APP.slice(at, end);
};

// Seven consecutive days either side of the boundary between the first session
// and the third, so every weekday is reachable under both masks. Oct 6 to Oct
// 12 is inside the first session and outside the third; Oct 19 to Oct 25 is the
// other way round.
const weekFrom = (iso) =>
  Array.from({ length: 7 }, (_, i) => {
    const d = at(iso);
    d.setDate(d.getDate() + i);
    return d;
  });
const EARLY = weekFrom('2026-10-06');
const LATE = weekFrom('2026-10-19');
const dayOf = (week, d) => week.find((x) => x.getDay() === d);

// The 18 rooms whose Monday is not the same class on both sides of that
// boundary. The test re-derives the list rather than trusting it; it is written
// out so a build that moves one of them is a diff a reader can see.
const MONDAY_MOVES = [
  'AA0108', 'AA0246', 'BE0120', 'BO0317', 'DE0268', 'HA0025',
  'HC0250', 'HH0159', 'HI0035', 'JR0295', 'KH0116', 'KH0333',
  'LZ0021', 'PEA0151', 'PS0014', 'RA0059', 'SB0305', 'SB0320',
];

test('the mask and the weekday both come off the date, over the whole shipped index', () => {
  // The fixture first. If the term stops straddling this boundary the counts
  // below stop meaning anything, and this is the line that says so.
  for (const d of EARLY) assert.deepEqual(activeSessions(INDEX.sessions, isoDate(d)), [true, true, false]);
  for (const d of LATE) assert.deepEqual(activeSessions(INDEX.sessions, isoDate(d)), [false, true, true]);

  const rooms = Object.entries(INDEX.rooms);
  const perDay = [0, 0, 0, 0, 0, 0, 0];
  const moved = [];
  let differing = 0;
  for (const [id, room] of rooms) {
    for (let d = 0; d < 7; d++) {
      const early = blocksOn(room, dayOf(EARLY, d), INDEX.sessions);
      const late = blocksOn(room, dayOf(LATE, d), INDEX.sessions);
      if (JSON.stringify(early) === JSON.stringify(late)) continue;
      differing += 1;
      perDay[d] += 1;
      if (d === 1) moved.push(id);
    }
  }

  // The figures js/day.js cites for why the date has to decide the mask.
  // Reading the weekday off a clock collapses all seven columns onto one, and
  // dropping the mask makes both sides equal, so every number here moves under
  // either mutation.
  assert.equal(rooms.length, 425);
  assert.equal(rooms.length * 7, 2975);
  assert.equal(differing, 107, 'room-days that differ across the session boundary');
  assert.deepEqual(perDay, [0, 18, 24, 25, 24, 16, 0], 'differing room-days by weekday, Sunday first');
  assert.deepEqual(moved.sort(), [...MONDAY_MOVES].sort());
});

test('the grid and the claim read one list of classes, on both sides of the boundary', () => {
  // The grid draws classesOn() and the sentence above it reads blocksOn(). The
  // defect was that the two filtered the busy grid separately, off two clocks,
  // and were allowed to come back with different days.
  let carried = 0;
  for (const room of Object.values(INDEX.rooms)) {
    for (const date of [...EARLY, ...LATE]) {
      const drawn = classesOn(room, date, INDEX.sessions, INDEX.courses);
      const read = blocksOn(room, date, INDEX.sessions);
      assert.equal(read.length > 0, drawn.length > 0, `one of them found a class the other did not, ${isoDate(date)}`);
      if (!drawn.length) continue;
      carried += 1;
      assert.equal(read[0][0], drawn[0].from, `first class disagrees on ${isoDate(date)}`);
      for (const c of drawn) {
        assert.ok(
          read.some(([s, e]) => c.from >= s && c.to <= e),
          `a class the grid draws on ${isoDate(date)} falls outside every block the claim reads`,
        );
      }
    }
  }
  assert.ok(carried > 0, 'the comparison exercised room-days carrying classes');
});

test('js/day.js reads no clock of its own', () => {
  // It is handed the date. A Date built inside it is the bug back: the weekday
  // would follow the machine while the grid beside it followed the stepper.
  assert.doesNotMatch(DAY_SRC.replace(/^\s*\/\/.*$/gm, ''), /new Date\(|Date\.now\(/);
});

test('a day the app refuses to answer for does not get a first class', () => {
  // One tap on Next day from an ordinary Tuesday used to print "First class
  // 10:05am" on Veterans Day, which is a date this same build answers with
  // "campus is closed" when you are standing in it.
  const room = INDEX.rooms.AA0005;
  const dates = Object.keys(INDEX.closed);
  assert.equal(dates.length, 7, 'the shipped calendar moved');
  for (const iso of dates) {
    const entry = INDEX.closed[iso];
    const blocks = blocksOn(room, at(iso), INDEX.sessions);
    assert.ok(blocks.length > 0, `AA0005 holds nothing on ${iso}, so this proves nothing`);
    const claim = dayClaim({
      closed: false,
      blocks,
      calendar: calendarOn(iso, INDEX, CURRENT),
      inTerm: inTermOn(iso, CURRENT, INDEX),
      term: CURRENT.termName,
    });
    assert.doesNotMatch(claim.head, /^(First class|No class|Closed)/, `${iso} answers with the schedule`);
    assert.ok(claim.head.startsWith(entry.name), `${iso} does not name the closure: ${claim.head}`);
    // Autumn Break has open doors and no classes, which is the best day of the
    // term for this app, so dressing it as a closure would cost a room.
    assert.match(claim.head, entry.state === 'no-classes' ? /, no classes$/ : /, campus is closed$/);
  }
});

test('a date the schedule does not reach is not answered as an empty room', () => {
  // Every session mask is off past the last day of instruction, so every room
  // on every later date comes back empty, and "No class Tue Dec 15" would be a
  // statement of fact about a date the index carries nothing for.
  const room = INDEX.rooms.AA0005;
  const shape = (iso) =>
    dayClaim({
      closed: false,
      blocks: blocksOn(room, at(iso), INDEX.sessions),
      calendar: calendarOn(iso, INDEX, CURRENT),
      inTerm: inTermOn(iso, CURRENT, INDEX),
      term: CURRENT.termName,
    });

  assert.equal(shape('2026-12-15').head, 'Finals week, exam rooms are not published');
  for (const iso of ['2027-01-14', '2026-08-17']) {
    assert.equal(shape(iso).head, `${CURRENT.termName} does not cover this day`);
    assert.doesNotMatch(shape(iso).head, /^No class/);
  }
  // A Sunday inside the term is empty for the ordinary reason, and still says so.
  assert.equal(shape('2026-09-20').head, 'No class');
});

test('a stepped day inside the term gets its own first class', () => {
  const room = INDEX.rooms.AA0005;
  const thursday = at('2026-09-17');
  assert.equal(thursday.getDay(), 4);
  const claim = dayClaim({
    closed: false,
    blocks: blocksOn(room, thursday, INDEX.sessions),
    calendar: calendarOn('2026-09-17', INDEX, CURRENT),
    inTerm: inTermOn('2026-09-17', CURRENT, INDEX),
    term: CURRENT.termName,
  });
  assert.equal(claim.head, 'First class 10:20am');
  assert.equal(claim.sub, '');
  // Nothing about now. On another day the walk, the window and the duration are
  // facts about the wrong day. And no date, because the grid heading five lines
  // below already names the day this sentence is about.
  for (const word of ['Yours', 'Next free', 'till', 'today', 'Sep', 'Thu']) {
    assert.ok(!claim.head.includes(word), `the stepped claim says ${word}`);
  }
});

test('the screen hands one date to the grid, the timeline and the claim', () => {
  const tl = bodyOf('timelineRows');
  assert.match(tl, /function timelineRows\([^)]*\bdate\b/, 'timelineRows takes no date');
  assert.match(tl, /hoursFor\(room\.b, date\.getDay\(\)\)/);
  assert.match(tl, /blocksOn\(room, date, schedule\.sessions\)/);
  assert.equal((tl.match(/state\.day/g) ?? []).length, 0, 'timelineRows still reads state.day');

  const room = bodyOf('roomHtml');
  assert.match(room, /const date = dayShown\(\)/);
  assert.match(room, /timelineRows\([^)]*\bdate, schedule\)/);
  // An equality and nothing else. `roomDayOffset === 0 || true` still reads as
  // a day check and still matches a looser pattern, and it puts today's
  // sentence back over every stepped day.
  assert.match(room, /const today = roomDayOffset === 0;\n/);
  assert.match(room, /!today\s*\?\s*shapeFor\(tl, date, schedule\)/, 'claimFor is still reachable off today');

  // The calendar is half the verdict, so the screen has to go and get it.
  const shape = bodyOf('shapeFor');
  assert.match(shape, /calendarOn\(iso, schedule, state\.current\)/);
  assert.match(shape, /inTermOn\(iso, state\.current, schedule\)/);
});

test('one weekday runs the whole remembered pick', () => {
  // The blob is pasted into the wrong-answer template, so a record labelling
  // Thursday's blocks "Wed" is the defect this screen exists to remove, one
  // line down. A row tapped at 00:02 was ranked yesterday and state.day says so.
  const pick = bodyOf('rememberPick');
  assert.match(pick, /shown\.getDay\(\) - state\.day/, 'the day is not taken back to the answer');
  assert.match(pick, /blocksOn\(room, shown,/, 'the block list is off another clock');
  assert.match(pick, /isoDate\(shown\)/, 'the session mask is off another clock');
  assert.match(pick, /Number\(b\[0\]\) === state\.day/, 'the closer lookup is off another clock');
  assert.match(pick, /dayName: .*\[state\.day\]/, 'the label is off another clock');
});

test('the back button on the room screen names the pane back lands on', () => {
  // Outside scheduled hours a ?room= link opens over the buildings screen, and
  // the label said "Back to the room list" over a list that was never pushed.
  const open = bodyOf('openRoom');
  assert.match(open, /pushState\(\{[^}]*from: state\.screen/);

  // The pairing, not the presence. Every string is in this function either way,
  // so separate matches all hold with the arms swapped, which is the reported
  // defect back again. Three arms now: the way opens rooms too, and it is not
  // the room list.
  const show = bodyOf('showRoom');
  assert.match(show, /from === 'near'\s*\?\s*'Back to the nearest buildings'/);
  assert.match(show, /from === 'way'\s*\?\s*'Back to the way'\s*:\s*'Back to the room list'/);
});

// ---- the duration, and where the list says it

// #85 took the four-chip radiogroup off the ranked list. It cost 61px of a
// 321px peeked sheet to keep asking a question that had already been answered,
// and the room screen had already stopped showing it.
//
// The half that is easy to get wrong is the other half. The chip bar was the
// ONLY place the list named the duration: paintList renders note + strip +
// caveat + rows, and on the happy path the strip is empty, so deleting the
// chips without replacing them leaves a column of room names that does not say
// what question it is the answer to. These hold both halves together, because
// either one alone is a regression.
test('the duration chips are gone from the page, not merely hidden on it', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  // Comments are prose, not markup and not style. scripts/test/sw.test.mjs
  // strips them before counting for the same reason: the comment explaining
  // why a thing is gone names the thing, and must not read as it coming back.
  const live = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(live, /class="chip"/, 'a chip is still in the DOM');
  assert.doesNotMatch(live, /role="radiogroup"/, 'the duration radiogroup is still in the DOM');
  // A hidden node still has CSS, and CSS for a node nothing renders is how the
  // bar comes back by accident. \b rather than a character class: the rule this
  // change actually deleted was `.row, .chip, .opt, .b-row, ... {`, and a comma
  // is neither whitespace, a brace nor a bracket, so the old pattern would have
  // walked straight past the shape it was written to catch.
  assert.doesNotMatch(live, /^\s*#chips\b[^{]*\{/m, 'the chip bar still has a rule');
  assert.doesNotMatch(live, /\.chip\b/, 'a chip selector survives in the stylesheet');
  // And nothing in the app is still wired to it, which is what the roving
  // tabindex handler and the paintChips sync would be.
  assert.doesNotMatch(APP, /['"#]chips['"]|\.chip\b/, 'js/app.js still reaches for the chips');
  assert.doesNotMatch(APP, /paintChips|attachChips/, 'the chip handlers are still here');
});

test('the #chips node left behind for the old shell is empty, and dated', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  // sw.js serves navigations network-first and assets cache-first, so the first
  // load after this deploys runs the new index.html against the js/app.js still
  // in the shell cache. That app.js calls attachChips() before it wires #back,
  // popstate, the sheet or boot(), and its first line is
  // $('chips').querySelectorAll('.chip') — a TypeError on a missing node, and a
  // screen frozen on "finding campus..." with no way out. This node exists only
  // so that forEach runs over nothing instead.
  const node = html.match(/<div id="chips"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(node, 'the shim the old shell needs is gone; see #85 before removing it');
  assert.equal(node[1].trim(), '', 'the shim grew content, which makes it a control again');
  assert.match(node[0], /\bhidden\b/, 'the shim is not hidden');
  // It is scaffolding with an expiry, not a feature. Once a release has shipped
  // carrying it, no cached app.js reaches for #chips and the node can go.
  const why = html.slice(Math.max(0, html.indexOf('<div id="chips"') - 1400), html.indexOf('<div id="chips"'));
  assert.match(why, /REMOVE AFTER ONE RELEASE/, 'the shim lost the note saying it is temporary');
});

test('the ranked list says which question it is answering', () => {
  const paint = bodyOf('paintList');
  // In the concatenation, so it cannot be a line that renders somewhere else.
  assert.match(
    paint,
    /list\.innerHTML =\s*\n\s*note \+\s*\n\s*asked\(\) \+/,
    'the rows are painted without the line that names the ask',
  );
  const line = APP.slice(APP.indexOf('const asked = ()'), APP.indexOf('function paintList('));
  assert.ok(line.length > 0, 'asked() is gone');

  // Prose, not a control. The chips were 44px targets and the replacement is a
  // paragraph: a second way to change the duration is the thing #85 removed.
  assert.match(line, /<p class="asked">/);
  assert.doesNotMatch(line, /<button|onclick|role=/, 'the line naming the ask is a control again');

  // One vocabulary for one figure, and one function for it. The strip two lines
  // below names the ask and so does the empty screen; a second rendering of the
  // same ask on the same screen is how two lines disagree. They all read
  // askedFor(), which is the only place that knows "rest of day" is not a
  // length dur() can print.
  assert.match(line, /askedFor\(\)/);
  assert.match(APP, /const askedFor = \(\) => \(state\.duration === 'day' \? 'the rest of the day' : dur\(state\.needed\)\);/);
  for (const fn of ['paintList', 'emptyAnswer', 'paintCard']) {
    assert.doesNotMatch(
      bodyOf(fn),
      /dur\(state\.needed\)/,
      `${fn} renders the ask without going through askedFor()`,
    );
  }

  // It names the ASK, not an offer. state.results can hold rows shorter than
  // the ask whenever one row meets it, so "free for 2h00" over these rows is a
  // promise the list does not keep.
  assert.doesNotMatch(line, /[Ff]ree for/);
});

// ---- the card, which is what a duration opens now

test('a duration opens one room, not the ranking', () => {
  // Colin, who uses this on campus every day, asked for "a single button that
  // just finds the nearest empty classroom and if its full u swipe and gives u
  // next best". The list is still there, one tap behind it, but it is no longer
  // what answering the question puts on screen.
  const choose = bodyOf('choose');
  assert.match(choose, /showCard\(\)/);
  assert.doesNotMatch(choose, /showList\(\)/, 'a duration still opens the list');
  assert.match(choose, /history\.pushState\(\{ v: 'card' \}/);
  // And the card is a pane of the same sheet, so it inherits the drag, the
  // dismiss and the covered map rather than reimplementing them.
  assert.match(APP, /const PANES = \['card', 'list'/);
});

test('the card carries the two things Enes said were the point, and nothing else', () => {
  // "the room number is important and also the building is important", and
  // "remove all the filler text". The picture is the room, and one plate over it
  // carries the name and the three facts. The count, the walk cap and the
  // coverage paragraph stay on the list -- a card carrying them is a list with
  // one row on it.
  const paint = bodyOf('paintCard');
  for (const bit of ['c-photo', 'c-plate', 'c-b', 'c-facts']) {
    assert.ok(paint.includes(bit), `the card lost ${bit}`);
  }
  assert.ok(paint.includes('cardParts(r)'), 'the card stopped naming the building and the room');
  assert.equal(paint.includes('caveatHtml'), false, 'the coverage paragraph is back on the card');
  assert.equal(paint.includes('MAX_WALK'), true, 'the end of the deck stopped naming the walk cap');

  // The strip is NOT filler. It is the only thing that says the answer is
  // degraded, and a card without it claims more than the ranking does.
  assert.ok(paint.includes('state.tally?.shorter'), 'the card stopped admitting a short answer');
  assert.ok(paint.includes('state.tally?.waiting'), 'the card stopped admitting an empty minute');
});

// ---- the photograph

test('a room with no photograph gets a card, not a broken frame', () => {
  // 119 of the 425 have none, and photoFor() is the only thing that decides.
  // Null means BOTH "OSU never photographed this room" and "the manifest has
  // not arrived yet", because the card is the same either way: the words are
  // the answer and the picture was always the bonus.
  const src = bodyOf('photoFor');
  assert.match(src, /state\.photos\?\.has\(id\)/);
  assert.match(src, /: null/);
  const paint = bodyOf('paintCard');
  assert.match(paint, /photo \? '' : ' plain'/, 'a photoless room stopped getting the plain card');
  // And a file that 404s or decodes to nothing falls back to the same card
  // rather than leaving an empty frame under the plate.
  assert.match(paint, /source\.onerror/);
  assert.match(paint, /classList\.add\('plain'\)/);
  // The warp draws into a canvas the pane may have replaced under a slow
  // decode -- a swipe, or a background re-rank -- and drawing into one nothing
  // holds any more is how a stale room ends up under the right name.
  assert.match(paint, /canvas\.isConnected/);
});

test('the photographs are on demand, never precached, and never re-fetched', () => {
  // 11.7 MB together. Precaching them would be the install this app refuses to
  // make a student wait for; revalidating them would spend 39 KB of somebody's
  // allowance on every card, on the one screen that exists for one bar of LTE.
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  assert.match(sw, /const PHOTO = /, 'sw.js does not recognise a photograph');
  assert.match(sw, /if \(PHOTO\.test\(url\.pathname\)\) \{[\s\S]{0,80}immutable\(request\)/);
  const immutableFn = sw.slice(sw.indexOf('async function immutable('), sw.indexOf('async function staleWhileRevalidate('));
  assert.equal(/waitUntil|event\./.test(immutableFn), false, 'the photograph branch revalidates');
  assert.equal(/photos/.test(sw.slice(sw.indexOf('const SHELL_ASSETS'), sw.indexOf('];', sw.indexOf('const SHELL_ASSETS')))), false,
    'a photograph is in the precached shell');
  assert.equal(/photos/.test(sw.slice(sw.indexOf('const WARM_ALWAYS'), sw.indexOf(';', sw.indexOf('const WARM_ALWAYS')))), false,
    'a photograph is warmed on install');

  // And the eviction that clears last term's files must not reach them: they
  // are not term keyed, and the same regex once ate the building hours.
  const evict = sw.slice(sw.indexOf('async function evictOldTerms('));
  const pattern = evict.match(/pathname\.match\((\/[^;]+\/)\)/)[1];
  assert.equal(new RegExp(pattern.slice(1, -1)).test('/Vacant/data/photos/CZ0160.webp'), false,
    'the term eviction deletes photographs');
});

test('the manifest is off the critical path, like the map is', () => {
  // data/photos.json is 2 KB and no answer needs it. boot() must not wait on
  // it, and a card painted before it lands is a card without a picture rather
  // than a card that waited for one.
  const boot = bodyOf('boot');
  const at = boot.indexOf("json('photos.json')");
  assert.ok(at > 0, 'boot() stopped fetching the photo manifest');
  assert.equal(boot.slice(Math.max(0, at - 40), at).includes('await'), false,
    'boot() waits for the photo manifest');
  assert.match(boot.slice(at), /\.catch\(/, 'a missing manifest is not survivable');
});

test('the swipe is not the only way to answer the card', () => {
  // A gesture nothing announces is unreachable from a keyboard and invisible to
  // a screen reader. Both verdicts are real buttons with written names, the
  // card takes focus, and the arrow keys do what the swipe does.
  const paint = bodyOf('paintCard');
  assert.match(paint, /id="c-no"[^>]*aria-label="[^"]+"/);
  assert.match(paint, /id="c-yes"[^>]*aria-label="[^"]+"/);
  assert.match(paint, /id="c-top"[^>]*tabindex="0"/);
  const swipe = bodyOf('attachSwipe');
  assert.match(swipe, /ArrowLeft/);
  assert.match(swipe, /ArrowRight/);
  // Down goes back to the question, and the card's own name is where that is
  // said: a gesture nothing announces is invisible to a reader who cannot see
  // the card move, and nothing on this screen prints it.
  assert.match(swipe, /ArrowDown/);
  assert.match(swipe, /toAsk\(\)/);
  assert.match(bodyOf('paintCard'), /Swipe down to start over/);
  // No back arrow either. It was a third piece of chrome on a photograph, and
  // the corner belongs to the menu now. Decided in showPane and nowhere else:
  // a CSS rule hiding it while showPane un-hid it is two mechanisms for one
  // fact, which is how they drift.
  assert.match(bodyOf('showPane'), /\$\('back'\)\.hidden = name === 'card'/);
  const css = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.equal(/body\.carding #back \{/.test(css), false, 'the CSS hides #back as well');

  // Scoped to the card itself. The end of the deck still has a button, and
  // should: there is no photograph on that screen, no gesture, and no room left
  // to swipe -- the list is the only thing to offer.
  const card = paint.slice(paint.indexOf('c-deck'));
  assert.equal(/c-more|i-list/.test(card), false, 'the list grew a control on the card again');
  // And the repaint does not drop the reader on the body.
  assert.match(bodyOf('rejectCard'), /\$\('c-top'\)\?\.focus/);
});

test('neither screen without a back arrow is a dead end', () => {
  // The card and the way both dropped the arrow, and on an installed icon there
  // is no browser chrome behind them either, so each needs its own way out.
  // The card has the downward throw and the way has the sheet's grip, and both
  // have the menu, whose first item is the one Enes asked for by name.
  assert.match(bodyOf('attachMenu'), /act\('m-back', \(\) => history\.back\(\)\)/);
  assert.match(APP, /attachMenu\(\);/);
  // Which means the way needs a history entry of its own for back to land on.
  assert.match(bodyOf('openWay'), /history\.pushState\(\{ v: 'way'/);

  // One corner, two controls, never both, and the menu is on the two screens
  // the arrow left.
  const pane = bodyOf('showPane');
  assert.match(pane, /\$\('back'\)\.hidden = name === 'card'/);
  assert.match(pane, /\$\('menu'\)\.hidden = name !== 'card'/);
  const way = bodyOf('showWay');
  assert.match(way, /\$\('back'\)\.hidden = true/);
  assert.match(way, /\$\('menu'\)\.hidden = false/);

  // A panel that outlives the screen it was opened on is a set of choices about
  // somewhere the reader has left.
  for (const fn of ['showPane', 'showAsk', 'showWay']) {
    assert.match(bodyOf(fn), /closeMenu\(\)/, `${fn} leaves the menu open`);
  }

  // A disclosure, not a menu: role="menu" promises arrow keys move between the
  // items, and the app does not implement that.
  const css = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.match(css, /<button id="menu"[^>]*aria-expanded="false"[^>]*aria-controls="menu-pop"/s);
  assert.equal(/role="menu"/.test(css), false, 'the menu claims a keyboard model it does not have');
  // Escape closes it, and so does a press on the backdrop.
  const menu = bodyOf('attachMenu');
  assert.match(menu, /e\.key !== 'Escape'/);
  assert.match(menu, /pop\.addEventListener\('pointerdown'/);
});

test('a press on a verdict button is not eaten by the card under it', () => {
  // The card captures the pointer to follow a drag, and pointer capture
  // retargets pointerup and CLICK onto the capturing element. So a press of the
  // bin or the tick was delivered to the card and swallowed: scripts/shoot.mjs
  // pressed the bin 120 times and never left the first room. The guard is the
  // one the sheet has had all along, and both are checked here so neither can
  // be dropped again.
  const card = bodyOf('attachSwipe');
  assert.match(card, /if \(e\.target\.closest\('button'\)\) return;/);
  assert.match(card, /setPointerCapture/);
  assert.ok(
    card.indexOf("closest('button')") < card.indexOf('setPointerCapture'),
    'the card captures the pointer before it checks what was pressed',
  );
});

test('an interrupted laptop drag cannot leave the card off screen', () => {
  // pointerup usually returns to the capturing card. Capture can fail, or the
  // browser can take it away when a trackpad drag crosses or leaves the window;
  // in either case the last pointermove has left an inline transform behind.
  // Every abnormal end must put the card back, while the window fallbacks must
  // be scoped to the active drag so repainted cards are not retained forever.
  const swipe = bodyOf('attachSwipe');
  assert.match(swipe, /addEventListener\('lostpointercapture', abandon\)/);
  assert.match(swipe, /addEventListener\('blur', abandon\)/);
  assert.match(swipe, /window\.addEventListener\('pointerup', end, true\)/);
  assert.match(swipe, /window\.addEventListener\('pointercancel', end, true\)/);
  assert.match(swipe, /const abandon = \(e\) => \{[\s\S]*?drag = null;[\s\S]*?clearFallbacks\(\);[\s\S]*?rest\(\);/);
  assert.match(swipe, /const clearFallbacks = \(\) => \{[\s\S]*?removeEventListener\('pointerup', end, true\)/);
  assert.ok(
    swipe.indexOf('drag = null;', swipe.indexOf('const end =')) <
      swipe.indexOf('clearFallbacks();', swipe.indexOf('const end =')),
    'a normal release removes fallbacks before it changes screens',
  );
});

test('a fast mouse release counts even when pointermove missed the distance', () => {
  // Browsers may coalesce a quick down-and-up into no useful pointermove. The
  // pointerup coordinates are still the end of the gesture; using drag.dx here
  // would make the same physical swipe work slowly and fail when done quickly.
  const swipe = bodyOf('attachSwipe');
  assert.match(swipe, /const \{ dx: movedX, dy: movedY, x0, y0, t0 \} = drag;/);
  assert.match(swipe, /const dx = released \? e\.clientX - x0 : movedX;/);
  assert.match(swipe, /const dy = released \? e\.clientY - y0 : movedY;/);
  assert.ok(
    swipe.indexOf('const dx = released') < swipe.indexOf('const thrown ='),
    'the throw decision still reads the last pointermove sample',
  );
});

// ---- what a review of this branch found

// Six defects, one shape: a new screen that does its own pane work, and a new
// control on two screens, both reaching code written before either existed.
// Only the first of these is a real runtime check -- js/sheet.js is arithmetic
// and can be run. The rest are regex over source, which is what this suite can
// do without a browser, and that limit is why the screenshot run exists.

test('a full-bleed screen still composes the camera for a band it can see', () => {
  const H = 852;
  // restFor answers 1 for the card, because the SHEET is the whole viewport
  // there, and 1 - 1 is a band of nothing. bandFor used to pass that straight
  // through: measured at 393x852 it returned 1px, and clampView collapses on it
  // -- halfW came out 393 times too large, `halfW * 2 >= gridW` held, and cx was
  // forced to the middle of the basemap. Four taps reach it, because frame()
  // stands down once the map has been moved by hand.
  assert.equal(restFor('card'), 1, 'the card stopped being full bleed');
  assert.equal(bandFor('card', H), bandFor('list', H));
  assert.ok(bandFor('card', H) > 400, `the card composes for a ${bandFor('card', H)}px band`);
  // And the rail still comes off it, the same as everywhere else.
  assert.equal(bandFor('card', H, 80), bandFor('list', H, 80));
});

test('checking again on the way does not switch the map off under the plate', () => {
  // answer() drops the selection, and paintMap() reads that: nothing targeted
  // means body.nomap, so the footprint, the walk line and the map go, leaving a
  // plate naming a room over a black screen. Two ways in, both new: the menu's
  // Check again, and the same button in the list footer, which is scrollable
  // under the plate now.
  const refresh = bodyOf('refresh');
  assert.match(refresh, /\['card', 'list', 'room', 'way'\]\.includes\(state\.screen\)/);
  assert.match(refresh, /state\.screen === 'way' \? state\.selected\?\.id : null/);
  // Back to the same room if it survived the re-rank, and to the card if a
  // class has taken it.
  assert.match(refresh, /state\.results\.some\(\(r\) => r\.id === held\)\) showWay\(held\)/);
  assert.match(refresh, /history\.replaceState\(\{ v: 'card' \}/);
});

test('the menu holds the keyboard as well as the screen', () => {
  // The backdrop stops a finger and nothing else. Tab walked off the last
  // choice onto #c-top, whose keydown makes Enter, Space and ArrowRight take
  // the room, so a reader could accept a room while looking at a menu.
  const menu = bodyOf('attachMenu');
  assert.match(menu, /const behind = \['sheet', 'way', 'ask'\]/);
  assert.match(menu, /for \(const id of behind\) \$\(id\)\.inert = on/);
  assert.match(menu, /for \(const id of behind\) \$\(id\)\.inert = false/);
  // And a touch press on the backdrop must not click through: the compat click
  // is hit-tested after the panel has gone, so it would land on the row under it.
  assert.match(menu, /e\.preventDefault\(\);\n\s*show\(false\)/);
});

test('the photograph is redrawn when its box changes', () => {
  // drawWarp sizes the bitmap to the canvas box once, on decode, and CSS
  // stretches it to fill from then on. The install rail mounts seconds after
  // boot and the sheet gives up its height, so the room lost 9% of its own at
  // 393x852. Rotation is the same failure, larger.
  const paint = bodyOf('paintCard');
  assert.match(paint, /new ResizeObserver\(/);
  assert.match(paint, /again\.disconnect\(\)/);
  // Guarded on the size actually differing, because observe() fires once on its
  // own and the draw is 240 drawImage calls.
  assert.match(paint, /if \(now === box\) return;/);
});

test('a verdict cannot fire onto a screen the reader has already left', () => {
  // The 200ms is the card sliding off. A back gesture inside it lands on the
  // question, and the timer then dragged the reader forward to a room.
  const swipe = bodyOf('attachSwipe');
  assert.match(swipe, /if \(state\.screen !== 'card'\) return;/);
});

test('the deck is ranked before the screen that shows it', () => {
  // The other way round, paintCard() ran once against the previous answer. On
  // the first duration of a session that is no rows at all, so the reader got
  // "That is all of them. You went through 0 rooms", and focusHeading() moved
  // focus onto a heading answer() then replaced, dropping a keyboard reader on
  // the body.
  const choose = bodyOf('choose');
  assert.ok(
    choose.indexOf('answer();') < choose.indexOf('showCard();'),
    'choose() paints the card before it has an answer to paint',
  );
});

test('a zero-room answer is not rendered as an exhausted card deck', () => {
  const paint = bodyOf('paintCard');
  const empty = paint.indexOf('if (seen === 0)');
  const exhausted = paint.indexOf('That is all of them.');
  assert.ok(empty >= 0 && empty < exhausted, 'the zero-answer branch must run before the exhausted-deck copy');
  assert.match(paint.slice(empty, exhausted), /emptyAnswer\(\)/);
  assert.match(bodyOf('emptyAnswer'), /No room is free for.*Try a shorter time/s);
});

test('a full photo cache does not throw away a photograph that arrived', () => {
  // 306 photographs at 39 KB is 11.7 MB of a quota nothing here caps, and a
  // QuotaExceededError inside the try discarded a response the phone was
  // already holding.
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const fn = sw.slice(sw.indexOf('async function immutable('), sw.indexOf('\n}', sw.indexOf('async function immutable(')));
  assert.match(fn, /data\.put\(request, response\.clone\(\)\)\.catch\(\(\) => \{\}\)/);
  assert.ok(
    fn.indexOf('} catch {') < fn.indexOf('data.put('),
    'the cache write is still inside the try that swallows it',
  );
});

test('every screen that leaves the room screen puts the compass down', () => {
  // The two deviceorientation listeners are bound while the room screen's
  // needle is live, and they close over nodes the next repaint replaces. Every
  // exit has to call orientationOff, and the way is an exit that does not go
  // through showPane: take a room, tap its lit row, press Point me, go back.
  for (const fn of ['showPane', 'showAsk', 'showWay', 'repaintRoom']) {
    assert.match(bodyOf(fn), /orientationOff\(\)/, `${fn} walks off with the compass still bound`);
  }
});

test('taking a room shows the way to it, and the calendar is what it leaves out', () => {
  // By the time you have said yes the day as a calendar is not the question,
  // and which way to walk is. The other ROOMS are a different matter: they are
  // in the sheet underneath, one tap from moving the arrow.
  assert.match(bodyOf('acceptCard'), /openWay\(r\.id\)/);
  assert.match(bodyOf('openWay'), /history\.pushState/);
  const way = bodyOf('showWay');
  assert.match(way, /for \(const pane of PANES\) \$\(pane\)\.hidden = pane !== 'list'/);
  assert.match(way, /\$\('sheet'\)\.hidden = false/);
  assert.match(way, /markRows\(\)/);
  // The room the arrow points at is the one that is lit, so the camera composes
  // for the same band the list leaves.
  assert.equal(REST.way, PEEK, 'the way frames the map for a sheet that is not the list\'s');

  // And tapping another row moves the plate with the arrow, rather than leaving
  // the headline naming a room the map is no longer pointing at.
  assert.match(bodyOf('select'), /if \(state\.screen === 'way'\) paintWay\(r\.id, r\)/);
});

test('a re-rank puts the deck back on top', () => {
  // "the third one" is a different room after the ranking moves, so the index
  // cannot survive it. answer() is where both screens are repainted.
  const ans = bodyOf('answer');
  assert.match(ans, /state\.cardIndex = 0;/);
  assert.match(ans, /paintCard\(\);/);
  assert.match(ans, /paintList\(\);/);
});

test('the sheet drag stands aside for the card', () => {
  // The card owns the horizontal gesture. Left in, a diagonal drag begun on it
  // becomes a sheet drag on its eighth pixel and throws the answer away
  // mid-swipe, which is the same defect the dismiss travel was narrowed for.
  const sheet = bodyOf('attachSheet');
  assert.match(sheet, /if \(e\.target\.closest\('\.c-card'\)\) return;/);
  const css = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.match(css, /\.c-card \{[^}]*touch-action: none/);
});

test('back names the screen it lands on, at every step of the answer', () => {
  // Its accessible name has to name the screen it reaches rather than reading
  // "Back", and there are three steps now: the card is what a duration opens,
  // the list is one tap behind the card, and a room is behind either.
  assert.match(
    bodyOf('showCard'),
    /\$\('back'\)\.setAttribute\('aria-label', 'Back to the question'\)/,
  );
  // The list is reached from the card and, through the menu, from the way, so
  // its label is a pair rather than a string.
  assert.match(bodyOf('openList'), /pushState\(\{[^}]*from: state\.screen/);
  assert.match(
    bodyOf('showList'),
    /from === 'way'\s*\?\s*'Back to the way'\s*:\s*'Back to the card'/,
  );
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /id="back"[^>]*aria-label="Back to the question"/);
  // The four .opt buttons are what back lands on, and they are the four the
  // chips used to duplicate.
  for (const min of ['30', '60', '120', 'day']) {
    assert.match(html, new RegExp(`class="opt[^"]*" data-min="${min}"`), `the ${min} choice is gone`);
  }
});

// ---- the night gate

// Nothing in this file pinned a word of the night screen before these. The
// buildings screen said "Everything is closed right now." and the question
// screen said nothing at all, so the copy could rot without a test noticing.

const TERM = HOURS.terms['autumn-2026-classroom-pool-building-schedule'];
const DOORS = (code, day) => TERM.buildings[code]?.hours[day];
const COUNTS = roomsPerBuilding(INDEX);
const BUSY = busyDayOf(CURRENT, INDEX);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HERE = { lat: 39.99944, lon: -83.01502 }; // the Thompson Library steps
const opening = (day, nowMin) =>
  nextOpening({ buildings: SLICE, counts: COUNTS, hoursFor: DOORS, day, nowMin });

test('weekend room needs return suitable rooms only where building hours allow them', () => {
  const all = Object.entries(INDEX.rooms).map(([id, room]) => ({ id, ...room }));
  const matching = filterRoomsByPreferences(all, { minSeats: 20, features: ['whiteboards'] });
  assert.ok(matching.length > 0);
  for (const [date, day] of [['2026-09-19', 6], ['2026-09-20', 0]]) {
    assert.ok(matching.some((room) => DOORS(room.b, day) === null), 'the filter includes some closed buildings');
    const rows = rank(matching, {
      origin: HERE, now: 12 * 60, day, needed: 60, buildings: SLICE,
      hoursFor: DOORS, sessions: INDEX.sessions, date,
    });
    assert.ok(rows.length > 0, `${date} has no usable matching room`);
    for (const row of rows) {
      const room = INDEX.rooms[row.id];
      assert.ok(room.cap >= 20 && room.features.includes(44), row.id);
      assert.notEqual(DOORS(room.b, day), null, `${row.id} is in a published-closed building`);
    }
  }
});

// A date walked forward by whole days, at a wall-clock minute.
const on = (d, plus, min = 0) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + plus, Math.floor(min / 60), min % 60);

// firstDoor in js/app.js, minus the short name. The calendar lives at the call
// site because data/buildings-hours.json is weekly and knows no holidays.
const firstDoor = (now) => {
  const first = opening(now.getDay(), now.getHours() * 60 + now.getMinutes());
  if (!first) return null;
  const day = on(now, (first.day - now.getDay() + 7) % 7);
  return closedDayFor(isoDate(day), CURRENT, INDEX)?.state === 'offices-closed' ? null : first;
};

// The gate as paintGate builds it, against the shipped index and hours table.
const gateAt = (now) => {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return unscheduledGate({
    now,
    current: CURRENT,
    index: INDEX,
    busyDay: BUSY,
    opening: firstDoor(now),
    openNow: openDoorCount({ counts: COUNTS, hoursFor: DOORS, day: now.getDay(), nowMin }),
  });
};

// Whether the app answers at all is a fact about the DATE. Each date is asked
// once; weekend searches use the engine's 7am-11pm window while ordinary days
// use the measured class window.
const dayCache = new Map();
const dayFacts = (d) => {
  const iso = isoDate(d);
  if (!dayCache.has(iso)) {
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const start = weekend ? 420 : BUSY.earliestStart;
    const end = weekend ? 1380 : BUSY.latestEnd;
    const ranked = resolveState({ now: on(d, 0, 12 * 60), current: CURRENT, index: INDEX }).ranked;
    dayCache.set(iso, {
      ranked, start, end,
      covers: roomSearchOn({ now: on(d, 0, start), current: CURRENT, index: INDEX, ranked, busyDay: BUSY }),
    });
  }
  return dayCache.get(iso);
};
const isGateMinute = (d, m) => {
  const day = dayFacts(d);
  return day.ranked && !(day.covers && m >= day.start && m < day.end);
};

// For every gate minute in the range: read the sentence the way a person would,
// turn that into a date and minute, and check whether the app will really rank
// then. The sentence is checked against the search boundary, not the weekday
// mask used to write it.
function walkGate(from, to, step) {
  const wrong = [];
  const silent = [];
  let visited = 0;
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    for (let m = 0; m < MINUTES_IN_DAY; m += step) {
      if (!isGateMinute(d, m)) continue;
      const now = on(d, 0, m);
      visited += 1;
      const body = gateAt(now).body;
      const cut = body.indexOf('Vacant ranks rooms again');
      if (cut < 0) {
        silent.push(isoDate(now));
        continue;
      }
      // The clause's own day word wins; "today" means today; and with neither,
      // the last day named before it carries over, because two adjacent
      // sentences are read as one thought.
      const clause = body.slice(cut);
      const before = DAYS.filter((x) => body.slice(0, cut).includes(x));
      const own = DAYS.find((x) => clause.includes(x));
      const name = own ?? (/ today at /.test(clause) ? null : (before[before.length - 1] ?? null));
      const time = clause.match(/at (\d{1,2}):(\d{2})(am|pm)/);
      if (!time) {
        wrong.push(`${isoDate(now)} ${clock(m)}: no search time in ${body}`);
        continue;
      }
      const atMin = (Number(time[1]) % 12 + (time[3] === 'pm' ? 12 : 0)) * 60 + Number(time[2]);
      let target = null;
      for (let ahead = 0; ahead < 7 && !target; ahead++) {
        if (ahead === 0 && m >= atMin) continue;
        const c = on(now, ahead, atMin);
        if (name === null ? ahead === 0 : DAYS[c.getDay()] === name) target = c;
      }
      const day = target && dayFacts(target);
      if (!day?.ranked || !day.covers || atMin < day.start || atMin >= day.end) {
        wrong.push(`${isoDate(now)} ${clock(m)}: ${body}`);
      }
    }
  }
  return { visited, wrong, silent };
}

test('the first door after 11:40pm on a Monday is not one that opened this morning', () => {
  // PAES at 5:00am is the earliest opening the Autumn table holds on any
  // weekday, and it is 5h20 the wrong side of the minute being asked about.
  const first = opening(1, 23 * 60 + 40);
  assert.equal(first.day, 2, 'Tuesday');
  assert.equal(first.opensAt, 300);
  assert.match(first.name, /PAES/);
  assert.equal(first.ties, 1);
  assert.equal(openingPhrase(first, 1), `On Tuesday ${first.name} opens at 5:00am`);
});

test('three doors share 7:00am on a Saturday, and the sentence says so', () => {
  const first = opening(6, 180);
  assert.equal(first.day, 6, 'later the same morning, not Monday');
  assert.equal(first.opensAt, 420);
  assert.equal(first.name, 'Hitchcock Hall');
  assert.equal(first.ties, 3);
  const also = Object.keys(COUNTS).filter((c) => DOORS(c, 6)?.[0] === 420);
  assert.deepEqual(also.sort(), ['072', '274', '338']);
  assert.equal(openingPhrase(first, 6), 'Hitchcock Hall and 2 more open at 7:00am');
});

test('a Sunday afternoon door is named on the day it opens', () => {
  const first = opening(0, 900);
  assert.equal(first.opensAt, 960);
  assert.equal(first.name, 'Pomerene Hall');
  assert.equal(first.ties, 1);
  assert.equal(openingPhrase(first, 0), 'Pomerene Hall opens at 4:00pm');
});

test('no hours table means no door, not a guessed one', () => {
  assert.equal(nextOpening({ buildings: SLICE, counts: COUNTS, hoursFor: () => undefined, day: 1, nowMin: 0 }), null);
  assert.equal(nextOpening({ buildings: SLICE, counts: {}, hoursFor: DOORS, day: 1, nowMin: 0 }), null);
  assert.equal(nextOpening({ buildings: SLICE, counts: COUNTS, day: 1, nowMin: 0 }), null);
  assert.equal(openingPhrase(null, 1), null);
});

test('every minute of the week, the first door is still ahead of you', () => {
  // The whole point of the function. A door that opened this morning is not a
  // door you can walk to now, and printing one is the bug the row phrases in
  // js/app.js already record fixing once.
  let checked = 0;
  for (let day = 0; day < 7; day++) {
    for (let m = 0; m < MINUTES_IN_DAY; m++) {
      const first = opening(day, m);
      assert.ok(first, `no door found at day ${day} minute ${m}`);
      if (first.day === day) assert.ok(first.opensAt > m, `day ${day} minute ${m} named ${first.opensAt}`);
      checked += 1;
    }
  }
  assert.equal(checked, 7 * MINUTES_IN_DAY);
});

test('the doors published on each weekday are what the walk crosses a day for', () => {
  // The measurement the nextOpening header rests on. Saturday is the thin day
  // and Sunday is not far behind it, which is why the walk steps days at all.
  const published = [0, 1, 2, 3, 4, 5, 6].map(
    (d) => Object.keys(COUNTS).filter((c) => Number.isFinite(DOORS(c, d)?.[0])).length,
  );
  assert.deepEqual(published, [11, 46, 46, 46, 46, 46, 5]);
  // From a Saturday night the answer is three doors at 7:00am on the Sunday.
  // Monday is unreachable from any Saturday minute, and Monday's own earliest
  // door is PAES on its own, so "46 of them opening Monday" was wrong twice.
  assert.deepEqual(opening(6, 1420), { code: '274', name: 'Hitchcock Hall', day: 0, opensAt: 420, ties: 3 });
  assert.equal(opening(1, 0).ties, 1);
  assert.match(opening(1, 0).name, /PAES/);
  // And the walk never needs more than one day boundary anywhere in the week.
  for (let day = 0; day < 7; day++) {
    for (let m = 0; m < MINUTES_IN_DAY; m++) {
      assert.ok((opening(day, m).day - day + 7) % 7 <= 1, `day ${day} minute ${m} walked past tomorrow`);
    }
  }
});

test('openDoorCount agrees with the group the buildings screen renders', () => {
  // The gate has no origin and must not need one to know whether campus is shut.
  // rankBuildings answers the same question for a reader standing somewhere, so
  // the two are held together across a week.
  for (let day = 0; day < 7; day++) {
    for (let m = 0; m < MINUTES_IN_DAY; m += 5) {
      const groups = rankBuildings({ origin: HERE, buildings: SLICE, counts: COUNTS, hoursFor: DOORS, day, nowMin: m });
      assert.equal(
        openDoorCount({ counts: COUNTS, hoursFor: DOORS, day, nowMin: m }),
        groups.open.length,
        `day ${day} minute ${m}`,
      );
    }
  }
  assert.equal(openDoorCount({ counts: COUNTS, hoursFor: undefined, day: 1, nowMin: 0 }), 0);
});

test('the day the gate promises rooms back is a day the app will actually rank on', () => {
  // The assertion busyDay.weekdays cannot make. It is a weekly Mon-Fri mask
  // built out of block counts with no calendar in it, so reading it alone named
  // Labor Day, Veterans Day, Thanksgiving and the day after the term ended:
  // 3,780 of the 94,665 gate minutes of Autumn 2026 at one minute resolution,
  // 3.99% before the weekend search. Quarter hours here because the gate walks
  // the calendar; the Labor Day weekend is walked minute by minute below.
  const walked = walkGate(new Date(2026, 7, 25), new Date(2026, 11, 20), 15);
  assert.equal(walked.visited, 4391);
  assert.deepEqual(walked.wrong, []);
  // The clause is dropped, not guessed, when there is no day left to name: the
  // term's last class meets on 2026-12-09 and the index holds nothing after it.
  assert.deepEqual([...new Set(walked.silent)], ['2026-12-09']);
});

test('every gated minute of the Labor Day weekend names a day it can rank on', () => {
  // Friday night now promises Saturday morning; Saturday night promises Sunday
  // morning; Sunday night skips the closed Labor Day and promises Tuesday.
  const walked = walkGate(new Date(2026, 8, 4), new Date(2026, 8, 6), 1);
  assert.equal(walked.visited, 1665);
  assert.deepEqual(walked.wrong, []);
  assert.deepEqual(walked.silent, []);
  assert.match(gateAt(new Date(2026, 8, 4, 23, 0)).body, /On Saturday .*rooms again at 7:00am\.$/);
  assert.match(gateAt(new Date(2026, 8, 5, 23, 0)).body, /On Sunday .*rooms again at 7:00am\.$/);
  assert.match(gateAt(new Date(2026, 8, 6, 23, 0)).body, /rooms again on Tuesday at 8:00am\.$/);
  assert.equal(
    resolveState({ now: new Date(2026, 8, 7, 8, 0), current: CURRENT, index: INDEX }).heading,
    'Labor Day, campus is closed',
  );
});

test('the gate names no door while a door is open', () => {
  // The buildings screen guards this sentence on groups.open.length and the gate
  // did not, so it named a future door while buildings were already open.
  // Weekend daytime is now a search window and no longer belongs in this walk.
  const week = new Date(2026, 8, 13); // Sunday 2026-09-13, an ordinary week
  let gateMinutes = 0;
  let openMinutes = 0;
  let named = 0;
  for (let d = 0; d < 7; d++) {
    for (let m = 0; m < MINUTES_IN_DAY; m++) {
      const now = on(week, d, m);
      if (!isGateMinute(now, m)) continue;
      gateMinutes += 1;
      const body = gateAt(now).body;
      const open = rankBuildings({
        origin: HERE, buildings: SLICE, counts: COUNTS, hoursFor: DOORS, day: now.getDay(), nowMin: m,
      }).open.length;
      if (open === 0) {
        if (/opens? at /.test(body)) named += 1;
        continue;
      }
      openMinutes += 1;
      assert.doesNotMatch(body, /opens? at /, `${DAYS[now.getDay()]} ${clock(m)} with ${open} open: ${body}`);
    }
  }
  assert.equal(gateMinutes, 4485);
  assert.equal(openMinutes, 1965);
  assert.equal(named, 2520, 'the door clause still fires on the minutes campus really is shut');
});

test('a registrar no-classes day is not read as an ordinary teaching day', () => {
  // Three weekdays the mask says yes to and the registrar publishes as closed to
  // classes. resolveState flags them and names them on the ranked screen, while
  // the gate said the opposite on both sides of the day: "Classes have not
  // started yet" in the morning, "Classes are done for the day" at night. 705
  // gate minutes on each of the three, 2,115 a term.
  for (const [iso, name] of [
    ['2026-10-15', 'Autumn Break'],
    ['2026-10-16', 'Autumn Break'],
    ['2026-11-25', 'Thanksgiving Break begins'],
  ]) {
    const [y, mo, d] = iso.split('-').map(Number);
    assert.equal(closedDayFor(iso, CURRENT, INDEX).state, 'no-classes');
    const noon = resolveState({ now: new Date(y, mo - 1, d, 12, 0), current: CURRENT, index: INDEX });
    assert.equal(noon.classesSuspended, true, iso);
    assert.ok(noon.note.startsWith(`${name}. No classes are meeting today,`), noon.note);
    for (const h of [3, 23]) {
      const body = gateAt(new Date(y, mo - 1, d, h, 0)).body;
      assert.ok(body.startsWith(`${name}. No classes are meeting today.`), `${iso} ${h}:00 said ${body}`);
    }
  }
  // A weekday with nothing on the calendar keeps the ordinary reading.
  assert.match(gateAt(new Date(2026, 8, 15, 3, 0)).body, /^Classes have not started yet\./);
  assert.match(gateAt(new Date(2026, 8, 15, 23, 0)).body, /^Classes are done for the day\./);
});

test('the gate says what the clock is doing without repeating its own button', () => {
  const button = 'Show nearest buildings';
  for (const [now, want] of [
    [new Date(2026, 8, 14, 23, 40), /^Classes are done for the day\./],
    [new Date(2026, 8, 15, 2, 0), /^Classes have not started yet\./],
    [new Date(2026, 8, 12, 3, 0), /^Few classes are scheduled today\./],
  ]) {
    const said = gateAt(now);
    assert.match(said.body, want);
    assert.equal(said.heading, `${DAYS[now.getDay()]}, ${clock(now.getHours() * 60 + now.getMinutes())}`);
    assert.equal(said.body.split('\n').length, 1, 'one line');
    assert.notEqual(said.heading, button);
    assert.ok(!said.heading.includes(button) && !button.includes(said.heading), said.heading);
    // docs/DECISIONS.md 2026-08-29 took the per-building room count off this
    // screen. This line is not a way back in.
    assert.doesNotMatch(said.body, /classroom|\d+ rooms?\b/);
  }
});

test('a Saturday predawn gate names the weekend room search and the first door', () => {
  const said = gateAt(new Date(2026, 8, 12, 3, 0));
  assert.equal(said.heading, 'Saturday, 3:00am');
  assert.equal(
    said.body,
    'Few classes are scheduled today. Hitchcock Hall and 2 more open at 7:00am ' +
      'and Vacant ranks rooms again at 7:00am.',
  );
  // 11:40pm on a Monday, the minute the whole screen was written for. The
  // Journalism Building publishes hours to midnight on weeknights, so one door
  // is open and the sentence does not offer tomorrow's.
  const night = gateAt(new Date(2026, 8, 14, 23, 40));
  assert.equal(night.heading, 'Monday, 11:40pm');
  assert.equal(night.body, 'Classes are done for the day. Vacant ranks rooms again on Tuesday at 8:00am.');
  assert.equal(openDoorCount({ counts: COUNTS, hoursFor: DOORS, day: 1, nowMin: 1420 }), 1);
});

test('the ranked clause says today when the door clause has named tomorrow', () => {
  // Two adjacent sentences are read as one thought, so a bare "at 8:00am"
  // sitting behind "On Wednesday" reads as Wednesday when it means 30 minutes
  // away. The shipped table never reaches this any more, because a door is
  // always open in the window that produced it, so it is driven from a door
  // handed in rather than looked up.
  const now = new Date(2026, 8, 15, 7, 30);
  const tomorrow = { code: '245', name: 'PAES', day: 3, opensAt: 300, ties: 1 };
  const said = unscheduledGate({ now, current: CURRENT, index: INDEX, busyDay: BUSY, opening: tomorrow, openNow: 0 });
  assert.equal(
    said.body,
    'Classes have not started yet. On Wednesday PAES opens at 5:00am. Vacant ranks rooms again today at 8:00am.',
  );
  // The same door today, and the two join into one sentence with one day word.
  const later = unscheduledGate({
    now,
    current: CURRENT,
    index: INDEX,
    busyDay: BUSY,
    opening: { ...tomorrow, day: 2, opensAt: 450 },
    openNow: 0,
  });
  assert.equal(later.body, 'Classes have not started yet. PAES opens at 7:30am and Vacant ranks rooms again at 8:00am.');
  // And with a door open there is no door clause and no day word to carry.
  const open = unscheduledGate({ now, current: CURRENT, index: INDEX, busyDay: BUSY, opening: tomorrow, openNow: 46 });
  assert.equal(open.body, 'Classes have not started yet. Vacant ranks rooms again at 8:00am.');
});

test('the closed group breaks a distance tie on which door opens first', () => {
  // A sort key that never moves a row is decoration, so it is measured, and the
  // figure is pinned here rather than left in a comment to rot. Over a 12x12
  // grid on the campus box at every quarter hour of every day: 2,836 of 96,768
  // closed lists come out in a different order, 2.93%, and no row moves more
  // than two places. The commonest case is Hagerty Hall over Arps Hall, 144 of
  // them, both a 12 minute walk and both 678 m out, Hagerty opening 6:00pm and
  // Arps shut for the day.
  //
  // 2,984, 3.08% and one place until 2026-09-15. Three things moved at once and
  // they do not pull the same way, so no one number here is readable alone: the
  // walk now ends at a building's nearest door rather than at its centroid,
  // which changes which buildings tie at all; the term slice was rebuilt from
  // 96 buildings to 46, which shortens every list; and it then grew back to 50
  // to keep the picker's shortcut bar alive. The grid is drawn off the slice's
  // bounding box, so the last of those moved every origin as well.
  //
  // What is worth watching is the last figure. A row can now move two places,
  // which means the slice has a tie run three buildings long where it used to
  // have none.
  const lats = Object.values(SLICE).map((b) => b.lat);
  const lons = Object.values(SLICE).map((b) => b.lon);
  const box = { s: Math.min(...lats), n: Math.max(...lats), w: Math.min(...lons), e: Math.max(...lons) };
  const byWalk = (a, b) => a.walk - b.walk || a.metres - b.metres;
  const order = Object.fromEntries(Object.keys(COUNTS).map((code, i) => [code, i]));
  let lists = 0;
  let moved = 0;
  let furthest = 0;
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 12; j++) {
      const origin = { lat: box.s + ((box.n - box.s) * i) / 11, lon: box.w + ((box.e - box.w) * j) / 11 };
      for (let day = 0; day < 7; day++) {
        for (let m = 0; m < MINUTES_IN_DAY; m += 15) {
          const { closed } = rankBuildings({ origin, buildings: SLICE, counts: COUNTS, hoursFor: DOORS, day, nowMin: m });
          lists += 1;
          // Only rows that tie on the walk can have moved, so the comparison is
          // run by run: inside each tie the walk alone would leave them in the
          // index's own order, and the sorted list says where they went.
          let move = 0;
          for (let i0 = 0; i0 < closed.length; ) {
            let j0 = i0;
            while (j0 + 1 < closed.length && byWalk(closed[j0], closed[j0 + 1]) === 0) j0 += 1;
            if (j0 > i0) {
              const run = closed.slice(i0, j0 + 1);
              const walkOnly = [...run].sort((a, b) => order[a.code] - order[b.code]);
              for (let k = 0; k < run.length; k++) move = Math.max(move, Math.abs(walkOnly.indexOf(run[k]) - k));
            }
            i0 = j0 + 1;
          }
          if (move > 0) moved += 1;
          furthest = Math.max(furthest, move);
          for (let k = 0; k + 1 < closed.length; k++) {
            const [a, b] = [closed[k], closed[k + 1]];
            assert.ok(byWalk(a, b) <= 0, 'the walk still leads');
            if (byWalk(a, b) !== 0) continue;
            // The key is the NEXT door. An `after` row's opensAt is the minute
            // it opened this morning and then locked, so keying on that put a
            // building shut for the rest of the day above one still to open:
            // four of those, all Sullivant Hall over Hagerty Hall on a Sunday
            // evening.
            assert.ok(
              a.when === 'before' || b.when !== 'before',
              `${a.code} (${a.when}) sorts above ${b.code} (${b.when}) at the same distance`,
            );
            if (a.when === 'before' && b.when === 'before') {
              assert.ok(a.opensAt <= b.opensAt, `${a.code} opens ${a.opensAt} above ${b.code} opens ${b.opensAt}`);
            }
          }
        }
      }
    }
  }
  assert.equal(lists, 96768);
  // 2,836 before #115. A row's metres are the metres WALKED now, which for the
  // fallback is the straight line times 1.30, so two buildings that rounded to
  // the same whole metre no longer always do. Fewer distance ties means the
  // opensAt tie-break has fewer lists to break.
  assert.equal(moved, 2010);
  // One place, which is what the comment in js/state.js has always claimed. It
  // was two while a row's metres were the straight line: two buildings tied on
  // rounded distance could sit either side of a third.
  assert.equal(furthest, 1);
});

// ---- the screens that say it

// Everything above is a pure function in js/state.js, and the bug in this
// branch's own title lives in js/app.js. These read the two files as text, the
// way dev.test.mjs and the container-query test already do, so putting any one
// of the screen changes back turns something here red.

test('paintGate says the night out loud instead of borrowing the buildings screen', () => {
  const app = readFileSync(join(ROOT, 'js/app.js'), 'utf8');
  const from = app.indexOf('function paintGate(');
  const gate = app.slice(from, app.indexOf('\n// ---', from));
  assert.ok(gate.length > 200, 'paintGate not found');
  assert.match(gate, /unscheduledGate\(\{/);
  assert.doesNotMatch(gate, /UNSCHEDULED\.(head|body)/, 'the buildings screen pair is back on the question screen');
  // Orange is a refusal, not a clock.
  assert.match(gate, /classList\.remove\('refusal'\)/);
  assert.match(gate, /classList\.add\('refusal'\)/);
  assert.ok(
    gate.indexOf("classList.remove('refusal')") < gate.indexOf('if (!s || s.ranked)'),
    'the class has to be cleared before the branch, or a gate hidden by a ranked minute keeps it',
  );
});

test('the gate card is only orange when it refuses', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const rules = html.slice(html.indexOf('\n  #gate {'), html.indexOf('#gate p {'));
  assert.match(rules, /border: 1px solid var\(--line\)/, '#gate wears --warn on every state again');
  assert.doesNotMatch(rules.slice(0, rules.indexOf('#gate.refusal')), /var\(--warn\)/);
  assert.match(rules, /#gate\.refusal \{ border-color: var\(--warn\); \}/);
  assert.match(rules, /#gate\.refusal h2 \{ color: var\(--warn\); \}/);
  // The two colours in docs/DECISIONS.md were read off the running app: Labor
  // Day at 2:00pm comes out rgb(255, 176, 46) and Monday at 11:40pm
  // rgb(29, 35, 44). These are the tokens they resolve from.
  assert.match(html, /--warn:\s*#ffb02e/i);
  assert.match(html, /--line:\s*#1d232c/i);
});

test('the question screen is repainted when the app comes back to the foreground', () => {
  // The gate heading is a live minute now. Left off this list, a card booted at
  // 11:40pm on a Monday still read "Monday, 11:40pm" at 10:00am on the Tuesday,
  // on a minute the app is willing to rank.
  const app = readFileSync(join(ROOT, 'js/app.js'), 'utf8');
  const hook = app.slice(app.indexOf("addEventListener('visibilitychange'"));
  assert.match(hook.slice(0, 600), /'ask'/);
  // And the card is in it too. It is what a duration opens now, so it is the
  // screen most sessions are actually looking at when the phone comes back.
  assert.match(hook.slice(0, 600), /'card'/);
});

test('the buildings screen names the door it is already holding the hours for', () => {
  const app = readFileSync(join(ROOT, 'js/app.js'), 'utf8');
  const near = app.slice(app.indexOf('function paintNear('), app.indexOf("$('near').innerHTML"));
  assert.match(near, /openingPhrase\(/);
  assert.match(near, /Everything is closed\. \$\{door\}\./);
  assert.match(near, /Everything is closed right now\./);
  // The nearest of the tied doors, not the first one the index reaches.
  assert.match(near, /groups\.closed\.find\(/);
  // And no door named at all on a day the university is shut.
  const first = app.slice(app.indexOf('function firstDoor('), app.indexOf('function paintNear('));
  assert.match(first, /closedDayFor\([\s\S]*?'offices-closed'/);
});

test('a focused heading does not wear the ring that means you can press it', () => {
  const app = readFileSync(join(ROOT, 'js/app.js'), 'utf8');
  assert.match(app, /el\.focus\(\{ preventScroll: true, focusVisible: false \}\)/);
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  // Scoped to h2, so anything else carrying tabindex="-1" keeps its ring.
  assert.match(html, /h2\[tabindex="-1"\]:focus-visible \{ outline: none; \}/);
});

// ---- the walk bound and the empty screen

// The off-campus gate, held to the data rather than to a memory of it.
//
// It shipped at 8 km, which is not a measurement of anything: it is nearly four
// times the distance past which no classroom is walkable, so the downtown origin
// in issue #60, 4.42 km out, got no note at all and a list whose first row was a
// 71 minute walk. The replacement is a walkability line, and the reason it must
// not be read as a campus boundary is in the building table.
test('the off-campus gate is a walk, and the file says which buildings sit outside it', () => {
  const src = readFileSync(join(ROOT, 'js', 'app.js'), 'utf8');
  const css = readFileSync(join(ROOT, 'index.html'), 'utf8');
  // The comment is prose and prose wraps, so it is read with its line breaks
  // folded out. The carriage return goes with them: git checks this tree out with
  // CRLF, so without it every figure that landed at the end of a line reads as
  // missing, which is how this test first failed.
  const said = src.replace(/\r?\n\s*\/\/ ?/g, ' ');
  const gate = Number(src.match(/^const OFF_CAMPUS_KM = ([\d.]+);$/m)[1]);
  assert.equal(gate, 2.2);

  // The app's own fallback point, and its own crude km, which is the number the
  // gate actually compares. It runs short of the engine's equirectangular
  // distanceMetres, so the walkability bound below is measured the engine's way
  // and the buildings the gate excludes are measured the gate's way.
  const oval = { lat: 39.9995, lon: -83.013 };
  const km = (b) => Math.hypot((b.lon - oval.lon) * 85, (b.lat - oval.lat) * 111);

  // What the flat conversion costs, at the origin issue #60 was filed from. The
  // comment in js/app.js prints both figures, so both are recomputed here.
  const downtown = { lat: 39.9612, lon: -82.9988 };
  assert.equal(Number(km(downtown).toFixed(2)), 4.42);
  assert.equal(Number((distanceMetres(oval, downtown) / 1000).toFixed(2)), 4.43);
  assert.ok(said.includes('4.42 km against 4.43 at the issue #60 origin'));

  // The analytic bound: the farthest building holding a room the ranking can
  // offer, plus the straight-line reach of MAX_WALK. The gate may sit above it
  // and must never sit below, or a student inside walking range is sent to the
  // Oval instead of to the room they could have walked to.
  const held = new Set(Object.values(INDEX.rooms).map((r) => r.b));
  const farthest = Math.max(...[...held].map((code) => distanceMetres(oval, SLICE[code]) / 1000));
  const reach = (MAX_WALK * WALK_MPM) / DETOUR / 1000;
  assert.equal(Number(farthest.toFixed(3)), 1.41, 'Animal Science, the farthest building with a room');
  assert.equal(Number(reach.toFixed(3)), 0.72, `${MAX_WALK} minutes of walking, straight line`);
  assert.ok(gate >= farthest + reach, `a ${gate} km gate is inside the ${(farthest + reach).toFixed(3)} km bound`);

  // The building the comment names, recomputed, so the sentence cannot rot away
  // from the table underneath it. Every one is OSU property and every one is
  // outside the gate, which is exactly why the note it prints is about the walk
  // and not about being off campus.
  //
  // Read off the FULL index, not the term slice. It was the slice until
  // 2026-09-15, when that file was rebuilt against its own room index for the
  // first time since 2026-08-27 and went from 96 buildings to 46. None of the
  // 46 sits outside the gate, so the slice can no longer carry this claim: it
  // is a list of classroom buildings now, not a sample of OSU property.
  const beyond = Object.entries(FULL)
    .map(([code, b]) => ({ code, name: b.name, lat: b.lat, lon: b.lon, km: km(b) }))
    .filter((b) => b.km > gate)
    .sort((a, b) => a.km - b.km);
  assert.equal(beyond.length, 268, 'buildings in the full index outside the gate');
  assert.ok(
    said.includes(`268 of the ${Object.keys(FULL).length} buildings`),
    'the count in the comment moved away from the full index',
  );
  // And the slice really does sit entirely inside it, which is the fact that
  // moved this assertion off the slice in the first place.
  assert.equal(
    Object.values(SLICE).filter((b) => km(b) > gate).length,
    0,
    'a term-slice building is outside the gate again, so the comment needs redoing',
  );
  const last = beyond[beyond.length - 1];
  assert.match(last.name, /Main St, 153 W/, 'the farthest building outside the gate moved');
  assert.ok(
    said.includes(`Main St, 153 W at ${last.km.toFixed(2)} km`),
    `js/app.js does not say "Main St, 153 W at ${last.km.toFixed(2)} km"`,
  );

  // And the note itself. "You are off campus" was a claim about geography the
  // table above disagrees with, and so was "nothing on campus is walkable": a
  // building outside the gate can still sit inside a MAX_WALK walk of another
  // one. What is airtight is the narrower claim below, that not one of them
  // holds a room the ranking can offer.
  for (const b of beyond) {
    // Through the app's own estimate, which is what this claim is about:
    // walkMinutes takes metres WALKED since #115, and the fallback that answers
    // for a point this far out is the straight line times DETOUR.
    //
    // The stricter bound a routed walk allows -- MAX_WALK x WALK_MPM = 936 m of
    // straight line, since pavement can only be longer -- admits five pairs,
    // the nearest being Scott Hall at 857 m. Reaching one needs a route with no
    // detour at all against a measured median circuity of 1.44, so the note
    // holds in practice and the gate is worth a second look on paper.
    // docs/research/walking-routes-115.md records both numbers.
    const near = Object.entries(SLICE).filter(
      ([code, o]) => code !== b.code && walkMinutes(distanceMetres(b, o) * DETOUR) <= MAX_WALK,
    );
    assert.equal(
      near.filter(([code]) => held.has(code)).length,
      0,
      `${b.name} can walk to a building holding a ranked room, so the note is a claim about classrooms and not about campus`,
    );
  }
  assert.ok(src.includes('No classroom close enough to walk to'));
  assert.ok(!src.includes('You are off campus'), 'the geography claim is back in js/app.js');
  assert.ok(!css.includes('You are off campus'), 'index.html still quotes the deleted sentence as live copy');
});

// The empty screen, and the sentence that used to call a busy room free.
//
// shape() builds `beyond` out of rows that cleared a 90 minute wait, so a room
// in it could be one that does not open for another hour and a half. Measured in
// the real app, pinned to 2026-09-15 09:00 at 40.0175, -83.013: it printed "148
// rooms are free further out, the nearest a 25 minute walk to Schoenbaum Hall",
// and Schoenbaum Hall did not open until 10:55am. 51 of the 148 were not free.
test('nothing the empty screen calls free is a room that has not opened yet', () => {
  const empty = bodyOf('emptyAnswer');

  // The count and the room in the sentence with "free" in it both come off
  // beyond, which shape() now holds to wait === 0.
  assert.match(empty, /\$\{far\.count\} room.* free further out, the nearest a/s);
  assert.match(empty, /const later = far\?\.waiting;/);
  // And the rooms that open later get their own sentence, which says when.
  assert.match(empty, /further out open.* the nearest a/s);
  assert.match(empty, /clock\(later\.nearest\.availableAt\)/);
  // The heading follows both, or a screen with only waiting rooms behind it
  // reads "Nothing open right now" over rooms that are open, just not yet.
  assert.equal((empty.match(/heading: 'Nothing close enough\.'/g) ?? []).length, 2);

  // The live region stops announcing a count over a screen that has none. It
  // used to say "297 rooms free, 0 shown" under "Nothing close enough."
  //
  // The count itself moved into engine.js tally() and is asserted below, in
  // "print and speech count free by one rule". What is left here is the half
  // this test is about: that the sentence is the free count and not state.total,
  // and that a screen with no rows does not get one at all.
  const spoken = APP.slice(APP.indexOf('  const free = state.tally'), APP.indexOf('// A name over 24 characters'));
  assert.match(spoken, /const free = state\.tally\.free;/, 'the spoken count is not the free count');
  assert.match(spoken, /state\.results\.length\s*\?/, 'a screen with no rows still announces a count');
});

// The rule itself is engine.js tally(), tested in engine.test.mjs over a
// fixture that carries an unknown-hours room. This is the other half, and it
// has to be a source test because there is no DOM here: that js/app.js still
// asks for the rule instead of writing it out a third time. The two counts sat
// three hundred lines apart and only the printed one tested published hours,
// which is how a screen reader was told "103 rooms free" on the screen built to
// say we do not know.
test('js/app.js counts free rooms through tally() and nowhere else', () => {
  const src = codeOnly(readFileSync(join(ROOT, 'js', 'app.js'), 'utf8'));
  const byHand = src.split('\n').map((l) => l.trim()).filter((l) => l.includes('wait === 0'));
  assert.deepEqual(byHand, [], 'a free count is spelled out again instead of reading state.tally');
  for (const line of [
    'state.tally = tally(state.results, usable);',
    'const free = state.tally.free;',
    'const { meets, shorter, waiting } = state.tally;',
  ]) {
    assert.ok(src.includes(line), `js/app.js no longer has: ${line}`);
  }
});

// Colour is not a state. Driven at 216ba00 with Accessibility.getFullAXTree at
// 393x852, the four came back `button "30 min" {}`, `button "1 hour" {}`,
// `button "2 hours" {}`, `button "rest of day" {}`, with nothing separating the
// chosen one from the other three. #76 made it live rather than theoretical:
// the remembered duration is restored on boot, so with vacant.duration set to
// "120" the accent fill lands on "2 hours" and the tree still says nothing.
//
// Toggle buttons, not a radio group. A radio group is a promise about the
// keyboard that this control does not keep: #85 deleted the roving tabindex and
// the arrow keys along with the chip bar, and all four are plain tab stops now.
test('the chosen duration is in the accessibility tree, not only in the fill', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const opts = [...html.matchAll(/<button class="opt[^"]*" data-min="[^"]*"[^>]*>/g)].map((m) => m[0]);
  assert.equal(opts.length, 4, 'the four duration buttons moved');
  assert.equal(
    opts.filter((b) => b.includes('aria-pressed="true"')).length,
    1,
    'exactly one duration button is authored as chosen',
  );
  for (const b of opts) assert.match(b, /aria-pressed="(true|false)"/, `no aria-pressed on ${b}`);
  // The one carrying the accent fill is the one carrying the state.
  assert.match(opts.find((b) => b.includes('primary')), /aria-pressed="true"/);

  // A radio role would announce arrow-key navigation the app does not
  // implement, so the group stays a group.
  assert.doesNotMatch(html, /role="radio(group)?"/, 'a radio role promises a keyboard model #85 removed');

  const src = codeOnly(readFileSync(join(ROOT, 'js', 'app.js'), 'utf8'));
  const paint = src.slice(src.indexOf('function paintDuration()'), src.indexOf('function firstDoor'));
  assert.match(paint, /setAttribute\('aria-pressed', String\(on\)\)/, 'paintDuration paints colour only');
  assert.match(paint, /classList\.toggle\('primary', on\)/, 'the fill and the state come off one boolean');
});

// A missing basemap costs the map and nothing else, which is only true if the
// black rectangle it leaves is explained. Driven at 216ba00 at 393x852 with
// data/campus.json blocked over CDP: the list answered with 38 rows, the canvas
// was hidden, the sheet rested with its top edge at y=528, and the 528px above
// it, 62.0% of the screen, said nothing. #53 named the sentence and it was
// never written.
test('a missing basemap says so above row one, in print and out loud', () => {
  const src = codeOnly(readFileSync(join(ROOT, 'js', 'app.js'), 'utf8'));
  assert.match(src, /const MAPLESS = 'No campus map on this phone yet\.';/, "#53's sentence is missing");
  // One constant with two readers, because a sentence written twice ends up
  // written two ways.
  assert.equal((src.match(/MAPLESS/g) ?? []).length, 3, 'MAPLESS has lost a reader or gained a copy');

  // The catch that hides the canvas is the thing that has to raise the flag.
  const catchBlock = src.slice(src.indexOf("$('map').hidden = true;"), src.indexOf('const current = await json'));
  assert.ok(catchBlock.length > 0, 'the basemap catch in boot() moved');
  assert.match(catchBlock, /state\.mapless = true;/, 'the canvas is hidden and nothing records why');

  // Printed as the same .strip the situation note uses, so it lands in the
  // reading order the list already has rather than in a component of its own.
  const notes = src.slice(src.indexOf('const notes = () =>'), src.indexOf('function paintList()'));
  assert.match(notes, /state\.mapless \? MAPLESS : ''/);
  assert.match(notes, /<p class="strip">/);

  // And said, on the one live region the contract allows, rather than on a
  // second one.
  assert.match(src, /state\.mapless \? MAPLESS : null,/, 'the notice is print-only');
  assert.equal(
    (readFileSync(join(ROOT, 'index.html'), 'utf8').match(/aria-live/g) ?? []).length,
    1,
    'docs/a11y-contract.md allows exactly one live region',
  );
});

// Nothing walkable from here is a state the app has to answer, not a screen it
// can leave the student on. Measured on Wed 2026-09-02 at 14:10 with a 30 minute
// ask, two origins 20 m apart on one bearing out of the Oval: at 2.190 km the
// screen had 0 rows and its only controls were Check again, What Vacant knows
// and the four duration chips, none of which can change a walk (the chip bar has
// since gone, with #85; the two buttons are what is left); at 2.210 km the
// same situation crossed OFF_CAMPUS_KM, fell back to the Oval and got 40
// tappable rows.
test('an origin with nothing walkable is answered, not left on a dead end', () => {
  const src = readFileSync(join(ROOT, 'js', 'app.js'), 'utf8');
  const branch = src.slice(src.indexOf('const stranded ='), src.indexOf('  // Nothing is selected until'));
  assert.ok(branch.length > 0, 'the stranded branch in answer() moved');

  // The predicate is the one shape() computes, not the circle.
  assert.match(branch, /const stranded = !state\.results\.length && state\.bounds\.beyond\.count > 0;/);
  // A located origin re-answers from the Oval, with the note the gate prints.
  assert.match(branch, /if \(stranded && state\.origin\?\.source === 'gps'\) \{\s*useOrigin\(ovalOrigin\(\), NO_WALK_OVAL\);\s*return answer\(\);/);
  // A hand-picked one keeps its coordinates and gets the note, which is what
  // carries #note-pick onto a screen whose other controls cannot help.
  assert.match(branch, /state\.origin\?\.source === 'picked'.*useOrigin\(state\.origin, stranded \? NO_WALK : null\)/s);
  // Both notes are the same sentence, so the two screens cannot drift apart.
  assert.match(src, /const NO_WALK = 'No classroom close enough to walk to';/);
  assert.match(src, /const NO_WALK_OVAL = `\$\{NO_WALK\}, showing from the Oval`;/);
  // And the gate still prints it, so the 2.19 km and 2.21 km screens agree.
  // The circle moved into offCampus() when the watch landed (#87), because it
  // now has to run on every accepted position rather than only the first one.
  // scripts/test/follow.test.mjs is what holds it on both paths.
  assert.match(src, /if \(offCampus\(here\)\) return finish\(oval, NO_WALK_OVAL\);/);
});

// Three invariants this change turns on, all read out of js/app.js because
// there is no DOM in this suite. Each one is a mutation that used to leave the
// whole suite green while putting back exactly the defect being removed.
test('soonest is read off the unfiltered rows, above the bound that would empty it', () => {
  const src = readFileSync(join(ROOT, 'js', 'app.js'), 'utf8');
  const soonest = src.indexOf('state.soonest = results');
  const bounds = src.indexOf('state.bounds = shape(usable);');
  assert.ok(soonest > 0, 'state.soonest no longer comes off the unfiltered rows');
  assert.ok(bounds > soonest, 'shape() now runs before soonest is taken');
  // `usable` is already filtered to wait <= MAX_WAIT_MIN, so taking soonest off
  // it filters wait > MAX_WAIT_MIN over an empty set and the "first one open"
  // sentence silently never appears again.
  assert.ok(!src.includes('state.soonest = usable'), 'soonest is taken off the filtered rows');
});

test('the footer spends the two counts the right way round', () => {
  const src = readFileSync(join(ROOT, 'js', 'app.js'), 'utf8');
  const foot = src.slice(src.indexOf('  const rest = state.bounds?.cap.rest'), src.indexOf('  list.innerHTML =\r\n    note +\r\n    strip +'));
  assert.ok(foot.length > 0, 'the footer moved');
  // rest is what the fold held back inside the walk bound; beyond is what the
  // bound itself removed. Swapped, the footer says the far rooms are the close
  // ones, which is the class of error this footer exists to stop.
  assert.match(foot, /const rest = state\.bounds\?\.cap\.rest \?\? 0;/);
  assert.match(foot, /const past = state\.bounds \? state\.bounds\.beyond\.count \+ state\.bounds\.beyond\.waiting\.count : 0;/);
  assert.match(foot, /const inside = rest \? `<b>\$\{rest\} more<\/b> within a \$\{MAX_WALK\} minute walk`/);
  assert.match(foot, /const outside = past\s*\?\s*`<b>\$\{past\} more<\/b> \$\{rest \? 'past it'/);
});

// ------- the origin bar, and the two refusal cards

test('the origin bar costs nothing on the screen a phone with a fix sees', () => {
  // The rule is lifted out of js/app.js and run. That file reaches for document
  // at import time, so it cannot be imported here, but the expression is pure,
  // so it is pulled out of the source and handed a state of its own.
  const app = readFileSync(join(ROOT, 'js', 'app.js'), 'utf8');
  const at = app.indexOf('const originBarOn = (screen) =>');
  assert.ok(at > 0, 'js/app.js no longer has an origin bar rule to pin');
  const barRule = new Function('state', `${app.slice(at, app.indexOf(';', at) + 1)} return originBarOn;`);
  const on = (state, screen) => barRule(state)(screen);
  const gps = { origin: { source: 'gps' }, originIsGuess: false };
  const picked = { origin: { source: 'picked', label: 'Enarson' }, originIsGuess: false };
  const oval = { origin: { source: 'oval' }, originIsGuess: true };

  // docs/DECISIONS.md cut this bar because it cost a full row at the top of the
  // most-used screen for everyone. A real position still pays nothing for it.
  assert.equal(on(gps, 'list'), false);
  assert.equal(on(gps, 'near'), false);
  assert.equal(on({ ...gps, dev: true }, 'list'), true, 'dev mode lost its bar');

  // The two origins the app chose FOR the student. A picked building is
  // otherwise permanent, with no visible way to say "no, use my location".
  assert.equal(on(picked, 'list'), true);
  assert.equal(on(picked, 'near'), true);
  assert.equal(on(oval, 'list'), true);

  // And nowhere else. The room screen, the picker and the question are not
  // places anyone corrects where they are standing.
  for (const screen of ['ask', 'room', 'pick', 'about']) {
    assert.equal(on(picked, screen), false, `the bar is on the ${screen} screen`);
  }

  // The rule is applied in both places the bar can change. showPane covers a
  // screen change; paintOriginBar covers the origin changing without one, which
  // is exactly what tapping the X does.
  const pane = app.slice(app.indexOf('function showPane(name)'), app.indexOf('function showList()'));
  assert.match(pane, /\$\('origin'\)\.hidden = !originBarOn\(name\)/);
  const paint = app.slice(app.indexOf('function paintOriginBar()'), app.indexOf('// ------', app.indexOf('function paintOriginBar()')));
  assert.match(paint, /\$\('origin'\)\.hidden = !originBarOn\(state\.screen\)/, 'clearing a picked origin leaves the row on screen');
});

test('a boot that failed stops the line that says it is still looking', () => {
  const css = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const spinner = css.indexOf('#ask:not(.ready) .loading');
  const failed = css.indexOf('#ask.failed .loading');
  assert.ok(spinner > 0, 'the loading rule is gone');
  assert.ok(failed > 0, 'nothing stops the loading line on a failed boot');
  // Both are one id and two classes, so source order is the whole of the win.
  assert.ok(failed > spinner, `the failed rule is at ${failed}, above the rule it has to beat`);
  assert.match(css.slice(failed, failed + 60), /opacity: 0/);
});

// The X is the undo for a picked origin, so it always goes. The ROW it sits in
// only goes when locate() came back with a real position: on the Oval fallback
// state.originIsGuess keeps the row up with the button gone. Measured headless
// at the shoot's clock and position with geolocation denied, guarding on the row
// put focus on document.body, which is the loss the guard is there to stop, on
// the branch a picked-origin user is most likely to be on.
test('clearing a picked origin moves focus to whichever control survives', () => {
  const app = readFileSync(join(ROOT, 'js', 'app.js'), 'utf8');
  const clear = app.slice(app.indexOf('function clearPickedOrigin()'), app.indexOf('function useOrigin('));
  assert.match(clear, /\$\('origin'\)\.hidden \? \$\('back'\) : \$\('origin-where'\)/);
  assert.match(clear, /\.focus\(\{ preventScroll: true \}\)/);
  // Guarding on the row alone is the bug, so it must not be what is written.
  assert.equal(
    /if \(\$\('origin'\)\.hidden\) \$\('back'\)\.focus/.test(clear),
    false,
    'the focus guard watches the row again, and the row survives the Oval fallback',
  );
});

// Both cards answer the same dead network, and which one gets there first
// changes run to run: measured 3 of 5 runs on a refused server and 2 of 3 on a
// stalled one. So both stand down for the other, not just the slower one.
test('the two refusal cards never end up stacked on each other', () => {
  const app = readFileSync(join(ROOT, 'js', 'app.js'), 'utf8');
  const first = readFileSync(join(ROOT, 'js', 'firstrun.js'), 'utf8');

  const failed = app.slice(app.indexOf('function bootFailed()'), app.indexOf("window.addEventListener('DOMContentLoaded'"));
  assert.match(failed, /if \(\$\('cold'\)\) return;/, 'bootFailed() paints under the first-run card');
  assert.ok(
    failed.indexOf("$('cold')") < failed.indexOf("$('gate').hidden = false"),
    'bootFailed() has already started painting before it checks',
  );

  // And the other order. js/firstrun.js says nothing behind its card is usable
  // or focusable; an enabled #gate-go underneath would make that false.
  const open = first.slice(first.indexOf('function open() {'), first.indexOf('function close() {'));
  assert.match(open, /getElementById\('gate'\)/, 'the cold card leaves the gate showing underneath it');
  assert.match(open, /gate\.hidden = true/);
});

test('a boot that never loaded says so, and offers the one button that can help', () => {
  const app = readFileSync(join(ROOT, 'js', 'app.js'), 'utf8');
  const failed = app.slice(app.indexOf('function bootFailed()'), app.indexOf("window.addEventListener('DOMContentLoaded'"));
  assert.match(failed, /'Could not load the schedule\.'/);
  assert.match(failed, /'Try again'/);
  assert.match(failed, /location\.reload\(\)/);
  // The four duration buttons are dead on this path, so they leave with the
  // question rather than sitting there dimmed under a refusal.
  assert.match(failed, /\$\('ask-q'\)\.hidden = true/);
  assert.match(failed, /classList\.add\('failed'\)/);
  assert.match(failed, /focusHeading\(\$\('gate-h'\)\)/);
});

// ---- the band each screen leaves

test('the strip the map composes for is the one that screen actually leaves', () => {
  // viewport() held a second copy of the resting height that said peek on every
  // screen, so the room screen framed the walk line for a 324px sheet and then
  // drew it under a 613px one: measured off the canvas at 393x852, 164 of the
  // 206px of target ink came out under the panel. These are the values, not the
  // spelling, so moving ROOM_SHEET moves this line.
  assert.equal(bandFor('room', 852), 239);
  assert.equal(bandFor('list', 852), 528);
  assert.equal(bandFor('near', 852), 528);
  assert.equal(bandFor('pick', 852), 187);
  assert.equal(bandFor('about', 852), 187);
  // The question screen has no sheet, so the whole canvas is the band.
  assert.equal(bandFor('ask', 852), 852);
  // A screen nobody wrote down rests where the ranked list does.
  assert.equal(bandFor('nowhere', 852), 528);
  // The install rail stands the sheet on top of it, so the map has that much
  // less. Left out, 112 of the room screen's 122px of walk line went back under
  // the panel with both bars up at 393x852.
  assert.equal(bandFor('room', 852, 147), 239 - 147);
  assert.equal(bandFor('list', 852, 80), 528 - 80);
  // A rail taller than the strip leaves nothing, and the camera still needs a
  // number it can divide by.
  assert.equal(bandFor('room', 852, 538), 1);
  assert.equal(restFor('room'), REST.room);
  assert.ok(REST.room > REST.list, `the room rests at ${REST.room}, the list at ${REST.list}`);
});

test('viewport() reads that one table rather than deciding a second time', () => {
  const src = readFileSync(join(ROOT, 'js', 'app.js'), 'utf8');
  const at = src.indexOf('function viewport()');
  const body = src.slice(at, src.indexOf('\n}', at));
  assert.match(body, /band: bandFor\(state\.screen, height, railHeight\(\)\)/);
  assert.equal(/state\.screen ===/.test(body), false, 'viewport() decides the resting height a second time');
  // And it does NOT ask whether anything is selected. The band is the strip the
  // map is looked at through, which is the targeted one on every screen; the
  // covered band is a strip nobody sees and clampView collapses on it.
  assert.equal(/state\.selected|targeted\(\)/.test(body), false, 'viewport() composes for a band nobody sees');
});

test('a sheet dragged on one screen does not become another screen height', () => {
  const H = 852;
  // Leaving a room used to keep its 613px sheet while the map had already been
  // composed for the list's 528px band, so the walk line was drawn under the
  // panel and the Back tap rescaled it 1.69x with the camera untouched.
  // The rest arrives in pixels now, worked out by restPxFor, because where a
  // screen rests is no longer a fraction of the viewport alone.
  assert.equal(openAt('list', { screen: 'room', h: 613 }, PEEK * H), REST.list * H);
  assert.equal(openAt('near', { screen: 'room', h: 613 }, PEEK * H), REST.near * H);
  // Staying on one screen keeps whatever height it was dragged to.
  assert.equal(openAt('list', { screen: 'list', h: 613 }, PEEK * H), 613);
  // Nothing dragged yet, so the screen's own rest.
  assert.equal(openAt('list', { screen: 'list', h: 0 }, PEEK * H), REST.list * H);
  assert.equal(openAt('room', null, REST.room * H), REST.room * H);
});

test('a screen change re-composes the camera for the strip it leaves', () => {
  // The one half of this that a suite with no layout engine can hold: that the
  // call is there. What it is worth was measured by driving the app at 393x852,
  // where the list frame after Back is the frame the list had before the room
  // was opened, walk line at y 197..402.5 either side and none of it under the
  // panel.
  const src = readFileSync(join(ROOT, 'js', 'app.js'), 'utf8');
  const pane = src.slice(src.indexOf('function showPane('), src.indexOf('function reframe()'));
  assert.match(pane, /const arrived = state\.screen !== name;/);
  assert.match(pane, /if \(arrived\) reframe\(\);/);
});

// ---- what a drag on the sheet means

test('only the grip can pull the sheet far enough to throw the answer away', () => {
  const H = 852;
  const peek = PEEK * H;
  const full = FULL_SHEET * H;
  // Every screen showing a map can still be pulled down to peek, so peek is
  // both the floor and the dismiss trigger on all of them. Reading the screen's
  // REST here instead moved both up with it: measured at 393x852, an 88px pull
  // on the room screen's grip went from sliding the sheet to 525 to throwing the
  // answer away, and the room and picker sheets stopped going down at all,
  // which puts their map band out of reach of a thumb.
  for (const screen of ['list', 'room', 'pick', 'about']) {
    assert.equal(lowPxFor(screen, H, 0, true), peek, `${screen} cannot be pulled down to the map`);
    const rest = restPxFor(screen, H, 0, true);
    const low = lowPxFor(screen, H, 0, true);
    assert.equal(sheetAfterDrag(rest, DISMISS_PX, 'grip', low, full).dismiss, rest === peek);
    assert.equal(sheetAfterDrag(rest, 400, 'pane', low, full).h, peek);
  }
  // Driven at 393x852, the 44px version dismissed on a 60px pull started on a
  // row: the sheet went 324 to 0 and took the list, the selection and the
  // scroll position with it. The pane's floor is peek however hard it is pulled.
  assert.equal(sheetAfterDrag(peek, 60, 'pane', peek, full).dismiss, false);
  const hard = sheetAfterDrag(peek, 400, 'pane', peek, full);
  assert.equal(hard.dismiss, false);
  assert.equal(hard.h, peek);
  // The grip owns the travel below peek, and the end of it is the trigger. 60px
  // is still short of it, which is the pull the row bug was measured on.
  assert.equal(sheetAfterDrag(peek, 60, 'grip', peek, full).dismiss, false);
  assert.equal(sheetAfterDrag(peek, DISMISS_PX - 1, 'grip', peek, full).dismiss, false);
  assert.equal(sheetAfterDrag(peek, DISMISS_PX, 'grip', peek, full).dismiss, true);
  // The sheet stops dead at the floor, so a harder pull lands on it, not past.
  assert.equal(sheetAfterDrag(peek, 400, 'grip', peek, full).h, floorFor('grip', peek));
  // Upward, both stop at the cap.
  assert.equal(sheetAfterDrag(peek, -900, 'grip', peek, full).h, full);
});

test('a covered map has no travel to pull the sheet through, only a dismiss', () => {
  // The one screen where the floor is NOT peek. It rests at its own ceiling and
  // there is nothing under it to uncover, so all three numbers are one number: a
  // pull short of the dismiss travel goes nowhere, and the grip still reaches
  // the end and throws the list away, which is how Back has always worked here.
  const H = 852;
  const rest = restPxFor('list', H, 0, false);
  const cap = capFor('list', H, 0, false);
  const low = lowPxFor('list', H, 0, false);
  assert.equal(rest, cap, 'the covered list rests below its own ceiling');
  assert.equal(low, rest, 'the covered list can be pulled below where it rests');
  assert.equal(sheetAfterDrag(rest, 60, 'pane', low, cap).h, rest);
  assert.equal(sheetAfterDrag(rest, 60, 'pane', low, cap).dismiss, false);
  assert.equal(sheetAfterDrag(rest, 60, 'grip', low, cap).dismiss, false);
  assert.equal(sheetAfterDrag(rest, DISMISS_PX, 'grip', low, cap).dismiss, true);
  // And it cannot be pushed up past where it already is.
  assert.equal(sheetAfterDrag(rest, -400, 'pane', low, cap).h, cap);
});

test('the two floors are how far down the sheet goes and the end of the grip travel', () => {
  const H = 852;
  assert.equal(floorFor('pane', PEEK * H), PEEK * H);
  assert.equal(floorFor('grip', PEEK * H), PEEK * H - DISMISS_PX);
  // Pixels in, pixels out: it took a viewport height and assumed PEEK, which
  // stopped holding the moment a screen could cover the map.
  const covered = lowPxFor('list', H, 0, false);
  assert.equal(floorFor('pane', covered), covered);
  assert.equal(floorFor('grip', covered), covered - DISMISS_PX);
});

// ---- the map is only on screen when it has an answer on it

test('a screen with nothing on the map covers it until a row is tapped', () => {
  // The complaint this came from, in numbers: at 393x852 the list rested at
  // peek and left a 528px band of campus carrying nothing but the blue dot,
  // which is 62% of the screen spent on a picture of where the reader already
  // is. Tapping a row is what puts something on that canvas, so tapping a row
  // is what uncovers it.
  for (const screen of ['list', 'near', 'room', 'pick', 'about']) {
    assert.equal(restFor(screen, false), COVER, `${screen} still leaves a map band`);
    assert.equal(restFor(screen, true), REST[screen]);
  }
  // The question screen is the exception twice over: no sheet, and a blurred
  // drifting background rather than a map anybody reads.
  assert.equal(restFor('ask', false), REST.ask);

  // Defaulted to targeted, so every caller written before this existed reads
  // the table it always read.
  assert.equal(restFor('list'), REST.list);

  // The band does NOT follow. It is the strip the map is looked at through, so
  // it stays the targeted one while the screen is covering it -- otherwise the
  // camera composes for 68px nobody sees, and clampView collapses on that band
  // and forces the centre to the middle of the basemap. Composing for 528 while
  // covered is what makes the reveal a finished frame.
  assert.equal(bandFor('list', 852), 528);
  assert.equal(bandFor('list', 852, 80), 528 - 80);
});

test('the covered sheet stops where the back button and the install rail are', () => {
  // FULL left 187px of empty ground above the list at 393x852, which is two
  // rows of rooms spent on nothing now that there is no map behind it. The only
  // thing still up there is the back button, and the install rail stands the
  // sheet on top of itself, so the two come out of one subtraction.
  const H = 852;
  assert.equal(capFor('list', H, 0, false), H - BACK_PX);
  assert.equal(capFor('list', H, 79, false), H - 79 - BACK_PX);
  // COVER is the ceiling on the fraction, so a tall screen does not run the
  // sheet to within 76px of the top of a tablet.
  assert.equal(capFor('list', 2000, 0, false), COVER * 2000);
  // Floored at PEEK, not at FULL. FULL is a HEIGHT and the rail sits under it,
  // so flooring there put the sheet's top edge above the back button once the
  // rail passed 134px and off the screen entirely past 187 -- the failure this
  // cap exists to stop, reintroduced by its own guard. Checked as the property
  // that matters rather than as a number: the button always clears the sheet.
  assert.equal(capFor('list', H, 600, false), PEEK * H);
  for (const rail of [0, 80, 111, 134, 187, 300]) {
    const top = H - rail - capFor('list', H, rail, false);
    assert.ok(top >= BACK_PX, `a ${rail}px rail leaves the sheet's top edge at ${top}`);
  }
  // Nothing moves while the map is on screen.
  assert.equal(capFor('list', H, 0, true), FULL_SHEET * H);
  assert.equal(capFor('room', H, 0, true), FULL_SHEET * H);
  // And a screen rests at the smaller of its fraction and that cap.
  assert.equal(restPxFor('list', H, 0, false), H - BACK_PX);
  assert.equal(restPxFor('list', H, 0, true), PEEK * H);
  assert.equal(restPxFor('room', H, 0, true), REST.room * H);
});

test('the map class is written in one place, off the same pair the sheet reads', () => {
  // Two places deciding "is the map on screen" is how a class ends up one
  // screen behind the sheet it is meant to agree with. paintMap() is the only
  // writer, setSheet() is where every screen change and every selection lands,
  // and showAsk() is the one transition that hides the sheet instead of sizing
  // it, so it says so itself.
  const writers = [...APP.matchAll(/classList\.toggle\('nomap'/g)];
  assert.equal(writers.length, 1, `'nomap' is written in ${writers.length} places`);
  assert.match(bodyOf('paintMap'), /state\.screen !== 'ask' && !targeted\(\)/);
  assert.match(bodyOf('setSheet'), /paintMap\(\);/);
  assert.match(bodyOf('showAsk'), /paintMap\(\);/);

  // And the class has a rule, or the whole thing is a no-op nobody notices.
  const css = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.match(css, /body\.nomap #map \{[^}]*opacity: 0/);
  // Untouchable as well as invisible: a pan on a canvas nobody can see still
  // latches state.userMoved, which is what stops frame() from ever fitting the
  // pair again for the rest of the session.
  assert.match(css, /body\.nomap #map \{[^}]*pointer-events: none/);
});

test('every place that drops the selection re-rests the sheet', () => {
  // There are two, and only one of them goes through showList(). A re-rank
  // clears it in answer(), and a re-rank can happen with a row lit: the Check
  // again button in the list footer and the visibilitychange handler both call
  // refresh() without asking followAction first. Driven at 393x852 before this
  // line existed, both ways in: the row went dark and the sheet stayed at 324
  // over a canvas with nothing left on it, which is the band this whole change
  // removes. Now 776, or 708 with the install rail up.
  for (const fn of ['answer', 'showList']) {
    const body = bodyOf(fn);
    const cleared = body.indexOf('state.selected = null');
    assert.ok(cleared > 0, `${fn} no longer clears the selection`);
    assert.match(
      body.slice(cleared),
      /sheetHeight\(\)|showPane\('list'\)/,
      `${fn} drops the selection without re-resting the sheet`,
    );
  }
  // The question screen has no sheet to rest, and setSheet would stamp its name
  // on sheetScreen.
  assert.match(bodyOf('answer'), /if \(state\.screen !== 'ask'\) sheetHeight\(\);/);
});

test('the sheet asks where it rests rather than assuming peek and full', () => {
  // Every height in js/app.js used to be written against PEEK or FULL, neither
  // of which knows whether anything is on the map. restNow() and capNow() do,
  // and both constants are gone from the imports so a new call site cannot
  // quietly go back to the old answer.
  assert.match(bodyOf('setSheet'), /Math\.max\(floorFor\('grip', lowNow\(\)\), Math\.min\(capNow\(\), px\)\)/);
  const imports = APP.slice(0, APP.indexOf("from './sheet.js'"));
  assert.doesNotMatch(imports, /PEEK|FULL/, 'js/app.js imports a constant it stopped needing');
  assert.equal(/restFor\(state\.screen\)/.test(APP), false, 'a call site still ignores the selection');
});

test('a height dragged over a lit room is not restored over a covered map', () => {
  const H = 852;
  const rest = restPxFor('list', H, 0, false);
  // Back out of a room and the selection is gone with it, so the 324px sheet
  // the list was dragged to would come back over a canvas with nothing on it:
  // the empty band, restored by the one path that skips the rest.
  assert.equal(openAt('list', { screen: 'list', h: 324 }, rest, false), rest);
  // With a room still lit it is that screen's height and it keeps it.
  assert.equal(openAt('list', { screen: 'list', h: 324 }, PEEK * H, true), 324);
  // And a screen nothing was dragged on opens where it rests.
  assert.equal(openAt('list', { screen: 'room', h: 613 }, PEEK * H, true), PEEK * H);
});

test('the gesture asks js/sheet.js instead of deriving the rule again', () => {
  // Two copies of "how far is far enough" is how a threshold meant for the grip
  // came to fire on a drag that started on a row.
  const src = readFileSync(join(ROOT, 'js', 'app.js'), 'utf8');
  assert.match(src, /sheetAfterDrag\(drag\.h0, dy, drag\.from, lowNow\(\), capNow\(\)\)/);
  assert.equal(src.includes('DISMISS_PX'), false, 'app.js names the dismiss distance a second time');
});

test('the click toggle reads travel, not net displacement', () => {
  const move = APP.slice(APP.indexOf('sheet.addEventListener(\'pointermove\''), APP.indexOf('const end = (e) =>'));
  const end = APP.slice(APP.indexOf('const end = (e) =>'), APP.indexOf('sheet.addEventListener(\'pointerup\', end)'));
  // lastY is the LAST sample because the velocity term needs it to be, so
  // `lastY - y0` is net displacement and any out-and-back reads as a press.
  // Measured in Chromium at 390x844 before this latch existed: a 60px pull on
  // the grip returned to its start snapped the sheet 321 -> 658, and the same
  // gesture begun on a row collapsed it 780 -> 321. Both were no-ops on main.
  assert.doesNotMatch(end, /lastY\s*-\s*drag\.y0|drag\.lastY\s*-/, 'the toggle is measuring net displacement again');
  assert.match(move, /Math\.abs\(dy\) >= 8\) drag\.travelled = true/, 'nothing latches the 8px any more');
  assert.match(end, /const moved = drag\.travelled/, 'the toggle stopped reading the latch');
  // A latch that is cleared mid-gesture is not a latch.
  assert.equal((APP.match(/drag\.travelled = /g) || []).length, 1, 'travelled is written more than once');
  // pointercancel is the platform taking the gesture, not the user releasing it.
  assert.match(end, /const released = e\.type === 'pointerup'/, 'a cancelled press can toggle the sheet');
  assert.match(end, /if \(!moved && released\)/, 'the toggle branch does not require a release');
});

test('the departmental label is a caveat, not the loudest thing on the row', () => {
  const dept = APP.slice(APP.indexOf('function deptOf('), APP.indexOf('const WALK_ICON'));
  assert.ok(dept.length > 0, 'deptOf is gone');
  // `.r-win b` is --fg at weight 650 and it belongs to the free-window: the
  // promise the row makes. windowOf and seatsOf emit plain text, so bolding the
  // reason a room ranks LOW would make it the only emphasised token on the row.
  assert.doesNotMatch(dept, /<b[\s>]/, 'the label is bold, and it outshouts the window it sits beside');
  assert.match(dept, /&middot; departmental/, 'the label lost the separator the seat count uses');
  // It carried a class nothing ever styled.
  assert.doesNotMatch(APP, /r-dept/, 'the dead style hook is back');
  assert.equal(readFileSync(join(ROOT, 'index.html'), 'utf8').includes('r-dept'), false);
  // Spoken, because "departmental" next to a seat count is a word with no
  // sentence around it. deptOf says so in as many words.
  assert.match(dept, /not a general-assignment room/, 'the row stopped writing the label out');
});

test('the room screen says the label as fully as the row it came from', () => {
  // The row's spoken name expands the word; landing on the room is not a reason
  // for a reader to hear less than the list already told them.
  const at = APP.indexOf("room.ga === false");
  assert.ok(at > 0, 'the room screen no longer carries the label');
  const line = APP.slice(at, at + 220);
  assert.match(line, /class="sr"/, 'the room screen prints the bare word with no sentence around it');
  assert.match(line, /not a general-assignment room/, 'and the sentence is not the one the row uses');
});

test('room needs stay optional and closed on the one-question screen', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const details = html.slice(html.indexOf('<details id="needs"'), html.indexOf('</details>', html.indexOf('<details id="needs"')));
  assert.ok(details.length > 0, 'the Room needs disclosure is gone');
  assert.doesNotMatch(details, /<details[^>]*\sopen(?:\s|>)/, 'optional room needs open over the duration question');
  assert.match(details, /id="need-seats"[^>]*type="number"[^>]*min="1"[^>]*max="999"/);
  assert.match(details, /id="need-features"/, 'the published feature choices have nowhere to render');
});

test('room requirements filter before ranking and never guess missing details', () => {
  const answer = APP.slice(APP.indexOf('function answer()'), APP.indexOf('// A name over 24 characters'));
  assert.match(answer, /filterRoomsByPreferences\(allRooms, state\.preferences\)/);
  assert.ok(
    answer.indexOf('filterRoomsByPreferences') < answer.indexOf('rank(rooms, ask)'),
    'ranking runs before the room requirements are applied',
  );
  assert.match(APP, /Missing room details do not count as a match/);
  assert.match(APP, /data-act="clear-needs"/, 'a zero-result filter has no way out');
});

test('furniture choices wait for published data while minimum seats works now', () => {
  const availability = APP.slice(APP.indexOf('function paintNeedsAvailability()'), APP.indexOf('function attachNeeds()'));
  assert.match(availability, /state\.featureCoverage\.known === 0/);
  assert.match(availability, /input\.disabled = !state\.ready \|\| state\.featureCoverage\.known === 0/);
  assert.match(availability, /Minimum seats works now/);
  // Boot used to enable every disabled descendant of #ask. That would turn the
  // furniture controls on even when no room carries the field yet.
  assert.doesNotMatch(APP, /querySelectorAll\('#ask \[disabled\]'\)/);
  assert.match(APP, /querySelectorAll\('#ask \[data-min\]\[disabled\]'\)/);
});

test('changing room needs invalidates a list reached with browser Forward', () => {
  const change = APP.slice(APP.indexOf('function changeNeeds()'), APP.indexOf('function paintNeedsAvailability()'));
  assert.match(change, /state\.preferencesDirty = true/);

  const pop = APP.slice(APP.indexOf("window.addEventListener('popstate'"), APP.indexOf('// Coming back to the foreground'));
  assert.match(pop, /v === 'list'/);
  assert.match(pop, /if \(state\.preferencesDirty\) answer\(\)/);
});

test('a broader room filter cannot keep the previous fallback warning', () => {
  const answer = APP.slice(APP.indexOf('function answer()'), APP.indexOf('// A name over 24 characters'));
  const firstPaint = answer.indexOf('paintList();');
  assert.ok(answer.indexOf('state.rung = null') < firstPaint);
  assert.ok(answer.indexOf('state.relaxed = false') < firstPaint);
  assert.ok(answer.indexOf('state.preferencesDirty = false') < firstPaint);
});
