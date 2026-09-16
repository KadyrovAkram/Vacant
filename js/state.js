// What the app is allowed to say today, worked out before a single room is
// ranked, and which screen says it.
//
// The verdict itself is not decided here. refusalFor() in js/engine.js decides
// whether Vacant may answer at all, for this file and for the ladder both, and
// resolveState() reads that one verdict and dresses it. Everything else here is
// presentation: which screen, which sentence, which button.
//
// Everything is pure and takes its clock as an argument. That is not a style
// preference. The exam-week refusal is the one behaviour nobody can check by
// opening the app, because the only way to reach exam week is to wait until
// December, so it has to be reachable from a test with a fake date.
//
// The row phrasing lives here for the same reason: a sentence about a door is a
// decision, and a decision that can only be checked by opening the app on the
// right afternoon is a decision nobody checks. The room screen's one claim is
// in js/claim.js, which is the same rule applied to the sentence that carries
// the most weight.
//
// Runs in the browser and under node, and imports nothing that touches the DOM.

import { DAY_END, DAY_START, DETOUR, MAX_WALK, PACKUP, activeSessions, calendarOn, refusalFor, walkMetres, walkMinutes } from './engine.js';

// ------------------------------------------------------------------- clock

// The app's clock, in one place, so a simulated minute is a real answer and not
// a mock.
//
// Every function in this file already takes its `now` as an argument, for the
// reason written at the top: exam week cannot be reached by opening the app.
// js/app.js was the hole. It called `new Date()` in eleven places, so the only
// way to see what Vacant says at 9pm on a Saturday in December was to be there.
//
// `pinClock` freezes the whole app on one instant. It is not a test seam that
// ships disabled: js/dev.js drives it from a date and a time control, and
// pinning rather than offsetting is deliberate, because an offset keeps ticking
// and a screen you are reading should not move under you.
let pinnedMs = null;

export const now = () => (pinnedMs == null ? new Date() : new Date(pinnedMs));

export const pinClock = (ms) => {
  pinnedMs = Number.isFinite(ms) ? ms : null;
};

export const clockIsPinned = () => pinnedMs != null;

// ---------------------------------------------------------------- formatting

export const isoDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const clock = (m) => {
  const h24 = Math.floor(m / 60) % 24;
  const mm = String(Math.floor(m) % 60).padStart(2, '0');
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${mm}${h24 < 12 ? 'am' : 'pm'}`;
};

export const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m} min`);

