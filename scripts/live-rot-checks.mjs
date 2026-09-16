// The four questions the live rot detector asks, with the network taken out.
//
// Every refusal guard in the build fires when the harvest FAILS. None of them
// fire when the harvest succeeds against changed data. If Ohio State renames
// the ONLINE pseudo-room, the funnel's exclusion stops matching, a 998-seat
// phantom room enters the index carrying real busy blocks, every count stays
// inside its floor, and the build goes green while the app gets worse.
//
// Pure. No node:fs, no fetch. The live test feeds these real pages and
// live-rot-checks.test.mjs feeds them canned ones, so the assertions themselves
// are provable offline.
//
// Each check returns { ok, detail }. detail always names what was observed,
// because "assertion failed" in a weekly issue costs a round trip to find out
// what moved.

import { hasRealRoom, toMinutes } from './lib/funnel.mjs';

// The seven fields build-index.mjs reads off a meeting. A rename here empties
// rooms silently rather than crashing.
export const REQUIRED_FIELDS = [
  'facilityId',
  'facilityType',
  'facilityCapacity',
  'buildingCode',
  'room',
  'startTime',
  'endTime',
];

// All seven, because a room with no weekday flag is dropped by the funnel and a
// renamed flag would drop the whole term.
export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

// There is no second copy of the clock rule here. There was one, and it was
// TIGHTER than the parser it claimed to describe: it rejected "9:05 AM", which
// funnel.mjs's toMinutes reads without complaint, so an upstream change of case
// would have filed an ops issue about a break that is not one. The check asks
// toMinutes directly now, and only a string toMinutes returns null for fails.

// The seat count Ohio State gives the ONLINE pseudo-room. Not a real capacity,
// and the number is the tell if the name ever stops being one.
export const ONLINE_CAPACITY = 998;

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function meetings(page) {
  const out = [];
  for (const entry of page?.data?.courses ?? []) {
    for (const section of entry.sections ?? []) {
      for (const meeting of section.meetings ?? []) out.push(meeting);
    }
  }
  return out;
}

// 1. Field shape, on the first row the harvest would actually keep.
//
// Deliberately not "the first row with a non-null facilityId". ONLINE carries a
// facilityId and a null startTime, so on a page where it comes first that
// sample fails the clock check for a reason that has nothing to do with clocks.
export function fieldShape(page) {
  const sample = meetings(page).find(hasRealRoom);
  if (!sample) {
    return {
      ok: false,
      detail:
        `no meeting on this page is in a real room, out of ${meetings(page).length}. ` +
        'A real room is a facilityId that is not ONLINE or OFFCAMPUS.',
    };
  }

  const missing = REQUIRED_FIELDS.filter((f) => !has(sample, f));
  if (missing.length) {
    return { ok: false, detail: `missing field(s) ${missing.join(', ')} on ${sample.facilityId ?? '?'}` };
  }

  const notBoolean = WEEKDAYS.filter((d) => typeof sample[d] !== 'boolean');
  if (notBoolean.length) {
    const seen = notBoolean.map((d) => `${d}=${JSON.stringify(sample[d])}`).join(', ');
    return { ok: false, detail: `weekday flag(s) are not booleans: ${seen}` };
  }

  for (const field of ['startTime', 'endTime']) {
    if (toMinutes(sample[field]) == null) {
      return { ok: false, detail: `${field} is ${JSON.stringify(sample[field])}, which toMinutes cannot parse` };
    }
  }

  if (typeof sample.buildingCode !== 'string') {
    return { ok: false, detail: `buildingCode is ${JSON.stringify(sample.buildingCode)}, and it is the join key` };
  }
  if (typeof sample.facilityCapacity !== 'number') {
    return { ok: false, detail: `facilityCapacity is ${JSON.stringify(sample.facilityCapacity)}, not a number` };
  }

  return { ok: true, detail: `${sample.facilityId} ${sample.startTime} to ${sample.endTime}, all ${REQUIRED_FIELDS.length} fields and 7 weekday flags present` };
}

