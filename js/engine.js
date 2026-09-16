// How long a room is yours AFTER you finish walking to it.
//
// This is the whole differentiator, and it is not the number the README first
// reached for. Runs in the browser and under node, no imports.
//
// Two rules hold everywhere in this file. Every rounding breaks pessimistic, so
// the app never promises more time than the student gets. And "we do not know"
// is a third answer that never collapses into "free" or "closed".
//
// There is no `Date` in here on purpose. Times are wall-clock minutes since
// local midnight and dates are `YYYY-MM-DD` strings, so the engine cannot be
// wrong about a timezone it never sees. On the two Sundays a year Ohio moves
// its clocks a wall-clock minute and a real minute stop agreeing, which is what
// the `dst` option in `usableMinutes` is for.

// ------------------------------------------------------------------ config
// Every constant here is either measured or a guess, and says which.

// Metres per minute at an ordinary walking pace. GUESS. Average adult pace is
// about 1.34 m/s, which is 80.4 m/min, and this rounds it down because the
// student to design for is carrying a backpack up the Oval in February.
export const WALK_MPM = 78;

// Straight-line distance times this is roughly the real path. FUDGE FACTOR, not
// measured on OSU sidewalks. It sits near the 4/pi = 1.273 detour of a perfect
// grid, inside the 1.15 to 1.45 pedestrian circuity range.
export const DETOUR = 1.3;

// Neither of the two has been fitted, and the ground-truth walk in #26 is the
// measurement that would fit them. Two things to know before anyone does.
//
// The pair is exactly one metre to one second right now: 1.3 / 78 of a minute
// IS a second. So a stopwatch fits their RATIO and nothing else, and a fit that
// keeps that identity has changed nothing. Splitting them needs a measured path
// length as well as a time, from a phone track or a route drawn on a map.
//
// And the measurement is biased before the stopwatch starts, in two places
// that have to be kept apart.
//
// The OUTDOOR half of that bias is gone as of 2026-09-15. The walk used to end
// at the building's published point, which is a polygon centroid, so it ended
// inside a wall; approachMetres now ends it at the nearest door OSU publishes.
// 44 of the 46 shipped buildings have doors. The two that do not, Biological
// Sciences and the Theatre Building, still measure to the centroid, so a walk
// fitted against either of them carries the old bias and a fit should drop them.
// The subset also carries four buildings that host no class at all, because the
// picker's shortcut bar stands on them; they have doors and no rooms.
//
// The INDOOR half is untouched and is what is left to price: the door is not
// the room. MEASURED over the 46 shipped buildings by decoding data/campus.json
// against the published point, which scripts/test/walk-bias.test.mjs recomputes:
// the far corner of a building sits a median 44 m from it, 62 m at the 90th
// percentile, and 85 m at PAES, which at these constants is 44, 62 and 85
// SECONDS. That figure is now an upper bound on a corridor rather than a claim
// about the approach, because the approach stops at the right place. Subtract
// it before moving either number. The 38 s and 1 min 45 s in #26 are both low,
// and the stadium the second one names is dropped by the safety filter and
// never quoted at all.
//
// A fit also has to know the endpoint moved. MEASURED over six public origins
// and the 46 buildings: the nearest door is 23.3 m closer than the centroid on
// average, 262 of 276 origin-building pairs are shorter, and 108 of them lose a
// whole walk minute. A
// stopwatch time compared against a prediction made before that date is being
// compared against a different quantity. docs/research/entrances.md has the
// full replay.

// Minutes reserved at the end so you are not packing up while the next class
// files in. POLICY, and it is doing real work: OSU's passing period is 15
// minutes and 69.3% of all 2711 measured inter-class gaps are exactly that, so
// a 15 minute gap yields 5 usable minutes and the corridor shuffle drops out of
// every answer by arithmetic. Not a merge tolerance, which would also swallow
// the 1.3% of genuine 10 to 14 minute gaps and would report the second class's
// start as the moment the room frees, which is a lie.
export const PACKUP = 10;

// Default radius in minutes of walking. MEASURED: on a synthetic campus at 3x
// the real interval density the fallback ladder never fired once at 12 minutes,
// and only starts firing below 6.
export const MAX_WALK = 12;

// Do not offer a gap that opens further out than this. GUESS, and a product
// decision rather than a measurement: four hours from now is not an answer to
// "where can I sit". The "opens at" rung deliberately ignores it, because
// naming when the first building unlocks is that rung's whole job.
export const LOOKAHEAD = 240;

// How much a longer window is worth against a longer walk. UNMEASURED
// JUDGEMENT CALLS, both of them, and an open question in docs/DECISIONS.md
// under 2026-08-27. An hour of headroom buys six minutes of walking, and
// surplus past an hour buys nothing, because the student already said how long
// they needed. Measured effect: the pair changes which room is first in 1.4% of
// 980 probe queries and reorders the top five in 11.2%.
export const SURPLUS_WEIGHT = 0.1;
export const SURPLUS_CAP = 60;

// The window the schedule can speak about. MEASURED on the committed index
// (data/rooms-1268.json, 9,561 intervals over 581 rooms once the room safety
// filter has cut it): the earliest class starts at 05:45 and the latest ends at
// 21:55. DAY_END keeps the 23:00 it was set to against the 871-room index,
// which now sits above everything the data carries and never binds. A clamp
// that is too loose offers nothing extra; one that is too tight clips real
// intervals, which is what the research note's 22:00 did to 18 of them.
//
// DAY_START is a clamp, not a measurement. Without it a room with no morning
// class reports "free since 00:00", which is true and useless. It only ever
// shrinks what we offer.
//
// Neither of these is a claim that a door is unlocked. They bound the schedule,
// and a building with no published hours still reports no usable figure at all.
//
// NOT js/state.js's MINUTES_IN_DAY, which is 1440. That one is the last minute
// a wall clock can hold, and a window past it is broken arithmetic. This one is
// a clamp on what the app will offer.
export const DAY_START = 420; // 07:00
export const DAY_END = 1380; // 23:00, above the 21:55 the shipped index reaches

// The rungs the requested duration falls back through. GUESS, and it mirrors
// the duration chips the UI offers.
export const RELAX_LADDER = [120, 90, 60, 45, 30, 20];

// A relaxed answer is still an answer, so it has to be worth the walk. GUESS.
export const MIN_RELAXED_USABLE = 20;

// A rung has answered once it has this many rooms. GUESS.
export const LADDER_QUORUM = 3;

// Every name `query` can hand back in `rung`, in the order the ladder walks
// them. Exported because a rung name is not an internal label: it is the only
// thing that tells a screen WHICH constraint the answer gave up, and a screen
// that has no sentence for a rung shows a relaxed answer in the words of an
// exact one. The order here is the ladder's order; `query` reads it rather
// than keeping a second copy, so adding a rung means adding it here, and
// scripts/test/engine.test.mjs then fails until the screen has a sentence for
// it.
//
// `shorter:N` is one name per entry in RELAX_LADDER, so the duration chips and
// the rung names cannot drift apart either.
export const RUNGS = [
  'asked',
  'any-type',
  ...RELAX_LADDER.map((n) => `shorter:${n}`),
  'opens-at',
  'further',
  'anywhere',
  'longest',
];

// Room types worth offering by default, from docs/research/facility-types.md.
// MEASURED on the committed index: 520 of 871 rooms (59.7%) carry one of these.
// The rest are wet labs, studios, gyms and kitchens, which are not rooms you
// can sit down in with a laptop.
export const PREFERRED_TYPES = ['1B', '1C', '1A', 'LCTR', 'SMNR'];

