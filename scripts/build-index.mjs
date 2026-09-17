#!/usr/bin/env node
// Turn a harvest into data/rooms-<term>.json, the file the phone holds offline.
//
// Usage:  node scripts/build-index.mjs 1268
//         node scripts/build-index.mjs 1268 --dry-run
//         node scripts/build-index.mjs 1264 --no-pointer
//
// Split out of fetch-rooms.mjs deliberately, against the issue's "fetch-rooms
// writes two files". A full harvest costs about 680 requests against a
// university's API, and every schema change to the index would otherwise mean
// paying that again to see the result. Reading the committed harvest instead
// makes the inversion free to iterate on, and it is the same input either way.

import { gunzipSync } from 'node:zlib';
import { rename, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatFunnel,
  isPseudoRoom,
  isRealRoom,
  isUnplaceable,
  newCounter,
  toMinutes,
} from './lib/funnel.mjs';
import { collectMeetings, projectMeeting } from './fetch-rooms.mjs';
import {
  MIXED_COURSE,
  buildSessions,
  expandMeeting,
  mergeIntervals,
  propagateGroups,
} from './lib/rooms.mjs';
import {
  classify,
  DROP,
  MAX_CAMPUS_M,
  MIN_WEEKLY_MEETINGS,
  TYPE_WORDS,
} from './lib/room-safety.mjs';
import { indexRefusals, measure, notReady } from './lib/index-guards.mjs';
import { refusalMessage } from './guards.mjs';
import {
  closedDays,
  daysBetween,
  diffCalendars,
  lowConfidence,
  parseFinalsWindow,
  parseFiveYear,
  examWindow,
  parseIcs,
  termWindow,
} from './lib/calendar.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The detailed two-source file is a build input, not a boot asset. Only the
// Registrar's compact numeric characteristics are needed for room requirements.
// A new term without a matching feature harvest leaves the field absent, which
// the app treats as unknown rather than falsely claiming a room lacks a feature.
export function attachRoomFeatures(rooms, document, term) {
  if (String(document?._meta?.term) !== String(term)) return 0;
  let attached = 0;
  for (const [id, room] of Object.entries(rooms)) {
    const codes = document.rooms?.[id]?.registrar?.codes;
    if (!Array.isArray(codes)) continue;
    if (!codes.every((code) => Number.isInteger(code) && code >= 0 && code <= 999)) {
      throw new Error(`invalid Registrar characteristics for ${id}`);
    }
    room.features = [...new Set(codes)].sort((a, b) => a - b);
    attached++;
  }
  return attached;
}

// The Thompson Library steps, the middle of the Oval. Same point the
// screenshots are taken from, so "distance from campus" means one thing in this
// repo and not two.
const OVAL = { lat: 39.99944, lon: -83.01502 };