// The instruction-mode slug for online teaching, read off the facet rather than
// hardcoded. Hardcoding "dl" or "Distance Learning" means the check fails for
// the exact reason it exists to detect, and reports it as its own bug.
export function distanceLearningMode(page) {
  const facet = (page?.data?.filters ?? []).find((f) => f.slug === 'instruction-mode');
  const items = facet?.items ?? [];
  const hit = items.find((i) => /distance|online|remote/i.test(i.title ?? ''));
  return { slug: hit?.term ?? null, observed: items.map((i) => `${i.term}="${i.title}"`) };
}

// 2. ONLINE still exists and the funnel still excludes it.
//
// The row observed 2026-08-27 is facilityId ONLINE, facilityType 6F,
// facilityCapacity 998, buildingCode ONLINE, room null, and both clock fields
// null while all seven weekday flags are present. Rename buildingCode and it
// becomes a 998 seat room holding real busy blocks.
export function onlineStillExists(page) {
  const rows = meetings(page);

  // Asked first because it is the harm rather than the symptom. A row the
  // funnel now calls a real room while still carrying the online seat count is
  // a 998 seat phantom room in the index holding real busy blocks, with every
  // guard's count intact and the build green.
  const phantom = rows.filter((m) => m.facilityCapacity === ONLINE_CAPACITY && hasRealRoom(m));
  if (phantom.length) {
    const first = phantom[0];
    return {
      ok: false,
      detail:
        `${phantom.length} row(s) carry the ${ONLINE_CAPACITY} seat online capacity and are no longer excluded, ` +
        `e.g. facilityId ${JSON.stringify(first.facilityId)} buildingCode ${JSON.stringify(first.buildingCode)}`,
    };
  }

  const online = rows.filter((m) => m.buildingCode === 'ONLINE');
  if (online.length === 0) {
    const codes = [...new Set(rows.map((m) => m.buildingCode))].slice(0, 12);
    return {
      ok: false,
      detail: `no row on this page has buildingCode "ONLINE". ${rows.length} meetings, codes seen: ${codes.join(', ')}`,
    };
  }
  const first = online[0];
  return {
    ok: true,
    detail: `${online.length} of ${rows.length} rows are ONLINE, e.g. facilityId ${JSON.stringify(first.facilityId)} capacity ${JSON.stringify(first.facilityCapacity)}`,
  };
}

// 3. The building join still holds. Measured 2026-08-27 on page 1 of Autumn
// 2026: 163 real-room meetings, 39 distinct codes, 0 unresolved.
export function buildingJoin(page, buildings) {
  const counts = new Map();
  for (const m of meetings(page)) {
    if (!hasRealRoom(m)) continue;
    counts.set(m.buildingCode, (counts.get(m.buildingCode) ?? 0) + 1);
  }
  if (counts.size === 0) return { ok: false, detail: 'no real-room meeting on this page, so the join was never exercised' };

  const unresolved = [...counts.keys()].filter((c) => !has(buildings, c));
  if (unresolved.length) {
    const named = unresolved.map((c) => `${JSON.stringify(c)} (${counts.get(c)} meetings)`).join(', ');
    return { ok: false, detail: `${unresolved.length} of ${counts.size} building codes are not in buildings.json: ${named}` };
  }
  return { ok: true, detail: `all ${counts.size} building codes resolve, over ${[...counts.values()].reduce((a, b) => a + b, 0)} real-room meetings` };
}

// 4. The harvest axis still exists. fetch-rooms.mjs walks the catalog-number
// buckets and nothing else, so a facet that disappears or collapses to one
// bucket ends the 136 request budget the whole harvest is built on.
export function harvestAxis(page) {
  const filters = page?.data?.filters ?? [];
  const facet = filters.find((f) => f.slug === 'catalog-number');
  if (!facet) {
    return { ok: false, detail: `no catalog-number facet. Facets present: ${filters.map((f) => f.slug).join(', ') || 'none'}` };
  }
  const buckets = (facet.items ?? []).map((i) => i.term);
  if (buckets.length <= 1) {
    return { ok: false, detail: `catalog-number returned ${buckets.length} bucket(s): ${JSON.stringify(buckets)}` };
  }
  return { ok: true, detail: `${buckets.length} buckets: ${buckets.join(', ')}` };
}