// Rooms the ladder may fall back to once the preferred ones run out, saying so
// when it does: real rooms with chairs and tables, but access controlled or
// socially awkward. 5K holds a working dental clinic and a law clinic at Ohio
// State -- PH3089A and DI0455, both in docs/research/facility-types.md -- and
// NEITHER SHIPS: zero PH and zero DI rooms are in the committed index. The
// twelve 5K rooms here are in Ag Engineering, Derby, Denney, Hagerty, Knowlton,
// PAES, Stillman, Smith and Townshend. The clinics are why the type is not
// preferred; they are not a thing this index can put on a screen.
//
// The computer labs, 2P and 2Q, USED TO BE HERE and are not any more.
//
// NOT because they are the worst of this set by `ga`. A first draft said that
// and it is false: every type still listed here is 100% absent from the
// Registrar's general-assignment list -- 5K twelve of twelve, 6L, 2J and 5C all
// of theirs -- against 26 of 27 for the labs, and 1A sits in PREFERRED_TYPES at
// 15 of 18. By that measure the labs were the LEAST bad room here, and the
// sentence would have been precedent for deleting the rest.
//
// They are gone because of WHY their door is locked. A departmental classroom
// is locked by preference and opens when someone is around; a computer lab is
// locked by a lab monitor around fixed equipment, and there is nobody to ask.
// docs/research/facility-types.md is where that distinction is written down.
// The 96% is corroboration, not the criterion.
//
// Ranking them lower was tried first and did not work, which is the other half
// of the argument. Issue #89 put `ga` in tierOf and departmental rooms fell
// from 12.8% of row one to 0.0%, top ten 30.8% to 0.3%. They were already at
// the bottom of every list, and the report from actually using the app was
// still that lab rooms never work. A room ranked last is a room still shown.
//
// Removing them is free, and not merely on a sample. Every lab shares a
// building with at least two ordinary classrooms, so a lab and its neighbours
// are always at the SAME walk, and a list can only empty if every row inside
// MAX_WALK was a lab. Enumerated over all 19 lab-holding buildings x every walk
// 0 to 12 x 7 days x every 5 minutes x 5 asks -- 2,394,665 moments -- the count
// of lab-only moments is ZERO. Not "we sampled and found none": there is no
// origin, minute or ask on this index that can empty a list by this removal.
// Replayed as answers over 149 origins -- all 96 index buildings plus a 7x7
// lattice padded 25% past the bounding box and the four far corners -- seven
// days including the weekend, hourly 06:10 to 22:10, at asks of 30, 60, 120 and
// rest of day: 38,928 lists had rows before and 38,928 after, with a lab on row
// one 133 times. Those 133 are the walks this removes. The grid is written down
// because the first version of this comment gave the counts without it, and a
// figure nobody else can reproduce is worth about as much as a wrong one.
//
// They stay in TYPE_VISIBILITY for now, so the index still carries them and the
// bytes are still spent; the harvest is where that gets fixed, and it runs
// weekly. This is the half that takes effect on deploy.
export const SECONDARY_TYPES = ['5K', '6L', '2J', '5C'];

// Within the preferred set, ordered by how likely the room is to be a room one
// person can sit down in for an hour. 1B is the confident general classroom,
// 1A the seminar room, and 1C the lecture hall LAST.
//
// The lecture hall used to sit second, above the seminar room. It is not a
// dishonest row: MEASURED on the committed index, all 55 of the 1C rooms are on
// the Registrar's general-assignment list, so every one of them is centrally
// scheduled and open. It is a badly sized one. The 55 lecture halls run 48 to
// 727 seats, median 100, against 0 to 271 and a median of 34 for the 309
// classrooms, and issue #62 caught the top of that range in the wild: from the
// Oval on a Saturday, Independence Hall 100 and its 727 seats ranked first.
const TYPE_ORDER = { '1B': 0, SMNR: 1, '1A': 1, LCTR: 2, '1C': 2 };
const PREFERRED = new Set(PREFERRED_TYPES);

// Everything the app is allowed to offer, on any rung and in any list.
//
// Two things about this set are no longer what an older comment here said.
//
// It is not only the ladder's. sweep() reads it too, so a room outside it never
// enters rank() either, and "a caller that wants them has to say so" is no
// longer true of anything: there is no argument that reaches a room this set
// excludes. That is deliberate -- rank() plus shape() is what js/app.js paints,
// and a type filter that only rung() honoured is how labs stayed on screen
// under a sentence that had stopped naming them.
//
// And the rooms outside it are not what they were. Wet labs, dissection labs,
// gyms, studios, kitchens and the online pseudo-room never reach here at all:
// TYPE_VISIBILITY in scripts/lib/room-safety.mjs drops them at harvest, so the
// committed index carries none. On that index the rooms this set excludes are
// exactly the 27 computer labs. The wider guard stays because the type space is
// not closed -- an unrecognised code lands outside too, and the cost of
// guessing wrong is sending someone into a cadaver lab.
const OFFERABLE = new Set([...PREFERRED_TYPES, ...SECONDARY_TYPES]);

const R = 6371008.8;
const rad = (deg) => (deg * Math.PI) / 180;

// ---------------------------------------------------------------- distance

// Equirectangular, not haversine. This runs over every building on every query
// and at campus scale the error is under a metre, checked against a haversine
// reference over every building in data/buildings.json in the tests.
export function distanceMetres(a, b) {
  const x = rad(b.lon - a.lon) * Math.cos(rad((a.lat + b.lat) / 2));
  const y = rad(b.lat - a.lat);
  return Math.sqrt(x * x + y * y) * R;
}

// How far to the nearest door, which is the distance a walk actually covers.
//
// distanceMetres stops at the building's published point, and that point is a
// polygon CENTROID: data/buildings.draft.json has said so in a note since the
// layer was first pulled. Nobody walks to the middle of a building. `d` is the
// doors OSU publishes, whole metres east and north of that point, and the
// nearest of them is where the walk ends.
//
// The offsets add straight onto the origin-to-building vector because they are
// in the same equirectangular plane this function already works in. The only
// approximation is that the cos term is evaluated at the building rather than
// at the door, which over the 72 m of the furthest real door is under a
// millimetre; scripts/test/entrances.test.mjs holds this against a per-door
// distanceMetres call over every shipped door.
//
// A building with no `d` falls back to the published point, which is what every
// building did before the doors existed. 48 of the 50 buildings in the Autumn
// 2026 subset have doors, including 44 of the 46 that host a class. The two
// without are Biological Sciences, absent from the entrance layer entirely, and
// the Theatre, Film and Media Arts Building, whose four doors are all "Under
// Construction".
//
// This does NOT fix the detour bias. #115 measured OSU's own pedestrian network
// running 1.49x the straight line at the median, and correcting the endpoint
// moves the answer the other way: MEASURED over six public origins and the 46
// buildings, the nearest door is 23.3 m closer than the centroid on average, and
// 108 of 276 origin-building pairs lose a whole walk minute. What it removes is
// the endpoint error, which is real and separate: 111 of 6,210 building pairs
// come out in a different ORDER once the walk ends at a door, and the first
// building on the card changes in 2.9% of 238 replayed searches.
export function approachMetres(origin, building) {
  const x = rad(building.lon - origin.lon) * Math.cos(rad((origin.lat + building.lat) / 2)) * R;
  const y = rad(building.lat - origin.lat) * R;

  const doors = building.d;
  if (!doors?.length) return Math.sqrt(x * x + y * y);

  let best = Infinity;
  for (let i = 0; i < doors.length; i += 2) {
    const dx = x + doors[i];
    const dy = y + doors[i + 1];
    const metres = Math.sqrt(dx * dx + dy * dy);
    if (metres < best) best = metres;
  }
  return best;
}