// Haversine, in metres. A copy of the engine's, because the build must not
// import a browser module and 12 lines is cheaper than a shared package.
// Returns null for a building with no usable coordinate, which is the same
// answer as "no opinion" to the caller.
function metresFromOval(building) {
  if (!building || !Number.isFinite(building.lat) || !Number.isFinite(building.lon)) return null;
  const rad = (d) => (d * Math.PI) / 180;
  const p1 = rad(OVAL.lat);
  const p2 = rad(building.lat);
  const dp = rad(building.lat - OVAL.lat);
  const dl = rad(building.lon - OVAL.lon);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

// Bookings with no recoverable weekday get their clock window blocked on all
// seven days, so a handful of them is honest and a flood of them would delete
// the index. This counts BOOKINGS, which is what the guard compares against,
// not the deduped slots they collapse into. Measured off stats.unplaceableBookings
// on the three archives: 0 in 1268, 8 in 1264 (all of them Dreese Lab 280), 1
// in 1262. Twenty is above anything seen and below anything that matters.
const MAX_UNPLACEABLE = 20;

const TERM_NAMES = { 2: 'Spring', 4: 'Summer', 8: 'Autumn' };

// How many days a term is allowed to close, by the last digit of the term code.
//
// A parser that quietly returns nothing looks exactly like a term with no
// holidays, so the count is bounded on both sides rather than floored. Each
// bound is a real parse of the Registrar's five-year view plus or minus two,
// and an unknown digit refuses instead of defaulting to something generous.
//
// digit 2 measures LOW on purpose. Spring 2026 parses as one closed day,
// Martin Luther King Jr. Day, because the five rows of Spring Break are labelled
// "Spring Break" and nothing else. Those five days really are class-free and
// Vacant will call them busy, which is wrong in the safe direction. Extending
// the phrase list is what moves this bound, not a bigger number here. See
// DECISIONS.md.
const CLOSED_DAY_BOUNDS = {
  2: [1, 3], // Spring. Measured 1 on 1262, and see the note above.
  4: [1, 5], // Summer. Measured 3 on 1264: Memorial Day, Juneteenth, July 3.
  8: [5, 9], // Autumn. Measured 7 on 1268.
};

// How far a holiday may have slid between the two sources before the build
// stops calling it the ICS generator's known defect.
//
// The ICS is a third-party regeneration of the Registrar's calendar and it is
// wrong in two of the three seasons, every year on file. Measured 2026-08-27
// against all fifteen columns of the five-year view:
//
//   Autumn 2023-2027   0 disagreements, and all five exam windows identical
//   Spring 2024-2028   2 disagreements a year, exam window 1 to 6 days off
//   Summer 2024-2028   2, 4, 6, 6 and 2, exam window 1 to 6 days off
//
// Every one of those 30 lines is a PAIR. The ICS names the right holiday and
// dates it wrong: Memorial Day on Sunday May 31, Juneteenth on Thursday June
// 18, MLK Day on Sunday January 18. A university does not close its offices on
// a Sunday.
//
// Giving a source measured wrong a veto is how Spring and Summer ended up with
// no path to a shipped index at all. So a slid holiday is reported and the
// Registrar's date ships; a disagreement the slide does not explain is still
// fatal, in every season. Autumn gets 0 because it has never needed more.
const ICS_SHIFT_DAYS = { 2: 7, 4: 7, 8: 0 };

function die(message) {
  console.error(`\nFATAL  ${message}`);
  process.exit(1);
}

// 1268 -> Autumn 2026. The last digit is the term and the middle two are the
// year offset from 1900, so 126 is 2026.
export function termName(term) {
  const season = TERM_NAMES[Number(term.slice(3))];
  const year = 1900 + Number(term.slice(0, 3));
  return season ? `${season} ${year}` : null;
}

async function writeAtomic(path, text) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

// Read the vendored calendar and work out what the class API will not say: the
// days nothing meets, and the week of finals after the last day of instruction.
//
// Every refusal in here is a build failure rather than a warning, because the
// alternative is shipping a grid that is confidently wrong on 12 of the term's
// 83 weekdays.
export function calendarFor(term, name, { ics, fiveYear, finals }) {
  const year = Number(name.split(' ')[1]);
  const column = name.toUpperCase();

  const icsEvents = parseIcs(ics);
  if (!icsEvents.length) die('data/vendor/academic.ics parsed to zero events.');
  const registrar = parseFiveYear(fiveYear, column);
  if (!registrar.length) die(`the five-year view has no ${column} column, or its tables moved.`);

  const window = termWindow(registrar);
  if (!window) die(`the five-year view gave no ${column} teaching window.`);

  const season = Number(term.slice(3));
  const bounds = CLOSED_DAY_BOUNDS[season];
  const tolerance = ICS_SHIFT_DAYS[season];
  if (!bounds || tolerance === undefined) {
    die(`term ${term} has an unknown season digit, so nothing here knows what to expect of it.`);
  }

  // The publisher of record ships. The ICS is a third-party regeneration and
  // gets to raise its hand, not to decide.
  const closed = closedDays(registrar, [window.first, window.last]);
  const { shifted, unexplained } = diffCalendars(registrar, icsEvents, [window.first, window.last], {
    tolerance,
  });
  if (unexplained.length) {
    die(
      `the Registrar and the vendored ICS disagree on ${unexplained.length} date(s) inside ` +
        `${name}, and a slid holiday does not explain it. Neither is picked automatically:\n` +
        unexplained.map((d) => `         ${d}`).join('\n'),
    );
  }
  for (const line of shifted) {
    console.warn(`  warn  the vendored ICS slid ${line}. The Registrar's date ships.`);
  }
  if (closed.length < bounds[0] || closed.length > bounds[1]) {
    die(
      `${closed.length} closed day(s) for ${name}, outside the ${bounds[0]} to ${bounds[1]} ` +
        'bound for this season. Either the calendar moved or the parser did.',
    );
  }
  for (const day of closed) {
    if (day.date < window.first || day.date > window.last) {
      die(`closed day ${day.date} is outside ${window.first} to ${window.last}.`);
    }
  }

  // Three sources for one week, and a silent disagreement here sends someone
  // into a final.
  //
  // The finals page is preferred because it is the only one carrying the
  // time-of-day matrix, but it is the Registrar's LIVE page and it disappears
  // when the term does, so an expired term falls back to the five-year view.
  // That is the same publisher, and the matrix is deliberately unused: it is
  // useless without the exam ROOM, which lives in a Final Assignment List the
  // Registrar still marks coming soon.
  let exams = finals ? parseFinalsWindow(finals, year) : null;
  if (finals && !exams) die(`the ${name} finals page parsed to zero exam days.`);
  if (!exams) console.warn(`  warn  no ${name} finals page, using the five-year view for the exam window`);

  // The five-year view is the same publisher as the finals page, so those two
  // must be identical. The ICS is the third party and its window slides in the
  // same two seasons and by the same handful of days as its holidays do, so it
  // gets the same tolerance.
  for (const [label, events, slack] of [
    ['five-year view', registrar, 0],
    ['vendored ICS', icsEvents, tolerance],
  ]) {
    const other = examWindow(events, window.last);
    if (!other) die(`the ${label} gave no ${name} exam window.`);
    if (!exams) {
      exams = other;
      continue;
    }
    const slip = Math.max(
      Math.abs(daysBetween(other.start, exams.start)),
      Math.abs(daysBetween(other.end, exams.end)),
    );
    if (slip > slack) {
      die(
        `${name} exam window disagrees. ${finals ? 'finals page' : 'five-year view'}=` +
          `${exams.start}..${exams.end}, ${label}=${other.start}..${other.end}`,
      );
    }
    if (slip) {
      console.warn(
        `  warn  the ${label} puts ${name} finals at ${other.start} to ${other.end}, ${slip} ` +
          `day(s) off ${exams.start} to ${exams.end}. The Registrar's window ships.`,
      );
    }
  }

  // The exam window has to start after the last day of instruction, or an exam
  // block and a class block are the same thing and neither state means anything.
  if (exams.start <= window.last) {
    die(
      `${name} finals start ${exams.start}, on or before the last day of instruction ` +
        `${window.last}.`,
    );
  }

  return {
    closed,
    exams: { start: exams.start, end: exams.end },
    lowConfidence: lowConfidence(registrar, [window.first, window.last]),
    instruction: [window.first, window.last],
  };
}

// Invert harvested meeting records into room -> when it is busy.
//
// Pure and exported so the whole inversion can be tested on hand-built records
// without a 0.5 MB harvest on disk. main() below only reads files, prints and
// refuses.
export function invert(records, { isKnownBuilding, safety } = {}) {
  // Sessions are built from the rows that SURVIVE the funnel, not from all
  // 27,074 harvested meetings. Building them from everything emitted 12
  // sessions of which only 10 were referenced by any busy tuple: two came from
  // online and room-less sections and carried zero blocks. Since `instruction`
  // is min/max over sessions, current.json then claimed the term starts
  // 2026-08-03 when the earliest real classroom booking is 2026-08-10, a week
  // of "in term" with no room in the index holding a single block.
  const counter = newCounter();
  const kept = records.filter((r) => isRealRoom(r.m, r, counter, { isKnownBuilding }));

  // Real occupancy in a real room with no weekday anywhere in the payload. The
  // funnel drops these because they cannot be placed; the index picks them back
  // up because a room we know is used must not read free. See DECISIONS.md.
  const unplaceable = records.filter((r) => isUnplaceable(r.m, { isKnownBuilding }));

  // Sessions come from both lists. An unplaceable booking is a real booking, so
  // a room reachable only through one still needs its date pair on the table.
  const sessions = buildSessions([...kept, ...unplaceable]);
  const sessionIndex = new Map(sessions.map(([s, e], i) => [`${s}|${e}`, i]));

  const rooms = {};
  let intervalsIn = 0;
  let noSession = 0;

  // Course labels, interned once for the whole term.
  //
  // "BUSML 4382" is 10 bytes and the term names 2,836 distinct courses across
  // 9,462 blocks, so a table plus an integer per block is 3.3 references per
  // string. Writing the label into every tuple instead costs the difference for
  // nothing.
  //
  // Sorted at the end, not in insertion order, because insertion order is
  // harvest order and the committed file has to be a function of the schedule
  // rather than of the order the API answered in.
  const courseSeen = new Map();
  const courseOf = (record) => {
    const subject = record.subject;
    const number = record.catalogNumber;
    if (!subject || !number) return null;
    const label = `${subject} ${number}`;
    if (!courseSeen.has(label)) courseSeen.set(label, courseSeen.size);
    return label;
  };

  const sessionOf = (record) => {
    const m = record.m;
    return sessionIndex.get(`${m.startDate ?? record.startDate}|${m.endDate ?? record.endDate}`);
  };

  const roomFor = (m) => {
    const id = m.facilityId;
    if (!rooms[id]) {
      rooms[id] = {
        // The raw buildingCode. It is NOT reconstructable from facilityId:
        // room "N048" becomes SON0048, and buildingCode 148 maps to both SOE
        // and SON, so 331 of 1813 meetings disagree.
        b: m.buildingCode,
        n: m.room ?? null,
        // The raw facilityCapacity, including 0. 0 means unknown and 998 means
        // online; neither is a real seat count and neither is invented here.
        cap: Number.isFinite(m.facilityCapacity) ? m.facilityCapacity : null,
        type: m.facilityType ?? null,
        group: m.facilityGroup === true,
        busy: [],
      };
    }
    // facilityGroup can be true on any one of a room's meetings.
    if (m.facilityGroup === true) rooms[id].group = true;
    return rooms[id];
  };

  for (const record of kept) {
    const m = record.m;
    const si = sessionOf(record);
    // The one silent drop in an otherwise fully instrumented pipeline. A row
    // that passed the funnel and then vanishes has to move a number, or a
    // partial upstream drift empties whole rooms while the funnel still prints
    // a healthy usable count.
    if (si === undefined) {
      noSession++;
      continue;
    }

    const label = courseOf(record);
    const expanded = expandMeeting(
      m,
      toMinutes(m.startTime),
      toMinutes(m.endTime),
      si,
      label == null ? MIXED_COURSE : courseSeen.get(label),
    );
    intervalsIn += expanded.length;
    roomFor(m).busy.push(...expanded);
  }

  // Block an unplaceable booking on every day of its session.
  //
  // The alternative is the bug this exists to kill: Dreese Lab 280 reading free
  // through four Summer lab slots it is actually teaching in. Over-blocking
  // costs a student a room that was free on four of the five days. Under-
  // blocking walks them into a class. Only one of those is a lie in the
  // direction this app promises never to lie in.
  //
  // Seven days rather than Monday to Friday because nothing in the row says the
  // booking is on a weekday. Weekend meetings are rare (0.12% of day-expanded
  // blocks in 1268, 3.31% in 1264) but they are not zero, and rare is not a
  // fact about this particular row.
  let unplaceableBookings = 0;
  for (const record of unplaceable) {
    const m = record.m;
    const si = sessionOf(record);
    if (si === undefined) {
      noSession++;
      continue;
    }
    const start = toMinutes(m.startTime);
    const end = toMinutes(m.endTime);
    const room = roomFor(m);
    const label = courseOf(record);
    const ci = label == null ? MIXED_COURSE : courseSeen.get(label);
    if (!room.unplaceable) room.unplaceable = [];
    room.unplaceable.push([start, end, si]);
    for (let day = 0; day < 7; day++) room.busy.push([day, start, end, si, ci]);
    intervalsIn += 7;
    unplaceableBookings++;
  }

  // Cross-listed sections repeat the identical booking, so DL0280's four Summer
  // slots arrive as eight rows. Same dedupe the busy list gets, one level up.
  const unplaceableIds = [];
  for (const id of Object.keys(rooms)) {
    const room = rooms[id];
    if (!room.unplaceable) continue;
    unplaceableIds.push(id);
    const seen = new Map();
    for (const u of room.unplaceable) seen.set(u.join('|'), u);
    room.unplaceable = [...seen.values()].sort((a, b) => a[2] - b[2] || a[0] - b[0] || a[1] - b[1]);
  }
  unplaceableIds.sort();

  let dropped = 0;
  let merges = 0;
  for (const id of Object.keys(rooms)) {
    const result = mergeIntervals(rooms[id].busy);
    rooms[id].busy = result.intervals;
    dropped += result.dropped;
    merges += result.merges;
  }

  const { down, up } = propagateGroups(rooms);

  // `own` is scaffolding for idempotent propagation and must not ship.
  for (const room of Object.values(rooms)) delete room.own;

  // The safety filter runs LAST, after group propagation.
  //
  // MALC0100 is a facilityGroup parent typed 6F, which is hidden, and its two
  // halves are typed separately. Dropping the parent first would take its
  // booking with it and leave a half reading free during a class held in the
  // whole room, which is the one thing propagateGroups exists to prevent.
  const safetyStats = safety ? applySafety(rooms, safety) : null;

  // Dropping rooms can strand a whole session. Autumn 2026's 7W1 window
  // 2026-08-24 to 2026-10-09 belongs entirely to nine LAW sections in Drinko
  // Hall, and Drinko is a restricted building, so after the filter no busy tuple
  // points at it. A stranded session is not cosmetic: `instruction` is min and
  // max over the session list, so it stretches the term the app thinks it is in.
  const live = pruneSessions(rooms, sessions);
  const courses = pruneCourses(rooms, [...courseSeen.keys()]);

  return {
    rooms,
    sessions: live,
    courses,
    counter,
    safety: safetyStats,
    stats: {
      intervalsIn,
      dropped,
      merges,
      down,
      up,
      noSession,
      unplaceableBookings,
      unplaceableIds,
    },
  };
}

// Drop course labels nothing points at any more, sort what is left, and
// renumber. Mutates the course index inside every busy tuple.
//
// Sorted rather than left in insertion order for the same reason the room keys
// are sorted: insertion order is harvest order, and a rebuild that found no new
// class would otherwise rewrite the whole file and hide whether the data moved.
//
// The safety filter deletes whole rooms, so this runs after it. Autumn 2026
// names 2,836 courses before the filter.
export function pruneCourses(rooms, labels) {
  const used = new Set();
  for (const room of Object.values(rooms)) {
    for (const b of room.busy) {
      if (Number.isInteger(b[4]) && b[4] >= 0) used.add(labels[b[4]]);
    }
  }
  const live = [...used].filter(Boolean).sort();
  const renumber = new Map(live.map((label, i) => [label, i]));
  for (const room of Object.values(rooms)) {
    for (const b of room.busy) {
      if (!Number.isInteger(b[4]) || b[4] < 0) {
        b[4] = MIXED_COURSE;
        continue;
      }
      const at = renumber.get(labels[b[4]]);
      b[4] = at === undefined ? MIXED_COURSE : at;
    }
  }
  return live;
}

// Drop sessions nothing points at any more, and renumber what is left.
// Mutates the session index inside every busy and unplaceable tuple.
export function pruneSessions(rooms, sessions) {
  const used = new Set();
  for (const room of Object.values(rooms)) {
    for (const b of room.busy) used.add(b[3]);
    for (const u of room.unplaceable ?? []) used.add(u[2]);
  }
  if (used.size === sessions.length) return sessions;

  const live = [];
  const renumber = new Map();
  for (let i = 0; i < sessions.length; i++) {
    if (!used.has(i)) continue;
    renumber.set(i, live.length);
    live.push(sessions[i]);
  }
  for (const room of Object.values(rooms)) {
    for (const b of room.busy) b[3] = renumber.get(b[3]);
    for (const u of room.unplaceable ?? []) u[2] = renumber.get(u[2]);
  }
  return live;
}

// Drop every room a student should not be sent to, and flag what is left.
// Mutates `rooms` and returns what it did, so the build can print it.
//
// `metresFor` returns the distance from the Oval for a building code, or null.
// It is optional: a caller with no coordinate table skips the distance rule
// rather than dropping every room for having no distance.
export function applySafety(rooms, { gaRooms, restricted, metresFor, publishesHours } = {}) {
  const unknown = new Map();
  const kept = { shown: 0, secondary: 0 };
  const dropped = { type: 0, restricted: 0, offCampus: 0, farFromCampus: 0, thin: 0, noHours: 0 };
  const nonGa = [];
  const gaButHidden = [];
  // Every room the two new rules take out, named, so the build prints its own
  // evidence and nobody has to diff two 190 KB JSON files to see what moved.
  const cut = { farFromCampus: [], thin: [], noHours: [] };

  for (const id of Object.keys(rooms)) {
    const room = rooms[id];
    const why = {};
    const metres = metresFor ? metresFor(room.b) : null;
    const verdict = classify(
      {
        facilityId: id,
        facilityType: room.type,
        buildingCode: room.b,
        weeklyMeetings: room.busy?.length ?? null,
        metresFromOval: metres,
      },
      {
        gaRooms,
        restricted,
        unknown,
        why,
        // undefined, not false, when the caller has no hours table at all. The
        // rule then does not fire, the same way the evidence rule does not fire
        // without a GA list: a missing input is not a fact about the room.
        hoursKnown: publishesHours ? publishesHours(room.b) : undefined,
      },
    );
    if (!verdict) {
      if (gaRooms && gaRooms.has(id)) gaButHidden.push(`${id} type ${room.type}`);
      // Attributed by the rule that actually fired. The old code re-derived the
      // reason here and could only tell three of them apart.
      const reason = why.reason ?? DROP.type;
      dropped[reason]++;
      if (reason === DROP.farFromCampus) {
        cut.farFromCampus.push({ id, b: room.b, m: Math.round(metres) });
      }
      if (reason === DROP.thin) {
        cut.thin.push({ id, b: room.b, type: room.type, week: room.busy?.length ?? 0 });
      }
      if (reason === DROP.noHours) cut.noHours.push({ id, b: room.b });
      delete rooms[id];
      continue;
    }
    room.vis = verdict.vis;
    room.ga = verdict.ga;
    kept[verdict.vis]++;
    if (!verdict.ga) nonGa.push(id);
  }

  return { kept, dropped, unknown, nonGa, gaButHidden, cut };
}

// Rebuild a harvest from the committed page archive.
//
// data/harvest-<term>.json.gz is gitignored: it is regenerable from the API and
// changes every week. data/raw/<term>/ is committed, because 1262 and 1264 have
// left the API and cannot be refetched at any price. So on a fresh clone the
// only two terms that can never be re-fetched were also the only two that could
// not be built, which is backwards. The archive is the same pages the harvest
// was folded from, so folding them again reproduces it without a request.
//
// This is the union of every pass, exactly as fetch-rooms.mjs takes it: the
// pages already on disk are the passes, and meetingKey dedupes across them.
function harvestFromRaw(term) {
  const dir = join(ROOT, 'data', 'raw', term);
  if (!existsSync(dir)) return null;
  const pages = readdirSync(dir).filter((f) => f.endsWith('.json.gz')).sort();
  if (!pages.length) return null;

  const union = new Map();
  for (const f of pages) {
    collectMeetings(JSON.parse(gunzipSync(readFileSync(join(dir, f)))), union);
  }
  return {
    term,
    generated: null,
    source: `data/raw/${term}/, ${pages.length} archived pages`,
    meetings: [...union.values()].map(projectMeeting),
  };
}

async function main() {
  const term = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  // Writing current.json points the app at this term. Building an expired
  // archive for a diff should not do that, which is what --no-pointer is for.
  const noPointer = process.argv.includes('--no-pointer');
  if (!/^\d{4}$/.test(term ?? '')) {
    console.error('usage: node scripts/build-index.mjs <term> [--dry-run] [--no-pointer]');
    process.exit(2);
  }

  const harvestPath = join(ROOT, 'data', `harvest-${term}.json.gz`);
  const fromRaw = existsSync(harvestPath) ? null : harvestFromRaw(term);
  if (!existsSync(harvestPath) && !fromRaw) {
    die(
      `no harvest at data/harvest-${term}.json.gz and no page archive at ` +
        `data/raw/${term}/. Run fetch-rooms.mjs ${term} first.`,
    );
  }
  const buildingsPath = join(ROOT, 'data', 'buildings.json');
  if (!existsSync(buildingsPath)) die('data/buildings.json is missing.');

  // Both safety inputs are required. A missing file must not silently ship an
  // index with a dissection lab in it, so this refuses rather than filtering on
  // whatever it happens to have.
  const gaPath = join(ROOT, 'data', 'ga-rooms.json');
  if (!existsSync(gaPath)) {
    die(`data/ga-rooms.json is missing. Run fetch-ga-rooms.mjs ${term} first.`);
  }
  const restrictedPath = join(ROOT, 'data', 'restricted-buildings.json');
  if (!existsSync(restrictedPath)) die('data/restricted-buildings.json is missing.');
  const hoursPath = join(ROOT, 'data', 'buildings-hours.json');
  if (!existsSync(hoursPath)) {
    die('data/buildings-hours.json is missing. Run fetch-building-hours.mjs first.');
  }

  const icsPath = join(ROOT, 'data', 'vendor', 'academic.ics');
  const fivePath = join(ROOT, 'data', 'cache', 'registrar', 'academic-calendar-5-year-view.html');
  for (const p of [icsPath, fivePath]) {
    if (!existsSync(p)) die(`${p.slice(ROOT.length + 1)} is missing. Run fetch-calendar.mjs first.`);
  }

  const harvest = fromRaw ?? JSON.parse(gunzipSync(readFileSync(harvestPath)));
  if (fromRaw) {
    console.error(`no harvest on disk, folded ${harvest.meetings.length} meetings from ${harvest.source}`);
  }
  const buildings = JSON.parse(readFileSync(buildingsPath, 'utf8')).buildings;
  const isKnownBuilding = (code) => Object.prototype.hasOwnProperty.call(buildings, code);

  const gaFile = JSON.parse(readFileSync(gaPath, 'utf8'));
  const restrictedFile = JSON.parse(readFileSync(restrictedPath, 'utf8'));

  // The hours table for THIS term, picked by the slug rule js/app.js uses. A
  // term with no table would drop every room, which is a collapse and not a
  // filter, so it refuses instead.
  const hoursFile = JSON.parse(readFileSync(hoursPath, 'utf8'));
  const wantSlug = (termName(term) ?? '').toLowerCase().replace(/\s+/g, '-');
  // The empty-slug guard js/app.js carries, because this is the same rule. A
  // term whose season digit termName cannot read gives '', every slug
  // startsWith(''), and the first table in the file -- whichever term that is
  // -- would be applied as this term's doors: the noHours filter below drops
  // rooms on another term's published-closed days, and the warning that exists
  // for a missing table never prints. The run dies on the same unnameable term
  // further down; it should not have filtered anything first.
  const hoursSlug = wantSlug
    ? Object.keys(hoursFile.terms ?? {}).find((slug) => slug.startsWith(wantSlug))
    : undefined;
  // No table for this term is a MISSING INPUT, not a campus with no doors. The
  // Registrar publishes the current terms and takes old ones down, so the two
  // archived terms in data/raw/ have none and never will. Applying the rule
  // against nothing would drop all 425 rooms and call it a filter.
  //
  // Refusing outright is wrong for the same reason. It would mean an archived
  // term could no longer be rebuilt from the pages committed specifically so
  // that it could be, which is the one thing data/raw/ exists for.
  //
  // So: warn, skip the rule, and let the reader see it. The live term is
  // checked separately, by scripts/test/terms.test.mjs, because a live term
  // that quietly lost its doors is a different failure from an archived one
  // that never had them.
  const hoursTable = hoursSlug ? hoursFile.terms[hoursSlug] : null;
  if (!hoursTable) {
    console.warn(
      `  warn  data/buildings-hours.json has no table starting "${wantSlug}", so the ` +
        'published-hours rule is SKIPPED and rooms in undocumented buildings will ship.',
    );
  }

  const safety = {
    gaRooms: new Set(gaFile.rooms),
    restricted: new Set(Object.keys(restrictedFile.buildings)),
    metresFor: (code) => metresFromOval(buildings[code]),
    // The same term table the app picks, by the same rule, so a room can never
    // ship because the build read one term's doors and the phone read another's.
    publishesHours: hoursTable
      ? (code) => Object.prototype.hasOwnProperty.call(hoursTable.buildings, code)
      : null,
  };
  if (gaFile._meta?.term !== term) {
    console.warn(
      `  warn  data/ga-rooms.json was pulled for term ${gaFile._meta?.term}, building ${term}`,
    );
  }

  const { rooms, sessions, courses, counter, stats, safety: safetyStats } = invert(harvest.meetings, {
    isKnownBuilding,
    safety,
  });

  const roomCount = Object.keys(rooms).length;
  console.log(formatFunnel(counter));
  if (stats.unplaceableBookings) {
    console.log(
      `${stats.unplaceableBookings} booking(s) with no recoverable weekday, blocked on all ` +
        `seven days in ${stats.unplaceableIds.length} room(s): ${stats.unplaceableIds.join(' ')}`,
    );
  }
  console.log(
    `${roomCount} rooms, ${stats.intervalsIn} intervals in, ` +
      `${stats.dropped} exact duplicates dropped, ${stats.merges} merged, ` +
      `${stats.down} propagated to facilityGroup halves, ${stats.up} back to parents`,
  );
  console.log(`${sessions.length} sessions from observed date pairs`);
  if (stats.noSession) {
    console.warn(`  warn  ${stats.noSession} meeting(s) passed the funnel but matched no session`);
  }

  const { kept, dropped, unknown, nonGa, gaButHidden, cut } = safetyStats;
  const totalDropped = Object.values(dropped).reduce((a, b) => a + b, 0);
  console.log(
    `\nsafety filter: ${kept.shown} shown, ${kept.secondary} secondary, ` +
      `${totalDropped} dropped ` +
      `(${dropped.type} by type, ${dropped.restricted} in a restricted building, ` +
      `${dropped.offCampus} off campus, ` +
      `${dropped.farFromCampus} over ${MAX_CAMPUS_M} m from the Oval, ` +
      `${dropped.thin} under ${MIN_WEEKLY_MEETINGS} meetings a week and not general assignment, ` +
      `${dropped.noHours} in a building with no published hours)`,
  );
  for (const r of cut.farFromCampus) {
    console.log(`  too far: ${r.id} in building ${r.b}, ${r.m} m from the Oval`);
  }
  if (cut.thin.length) {
    const byBuilding = new Map();
    for (const r of cut.thin) byBuilding.set(r.b, (byBuilding.get(r.b) ?? 0) + 1);
    const worst = [...byBuilding].sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log(
      '  thin evidence, by building: ' +
        worst.map(([b, n]) => `${b}:${n}`).join(' ') +
        (byBuilding.size > worst.length ? ` and ${byBuilding.size - worst.length} more` : ''),
    );
  }
  console.log(
    `${nonGa.length} of ${kept.shown + kept.secondary} kept rooms are absent from ` +
      `data/ga-rooms.json and ship ga:false`,
  );
  // An unrecognised code is hidden, so this line is the only way the allow list
  // ever grows. Silence here means the code space has not moved.
  for (const [code, info] of [...unknown.entries()].sort((a, b) => b[1].rooms - a[1].rooms)) {
    console.log(`  new facilityType ${code}: ${info.rooms} room(s), for example ${info.example}`);
  }
  // The two sources disagreeing in the direction that costs us a room. Printed
  // rather than resolved: the Registrar schedules it, our type table hides it.
  for (const line of gaButHidden) {
    console.log(`  on the GA list but hidden by type: ${line}`);
  }

  if (stats.unplaceableBookings > MAX_UNPLACEABLE) {
    die(
      `${stats.unplaceableBookings} bookings have no recoverable weekday, over the ` +
        `${MAX_UNPLACEABLE} cap. Each one blocks its clock window on all seven days, so this ` +
        'many would delete the index rather than protect it. The upstream shape has moved: ' +
        'read the noWeekday stage in scripts/lib/funnel.mjs before raising the cap.',
    );
  }

  const name = termName(term);
  if (!name) die(`cannot name term ${term}. Refusing to guess rather than shipping a wrong label.`);

  const finalsPath = join(
    ROOT,
    'data',
    'cache',
    'registrar',
    `${name.toLowerCase().replace(/\s+/g, '-')}-finals-schedule.html`,
  );
  const calendar = calendarFor(term, name, {
    ics: readFileSync(icsPath, 'utf8'),
    fiveYear: readFileSync(fivePath, 'utf8'),
    finals: existsSync(finalsPath) ? readFileSync(finalsPath, 'utf8') : null,
  });

  // The window the app gates on, and it is the Registrar's own, never the min
  // and max of harvested meeting dates.
  //
  // Autumn 2026 harvests as 2026-08-10 to 2026-12-11 because Anatomy 6511 and
  // Pharmacy 7110 keep the medical school's calendar. 2026-12-11 is exactly
  // exams.start, so a gate built on the harvest lets the app offer a 727-seat
  // lecture hall as free until 10:50 pm on the first day of finals. It is also
  // never searchableTermsV2, whose dates are eleven-month search visibility
  // windows: Autumn 2026 "starts" 2026-02-09 by that field.
  const instruction = calendar.instruction;
  const observed = sessions.flat().sort();

  console.log(
    `\n${name} teaching ${calendar.instruction[0]} to ${calendar.instruction[1]} ` +
      `(harvested meetings run ${observed[0]} to ${observed[observed.length - 1]}), ` +
      `${calendar.closed.length} closed day(s), finals ${calendar.exams.start} to ${calendar.exams.end}`,
  );
  for (const d of calendar.closed) console.log(`  ${d.date}  ${d.state}`);
  for (const w of calendar.lowConfidence) console.log(`  ${w.start} to ${w.end}  ${w.reason}`);

  // Not a refusal. The professional colleges keep their own calendars: Anatomy
  // 6511 runs to 2026-12-11 and Pharmacy 7110 to 2026-12-10, both inside the
  // exam window. Their rooms are genuinely busy then. Every other room in those
  // buildings is not, which is what the exam-week refusal is for.
  const past = sessions.filter(([, end]) => end >= calendar.exams.start);
  if (past.length) {
    console.warn(
      `  warn  ${past.length} session(s) run into the exam window: ` +
        past.map((s) => s.join('..')).join(' '),
    );
  }

  // Room keys sorted, for the diff rather than the bytes. Non-deterministic key
  // order turns every weekly rebuild into a full-file rewrite, so nothing can
  // tell you whether the data actually moved.
  const sorted = {};
  for (const id of Object.keys(rooms).sort()) sorted[id] = rooms[id];
  const featurePath = join(ROOT, 'data', 'room-features.json');
  const featureDoc = existsSync(featurePath) ? JSON.parse(readFileSync(featurePath, 'utf8')) : null;
  const featureCount = attachRoomFeatures(sorted, featureDoc, term);
  console.log(`  Registrar room characteristics: ${featureCount}/${Object.keys(sorted).length} indexed rooms`);

  const payload = {
    term,
    // 0 = Sunday .. 6 = Saturday, matching data/buildings-hours.json.
    // busy is [weekday, startMinute, endMinute, sessionIndex], all integers.
    // cap 0 means unknown, 998 means online.
    schema:
      'busy=[day,start,end,session,course] day 0=Sun cap 0=unknown 998=online; ' +
      'course indexes into courses[], and -1 means the block carries no single ' +
      'course: either the schedule named none, or two classes merged into one block; ' +
      'unplaceable=[start,end,session] is a real booking whose weekday the API never gave, ' +
      'blocked on all seven days of that session; ' +
      'vis shown|secondary from facilityType; ga=false means the Registrar does not list ' +
      'the room as general assignment, which ranks it lower and never hides it; ' +
      'closed is keyed by date, state offices-closed means locked doors and no-classes ' +
      'means an open campus with nothing meeting; types maps facilityType to the word ' +
      'the app may print, and a type absent from it has no published decode; ' +
      'features is an optional array of Registrar Room Characteristics codes, ' +
      'absent when no matching term data was published',
    gaPulled: gaFile._meta?.pulled ?? null,
    restrictedPulled: restrictedFile._meta?.pulled ?? null,
    // The Registrar's own teaching window, not the min and max of harvested
    // meeting dates. Every closed day below is inside it.
    teaching: calendar.instruction,
    // Keyed by date, not a list. A screen answering "is today a closed day"
    // does one lookup, and the shape cannot be read correctly by a reader that
    // forgot it was a list, which is a bug that ships silently as "free".
    closed: Object.fromEntries(
      calendar.closed.map(({ date, state, name: holiday }) => [
        date,
        holiday ? { state, name: holiday } : { state },
      ]),
    ),
    exams: calendar.exams,
    lowConfidence: calendar.lowConfidence,
    // The facilityType vocabulary, so the app does not keep a second copy that
    // silently drops the codes it has not heard of. 5C is absent on purpose.
    types: TYPE_WORDS,
    sessions,
    // Sorted subject and catalog number, "BUSML 4382". No section, no title and
    // no instructor: the room screen needs to say which class is in the room,
    // not who is teaching it. See the no-instructor-data note in data/README.md.
    courses,
    rooms: sorted,
  };
  const json = `${JSON.stringify(payload)}\n`;

  // `generated` lives only in current.json. If it appeared here, every weekly
  // rebuild would differ even when no schedule changed.
  // Every shipped room carries a visibility the allow list put there. A room
  // with none reached the file without passing classify, which is the fail-open
  // this whole module exists to prevent.
  const unclassified = Object.entries(sorted).filter(([, r]) => r.vis !== 'shown' && r.vis !== 'secondary');
  if (unclassified.length) {
    die(`${unclassified.length} room(s) reached the index with no visibility: ${unclassified.slice(0, 10).map(([id]) => id).join(' ')}`);
  }

  if (/"generated"/.test(json)) die('generated must not appear inside the room index.');
  // Scoped to the rooms rather than the whole file. A closed day carries the
  // holiday's name, which is the publisher's own words and not geography.
  if (/"lat"|"lon"|"name"/.test(JSON.stringify(sorted))) {
    die('geography belongs in buildings.json, not here.');
  }
  if (/\d{1,2}:\d{2}\s*[ap]m/i.test(json)) die('a raw clock string reached the room index.');

  // The refusals. Everything above this point is a shape check; this is the one
  // that decides whether a harvest that PARSED is a harvest worth shipping.
  const indexPath = join(ROOT, 'data', `rooms-${term}.json`);
  const committed = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : null;
  // The rooms this build's filter deliberately removed. They are excluded from
  // BOTH measurements so the committed comparison stays a comparison of the
  // same population. See the note on measure().
  const filtered = new Set([...cut.farFromCampus, ...cut.thin, ...cut.noHours].map((r) => r.id));
  const now = measure(sorted, { exclude: filtered });
  const before = committed ? measure(committed.rooms, { exclude: filtered }) : null;
  // The count the file actually ships, which is not the count the guards read
  // once anything is excluded. Printed so the two can never be confused.
  const shipping = measure(sorted);

  const clockStrings = { parsed: 0, failed: 0 };
  const unresolved = new Set();
  for (const record of harvest.meetings) {
    const m = record.m;
    if (m?.facilityId == null || isPseudoRoom(m)) continue;
    for (const field of ['startTime', 'endTime']) {
      const value = m[field];
      if (typeof value !== 'string' || !value.trim()) continue;
      if (toMinutes(value) == null) clockStrings.failed++;
      else clockStrings.parsed++;
    }
    if (!isKnownBuilding(m.buildingCode)) unresolved.add(m.buildingCode);
  }
  const noCoordRooms = [...new Set(Object.values(sorted).map((r) => r.b))].filter(
    (code) => buildings[code]?.lat == null || buildings[code]?.lon == null,
  ).length;

  const refusals = indexRefusals({
    term,
    now,
    before,
    clockStrings,
    unresolvedCodes: [...unresolved],
    noCoordRooms,
    serialized: json,
  });

  console.log(
    `\nguards: ${now.blocks} busy blocks, ${now.minutes} busy minutes, ${now.rooms} rooms, ` +
      `${now.buildings} buildings, weekday balance ${now.weekdayBalance.toFixed(2)}` +
      (before ? `  (committed: ${before.blocks} blocks, ${before.minutes} minutes)` : '  (no committed file)'),
  );
  if (filtered.size) {
    console.log(
      `  ${filtered.size} room(s) held out of the comparison because this build's filter ` +
        `removed them on purpose. The file ships ${shipping.rooms} rooms, ` +
        `${shipping.buildings} buildings, ${shipping.blocks} blocks.`,
    );
  }
  console.log(
    `  ${clockStrings.parsed} clock strings parsed, ${clockStrings.failed} failed; ` +
      `${unresolved.size} unresolved building code(s); ${noCoordRooms} room building(s) with no lat/lon`,
  );

  const problem = refusalMessage(refusals);
  if (problem) {
    // A term nothing has ever built is NOT READY. Say why, write nothing, and
    // exit 0 so a workflow building several terms carries on to the next one.
    if (notReady(refusals, Boolean(committed))) {
      console.warn(`\nNOT READY  ${term} has no committed index and does not clear its floors yet:`);
      console.warn(problem.split('\n').map((l) => `           ${l}`).join('\n'));
      return;
    }
    console.error(`\nREFUSED  ${term} would ship less than data/rooms-${term}.json already holds.`);
    console.error(problem.split('\n').map((l) => `         ${l}`).join('\n'));
    console.error(
      '\n         The committed file is untouched. FORCE_WRITE=1 over a collapsed harvest is\n' +
        '         unrecoverable: a term deleted from searchableTermsV2 returns zero sections\n' +
        '         forever, so that file is the only copy of the grid that will ever exist.',
    );
    process.exit(1);
  }

  const current = {
    term,
    termName: name,
    generated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    rooms: `data/rooms-${term}.json`,
    events: `data/room-events-${term}.json`,
    // The launch subset from fetch-buildings.mjs, named here so the app never
    // has to build a filename out of the term itself.
    buildings: `data/buildings-${term}.json`,
    instruction,
  };

  console.log(`\n${name}, instruction ${instruction[0]} to ${instruction[1]}`);
  console.log(`index ${(json.length / 1024).toFixed(0)} KB raw`);

  if (dryRun) {
    console.log('DRY RUN, nothing written.');
    return;
  }
  await writeAtomic(join(ROOT, 'data', `rooms-${term}.json`), json);
  if (noPointer) {
    console.log(`wrote data/rooms-${term}.json, left current.json alone`);
    return;
  }
  await writeAtomic(join(ROOT, 'data', 'current.json'), `${JSON.stringify(current, null, 1)}\n`);
  console.log(`wrote data/rooms-${term}.json and data/current.json`);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('build-index.mjs');
if (invokedDirectly) main().catch((err) => die(err.message));