// Spoken forms. A screen reader gets words where the screen gets glyphs, so
// "7:50p" is read as "7:50 pm" and "2h05" as "2 hours 5 minutes".
export const spokenClock = (m) => {
  const h24 = Math.floor(m / 60) % 24;
  const mm = Math.floor(m) % 60;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(mm).padStart(2, '0')} ${h24 < 12 ? 'am' : 'pm'}`;
};

export const spokenDur = (m) => {
  const h = Math.floor(m / 60);
  const mm = Math.floor(m) % 60;
  const parts = [];
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (mm || !h) parts.push(`${mm} minute${mm === 1 ? '' : 's'}`);
  return parts.join(' ');
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDay(iso) {
  const [, m, d] = String(iso).split('-').map(Number);
  return Number.isFinite(m) && MONTHS[m - 1] ? `${MONTHS[m - 1]} ${d}` : String(iso);
}

// Whole days between two ISO days, by calendar date rather than elapsed hours,
// so a build at 23:00 read at 01:00 is one day old and not zero.
export function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${String(fromIso).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(toIso).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

// ---------------------------------------------------------------- the index floor

// A term that comes back with fewer rooms than this did not build, it
// collapsed. Measured on the shipped indexes: 581 rooms for Autumn 1268 once
// the room safety filter has cut it, 884 for Spring 1262, 206 for the much
// smaller Summer 1264. build-index.mjs holds one floor of 150 for every term,
// which a Spring index carrying 200 rooms walks straight through, so the app
// checks per term digit instead.
const ROOM_FLOOR = { 2: 400, 4: 100, 8: 400 };
export const TERM_NAMES = { 2: 'Spring', 4: 'Summer', 8: 'Autumn' };

export function floorFor(term) {
  return ROOM_FLOOR[Number(String(term ?? '').slice(-1))] ?? 150;
}

export function indexFloorCheck(index) {
  const observed = Object.keys(index?.rooms ?? {}).length;
  const expected = floorFor(index?.term);
  return { ok: observed >= expected, observed, expected };
}

// ---------------------------------------------------------------- calendar reads

// The calendar fields land in the room index. Reading current.json as well
// costs one line and means a rollover that moves them does not silently
// disable the refusal, which is the failure this file exists to prevent.
const calendar = (key, current, index) => index?.[key] ?? current?.[key];

// Accepts {start, end} or [start, end]. Anything else means no window.
function windowOf(raw) {
  if (!raw) return null;
  const start = Array.isArray(raw) ? raw[0] : raw.start;
  const end = Array.isArray(raw) ? raw[1] : raw.end;
  return start && end ? { start, end } : null;
}

// Two shapes reach this. The harvest writes a list of {date, state} rows,
// which is what the issue specifies and what the build actually emits; a
// date-keyed object is the shape that is easier to hand-write in a fixture.
// Reading only the second one is how the refusal ends up wired to nothing:
// `list['2026-09-07']` on an array is undefined and the campus-closed message
// never fires, with no error anywhere.
export function closedDayFor(today, current, index) {
  const closed = calendar('closed', current, index);
  if (!closed) return null;
  const asList = Array.isArray(closed);
  // A bare string in the LIST is a date, and calendarOn() in js/engine.js reads
  // one. This did not, so on that shape it answered null while the engine
  // refused: the screen lost the holiday's name, and scheduleCoversDate and
  // unscheduledGate, which both ask this whether the day is offices-closed,
  // read an ordinary day out of one the engine had already shut.
  const hit = asList
    ? closed.find((c) => (typeof c === 'string' ? c : c?.date) === today)
    : closed[today];
  if (!hit) return null;
  // And a bare string in the MAP is a state, which is the other half of the
  // same rule. Naming neither leaves the state unknown rather than guessed, and
  // refusedState takes the cautious branch on it exactly as the engine does.
  if (typeof hit === 'string') return { state: asList ? null : hit, name: null };
  return { state: hit.state ?? null, name: hit.name ?? null };
}

export function lowConfidenceFor(today, current, index) {
  const ranges = calendar('lowConfidence', current, index) ?? [];
  for (const raw of ranges) {
    const w = windowOf(raw);
    if (w && today >= w.start && today <= w.end) return { ...w, why: raw.why ?? raw.reason ?? null };
  }
  return null;
}

// Every date span the term claims to cover. `instruction` is the harvested
// first and last meeting date, and the sessions are the sub-terms inside it.
function termSpans(current, index) {
  const spans = [];
  const inst = windowOf(current?.instruction);
  if (inst) spans.push(inst);
  for (const s of index?.sessions ?? []) {
    const w = windowOf(s);
    if (w) spans.push(w);
  }
  return spans;
}

export function inTermOn(today, current, index) {
  return termSpans(current, index).some((s) => today >= s.start && today <= s.end);
}

// ---------------------------------------------------------------- staleness

// Four rungs, and the reason they are not decoration: 81% of campus reads free
// on a healthy day, so a Vacant whose weekly build died looks exactly like a
// Vacant that found a lot of rooms. The banner is the only channel that reports
// a dead build to the person who can fix it.
export function staleness({ now, current }) {
  const today = isoDate(now);
  const generated = current?.generated;
  const days = generated ? daysBetween(generated, today) : null;
  const end = windowOf(current?.instruction)?.end;

  if (end && today > end) {
    return { level: 'gated', days, text: 'This schedule covers a term that is over.' };
  }
  if (days == null) return { level: 'silent', days: null, text: '' };
  if (days >= 35) {
    return {
      level: 'banner',
      days,
      text: `Vacant last read the class schedule ${days} days ago. A build this old means the weekly job has stopped running, so treat everything below as a guess.`,
    };
  }
  if (days >= 14) return { level: 'line', days, text: `Schedule read ${days} days ago.` };
  return { level: 'silent', days, text: '' };
}

// ---------------------------------------------------------------- resolveState

const REFUSAL = { ranked: false, note: null, classesSuspended: false };
const TO_NEAR = { label: 'Show nearest buildings anyway', to: 'near' };

// Nothing in this file decides WHETHER to refuse. refusalFor() in js/engine.js
// does, for this screen and for the ladder both, and everything below reads its
// verdict and dresses it: which screen, which words, which button.
//
// That split is not tidiness. Two functions that each decide whether the app
// may answer will drift, and the day they drift is the day the question screen
// says nobody knows while the list behind it offers 450 rooms.
//
// The two facts refusalFor cannot reach on its own are worked out here and
// handed in: the index floor, which is a fact about how big this term should
// be, and whether today falls inside the term at all.
export function resolveState({ now, current, index }) {
  const today = isoDate(now);
  const floor = indexFloorCheck(index);
  const refusal = refusalFor({
    now: now.getHours() * 60 + now.getMinutes(),
    rooms: Object.values(index?.rooms ?? {}),
    sessions: index?.sessions,
    date: today,
    calendar: calendarOn(today, index, current),
    floor,
    inTerm: inTermOn(today, current, index),
  });
  if (refusal) return refusedState(refusal, { today, current, index, floor });

  const closed = closedDayFor(today, current, index);
  // Oct 15 and 16 sit in both tables. One message beats two stacked banners, so
  // a closed day takes the note and the low-confidence window is dropped.
  if (closed?.state === 'no-classes') {
    return {
      kind: 'RANKED',
      ranked: true,
      heading: null,
      body: null,
      note: `${closed.name ? `${closed.name}. ` : ''}No classes are meeting today, so campus is quiet and these rooms are free for that reason rather than a lucky gap.`,
      // The busy grid still marks rooms busy on a day nobody is teaching in
      // them, so the sweep has to be told to ignore it. 2,048 of the 2,106
      // Wednesday blocks are still active on Veterans Day.
      classesSuspended: true,
      action: null,
    };
  }

  if (lowConfidenceFor(today, current, index)) {
    return {
      kind: 'RANKED',
      ranked: true,
      heading: null,
      body: null,
      note: 'Session 1 is finishing this week. Its finals run in the seven week rooms without appearing on the schedule, while the full term classes meet as normal, so today the answers below are weaker than usual in both directions.',
      classesSuspended: false,
      action: null,
    };
  }

  if (now.getDay() === 0 || now.getDay() === 6) {
    return {
      kind: 'RANKED', ranked: true, heading: null, body: null,
      note: 'Weekend search: Most rooms have no listed class, but building hours and other use still matter. A free result does not guarantee an unlocked door.',
      classesSuspended: false, action: null,
    };
  }

  return { kind: 'RANKED', ranked: true, heading: null, body: null, note: null, classesSuspended: false, action: null };
}

// One verdict, six screens. The engine names the fact that stopped it; this
// says what that looks like to somebody holding a phone. Every one of them
// keeps the way through to the buildings screen except the two where a list of
// buildings would be just as wrong: a clock the device cannot read, and an
// index that did not build.
function refusedState(refusal, { today, current, index, floor }) {
  switch (refusal.refused) {
    case 'index':
      return {
        ...REFUSAL,
        kind: 'INDEX_REFUSED',
        heading: 'The schedule did not build',
        body: 'Vacant read fewer rooms than a term this size can hold, so the weekly build broke somewhere. Ranking what survived would invent free rooms out of missing data.',
        detail: `rooms ${floor.observed} < ${floor.expected}`,
        action: null,
      };

    case 'exams': {
      const exams = windowOf(calendar('exams', current, index));
      return {
        ...REFUSAL,
        kind: 'EXAM_REFUSAL',
        heading: 'Finals week',
        body: exams
          ? `Ohio State reassigns rooms for exams and does not publish the assignments. Vacant cannot tell you what is free until ${fmtDay(nextDay(exams.end))}.`
          : 'Ohio State reassigns rooms for exams and does not publish the assignments, so Vacant cannot tell you what is free.',
        detail: null,
        action: TO_NEAR,
      };
    }

    case 'out-of-term': {
      const inst = windowOf(current?.instruction);
      const next = nextTermStart(current);
      if (inst && today < inst.start) {
        return {
          ...REFUSAL,
          kind: 'BETWEEN_TERMS',
          heading: `${current?.termName ?? 'This term'} has not started yet`,
          body: `Classes run ${fmtDay(inst.start)} to ${fmtDay(inst.end)}. Until then the schedule says nothing about which rooms are empty, so Vacant is not answering.`,
          detail: null,
          action: TO_NEAR,
        };
      }
      if (next) {
        const gap = daysBetween(today, next.start);
        return {
          ...REFUSAL,
          kind: 'BETWEEN_TERMS',
          heading: 'Campus is between terms',
          body: `The last class of ${current?.termName ?? 'the term'} met on ${fmtDay(inst?.end ?? today)}. ${next.name ?? 'The next term'} begins ${fmtDay(next.start)}, ${gap} days from now. Nothing meets in between, so there is no schedule to read.`,
          detail: null,
          action: TO_NEAR,
        };
      }
      return {
        ...REFUSAL,
        kind: 'TERM_ENDED',
        heading: `${current?.termName ?? 'The term'} is over`,
        body: 'Ohio State has not published the next term yet. Vacant will not rank rooms against a term that has finished.',
        detail: current?.generated ? `last checked ${current.generated}` : null,
        action: TO_NEAR,
      };
    }

    case 'closed': {
      const closed = closedDayFor(today, current, index);
      return {
        ...REFUSAL,
        kind: 'CAMPUS_CLOSED',
        heading: closed?.name ? `${closed.name}, campus is closed` : 'Campus is closed today',
        body: 'University offices are closed and most buildings are locked, so a room the schedule shows as empty is still a room you cannot get into.',
        detail: null,
        action: TO_NEAR,
      };
    }

    // The index's own coverage of today has collapsed. That is what finals week
    // looks like from inside an index carrying no exam window, and it is also
    // what the tail of a term and a half-broken build look like. Vacant cannot
    // tell the three apart, so it says only the part it is sure of.
    case 'no-schedule':
      return {
        ...REFUSAL,
        kind: 'SCHEDULE_DARK',
        heading: 'Almost nothing is scheduled today',
        body:
          "The term's schedule has all but emptied out for today. That happens at the end of a term, " +
          'before one starts, and when a build breaks, and Vacant cannot tell those three apart, ' +
          'so it will not read an empty schedule as an empty campus.',
        detail: refusal.coverage ? `${refusal.coverage.live} of ${refusal.coverage.total} blocks live` : null,
        action: TO_NEAR,
      };

    // A device whose clock cannot be read cannot be told which doors are open
    // either, so this is the one refusal with nowhere to send anybody.
    default:
      return {
        ...REFUSAL,
        kind: 'CLOCK_REFUSED',
        heading: 'Vacant cannot read the time',
        body: refusal.reason,
        detail: null,
        action: null,
      };
  }
}

function nextDay(iso) {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return iso;
  return new Date(t + 86400000).toISOString().slice(0, 10);
}

// current.next is whatever the harvest knows about the term after this one. The
// research docs write it three different ways, so all three read.
function nextTermStart(current) {
  const n = current?.next;
  if (!n) return null;
  const start = windowOf(n.instruction)?.start ?? n.start ?? n.from ?? null;
  return start ? { start, name: n.termName ?? n.name ?? null } : null;
}

// ---------------------------------------------------------------- unscheduled hours

// A day the schedule really covers, as a share of the week's blocks. Measured
// on the shipped index, 9,561 blocks: the five weekdays carry 15.39% to 22.47%
// each, Saturday carries 0.06% and Sunday nothing at all. Six blocks in the
// whole term do not make Saturday a scheduled day, and the gap between 0.06 and
// 15.39 is wide enough that nothing sits near this line.
const DAY_SHARE = 0.01;

// The tail of the day is not its edge. Fifteen of the shipped index's 9,561
// blocks start before 8:00 and eight end after 21:30, mostly single evening
// sections, and letting one 21:55 class hold the whole campus in "scheduled
// hours" is what turns the ranked list into a distance sort at 10pm. Trimming
// half a percent off each end lands on 8:00 and 20:30.
const TAIL = 0.005;

// A day whose sessions have all ended is not a day the schedule covers, and
// the weekday mask above cannot see that: it is week-shaped, so 2026-12-10
// reads as an ordinary Thursday while the sessions running that date hold one
// block out of the 2,135 the weekly Thursday pattern carries.
//
// Measured over the 109 weekdays of the shipped Autumn 1268 index, 581 rooms
// and 9,561 blocks: 32 days where the sessions have all finished or not yet
// begun, topping out at 0.177% of their weekday's blocks, and 77 teaching days
// bottoming out at 93.97%. The two clusters are 531x apart with nothing in
// between, so this line has a 2.8x margin under it and a 188x margin over it.
const DARK_SHARE = 0.005;

const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

// The bounds the class schedule actually covers. current.json carries them when
// the build emits them, and otherwise they are measured off the index here,
// because four research passes found the last class of the day at 20:15, 21:30,
// 22:15 and 22:30, and a constant picked from any one of those is wrong on the
// other three.
export function busyDayOf(current, index) {
  const given = current?.busyDay;
  if (given && Number.isFinite(given.earliestStart) && Number.isFinite(given.latestEnd)) return given;

  const starts = [];
  const ends = [];
  const perDay = [0, 0, 0, 0, 0, 0, 0];
  let total = 0;
  for (const room of Object.values(index?.rooms ?? {})) {
    for (const b of room.busy ?? []) {
      const d = Number(b[0]);
      const s = Number(b[1]);
      const e = Number(b[2]);
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
      if (d >= 0 && d <= 6) perDay[d] += 1;
      starts.push(s);
      ends.push(e);
      total += 1;
    }
  }
  if (!total) return null;
  starts.sort((a, b) => a - b);
  ends.sort((a, b) => a - b);
  return {
    earliestStart: quantile(starts, TAIL),
    latestEnd: quantile(ends, 1 - TAIL),
    weekdays: perDay.map((n) => n / total >= DAY_SHARE),
    measured: true,
  };
}

// How much of this weekday's schedule is actually running on this date, as a
// share of the blocks the weekly pattern carries for that weekday. 1 means a
// full teaching day, 0 means the term's classes have all ended or none has
// started.
export function scheduleShareOn({ now, index }) {
  const active = activeSessions(index?.sessions, isoDate(now));
  const day = now.getDay();
  let total = 0;
  let running = 0;
  for (const room of Object.values(index?.rooms ?? {})) {
    for (const b of room.busy ?? []) {
      if (Number(b[0]) !== day) continue;
      total += 1;
      if (b[3] !== undefined && active[b[3]] === false) continue;
      running += 1;
    }
  }
  return total ? running / total : 0;
}

// True when today is one of those days. One caller decides whether to rank on
// it, another picks which sentence explains why not, and a second copy of the
// number is how those two drift apart.
export function scheduleDarkOn({ now, index }) {
  return scheduleShareOn({ now, index }) < DARK_SHARE;
}

// True when the class schedule covers this DATE at all, with nothing said about
// the minute. Split out of inScheduledHours because the night gate asks it about
// days that have not happened yet, where busyDay.weekdays on its own says yes to
// Labor Day, Veterans Day and Thanksgiving.
export function scheduleCoversDate({ now, current, index, busyDay = busyDayOf(current, index) }) {
  const today = isoDate(now);
  if (!busyDay) return false;
  if (!inTermOn(today, current, index)) return false;
  // A no-classes day still ranks, with the quiet-campus line saying why. Only a
  // day the university itself is shut takes the schedule off the table.
  if (closedDayFor(today, current, index)?.state === 'offices-closed') return false;
  const exams = windowOf(calendar('exams', current, index));
  if (exams && today >= exams.start && today <= exams.end) return false;
  if (!busyDay.weekdays[now.getDay()]) return false;
  // Finals week is the case this catches without needing a calendar. Ohio State
  // stops publishing rooms once exams start, so every busy list empties out and
  // the ranked list reads 871 rooms free, a 727 seat lecture hall first. An
  // index with no exam window cannot name the reason, but it can see that its
  // own schedule has gone dark, and that is enough to stop it answering.
  return !scheduleDarkOn({ now, index });
}

// True when the class schedule constrains this minute at all. Outside it every
// room in the index reads free and the ranked list quietly becomes a distance
// sort wearing the clothes of a schedule answer.
export function inScheduledHours({ now, current, index }) {
  // Measured once and handed down: busyDayOf sorts every block in the index and
  // this path runs on every repaint.
  const busyDay = busyDayOf(current, index);
  if (!scheduleCoversDate({ now, current, index, busyDay })) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  return minute >= busyDay.earliestStart && minute < busyDay.latestEnd;
}

// The live search can still be useful on Saturday and Sunday when the class
// schedule is sparse. Keep the ordinary weekday boundary, but offer weekend
// searches during the engine's 7am-11pm sweep window. The ranked verdict still
// wins: exams, a closed campus, an out-of-term date and a broken index cannot
// be turned into available rooms by this exception. Published-closed buildings
// and registered events are handled by the same ranking path as on weekdays.
function roomSearchWindow({ now, current, index, busyDay, ranked }) {
  if (!busyDay) return null;
  if (!(ranked ?? resolveState({ now, current, index }).ranked)) return null;
  const day = now.getDay();
  if (day === 0 || day === 6) return { start: DAY_START, end: DAY_END };
  if (!scheduleCoversDate({ now, current, index, busyDay })) return null;
  return { start: busyDay.earliestStart, end: busyDay.latestEnd };
}

export function roomSearchOn({ now, current, index, ranked, busyDay = busyDayOf(current, index) }) {
  const window = roomSearchWindow({ now, current, index, busyDay, ranked });
  if (!window) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  return minute >= window.start && minute < window.end;
}

// Buildings whose published hours are non-null on all seven days. Read out of
// the hours table rather than typed into the app, so a term rollover that
// closes one of them on Sundays drops it from this list with no code change.
export function allWeekCodes(hoursTerm) {
  return Object.entries(hoursTerm?.buildings ?? {})
    .filter(([, rec]) => Array.isArray(rec.hours) && rec.hours.every((d) => Array.isArray(d)))
    .map(([code]) => code);
}

export function roomsPerBuilding(index) {
  const counts = {};
  for (const room of Object.values(index?.rooms ?? {})) {
    if (!room?.b) continue;
    counts[room.b] = (counts[room.b] ?? 0) + 1;
  }
  return counts;
}

// The nearest buildings that hold classrooms, in three groups that are never
// interleaved. A building with no published hours is not sorted among the open
// ones, because "we do not know" is a weaker claim than "open until 11pm" and
// the order has to carry that difference where a label would be skipped.
export function rankBuildings({ origin, buildings, counts, hoursFor, day, nowMin, field }) {
  const open = [];
  const unknown = [];
  const closed = [];

  for (const [code, count] of Object.entries(counts ?? {})) {
    const b = buildings?.[code];
    if (!b || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) continue;
    // The same routed metres the room ranking uses, so the picker and the card
    // cannot quote two different walks to the same building.
    const metres = walkMetres(origin, b, code, field);
    if (!Number.isFinite(metres)) continue;
    const hours = hoursFor ? hoursFor(code, day) : undefined;
    // Five states, not two. 43 of the 47 buildings in the Registrar pool
    // publish at least one day as closed, so on a weekend "the Registrar says
    // this is shut today" is the majority of the closed group, and rendering it
    // the same as "nobody publishes anything" throws away the one published
    // fact the screen exists to carry.
    const when = !Array.isArray(hours)
      ? hours === null
        ? 'closed-today'
        : 'unknown'
      : nowMin < hours[0]
        ? 'before'
        : nowMin >= hours[1]
          ? 'after'
          : 'open';
    const row = {
      code,
      name: b.name,
      rooms: count,
      metres: Math.round(metres),
      walk: walkMinutes(metres),
      when,
      opensAt: Array.isArray(hours) ? hours[0] : null,
      closesAt: Array.isArray(hours) ? hours[1] : null,
    };
    if (when === 'unknown') unknown.push(row);
    else if (when === 'open') open.push(row);
    else closed.push(row);
  }

  const byWalk = (a, b) => a.walk - b.walk || a.metres - b.metres;
  // Two shut doors the same distance away are not the same answer: the one that
  // opens sooner is. The key is the NEXT door and not opensAt, which for a row
  // already shut for the day is the minute it opened this morning. Moves 2,010
  // of 96,768 closed lists, 2.08%, never by more than one place, and
  // scripts/test/screens.test.mjs asserts both figures.
  //
  // It moved 2,836 of them until #115, and the drop is not a behaviour change:
  // a row's metres are the metres WALKED now, which for the straight-line
  // fallback is the old distance times 1.30, so two buildings that rounded to
  // the same whole metre mostly no longer do. Fewer ties, fewer lists for this
  // to break.
  const nextDoor = (r) => (r.when === 'before' ? r.opensAt : MINUTES_IN_DAY + 1);
  const byDoor = (a, b) => byWalk(a, b) || nextDoor(a) - nextDoor(b);
  open.sort(byWalk);
  unknown.sort(byWalk);
  closed.sort(byDoor);
  return { open, unknown, closed };
}

// ------------------------------------------------------------ the first door

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The first door to open after this minute, anywhere the index holds rooms. Both
// night screens knew every opening time in the table and neither said one.
//
// It walks DAYS, not hours, because the weekend needs it: 5 of the 46 buildings
// publish Saturday hours and 11 publish Sunday, so on a Saturday night the next
// door is three of them at 7:00am on the Sunday. A day already under way counts
// from the next minute on, never from the start of it.
//
// ties carries how many share the named minute. Nothing here knows where the
// reader is standing, so it cannot call one of three the nearest; js/app.js
// swaps in the closest on the screen that does know.
export function nextOpening({ buildings, counts, hoursFor, day, nowMin }) {
  if (typeof hoursFor !== 'function') return null;
  for (let ahead = 0; ahead < 7; ahead++) {
    const on = (day + ahead) % 7;
    let best = null;
    let ties = 0;
    for (const code of Object.keys(counts ?? {})) {
      const name = buildings?.[code]?.name;
      if (!name) continue;
      const hours = hoursFor(code, on);
      if (!Array.isArray(hours) || !Number.isFinite(hours[0])) continue;
      const opensAt = hours[0];
      if (ahead === 0 && opensAt <= nowMin) continue;
      if (!best || opensAt < best.opensAt) {
        best = { code, name, day: on, opensAt };
        ties = 1;
      } else if (opensAt === best.opensAt) {
        ties += 1;
      }
    }
    if (best) return { ...best, ties };
  }
  return null;
}

// How many doors are unlocked at this minute. rankBuildings answers the same
// question but only for a reader whose position is known, and whether campus is
// shut is not a fact about where anybody is standing.
export function openDoorCount({ counts, hoursFor, day, nowMin }) {
  if (typeof hoursFor !== 'function') return 0;
  let n = 0;
  for (const code of Object.keys(counts ?? {})) {
    const hours = hoursFor(code, day);
    if (Array.isArray(hours) && nowMin >= hours[0] && nowMin < hours[1]) n += 1;
  }
  return n;
}

// The clause that names a door: who opens it, when, and which day if that is
// not today. Both screens say it, so it is written once and neither can drift
// into naming a different door for the same minute.
export function openingPhrase(opening, day) {
  if (!opening) return null;
  const who = opening.ties > 1 ? `${opening.name} and ${opening.ties - 1} more` : opening.name;
  const lead = opening.day === day ? '' : `On ${DAY_NAMES[opening.day]} `;
  return `${lead}${who} ${opening.ties > 1 ? 'open' : 'opens'} at ${clock(opening.opensAt)}`;
}

// The next minute room search is offered, which may be a weekend morning even
// when no regular class day is coming until Monday.
//
// It steps DATES rather than trusting the weekly class mask. The next morning
// may be a weekend search, and the first weekday after it may be a holiday or
// outside the term; neither can be inferred from the day of the week alone.
//
// Seven days and no further, so the day it names can only mean one date, and
// nothing found means the sentence drops the clause rather than guessing.
function nextRoomSearch({ now, current, index, busyDay }) {
  if (!busyDay) return null;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (let ahead = 0; ahead < 7; ahead++) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead, 12, 0);
    const window = roomSearchWindow({ now: date, current, index, busyDay });
    if (!window || (ahead === 0 && nowMin >= window.start)) continue;
    return { day: date.getDay(), at: window.start, ahead };
  }
  return null;
}

// The ordinary night was the one state in the app with no explanation on it:
// every holiday got a paragraph, and 11:40pm on a Monday got a heading that
// repeated its own button over an empty one.
//
// The heading is the minute, because the whole answer is a function of it and
// this is the one screen with no list underneath saying so. The body is up to
// three facts: what the clock is doing, which door opens first if campus is
// shut, and when the ranked list comes back. No room count, because
// docs/DECISIONS.md 2026-08-29 took that off this screen.
export function unscheduledGate({ now, current, index, busyDay, opening, openNow = 0 }) {
  const day = now.getDay();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const heading = `${DAY_NAMES[day]}, ${clock(nowMin)}`;

  // A registrar no-classes day is a weekday the mask says yes to, so without the
  // calendar it read as a teaching day whose classes were pending, or finished.
  // resolveState names the day on the ranked screen; this says the same words.
  const off = closedDayFor(isoDate(now), current, index);
  const campus =
    off?.state === 'no-classes'
      ? `${off.name ? `${off.name}. ` : ''}No classes are meeting today.`
      : !busyDay?.weekdays?.[day]
        ? 'Few classes are scheduled today.'
        : nowMin < busyDay.earliestStart
          ? 'Classes have not started yet.'
          : 'Classes are done for the day.';

  // Only when no door is open already, the way the buildings screen guards the
  // same sentence on groups.open.length. Without it the gate named the first
  // door on 3,885 of the week's 6,405 gate minutes with campus open behind it,
  // including 7:30am on a Tuesday with all 46 unlocked.
  const door = openNow > 0 ? null : openingPhrase(opening, day);
  const doorAhead = door ? (opening.day - day + 7) % 7 : null;
  const back = nextRoomSearch({ now, current, index, busyDay });
  if (!back) return { heading, body: door ? `${campus} ${door}.` : campus };
  // One day word, not two. When the door and the ranked list land on the same
  // date the clause has already named it, so the two join into one sentence.
  if (doorAhead === back.ahead) {
    return { heading, body: `${campus} ${door} and Vacant ranks rooms again at ${clock(back.at)}.` };
  }
  // Otherwise the clause carries its own day word, and needs one even when the
  // answer is today: a bare "at 8:00am" sitting behind "On Wednesday" reads as
  // Wednesday. No shipped minute reaches that now, because a door is open in
  // every window that would, so the tests drive it from a door handed in.
  const on = back.ahead === 0 ? (door ? ' today' : '') : ` on ${DAY_NAMES[back.day]}`;
  const rooms = `Vacant ranks rooms again${on} at ${clock(back.at)}.`;
  return { heading, body: door ? `${campus} ${door}. ${rooms}` : `${campus} ${rooms}` };
}

// ------------------------------------------------------------ the relaxed answer

// One sentence per rung of the engine's fallback ladder, for the strip over the
// list and for the live region that reads the list out.
//
// The ladder relaxes one constraint at a time and returns the rung that
// produced the answer, and until this existed js/app.js read neither `rung` nor
// `relaxed`, so a list built by dropping the room-type filter was headed by the
// same words as a list of ordinary classrooms. That is issue #90.
//
// Every sentence is written against LADDER_QUORUM rather than against zero, and
// that is the whole difficulty of the wording. A rung wins by finding THREE
// rooms, so `further` does not mean nothing near you is free: it means fewer
// than three rooms near you were, and the ladder preferred three further out to
// two close by.
//
// MEASURED, replaying the shipped app's own ranking (rank() then shape()) beside
// query() over the committed index, 99 origins on a 0.004 by 0.005 degree grid
// around the Oval, Mon to Fri 2026-09-14 to 18, hourly 08:00 to 20:00, at a 30
// and a 60 minute ask, 12,870 answers. The ladder relaxed on 9,486 of them and
// the list still had rows on 510. On those rows a reader could count, and the
// count never reached three: for `further`, `anywhere` and `longest` the list
// held 0, 1 or 2 rooms free now and long enough inside the walk bound (85, 7
// and 16 of 108), and for `any-type` it held 1 or 2 ordinary classrooms (15 and
// 151 of 166). "Nothing near you is free" printed over a list showing two free
// rooms is the one way this disclosure can lie, and counting to three is what
// stops it.
//
// The room words in the `any-type` sentence were measured over those same 166
// answers, and that measurement is now HISTORY rather than a description: it
// counted 130 rows of 2P computer teaching lab among 272, and a 2P can no
// longer reach a screen. Re-measured on the paint path after the labs left
// OFFERABLE, the rows this rung ADDS are 5K conference rooms and 2J TV and
// radio facilities, all of them departmental and none of them a lab.
//
// Which is why the sentence says "departmental rooms" rather than naming the
// types. Every type this rung can add is 100% absent from the general
// assignment list, so the one word is true of all of them, and it is the word
// the row already carries beside its seats. A draft naming "conference and
// meeting rooms" was narrower than the rung reaches and a TV and radio
// facility appeared under it, described by neither.
//
// `longest` never fired once in the 12,870, so its sentence is the only one
// here with no measurement behind it. It says the least for that reason.
// `restOfDay` is the ask the app cannot render as a length. neededMinutes()
// turns "rest of day" into Math.max(30, latestEnd - now), so dur() prints a
// figure the user never chose -- 12h15 at 08:00, and a flat "30 min" inside the
// last half hour of the index's day, which is indistinguishable from the button
// that does say 30 min. The list already names that button in words directly
// above this strip, so a second vocabulary here puts two renderings of one ask
// on adjacent lines.
export function rungPhrase(rung, { needed = 0, maxWalk = MAX_WALK, restOfDay = false } = {}) {
  const asked = restOfDay ? 'the rest of the day' : dur(needed);
  const spoken = restOfDay ? 'the rest of the day' : spokenDur(needed);
  const line = (text, say) => ({ text, say: say ?? text });

  // The rung the engine comments on twice. It used to say "computer labs and
  // departmental rooms" and the labs left OFFERABLE, so that named rooms the
  // list can no longer contain.
  //
  // "departmental rooms" is doing the work the room words cannot. Replayed as
  // the app paints -- rows from rank() plus shape(), strip from query().rung --
  // the rows this rung adds are conference rooms, an unlabelled type, TV and
  // radio facilities and one meeting room, and zero labs. A draft that named
  // only "conference and meeting rooms" was narrower than the rung reaches: a
  // TV and radio facility appeared under it, described by neither word. Every
  // one of these rows is departmental, and every one renders " . departmental"
  // beside its seats, so the phrase is the true one and it is the one the row
  // already carries.
  //
  // No clinic. A draft of this comment said one of the conference rooms is a
  // working dental clinic; PH3089A is a real room and a real clinic and it is
  // NOT IN THE INDEX -- zero PH rooms ship, and neither does the law clinic
  // DI0455. Both are named in docs/research/facility-types.md, which is where
  // the claim came from and where it should have stayed.
  if (rung === 'any-type') {
    return line(
      `Fewer than three ordinary classrooms near you are free for ${asked}. Vacant reached into departmental rooms.`,
      `Fewer than three ordinary classrooms near you are free for ${spoken}. Vacant reached into departmental rooms.`,
    );
  }

  // `shorter:45` and the rest of RELAX_LADDER. The duration is in the name
  // because it is the constraint that moved.
  const shorter = /^shorter:(\d+)$/.exec(String(rung));
  if (shorter) {
    const got = Number(shorter[1]);
    return line(
      `Fewer than three rooms near you are free for ${asked}. Vacant fell back to ${dur(got)}.`,
      `Fewer than three rooms near you are free for ${spoken}. Vacant fell back to ${spokenDur(got)}.`,
    );
  }

  // The duration is in this one for a reason worth keeping. "Free this second"
  // on its own reads as a claim about wait, and the screen it sits over can
  // hold four rows that ARE free this second and are simply too short: Mon
  // 2026-09-14 10:50 from 39.9915, -83.0230 at a 30 minute ask puts four rooms
  // in Biological Sciences on screen with no wait and a 19 minute window. The
  // rung is about rooms that fit, so the sentence has to say what it wanted.
  //
  // No second sentence. It said "Vacant fell back to rooms that open later"
  // over screens where every row was free right now: 12 of the 170 opens-at
  // lists in the 12,870-answer replay. What the ladder DID and what the list
  // SHOWS are two different searches, and only the first clause is about the
  // list.
  if (rung === 'opens-at') {
    return line(
      `Fewer than three rooms near you are free for ${asked} right now.`,
      `Fewer than three rooms near you are free for ${spoken} right now.`,
    );
  }

  // The radius rungs, and the reason neither says what the ladder went on to
  // do. js/app.js ranks with rank() + shape(), and shape() keeps only the rows
  // inside maxWalk. `further` and `anywhere` are by definition the rungs whose
  // answer lies OUTSIDE that cut, so the rooms they found can never appear on
  // the screen this sentence sits on. Not rarely: never, structurally, on every
  // one of the 108 such lists in the replay. The draft that said "Vacant looked
  // twice that far" was printing a claim the rows underneath refuted, over
  // screens that on main had said nothing at all -- which is worse than the
  // silence this whole change exists to replace.
  //
  // So both keep the one clause that is about the list in front of the reader,
  // and both quote maxWalk, the bound those rows were actually cut to. They
  // come out identical, and they should: from the reader's side the two rungs
  // are the same situation, and the difference between them is a fact about
  // the search, not about the answer.
  if (rung === 'further' || rung === 'anywhere') {
    return line(
      `Fewer than three rooms within a ${maxWalk} minute walk are free for ${asked}.`,
      `Fewer than three rooms within a ${maxWalk} minute walk are free for ${spoken}.`,
    );
  }

  // The last resort. js/engine.js expects the screen to lead with this rather
  // than present the one room it found as an answer, so the sentence is the
  // refusal and the row is the footnote.
  if (rung === 'longest') {
    return line(
      `Nothing Vacant can offer is free for ${asked} today, anywhere on campus.`,
      `Nothing Vacant can offer is free for ${spoken} today, anywhere on campus.`,
    );
  }

  // `asked` gave nothing up, and so has nothing to admit. Any other name is a
  // rung that grew without a sentence, and the engine test fails on it rather
  // than letting the app print a relaxed answer in the words of an exact one.
  return null;
}

// ---------------------------------------------------------------- the row window

// clock() wraps modulo 24 hours, so a window that ran past midnight would print
// as an innocent morning time rather than as an error, and the test that was
// meant to catch that parsed the printed string and so could never fail.
// Nothing in the engine can produce one today. This is what keeps it that way.
//
// NOT engine.js's DAY_END, which is 1380. That one is a clamp on what the app
// is willing to offer, the latest class end in the harvest. This one is the
// last minute a wall clock can hold, and a window past it is arithmetic that
// escaped the day rather than a late class.
export const MINUTES_IN_DAY = 1440;
const inDay = (m) => m == null || (Number.isFinite(m) && m >= 0 && m <= MINUTES_IN_DAY);

// What a row says about the end of its window, in glyphs and in words. No
// branch here prints a duration for a building nobody publishes hours for. That
// is the path that once printed "9h44", by capping an unknown window at
// midnight and calling the remainder free.
export function windowPhrase(row, close) {
  if (![row.availableAt, row.usableUntil, row.nextClassAt, close].every(inDay)) {
    return {
      tier: 'unknown',
      text: 'window unknown',
      say: 'Vacant worked out a window that does not fit inside today, so it is not saying when this room frees up',
    };
  }
  if (row.wait > 0) {
    // `usable` is null for a building nobody publishes hours for, and this
    // branch sits ABOVE the hoursKnown one, so `?? 0` put "then 0 minutes" in
    // a reader's ear for a room that simply has no published close. The
    // paragraph above this function is the rule it broke: no branch here
    // prints a duration for a window we cannot promise.
    const then = row.usable == null ? '' : ` then ${spokenDur(row.usable)}`;
    return {
      tier: 'wait',
      text: `from ${clock(row.availableAt)}`,
      say: `free at ${spokenClock(row.availableAt)}${then}`,
    };
  }
  if (!row.hoursKnown) {
    return {
      tier: 'unknown',
      text: 'hours not published',
      say: 'opening hours are not published for this building so Vacant cannot say when it locks',
    };
  }
  // 83.4% of rows end because the door locks and 16.6% because a class walks
  // in. Those are different promises, so they get different sentences rather
  // than one sentence with a marker on the end.
  if (close != null && row.nextClassAt < close) {
    return {
      tier: 'strong',
      text: `free till ${clock(row.usableUntil)}`,
      // usableUntil is PACKUP before the class, so "when a class starts" named a
      // cause the data contradicts: nothing starts at 3:20 when the class is at
      // 3:30, and the room screen says 3:30 for the same room. Both numbers and
      // the relation between them, or the two screens disagree out loud.
      say: `free until ${spokenClock(row.usableUntil)}, which is ${spokenDur(PACKUP)} before the next class at ${spokenClock(row.nextClassAt)}`,
    };
  }
  return {
    tier: 'medium',
    text: 'no class rest of today',
    say:
      close == null
        ? 'no class in it for the rest of today'
        : `no class in it for the rest of today, and the building locks at ${spokenClock(close)}`,
  };
}

// -------------------------------------------------------- following the walk

// The app asked the phone where it was exactly once, at launch, and then ranked
// every answer for the rest of the session from that one point. The whole
// product is one number, `usable = window - walk - packup`, and the walk is
// measured from a place the student leaves the moment they set off toward the
// room, so the number was wrong by the time it mattered. Issue #87.
//
// A watch fixes that and breaks something else if it is left ungated, because
// refresh() in js/app.js is written around a rule of its own: a list that
// re-sorts under a thumb loses the row somebody was reaching for. Both
// decisions live here, and not in js/app.js, for the reason at the top of this
// file: neither can be checked by opening the app. Reaching them by hand means
// walking across campus with a phone in your hand.

// How far the phone has to have moved before the app re-measures from the new
// point. 40 m is 0.51 minutes of walking at the engine's WALK_MPM of 78, so no
// walk figure on screen can be a whole minute wrong inside it, and it sits
// under the 75 m that js/app.js already calls a coarse fix. Below this the app
// would be re-ranking on the difference between two readings of one spot.
export const FOLLOW_M = 40;

// And a floor on how often that may happen at all. Somebody actually walking
// covers 40 m every 31 seconds at that pace, so this delays them by at most one
// fix; it is here for the phone standing still whose readings wander, which the
// 75 m coarse line says is a shape campus GPS really has.
//
// NOT MEASURED. No phone has been watched through a walk yet, which is the item
// still open on #87, and this number is the one that would move if it were.
export const FOLLOW_MS = 15000;

// Whether a position off the watch is worth acting on. Both gates, and the
// first fix passes both: js/app.js has no previous position to measure against
// and hands in Infinity for each.
export function followFix({ movedM, sinceMs, minM = FOLLOW_M, minMs = FOLLOW_MS } = {}) {
  // Written to fail closed. A NaN distance out of a malformed fix must not read
  // as "moved far enough", which `movedM < minM` would have done.
  if (!(sinceMs >= minMs)) return false;
  return movedM >= minM;
}

// What a fix that cleared those gates is allowed to do to the screen. Four
// answers, and three of them are refusals:
//
//   stop   a building was picked by hand. A deliberate choice is not a sensor
//          reading and does not expire, so there is nothing left to follow
//   room   a room is open. The reader has already chosen; the walk minutes on
//          that screen are redrawn where they stand and the ranking behind it
//          is not touched
//   hold   the dot and the line move with the new origin on the next frame and
//          the order stands. This is the thumb rule
//   rank   the list is idle and untouched, so it may be re-ordered
//
// The order of the tests is the whole function. `screen === 'room'` has to come
// before `selected`, because opening a room always selects its row, and a room
// screen tested for selection first would only ever hold.
export function followAction({ screen, selected, dragging, picked, scrolled } = {}) {
  if (picked) return 'stop';
  // A finger is down on the sheet. Not merely dragging it: a tap that has not
  // been let go of yet is a finger on a row, which is the case the rule is
  // about.
  if (dragging) return 'hold';
  if (screen === 'room') return 'room';
  if (selected != null) return 'hold';
  // Scrolled down the list is read as touched. The rows under the fold are the
  // ones somebody scrolled to see, and answer() paints from the top, so a
  // re-rank here throws away both the order and their place in it.
  if (scrolled) return 'hold';
  // Everywhere else is a control surface the ranking is not on screen behind:
  // the building picker, the about pane. Re-ranking under those repaints a list
  // nobody is looking at and reframes the map while they read.
  return screen === 'list' || screen === 'near' || screen === 'ask' ? 'rank' : 'hold';
}

// ---------------------------------------------------------------- diagnostics

export const round4 = (n) => (Number.isFinite(n) ? Number(n.toFixed(4)) : n);

const MAX_BLOCK = 4000;

// One labelled line each, so a student can paste the block into an issue and a
// maintainer can tell a stale side table from a wrong gap without holding the
// phone. The busy list is last because it is the only unbounded line, so it is
// the one that loses entries when the cap bites.
export function diagnosticsBlock(d) {
  const line = (k, v) => `${k.padEnd(10)} ${v}`;
  const rows = [
    line('build', `${d.build ?? 'unknown'}${d.controlling ? '  (controlling)' : ''}`),
    line('term', `${d.term ?? '?'}  ${d.termName ?? ''}`.trimEnd()),
    line('index', `generated ${d.generated ?? '?'}${d.ageDays == null ? '' : `  (${d.ageDays} days old)`}`),
    line('state', d.stateKind ?? '?'),
    line('counts', `${d.rooms ?? 0} rooms / ${d.buildings ?? 0} buildings / ${d.sessions ?? 0} sessions`),
  ];

  const acc = Number.isFinite(d.accuracy) ? `+/-${Math.round(d.accuracy)} m` : 'accuracy unpublished';
  const age = Number.isFinite(d.originAgeS) ? `  age ${d.originAgeS} s` : '';
  const where =
    d.includeLocation && Number.isFinite(d.lat) ? `  ${round4(d.lat)}, ${round4(d.lon)}` : '  [location withheld]';
  rows.push(line('origin', `${d.originSource ?? '?'}  ${acc}${age}${where}`));
  rows.push(line('hours', `${d.hoursSource ?? 'none'}  read ${d.hoursGenerated ?? '?'}`));
  rows.push(line('clock', `${d.clock ?? '?'}  ${d.zone ?? '?'}`));

  if (d.room) {
    const r = d.room;
    rows.push(line('room', `${r.id}  type ${r.type ?? '?'}  cap ${r.cap ?? '?'}  bldg ${r.building ?? '?'}`));
    if (Number.isFinite(r.metres)) {
      // Which model answered is the thing worth reading off a dev panel: a
      // routed figure and an estimated one are not the same claim, and off
      // campus every row silently becomes the second.
      const how = d.routed ? 'routed over sidewalks' : `straight line x ${DETOUR}`;
      rows.push(line('walk', `${r.metres} m walked -> ${r.walk} min   (${how}, WALK_MPM 78)`));
    }
    if (Number.isFinite(r.gapStart)) {
      const usable = r.usable == null ? 'unknown' : dur(r.usable);
      // The last minute you could have set off and still got the usable figure
      // on this line. Any later and the arrival, not the gap, sets the start,
      // so usable shrinks minute for minute. Once the gap has already opened
      // that is simply the minute the row was tapped.
      const leaveBy =
        Number.isFinite(r.nowMin) && Number.isFinite(r.walk)
          ? `, leaveBy ${clock(Math.max(r.nowMin, r.gapStart - r.walk))}`
          : '';
      rows.push(line('gap', `${clock(r.gapStart)}-${clock(r.gapEnd)} sess ${r.session ?? '?'}  ->  usable ${usable}${leaveBy}`));
    }
  }
  if (d.caches?.length) rows.push(line('caches', d.caches.join(', ')));

  const head = rows.join('\n');
  const all = d.busy ?? [];
  if (!all.length) return head.slice(0, MAX_BLOCK);

  const label = `busy ${d.dayName ?? ''}`.padEnd(10);
  const fmt = (list, dropped) =>
    `${label} ${list.map(([s, e]) => `${clock(s)}-${clock(e)}`).join(' | ')}${dropped ? ` ... ${dropped} more` : ''}`;

  let keep = all.length;
  let out = `${head}\n${fmt(all, 0)}`;
  // A room can carry 57 weekly intervals, and an issue URL that long stops
  // being a link, so the busy list is trimmed from the end until it fits.
  while (out.length > MAX_BLOCK && keep > 1) {
    keep -= 1;
    out = `${head}\n${fmt(all.slice(0, keep), all.length - keep)}`;
  }
  return out.length > MAX_BLOCK ? out.slice(0, MAX_BLOCK) : out;
}

// The watch handle, as a state machine, because the handle was the one half of
// #87 the tests could not reach.
//
// followFix and followAction above are pure and were mutation-checked. The
// lifecycle around them was not: it lived in js/app.js, which touches the DOM
// at import and cannot be loaded under node, so scripts/test/follow.test.mjs
// asserted REGEXES OVER THE SOURCE TEXT. That kills a mutation which rewrites a
// quoted string and nothing else. Reviewed with 26 mutations, five survived a
// green suite, and every one of them is a battery or staleness bug a reader
// would never see:
//
//   clearWatch(0) instead of clearWatch(id)  the watch never actually stops
//   drop the `id != null` guard              two live watches, doubled cost
//   drop `id = null` in stop()               the watch never restarts
//   drop the throttle assignments            every fix re-ranks
//
// Injecting the geolocation object and the visibility predicate is what makes
// those assertions possible, so this holds the handle and js/app.js holds the
// wiring. `geolocation` and `visible` are functions rather than values because
// both are read at call time in the browser and neither is stable across a
// session. It is spelled out rather than shortened to `geo` because
// scripts/test/install.test.mjs forbids the string `geo:` anywhere in js/ --
// geo: URIs are inert on iOS -- and a property named `geo` trips that guard for
// no reason.
export function createWatch({ geolocation, visible, onFix, onError, options = {} }) {
  let id = null;
  return {
    // Read-only on purpose: a caller that can assign the handle can lose it.
    get id() { return id; },
    get open() { return id != null; },
    // Returns why it did what it did, so a test can tell "refused" from "opened"
    // without reaching for the handle.
    start(origin) {
      if (id != null) return 'already-open';
      if (!origin) return 'no-origin';
      // A hidden page must never open one: the boot fix can resolve after the
      // user has switched away, and visibilitychange has already fired by then.
      if (!visible()) return 'hidden';
      // A picked building does not expire, so there is nothing to follow.
      if (origin.source === 'picked') return 'picked';
      const g = geolocation();
      if (typeof g?.watchPosition !== 'function') return 'unsupported';
      try {
        id = g.watchPosition(onFix, onError, options);
      } catch {
        // The locked-down webviews that throw on getCurrentPosition too. The
        // boot fix still stands and the app is no worse off than it was.
        id = null;
        return 'threw';
      }
      return 'open';
    },
    stop() {
      if (id == null) return 'closed';
      try {
        geolocation()?.clearWatch(id);
      } catch {
        /* nothing to do about it, and the handle is dropped either way */
      }
      // Cleared even when clearWatch threw, or a start() after a failed stop
      // refuses forever and the watch never comes back.
      id = null;
      return 'stopped';
    },
  };
}