// The metres a walk actually covers, which is the number every screen and the
// whole ranking is built on.
//
// Two sources, and which one answered is not a detail. data/walk-graph.json is
// OSU's own sidewalk network; where it reaches, this is a routed distance over
// pavement and DETOUR plays no part. Where it does not -- a standing point more
// than 150 m from any path, a building with no landing, a term whose file has
// not been built, a browser that failed to fetch it -- the old straight line
// times DETOUR answers instead, and says so by being the only thing left.
//
// The fallback is per ORIGIN and not per building: js/route.js returns no field
// at all rather than a field with holes in it, so one ranking is never half
// routed and half estimated. Mixing the two inside one list is the failure mode
// #115 names, because the models disagree by a median 35 m and the list is
// sorted on the difference.
export function walkMetres(origin, building, code, field) {
  const routed = field?.metresTo(code);
  if (Number.isFinite(routed)) return routed;
  return approachMetres(origin, building) * DETOUR;
}

// Pace, and nothing else.
//
// DETOUR used to live in here, which is what made the two unseparable: one
// number stood for both "campus paths bend" and "people walk at 78 m a minute",
// and #115's measurement could not move either without moving the other. The
// geometry is now upstream in walkMetres, so this is the one place a fitted
// walking speed would land -- and #26, the ground-truth walk, is still the
// measurement that would fit it.
export const walkMinutes = (walked) => Math.ceil(walked / WALK_MPM);

// ----------------------------------------------------------------- the maths

// Wall-clock minutes lost inside a window, on the one Sunday a year Ohio skips
// an hour. Gains in November are ignored on purpose: handing back an extra hour
// would be the only optimistic rounding in the engine.
function dstLoss(dst, from, to) {
  if (!dst || !(dst.lost > 0)) return 0;
  return from < dst.at && dst.at < to ? dst.lost : 0;
}

// THE formula.
//
//   usable = (gapEnd - PACKUP) - max(arrival, gapStart)
//
// NOT `gapEnd - now - walkTime`, which the README used. That version counts the
// time you spend standing in the corridor waiting for the previous class to end
// as time you get to study, and overstates by exactly the wait. For a gap of
// 14:00 to 16:00 with now 13:50 and a 6 minute walk it says 124 minutes. You
// arrive at 13:56, the room frees at 14:00, and you get 120.
//
// It is wrong in the other direction too. Subtracting the walk from a window
// you have not reached yet understates it: a room that frees in 5 minutes and
// is a 6 minute walk away is simply free when you get there, and the walk cost
// nothing because you spent it waiting anyway.
//
// `dst` is `{ at, lost }`, the wall-clock minute the clocks jump forward and by
// how much. A window spanning it holds fewer real minutes than the clock says,
// and this is the one place wall-clock arithmetic overstates.
export function usableMinutes({ now, gapStart, gapEnd, metres, packup = PACKUP, dst }) {
  const usableStart = Math.max(now + walkMinutes(metres), gapStart);
  const usableEnd = gapEnd - packup;
  return usableEnd - usableStart - dstLoss(dst, usableStart, usableEnd);
}

// When to get up. If the gap has not started there is no rush, so the card can
// say "free at 2:00, leave by 1:54" instead of implying you should sprint.
export function leaveBy({ now, gapStart, metres }) {
  return Math.max(now, gapStart - walkMinutes(metres));
}

// ---------------------------------------------------------------- sessions

// Which sessions are running on a given date. `sessions` is the array from
// rooms-<term>.json, each entry [startDate, endDate] as ISO days.
//
// A term is not one continuous block. The committed Autumn 2026 index carries
// 10 sessions, and the seven-week ones do not overlap: the second half starts
// 2026-10-19. Measured on the shipped index, 287 busy tuples on a November date
// belong to a session that has already ENDED, and 3 rooms have their entire
// busy list drawn from a session that is not running. Without this mask those
// rooms read fully booked while they are free all day.
//
// String comparison, not dates. `YYYY-MM-DD` sorts correctly as text, and a
// `Date` here would drag a timezone into a question that has none.
export function activeSessions(sessions, isoDate) {
  return (sessions ?? []).map(([start, end]) => isoDate >= start && isoDate <= end);
}

// The same answer as a Uint8Array, built once per day and reused by every query
// that day. Both shapes are accepted everywhere a mask is taken, because
// `0 === false` is false and an engine that tested for `false` would silently
// ignore a typed mask and report a room booked all day.
export function activeMask(sessions, isoDate) {
  const list = sessions ?? [];
  const mask = new Uint8Array(list.length);
  for (let i = 0; i < list.length; i++) {
    mask[i] = list[i][0] <= isoDate && isoDate <= list[i][1] ? 1 : 0;
  }
  return mask;
}

// ------------------------------------------------------------------- gaps

function withMalformed(gaps, count) {
  // Non-enumerable so the gaps still compare as a plain array, while a caller
  // that wants to assert on data quality can still read the count.
  Object.defineProperty(gaps, 'malformed', { value: count, enumerable: false });
  return gaps;
}

// Busy blocks for one room on one weekday, as
// [dayIndex, startMinute, endMinute, sessionIndex].
//
// Returns the free gaps between them inside [open, close], plus a count of
// blocks that arrived malformed. `active` is the mask from activeSessions or
// activeMask; when omitted every session counts, which is only correct if the
// index has one.
//
// One sweep. Duplicates, containment, partial overlap and back-to-back chaining
// all fall out of the merge, and none of them needs a branch of its own.
export function freeGaps(busy, day, open, close, active) {
  // `day` reaches this from a <select> value or a query string, where it is a
  // string. A strict === against a number then matches nothing, every block is
  // filtered out, and the room reports the whole day free with no error.
  const d = Number(day);
  let malformed = 0;

  // A window that does not run forwards is not a window. Published hours are
  // clean today, 486 day cells and none inverted, but an overnight building
  // would arrive as close <= open and the complement of nothing is a free day.
  if (!(Number.isFinite(open) && Number.isFinite(close) && close > open)) {
    return withMalformed([], 0);
  }

  const blocks = [];
  for (const b of busy) {
    if (Number(b[0]) !== d) continue;
    // A block from a session that is not running today is not a booking today.
    // A session index the mask does not cover stays busy: not knowing which
    // half of the term a class belongs to is not a licence to call the room
    // free.
    if (active && b[3] !== undefined) {
      const live = active[b[3]];
      if (live !== undefined && !live) continue;
    }
    let [, start, end] = b;
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      malformed++;
      continue;
    }
    // An end at or before the start is either a midnight crossing or corrupt
    // data. Dropping it reports an occupied room as free, which is the worst
    // failure this app has, so it is read conservatively as running to the end
    // of the day instead. The hours after midnight that a crossing block also
    // occupies belong to tomorrow, and this index has no way to say that.
    if (end <= start) {
      malformed++;
      end = 1440;
    }
    const clipped = [Math.max(start, open), Math.min(end, close)];
    if (clipped[1] > clipped[0]) blocks.push(clipped);
  }
  blocks.sort((a, b) => a[0] - b[0]);

  // Merge overlapping and touching blocks, so an 8:00-9:00 followed by a
  // 9:00-10:00 is one block and not two with an empty gap between them.
  const merged = [];
  for (const block of blocks) {
    const last = merged[merged.length - 1];
    if (last && block[0] <= last[1]) last[1] = Math.max(last[1], block[1]);
    else merged.push([...block]);
  }

  const gaps = [];
  let cursor = open;
  for (const [start, end] of merged) {
    if (start > cursor) gaps.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < close) gaps.push([cursor, close]);

  return withMalformed(gaps, malformed);
}

// Pick one gap out of a room's day, from the list the single sweep produced.
//
// A gap that has not started when you arrive is NOT equivalent to one that has.
// Picking purely by length sends someone on a seven minute walk to a room with
// a class in it for the next four hours, because that room's afternoon gap is
// longer than the gap the room next door has free right now. So a gap you can
// walk into wins over a longer one you would have to wait for, and the wait is
// reported either way.
//
// `mode` is 'fit' for the answer and 'soon' for the "opens at" rung, which
// skips the gap you could walk into so it can offer the later one that is
// actually long enough. Both come out of the same gap list, so the ladder never
// touches the busy intervals twice.
function pickGap(gaps, opts) {
  const { now, arrival, need = 0, packup = PACKUP, dst, mode = 'fit', lookahead = Infinity } = opts;
  const floor = Math.max(need, 1);
  const horizon = now + lookahead;
  let open = null; // the gap you are inside on arrival, and there is at most one
  let fitting = null; // the earliest later gap that is long enough
  let longest = null; // the best later gap when none of them is long enough

  for (const [gapStart, gapEnd] of gaps) {
    if (gapEnd <= now) continue; // entirely in the past
    const usableStart = Math.max(arrival, gapStart);
    const usableEnd = gapEnd - packup;
    const usable = usableEnd - usableStart - dstLoss(dst, usableStart, usableEnd);
    if (!(usable > 0)) continue; // NaN fails this too, which `<= 0` does not

    if (gapStart <= arrival) {
      if (mode !== 'soon') open = [gapStart, gapEnd, usable];
      continue;
    }
    if (gapStart > horizon) break; // gaps are ordered, so nothing later qualifies
    if (usable >= floor) {
      if (!fitting) fitting = [gapStart, gapEnd, usable];
    } else if (!longest || usable > longest[2]) {
      longest = [gapStart, gapEnd, usable];
    }
  }

  const chosen = mode === 'soon' ? fitting : open ?? fitting ?? longest;
  if (!chosen) return null;
  const [gapStart, gapEnd, usable] = chosen;
  return {
    gapStart,
    gapEnd,
    usable,
    wait: Math.max(0, gapStart - arrival),
    meetsNeed: usable >= need,
  };
}

// The gap you would actually get in this room. Returns null when the room gives
// you nothing. The single-room entry point; `query` reuses the same sweep
// across the whole campus without going through it.
export function bestGap(room, opts) {
  const { now, day, open, close, metres, needed = 0, packup = PACKUP, active, dst, mode, lookahead } = opts;
  const arrival = now + walkMinutes(metres);
  const gaps = freeGaps(room.busy ?? [], day, open, close, active);
  const picked = pickGap(gaps, { now, arrival, need: needed, packup, dst, mode, lookahead });
  if (!picked) return null;
  return { ...picked, malformed: gaps.malformed };
}

// ------------------------------------------------------------------ ranking

// Which tier a row sits in. Lower is better, and the order encodes three
// decisions the project already made rather than a preference:
//
//   published hours beat unknown hours, always. 565 of 612 buildings have no
//   published hours, so this is the majority path and the ranking has to carry
//   the honesty rather than leaving it to a label the eye skips.
//
//   a room open when you arrive beats one you would wait for, even a longer one.
//
//   a general-assignment room beats a departmental one. `ga` is the Registrar's
//   general-assignment pool, pulled 2026-08-27: centrally scheduled rooms, as
//   opposed to rooms a department controls and locks. MEASURED on the committed
//   index, 98 of 425 rooms are not in it, and 56 of those 98 are types the
//   first rung already offers by default (41 type-1B classrooms and 15 type-1A
//   seminar rooms), so they were ranking indistinguishably from a room anybody
//   can walk into. This is docs/BACKLOG.md's parked decision, which asked for
//   them "ranked below general-assignment rooms, with a one-word label on the
//   row": the flag has shipped in every room since then and nothing read it.
//
// `ga` is the LAST of the three, inside the wait and the window, on purpose. A
// departmental classroom that is open when you arrive still beats a general one
// you would wait an hour for: who holds the key is a smaller fact than whether
// the door is open at all.
//
// MEASURED by replaying rank() plus shape() from the Oval, every half hour
// 08:00 to 20:00 on the 2026-09-14 to 18 weekdays at asks of 30 and 60: 250
// lists, 9,103 shown rows. The baseline is this file as it stood on main, and
// the figures below are the whole of this commit against it -- the ga tier,
// TYPE_ORDER and the seat flip together -- not any one term in isolation. One
// run, one baseline, because the first draft of this comment quoted a top-ten
// percentage in the row-one slot and nobody could tell from the text which
// number came from which run.
//
//                              before    after
//   row one is departmental    32 (12.8%)  0 (0.0%)
//   top ten departmental       30.8%       0.3%
//   all shown rows             30.4%      15.4%
//
// It never empties the list. Departmental rooms are still 15.4% of the rows
// shown, further down, carrying the label.
//
// A row with no `ga` at all is treated as general assignment rather than
// departmental. An index built before the general-assignment pull carries the
// field on nothing, and demoting every room in it would be a worse answer than
// the one this replaces.
export function tierOf(row) {
  const dept = row.ga === false ? 1 : 0;
  if (row.hoursKnown) {
    if (row.wait === 0) return (row.meetsNeed ? 0 : 2) + dept;
    return 4 + dept;
  }
  return (row.wait === 0 ? 6 : 8) + dept;
}

// Free means the door is published open AND the room is empty right now. Both
// halves, because a room in a building nobody publishes hours for is a room we
// cannot say anything about, which is the one claim this app exists to refuse.
const isFree = (row) => Boolean(row.hoursKnown) && row.wait === 0;

// Everything a ranked list has to count, counted once.
//
// It is a function rather than four filters at the call sites because it WAS
// four filters at the call sites, three hundred lines apart, and only the
// printed ones carried the hoursKnown half. Driven at 216ba00 with
// data/buildings-hours.json blocked at the network, so every building reads as
// unpublished: the strip printed "Every building we have hours for is closed."
// over 34 rows reading "hours not published", and the live region announced
// "103 rooms free, 38 shown." Print and speech spent the same word on two
// different rules. github.com/EnesYilmazcode/Vacant/issues/45
//
// `shown` is the rows on screen and `reachable` is every room inside the wait
// bound, which is wider on purpose: the spoken count has always been about the
// whole answer, which is how it can honestly read "297 rooms free, 0 shown".
export function tally(shown, reachable = shown) {
  return {
    meets: shown.filter((r) => isFree(r) && r.meetsNeed).length,
    shorter: shown.filter(isFree).length,
    waiting: shown.filter((r) => r.hoursKnown && r.wait > 0).length,
    free: reachable.filter(isFree).length,
  };
}

// Classroom before seminar room before lecture hall before everything else.
export function typeRank(type) {
  const t = TYPE_ORDER[type];
  return t === undefined ? 3 : t;
}

// Seats, as a tiebreak, ordered toward the room one person asked for rather
// than the largest one on offer: at an equal walk a 26 seat classroom is a
// better answer than a 727 seat hall, and the old descending order made that
// exact swap the wrong way round. A room the index publishes no capacity for
// sorts last, which is where the old `?? 0` put it too, because an unknown is
// not evidence of a small room. 3 of the 425 rooms carry the cap 0 sentinel.
//
// MEASURED over the same 250 Oval lists and against the same main baseline as
// tierOf's table above, this whole commit rather than this term alone: the mean
// capacity of a shown row falls from 60.7 seats to 52.7, rows of 100 seats or
// more from 8.4% to 5.7%, and row one from 45.6 seats to 25.3.
//
// It is a tiebreak and not a score term, so it only fires at an equal walk and
// window, and that bound is the honest limit of what it buys. On the Saturday
// of issue #62 it does NOT move Independence Hall 100 off row one: measured at
// 09:00, 12:00, 14:00 and 17:00 on 2026-09-19, IH0100 (727 seats) is a 5 minute
// walk from the Oval and the next free room is 7, so no tiebreak can reach
// across the gap. Moving that row needs a minute-priced capacity penalty in
// scoreOf, and that price is a free parameter with nothing behind it until the
// ground-truth walk in #26 supplies one.
const seatRank = (seats) => (seats == null ? Number.MAX_SAFE_INTEGER : seats);

// Distance and window in the same unit, so a big surplus can buy a short
// detour. Lower is better. Pure distance ranks a 3 minute walk giving exactly
// the time asked above a 4 minute walk giving twice as much, which is the wrong
// answer, and an hour of headroom is worth six minutes of walking and no more.
//
// The penalty side is uncapped deliberately: among rooms that fall short of the
// need, this orders by how badly they miss.
export function scoreOf(row, need = 0) {
  if (row.usable == null) return row.walk; // unknown hours emit no window to trade
  
  const surplus = row.usable - need;
  if (need > 0 && surplus >= 0) {
    // For fixed-duration requests, walk time is primary if need is met.
    // Additional availability is only a tie-break.
    return row.walk - 0.001 * Math.min(surplus, SURPLUS_CAP);
  }
  
  return row.walk - SURPLUS_WEIGHT * Math.min(surplus, SURPLUS_CAP);
}

// The total order. It ends on the room id so the list cannot reshuffle between
// two identical queries: Finder's own API notes record that non-deterministic
// ordering cost it 6% of results per pull, and a stable final key costs nothing.
// A plain string compare, not localeCompare, because the collation of a room id
// should not depend on the phone's language.
function compareRows(a, b) {
  return (
    a.tier - b.tier ||
    a.score - b.score ||
    (b.usable ?? 0) - (a.usable ?? 0) ||
    typeRank(a.type) - typeRank(b.type) ||
    seatRank(a.seats) - seatRank(b.seats) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

// ------------------------------------------------------------------- shaping

// How many rows count as a screenful. MEASURED in the real app at 393x852, the
// device the screenshots are taken on: the sheet dragged to its tallest, 665 of
// those 852 pixels, holds 9 rows of the ranked list at once. Ten is the first
// count that does not fit, so a short list still has something under the fold.
export const SCREEN_ROWS = 10;

// What the ranked list is allowed to be, once compareRows has settled the
// order. Two bounds, and the shipped app applied neither, because js/app.js
// calls rank() and rank() has no radius and no fold.
//
// The radius. From a downtown origin the first row was Pomerene Hall at a 71
// minute walk and the last rendered row was 77 minutes, which is issue #60.
//
// The fold. Walk is cached per building, so every room in one building carries
// the same walk and compareRows ties them through tier and score and hands them
// back consecutively. MEASURED from the Oval every half hour Mon to Fri
// 2026-09-14 to 18 at a 30 and a 60 minute ask, over the 406 samples that had
// any rows: 37.1 rows across 9.2 buildings, the longest same-building run 11.5
// rows, and at 20:00 on the Friday 28 consecutive rows were Enarson. That is
// issue #62.
//
// Nothing is reordered and nothing is rescored. Rows come out in the order they
// went in with rows removed, so row one of a shaped list is row one of the
// ranked list whenever it is inside the bound.
//
// Rows are picked a pass at a time. Pass one is every building's best room,
// which is the screen the fold is there to protect; later passes only top the
// list up to SCREEN_ROWS and stop the moment it gets there. Picking by the list
// that comes out, rather than reading a per-building number off the building
// count, is what keeps the shown count monotone: as campus empties the list can
// only shrink. A number read off the building count did the opposite, and the
// step was visible in the app. From the Oval on Fri 2026-09-18 at a 30 minute
// ask, 20:13 put 10 rows on screen over 116 walkable rooms in 10 buildings and
// 20:14 put 17 rows over 100 rooms in 9: sixteen fewer rooms free, one fewer
// building open, and the list grew 70%.
//
// How much later passes are worth, MEASURED inside the hours the app actually
// ranks in, 08:00 to 20:15 Mon to Fri, over Mon to Fri 2026-09-14 to 18 at a 30
// and a 60 minute ask. From the Oval they are worth nothing: over 250 lists the
// first pass is the whole answer every time. Off it they are the answer: over
// 36,594 lists from 399 origins spread across the 2.2 km gate, a second pass
// runs on 59.2%, and the share of lists holding under ten rows goes from 59.7%
// with one room each to 18.0%.
export function shape(rows, { maxWalk = MAX_WALK, perBuilding, limit = 40 } = {}) {
  const near = [];
  const far = [];
  for (const row of rows) (row.walk <= maxWalk ? near : far).push(row);

  // Which room this is inside its own building, counting down the ranking.
  const nth = new Map();
  const depth = near.map((row) => {
    const n = nth.get(row.building) ?? 0;
    nth.set(row.building, n + 1);
    return n;
  });

  const keep = new Set();
  let deepest = 0;
  // A caller that names a cap gets that cap and no top-up.
  const enough = perBuilding === undefined ? Math.min(limit, SCREEN_ROWS) : limit;
  for (let pass = 0; pass < (perBuilding ?? Infinity); pass++) {
    const room = pass === 0 ? limit : enough;
    if (keep.size >= room) break;
    const before = keep.size;
    for (let i = 0; i < near.length; i++) {
      if (keep.size >= room) break;
      if (depth[i] === pass) keep.add(i);
    }
    if (keep.size === before) break;
    deepest = pass + 1;
  }
  const out = near.filter((_, i) => keep.has(i));

  // Free means free this second, the wait === 0 the rows and the strip already
  // use. Rooms past the bound that open later are held apart from it, because
  // the empty screen spends this count in a sentence with the word free in it:
  // at 2026-09-15 09:00 from 40.0175, -83.013 the nearest room past the bound
  // was Schoenbaum Hall, a 25 minute walk, and it did not open until 10:55am.
  const free = far.filter((r) => r.wait === 0);
  const later = far.filter((r) => r.wait > 0);
  // Ordered by score rather than by walk, so the nearest one has to be found
  // rather than read off the front.
  const nearest = (set) => set.reduce((a, b) => (a && a.walk <= b.walk ? a : b), null);

  return {
    rows: out,
    cap: {
      buildings: new Set(near.map((r) => r.building)).size,
      // The most rows one building was allowed, which is the deepest pass that
      // ran unless the caller named a number.
      perBuilding: perBuilding ?? deepest,
      // Rows inside the bound that did not make the screen, whether the fold or
      // the limit took them. They are NOT "further away": nearly all of them
      // are the same walk as a row already on the list, which is what the old
      // footer got wrong.
      rest: near.length - out.length,
    },
    beyond: {
      count: free.length,
      buildings: new Set(free.map((r) => r.building)).size,
      // The empty screen names this room instead of telling a student who is
      // simply too far away to ask for less time.
      nearest: nearest(free),
      // Past the bound and not free yet. The screen names when it opens.
      waiting: { count: later.length, nearest: nearest(later) },
    },
  };
}

// -------------------------------------------------------------------- marks
//
// The app fetches an index, parses it and answers once. Those three are the
// whole cold launch, so they are the three things worth a mark. The engine can
// only mark the two it owns; `mark` and `measure` are exported so the loader
// can wrap the fetch and the parse with the same names.

// `performance` is missing in a few embedded runtimes and the engine is not
// worth crashing over a timer.
const perf = typeof performance !== 'undefined' && performance.mark ? performance : null;

export function mark(name) {
  if (perf) perf.mark(name);
}

export function measure(name, start, end) {
  if (!perf || !perf.measure) return null;
  try {
    return perf.measure(name, start, end).duration;
  } catch {
    return null; // a missing start mark is not worth an exception
  }
}

const nowMs = () => (perf && perf.now ? perf.now() : 0);

// ------------------------------------------------------------------ the sweep

// One pass over the room table. Every room that survives geography and the
// hours fact gets its busy list swept exactly once, and the gap list is kept so
// the fallback ladder can ask the same room a different question without
// touching the intervals again.
//
// `hoursFor(buildingCode, day)` returns:
//   an [open, close] pair   the building publishes hours for that day
//   null                    the building publishes that day as CLOSED
//   undefined               the building publishes no hours at all
//
// Those three are NOT interchangeable. `null` is a fact and removes the room.
// `undefined` is an absence, and the room is shown, tiered below every
// published-hours room, and never given an assumed window.
function sweep(rooms, opts) {
  const {
    origin, now, day, buildings, hoursFor, active,
    // The walking field for THIS origin, from js/route.js, or nothing. Passed
    // in rather than imported so the engine stays a pure function of its
    // arguments and the tests can rank with and without a graph.
    field,
    dayStart = DAY_START, dayEnd = DAY_END, classesSuspended = false,
  } = opts;
  const walkCache = new Map();
  const out = [];
  const dropped = { notOfferable: 0, noBuilding: 0, noCoordinate: 0, badOrigin: 0, closed: 0, noWindow: 0 };

  for (const room of rooms) {
    const building = buildings[room.b];
    if (!building) {
      dropped.noBuilding++;
      continue;
    }
    // A building row with no usable coordinate is the same as no building. The
    // old guard checked only that the row existed, so a null lat produced a NaN
    // distance, and `NaN <= 0` is false, so the room shipped with NaN minutes
    // and an arbitrary sort position.
    if (!Number.isFinite(building.lat) || !Number.isFinite(building.lon)) {
      dropped.noCoordinate++;
      continue;
    }

    // 871 rooms sit in 96 buildings, so the distance is the same answer nine
    // times out of ten.
    let cached = walkCache.get(room.b);
    if (cached === undefined) {
      const metres = walkMetres(origin, building, room.b, field);
      // A geolocation fix that never resolved reaches here as NaN. Without this
      // every room comes back with NaN minutes in arbitrary order.
      cached = Number.isFinite(metres) ? { metres, walk: walkMinutes(metres) } : null;
      walkCache.set(room.b, cached);
    }
    if (!cached) {
      dropped.badOrigin++;
      continue;
    }

    // A room type nothing offers never enters the ranking. This has to happen
    // in sweep() and not only in rung(): js/app.js builds the list from rank()
    // plus shape(), and rank() had no type filter at all, so dropping the
    // computer labs from OFFERABLE alone changed which rung the ladder
    // REPORTED and left the labs sitting in the rows underneath it. That is the
    // same rank()/rung() split that let a strip describe a search the list
    // could not show.
    //
    // BELOW the origin check, and that placement is load-bearing. query()
    // decides "Vacant does not know where you are" with
    // `dropped.badOrigin === rooms.length`, so a filter that skips rooms before
    // the origin is tested makes that count unreachable on any index holding
    // one unofferable room. Measured with a NaN origin on the committed index:
    // above the check the refusal went from 'location' to none at all, and the
    // screen told a student nothing on campus was free when the truth was that
    // the fix had not resolved. js/engine.js's own comment forbids exactly that
    // collapse. Here, badOrigin still counts every room, as it did before.
    //
    // An absent type is trusted rather than dropped: an index built before
    // types were recorded must still rank. null and '' are absent in the same
    // way undefined is, so they are trusted too -- the old guard let undefined
    // through and failed closed on the other two, which is more trust for less
    // information and the wrong way round.
    if (room.type != null && room.type !== '' && !OFFERABLE.has(room.type)) {
      dropped.notOfferable++;
      continue;
    }

    const hours = hoursFor ? hoursFor(room.b, day) : undefined;
    if (hours === null) {
      dropped.closed++;
      continue;
    }
    // A pair that is not two finite minutes is not published hours. Reading it
    // as a window would invent a door time out of a parse failure.
    const hoursKnown =
      Array.isArray(hours) && Number.isFinite(hours[0]) && Number.isFinite(hours[1]);

    // For an unknown-hours building the window is the schedule's own bounds,
    // and ONLY so the class schedule can be swept. No usable figure is emitted
    // from it, because "free for 20 hours" at 3am in a building nobody knows is
    // open is an assumed window wearing a different hat.
    //
    // The start is clamped to DAY_START or to now, whichever is earlier. The
    // clamp is there so a room with no morning class does not report "free
    // since 00:00", which is true and useless. Clamping it past now instead
    // would put the room in a WAIT and make the row read "from 7:00 AM", and
    // 7:00 AM is a bound on the class schedule, not an hour anybody published
    // for that door.
    const [open, close] = hoursKnown ? hours : [Math.min(dayStart, now), dayEnd];

    // On a day the registrar publishes as having no classes, the busy grid is
    // not a description of the room. 2,048 of the 2,106 Wednesday blocks are
    // still active on Veterans Day, so trusting it hides 97% of campus.
    const gaps = classesSuspended
      ? withMalformed([[open, close]], 0)
      : freeGaps(room.busy ?? [], day, open, close, active);
    if (!gaps.length) {
      dropped.noWindow++;
      continue;
    }

    out.push({
      room,
      building,
      metres: cached.metres,
      walk: cached.walk,
      arrival: now + cached.walk,
      hoursKnown,
      gaps,
    });
  }
  return { candidates: out, dropped };
}

// Turn one swept candidate into a result row for a given need and mode.
function rowFrom(c, { now, need, packup, dst, mode, lookahead }) {
  const gap = pickGap(c.gaps, { now, arrival: c.arrival, need, packup, dst, mode, lookahead });
  if (!gap) return null;
  const row = {
    id: c.room.id,
    building: c.room.b,
    name: c.building.name,
    type: c.room.type ?? null,
    // cap 0 is the index's sentinel for UNKNOWN, not a room with no seats, and
    // 44 of 871 rooms carry it. `?? null` passes 0 straight through, so those
    // rooms would render a confident "0 seats".
    //
    // 998 is the index's other sentinel, for the ONLINE pseudo-room -- see
    // scripts/build-index.mjs's schema line and ONLINE_CAPACITY in
    // scripts/live-rot-checks.mjs. Zero of them ship, because the funnel drops
    // ONLINE long before here, and live-rot-checks.mjs exists precisely because
    // that filter is one upstream rename away from stopping. It is read as
    // unknown for the same reason js/preferences.js already refuses to match a
    // seat minimum against it, rather than rendering "998 seats".
    seats: c.room.cap == null || c.room.cap === 0 || c.room.cap === 998 ? null : c.room.cap,
    // On the Registrar's general-assignment list, or a room a department holds
    // the key to. `tierOf` ranks on it and the row renders the one-word label
    // off it, so it has to survive the trip out of the index. `?? null` and not
    // `?? false`: an index built before the general-assignment pull says
    // nothing about the room, which is not the same as saying no.
    ga: c.room.ga ?? null,
    metres: Math.round(c.metres),
    walk: c.walk,
    // Minutes you actually get, once you have walked there and left the packup
    // buffer. Null when the building publishes no hours, because we cannot know
    // when it locks.
    usable: c.hoursKnown ? gap.usable : null,
    // The end of the free window you could use, packup already removed. Not the
    // raw gap end, which disagrees with `usable` by exactly PACKUP and makes a
    // countdown hand back the buffer.
    usableUntil: c.hoursKnown ? gap.gapEnd - packup : null,
    // When the next class starts, or the building closes. Raw, for display.
    nextClassAt: gap.gapEnd,
    // When the room actually opens up, and how long you would wait after
    // arriving. Without these a caller cannot tell "available now" from
    // "available from 1:00 PM".
    availableAt: gap.gapStart,
    wait: gap.wait,
    // When to get up, which is now if the room is already free.
    leaveBy: leaveBy({ now, gapStart: gap.gapStart, metres: c.metres }),
    meetsNeed: c.hoursKnown ? gap.meetsNeed : null,
    hoursKnown: c.hoursKnown,
    malformedBlocks: c.gaps.malformed,
  };
  row.tier = tierOf(row);
  row.score = scoreOf(row, need);
  return row;
}

// Rank rooms for one query. The shape every caller has used since the walking
// skeleton: an array of rows, best first, no ladder and no radius.
//
// `lookahead` defaults to the whole day here rather than LOOKAHEAD, because the
// result screen uses the far-out rows to name the first building that opens,
// and a horizon would hand it back an empty answer at 6am.
export function rank(rooms, opts) {
  const {
    now, needed = 0, packup = PACKUP, dst, sessions, date, active: given,
    lookahead = Infinity,
  } = opts;
  mark('vacant:answer:start');
  // The index's sessions array and today's ISO date. Without both, every block
  // counts regardless of whether its session is running.
  mark('vacant:index:start');
  const active = given ?? (sessions && date ? activeMask(sessions, date) : undefined);
  mark('vacant:index:end');
  measure('vacant:index', 'vacant:index:start', 'vacant:index:end');

  const { candidates } = sweep(rooms, { ...opts, active });
  const out = [];
  for (const c of candidates) {
    const row = rowFrom(c, { now, need: needed, packup, dst, lookahead });
    if (row) out.push(row);
  }
  out.sort(compareRows);
  mark('vacant:answer:end');
  measure('vacant:answer', 'vacant:answer:start', 'vacant:answer:end');
  return out;
}

// -------------------------------------------------------- what today can be

// How much of the index is talking about a given date.
//
// A busy block carries a session index, and a session carries the dates it
// runs. So the share of blocks whose session is live is a fact about whether
// the schedule still describes today, and it costs one pass.
//
// Returns share null when there is nothing to measure: an index with no busy
// blocks, or a caller that passed no mask. Null is not zero. An engine that
// read "I cannot tell" as "nothing is running" would refuse to answer a small
// index that is perfectly healthy.
export function scheduleCoverage(rooms, active) {
  let total = 0;
  let live = 0;
  for (const room of rooms ?? []) {
    for (const b of room.busy ?? []) {
      total++;
      if (!active || b[3] === undefined || active[b[3]] === undefined || active[b[3]]) live++;
    }
  }
  return { total, live, share: total && active ? live / total : null };
}

// Below this share of the index live, the schedule has stopped describing the
// date and an empty room is not evidence of anything.
//
// MEASURED on the committed Autumn index, 9,561 blocks over 7 sessions, every
// date from August 1 to December 31: on the days classes meet the live share
// sits between 94.80% and 97.68%, and on every other day it is at or below
// 0.073%. Two clusters three orders of magnitude apart with nothing in between,
// so this sits an order of magnitude clear of each.
//
// The split is structural rather than lucky. One full-term session carries
// 9,057 of the 9,561 blocks, so the share is either that session running or it
// is not, and the same shape should hold for any term. Re-derive it anyway when
// a term with a different session layout ships.
export const SILENT_SHARE = 0.1;

// The calendar the class API does not publish, read off whatever the build put
// in the index.
//
// `closed` ships as [{date, state}] and `exams` as {start, end}, but a bare
// date string, a date-keyed object and a [start, end] pair all read too. The
// shape is another lane's to settle, and a rollover that changes it must not
// silently switch the refusal off. Sources are read in order, first hit wins.
//
// Nothing here is inferred. A day the Registrar did not publish is an ordinary
// day, not a holiday.
export function calendarOn(today, ...sources) {
  const from = (key) => {
    for (const src of sources) if (src?.[key] != null) return src[key];
    return undefined;
  };

  const raw = from('exams');
  const exams = Array.isArray(raw) ? { start: raw[0], end: raw[1] } : raw;
  if (exams?.start && exams?.end && today >= exams.start && today <= exams.end) return { exams: true };

  // A bare string means two different things in the two shapes: an entry in the
  // list is a DATE, a value in the map is a STATE.
  const closed = from('closed');
  const hit = Array.isArray(closed)
    ? closed.find((c) => (typeof c === 'string' ? c : c?.date) === today)
    : closed?.[today];
  if (!hit) return null;
  const asState = !Array.isArray(closed) && typeof hit === 'string';
  const kind = asState ? hit : (typeof hit === 'string' ? null : hit.state ?? null);
  const name = (typeof hit === 'string' ? null : hit.name) ?? null;

  // Offices closed and no classes are not shades of one thing. October 15 is
  // Autumn Break, no classes and the doors open, which is the best day of the
  // term for this app. September 7 is Labor Day, the same rooms behind locked
  // doors. A day whose state did not survive the build gets the cautious half.
  return kind === 'no-classes' ? { noClasses: true, name } : { buildingsClosed: true, name };
}

// Everything that has to be settled before a single room is swept.
//
// THE one place that decides whether Vacant may answer. The ladder calls it and
// so does js/state.js, which dresses the verdict into a screen; nothing else is
// allowed to reach the same conclusion by its own route, because two of those
// drift and the day they drift one screen offers 450 rooms while another says
// nobody knows.
//
// The checks come from four places and fail in different directions: a clock
// the device cannot read, an index that did not build, a calendar the class API
// does not publish, and the index's own coverage of today. An exam window makes
// an occupied room look free, a closed campus makes a reachable room look
// reachable, and a date the schedule has stopped covering makes all of campus
// look free at once.
//
// `floor` and `inTerm` are facts about the term rather than about the sweep, so
// they are worked out by the caller that knows the index shape and handed in.
// Both are optional: a caller that does not pass them is not asking about them.
//
// Returns null when today can be answered normally.
export function refusalFor({ now, rooms = [], sessions, date, active: given, calendar, floor, inTerm }) {
  // Wall-clock minutes since local midnight, and nothing else. A value outside
  // that range is an epoch subtraction, which is a whole hour wrong for the rest
  // of the day on the two Sundays a year Ohio changes its clocks. Computing an
  // answer from it would be confidently wrong rather than usefully wrong.
  if (!Number.isFinite(now) || now < 0 || now > 1440) {
    return {
      refused: 'clock',
      reason: 'Vacant could not read the time on this device, so it cannot say what is free.',
    };
  }

  // Fewer rooms than a term this size can hold is a build that broke, not a
  // campus that emptied. Ranking the survivors would report free rooms that are
  // free only because the rooms holding their classes went missing.
  if (floor && !floor.ok) {
    return {
      refused: 'index',
      reason: 'The weekly build read fewer rooms than this term can hold, so Vacant is not ranking what survived.',
      floor,
    };
  }

  // During the exam window the API's busy grid is empty for every room while
  // 200 people sit a final in it, and OSU publishes the exam room assignments
  // nowhere the app can read, so there is nothing to compute from. Refusing is
  // the only honest answer.
  if (calendar?.exams) {
    return {
      refused: 'exams',
      reason: calendar.reason
        ?? 'Finals week. Ohio State reassigns rooms for exams and does not publish the assignments, so Vacant cannot tell you what is free.',
    };
  }
  // Outside the term the busy grid describes nobody, so every room in it reads
  // free. Only a caller that knows the term's dates can see that, which is why
  // it arrives as an answer rather than as a measurement. It sits above the
  // closed days because between terms is the bigger fact: over winter break
  // "campus is between terms, Spring begins Jan 11" beats "Christmas Day,
  // campus is closed" for somebody looking for a room. Finals week is the
  // exception above it, because finals sit outside every session range and
  // would otherwise be read as an empty campus.
  if (inTerm === false) {
    return {
      refused: 'out-of-term',
      reason: 'Today is outside the term this schedule covers, so there is nothing to read it against.',
    };
  }

  if (calendar?.buildingsClosed) {
    return {
      refused: 'closed',
      reason: calendar.reason
        ?? `${calendar.name ? `${calendar.name}. ` : ''}Ohio State is closed today. Most buildings are locked, so a room the schedule shows as empty is still a room you cannot get into.`,
    };
  }

  // A day the registrar publishes as having no classes is a day the grid is
  // wrong the other way, marking rooms busy that nobody is in, and that one is
  // an answer rather than a refusal.
  if (calendar?.noClasses) return null;

  const active = given ?? (sessions && date ? activeMask(sessions, date) : undefined);
  const coverage = scheduleCoverage(rooms, active);
  if (coverage.share !== null && coverage.share < SILENT_SHARE) {
    return {
      refused: 'no-schedule',
      reason: 'The class schedule has nothing for today, in any room on campus. That is what a break or finals week looks like from here, not an empty campus.',
      coverage,
    };
  }
  return null;
}

// ------------------------------------------------------------------- ladder

// The whole answer for one query, including the fallback ladder.
//
// Never returns a blank screen without saying why. Every relaxed answer carries
// `relaxed: true` and names the rung that produced it, because an answer to a
// question the student did not ask has to admit that.
export function query(rooms, opts) {
  mark('vacant:query:start');
  mark('vacant:answer:start');
  const started = nowMs();
  const {
    now, needed = 0, packup = PACKUP, dst, sessions, date, active: given,
    maxWalk = MAX_WALK, limit = 40, calendar,
    dayStart = DAY_START, dayEnd = DAY_END,
  } = opts;

  const base = {
    dayStart,
    dayEnd,
    need: needed,
    askedNeed: needed,
    maxWalk,
    relaxed: false,
    rung: null,
    rows: [],
    total: 0,
    counts: { rooms: rooms.length, considered: 0, dropped: null },
    known: 0,
    unknown: 0,
    refused: null,
    reason: null,
    ms: 0,
  };

  mark('vacant:index:start');
  const active = given ?? (sessions && date ? activeMask(sessions, date) : undefined);
  mark('vacant:index:end');
  measure('vacant:index', 'vacant:index:start', 'vacant:index:end');

  // The clock, the calendar and the index's own coverage of today, all settled
  // before a room is swept. Same function the app calls, so a refusal reads the
  // same whether it came from the ladder or from the screen above it.
  const refusal = refusalFor({ now, rooms, active, calendar });
  if (refusal) {
    return finish({ ...base, refused: refusal.refused, reason: refusal.reason }, started);
  }

  const { candidates, dropped } = sweep(rooms, {
    ...opts, active, dayStart, dayEnd, classesSuspended: !!calendar?.noClasses,
  });
  base.counts = { rooms: rooms.length, considered: candidates.length, dropped };

  // Not knowing where the student is standing is a different failure from there
  // being nothing free, and it has a different fix. Collapsing the two would
  // send someone home when the geolocation fix simply never resolved.
  if (rooms.length && dropped.badOrigin === rooms.length) {
    return finish({
      ...base,
      refused: 'location',
      reason: 'Vacant does not know where you are, so it cannot say what is nearby.',
    }, started);
  }

  // `types` defaults to everything the ladder may reach rather than to no
  // filter at all. A rung that drops the preference has to land on the wider
  // list of rooms you can sit in, not on the whole facility inventory.
  const rung = (need, { mode, types = OFFERABLE, radius, lookahead = LOOKAHEAD, floor = 0, openNow } = {}) => {
    const out = [];
    for (const c of candidates) {
      if (radius !== undefined && c.walk > radius) continue;
      if (types && !types.has(c.room.type)) continue;
      const row = rowFrom(c, { now, need, packup, dst, mode, lookahead });
      if (!row) continue;
      // Free when you get there is the question the app was opened to answer.
      // A room you would wait for is a different answer and gets its own rung.
      if (openNow && row.wait > 0) continue;
      // A room we cannot promise a window for is never a near miss, so the
      // floor cannot be applied to it. It carries its honesty in `hoursKnown`.
      if (row.usable != null && row.usable < floor) continue;
      if (need > 0 && row.hoursKnown && !row.meetsNeed) continue;
      out.push(row);
    }
    out.sort(compareRows);
    return out;
  };

  // Rungs in the order the research note settled on: drop the room-type filter
  // before shortening the time, shorten the time before offering a room that is
  // not free yet, and only then walk further. The first four all mean "free when
  // you get there", which is the question the app was opened to answer.
  const shorter = RELAX_LADDER.filter((n) => n < needed);
  const runs = {
    asked: [needed, false, () => rung(needed, { types: PREFERRED, radius: maxWalk, openNow: true })],
    // Dropping the room-type preference is a relaxation like any other. The
    // rows it adds are SECONDARY_TYPES: conference rooms, one meeting room, a
    // TV and radio facility and two rooms of a type nothing decodes -- every
    // one of them departmental, none of them a computer lab any more -- so an
    // answer built from them is not the question the student asked and has to
    // admit it. js/state.js holds the sentence that admits it; this is the
    // other half of the "twice", and it went stale when the labs left
    // OFFERABLE. It said "departmental seminar rooms", which is 1A: a preferred
    // type, already in the asked rung, and not a room this rung can add.
    'any-type': [needed, true, () => rung(needed, { radius: maxWalk, openNow: true })],
    ...Object.fromEntries(shorter.map((n) => [
      `shorter:${n}`,
      [n, true, () => rung(n, { radius: maxWalk, openNow: true, floor: MIN_RELAXED_USABLE })],
    ])),
    // The README's "the room that frees up in twelve minutes". No horizon on
    // this one: naming when something opens is the whole point of the rung.
    'opens-at': [needed, true, () => rung(needed, {
      mode: 'soon', radius: maxWalk, floor: MIN_RELAXED_USABLE, lookahead: Infinity,
    })],
    further: [needed, true, () => rung(needed, { radius: maxWalk * 2, openNow: true })],
    anywhere: [needed, true, () => rung(needed, { lookahead: Infinity })],
    // Last resort: one room, and the UI is expected to lead with "nothing near
    // you is free" rather than presenting it as an answer.
    longest: [0, true, () => rung(0, { floor: MIN_RELAXED_USABLE, lookahead: Infinity }).slice(0, 1)],
  };

  // The order is RUNGS' order, not this object's, so that the list a screen is
  // tested against and the list the ladder walks cannot come apart. A rung
  // added to `runs` and not to RUNGS never runs; one added to RUNGS and not to
  // `runs` is skipped here and caught by the coverage test.
  const rungs = RUNGS.filter((name) => runs[name]).map((name) => [name, ...runs[name]]);

  // The first rung that reaches quorum wins. A rung that finds one or two rooms
  // is not nothing, so it is held as the fallback, but the ladder keeps going to
  // see whether relaxing something turns it into a real list. Holding the FIRST
  // such rung matters: the rungs get worse as they go, so overwriting it would
  // answer a three-room question with the last resort.
  let answer = null;
  for (const [name, need, relaxed, run] of rungs) {
    const found = run();
    if (!found.length) continue;
    if (!answer) answer = { name, need, relaxed, found };
    if (found.length >= LADDER_QUORUM) {
      answer = { name, need, relaxed, found };
      break;
    }
  }

  if (!answer) {
    return finish({ ...base, reason: 'Nothing on campus is free for long enough today.' }, started);
  }

  const rows = answer.found.slice(0, limit);
  return finish({
    ...base,
    rung: answer.name,
    relaxed: answer.relaxed,
    need: answer.need,
    total: answer.found.length,
    rows,
    // Shown rooms whose building publishes hours, against those it does not.
    // 565 of 612 buildings publish nothing, so a screen can be all unknowns and
    // the caller has to be able to see that without walking the rows.
    known: rows.filter((r) => r.hoursKnown).length,
    unknown: rows.filter((r) => !r.hoursKnown).length,
  }, started);
}

function finish(payload, started) {
  mark('vacant:query:end');
  mark('vacant:answer:end');
  measure('vacant:query', 'vacant:query:start', 'vacant:query:end');
  measure('vacant:answer', 'vacant:answer:start', 'vacant:answer:end');
  payload.ms = nowMs() - started;
  return payload;
}
