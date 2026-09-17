#!/usr/bin/env node
// Sweep the Registrar's SIS room matrix for the NON-CLASS occupancy of every room
// in data/rooms-<term>.json, and emit data/room-events-<term>.json.
//
// Usage:  node scripts/fetch-room-events.mjs
//         node scripts/fetch-room-events.mjs --week 09/28/2026
//         node scripts/fetch-room-events.mjs --rooms EC0322,CZ0160,AP0269
//         node scripts/fetch-room-events.mjs --dry-run
//         node scripts/fetch-room-events.mjs --week 09/28/2026 --from-cache
//
// Vacant's own harvest knows about CLASSES. It does not know about the two other
// things that put a person in a room: registered events (MTG, TOUR, INFO, WRKS,
// SMNR, RCPT, INTV, FAIR, DISC) and Registrar room blocks. Measured on the week of
// 08/31/2026, 323 of
// 327 events and 343 of 347 block cells land in a window Vacant currently calls
// entirely free, and blocks alone cover 10.7% of every weeknight 5-10pm free
// room-minute. That is the gap this file closes.
//
// Measured request count: 1 GET to open the session + 1 POST per room, so 426
// for a full 425-room sweep, plus one 302 hop on the GET = 427 HTTP round trips.
// Sequential by design, one POST at a time with a 120 ms gap: 230 seconds for
// the full sweep, and it parsed 8288 class cells, 327 events and 347 room blocks.
//
// Class cells are counted and thrown away. So is the Registrar's free text on
// every booking: 23 of the 189 distinct labels in one week name a real person,
// no heuristic separates those from the club names reliably, and issue #7
// already settled the same question for instructors. Only the type code
// survives. Nothing downstream wants the words.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The one script in this repo that does not import scripts/lib/fetch.mjs, on
// purpose. PeopleSoft hands out the session cookies on the 302 of the opening
// GET and every later POST has to echo the whole jar back. Node's own redirect
// following does not re-send cookies, so fetchText lands on a "you must have
// cookies enabled" page that arrives as a healthy 200 and parses as an empty
// grid: 425 rooms, no events, no error, no way to tell. request() below walks
// the hops by hand with a jar for that reason. Do not swap in the shared client.

const MATRIX_URL =
  'https://courses.erppub.osu.edu/psc/ps/EMPLOYEE/PUB/c/OSR_CUSTOM_MENU.OSR_ROOM_MATRIX.GBL';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, 'data', 'cache', 'sis-room-matrix');

const USER_AGENT =
  'Vacant/0.1 (+https://github.com/EnesYilmazcode/Vacant; contact via repo issues) ' +
  'weekly non-class room occupancy, <=430 requests/week (part of the <=1900 in scripts/lib/fetch.mjs)';

const DELAY_MS = 120;
const TIMEOUT_MS = 60000;
const RETRIES = 3;
// 1 GET + 425 POSTs + a redirect hop, with headroom for retries and one reopen.
const MAX_REQUESTS = 600;

const MIN_ROOMS = 400;
// Classes are discarded, but they are the stable half of the grid (8288 cells on
// 08/31/2026) so they are the only honest detector of a parse that collapsed.
// Events move week to week and cannot floor anything.
const MIN_CLASS_CELLS = 4000;
const MAX_INVALID = 5;
const MAX_NO_GRID = 5;

// Fail closed when the Registrar introduces a new code: it may be an event, or
// it may be a new kind of hold whose occupancy meaning has not been settled.
// RCPT, INTV and FAIR first appeared in the 09/07/2026 sweep and are ordinary
// registered reservations (reception, interview and fair), so they are busy.
// DISC appeared in the 09/14/2026 sweep with the same nine-digit event ids.
const EVENT_TYPES = new Set(['MTG', 'TOUR', 'INFO', 'WRKS', 'SMNR', 'RCPT', 'INTV', 'FAIR', 'DISC']);

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const COMBINED_BG = 'rgb(222,184,135)';

function die(message) {
  console.error(`\nFATAL  ${message}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// MM/DD/YYYY to the UTC midnight of that day. defaultWeek() below already
// picks the Monday in UTC "independent of a laptop's timezone", and this is the
// other half of that: `new Date('2026-09-14T12:00:00')` is parsed as LOCAL noon,
// and toISOString() then reports the day before it anywhere past UTC+12 --
// Chatham, Apia, Kiritimati. The overlay would have been stamped Sun to Sat
// while check-event-coverage.mjs, which builds the same pair with Date.UTC,
// expected Mon to Sun, and the weekly publish would refuse.
export function mondayOf(week) {
  const [month, day, year] = [week.slice(0, 2), week.slice(3, 5), week.slice(6)].map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

const localDate = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// One of the 425 facility ids is FL2125/35, a room made of two rooms. The slash
// is legal in a facility id and not in a filename.
export const cacheName = (facilityId) => facilityId.replace(/[^A-Za-z0-9]+/g, '_');

async function writeAtomic(path, data) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

// ---------------------------------------------------------------- html helpers

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function unescapeHtml(s) {
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return ENTITIES[name.toLowerCase()] ?? m;
  });
}

function attr(tag, key) {
  const m = tag.match(new RegExp(`\\b${key}=(?:'([^']*)'|"([^"]*)"|([^\\s>]+))`, 'i'));
  if (!m) return null;
  return unescapeHtml(m[1] ?? m[2] ?? m[3] ?? '');
}

// Every POST has to echo the whole hidden set, so this reads the tags rather than
// the handful of names we know: ICStateNum increments per response, ICSID is the
// session's, and a field we failed to notice is a field the server misses.
export function parseHidden(html) {
  const out = new Map();
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/type=['"]?hidden/i.test(tag)) continue;
    const name = attr(tag, 'name');
    if (!name) continue;
    out.set(name, attr(tag, 'value') ?? '');
  }
  return out;
}

// ---------------------------------------------------------------- grid parsing

const TIME_RANGE = /^(\d{1,2}):(\d{2})\s*(AM|PM)\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i;
// <br> becomes a sentinel byte the tag stripper cannot eat, so a cell's lines
// survive as lines through the tag strip. cellText then joins them with ' | ',
// which splitBookings splits back on, so a Registrar label containing a literal
// pipe would split wrong. None does in term 1268 and the type code is all that
// is kept anyway, so this is recorded rather than defended against.
const BR = '\u0001';

export function toMinutes(h, m, ap) {
  const hour = (Number(h) % 12) + (ap.toUpperCase() === 'PM' ? 12 : 0);
  return hour * 60 + Number(m);
}

// Tags are stripped before the entities are decoded, so an escaped &lt;b&gt; in a
// Registrar-typed label is not mistaken for markup and eaten.
const cellText = (inner) =>
  unescapeHtml(inner.replace(/<br\s*\/?>/gi, BR).replace(/<[^>]*>/g, ''))
    .split(BR)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .join(' | ')
    .trim();

// The grid is 7 day columns plus a leading time-label column, 4 rows per hour,
// and cells carry rowspan, so a row's Nth <td> is not the Nth column. `held`
// counts how many more rows each column is still covered for.
export function parseGrid(html) {
  const table = html.match(/<table[^>]*id='WEEKLY_SCHED_HTMLAREA'[\s\S]*?<\/table>/);
  if (!table) return null;
  const tbl = table[0];

  const heads = [...tbl.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
    unescapeHtml(m[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(),
  );
  const days = heads.slice(1);
  const cols = 1 + days.length;
  const held = new Array(cols).fill(0);
  const cells = [];

  let overflow = 0;
  for (const rowMatch of tbl.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const row = rowMatch[1];
    // Only the day header is skipped. Rows with no <td> at all are common (23 of
    // EC0204's 66) and they still have to run the countdown below, or every
    // column drifts and bookings get filed a day late.
    if (/<th\b/i.test(row)) continue;
    let col = 0;
    for (const td of row.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)) {
      while (col < cols && held[col] > 0) col++;
      if (col >= cols) {
        overflow++;
        break;
      }
      const tag = `<x ${td[1]}>`;
      const span = Number(attr(tag, 'rowspan') ?? 1) || 1;
      const text = cellText(td[2]);
      if (col > 0 && text) {
        cells.push({
          dayLabel: days[col - 1] ?? null,
          text,
          rowspan: span,
          combined: (attr(tag, 'style') ?? '').replace(/\s+/g, '').includes(COMBINED_BG),
        });
      }
      held[col] = span;
      col++;
    }
    for (let i = 0; i < cols; i++) if (held[i] > 0) held[i]--;
  }
  return { days, cells, overflow };
}

// One cell can hold several bookings, separated by an empty <br> line. Combined
// sections and overlapping reservations arrive that way (1124 such cells on
// 08/31/2026, all of them classes).
export function splitBookings(text) {
  const out = [];
  let cur = [];
  for (const part of text.split('|').map((p) => p.trim())) {
    if (part) cur.push(part);
    else if (cur.length) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

// The second line decides: a parenthesised 9-digit id is an event, "ROOM BLOCK"
// on the first line is a room block, anything else is a class.
export function classify(parts) {
  if (parts.length >= 2 && /^\(\s*\d{9}\s*\)$/.test(parts[1])) return 'event';
  if (/^ROOM\b/.test(parts[0]) && /\bBLOCK\b/.test(parts[0])) return 'block';
  return 'class';
}

// ---------------------------------------------------------------- the session

let requests = 0;
const jar = new Map();

function takeCookies(res) {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const pair = line.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

// Cookies have to survive the redirect chain, not just the final hop: PeopleSoft
// 302s the first GET, and it answers a cookie-less request with a "you must have
// cookies enabled" error page that arrives as a healthy 200. Node's own redirect
// following does not re-send the jar, so the hops are walked by hand.
async function request(url, init) {
  let target = url;
  let opts = init;
  for (let hop = 0; hop < 6; hop++) {
    if (requests >= MAX_REQUESTS) {
      die(`request cap reached: ${requests} requests, refusing to fetch ${target}`);
    }
    requests++;
    const headers = { 'user-agent': USER_AGENT, ...(opts.headers ?? {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(target, {
      ...opts,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    takeCookies(res);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      await res.text();
      if (!loc) throw new Error(`${res.status} with no Location from ${target}`);
      target = new URL(loc, target).toString();
      if (res.status === 303 || (res.status === 302 && opts.method === 'POST')) {
        opts = { method: 'GET' };
      }
      continue;
    }
    const body = await res.text();
    if (res.status >= 400) throw new Error(`${res.status} ${res.statusText}`);
    return body;
  }
  throw new Error(`too many redirects from ${url}`);
}

export const looksLikeSignon = (html) =>
  /must have cookies enabled/i.test(html) || /An error has occurred/i.test(html);

async function openSession() {
  jar.clear();
  const html = await request(MATRIX_URL, { method: 'GET' });
  if (looksLikeSignon(html)) die('the room matrix answered with the PeopleSoft signon page.');
  if (!html.includes('WEEKLY_SCHED_HTMLAREA')) {
    die('the room matrix page has no WEEKLY_SCHED_HTMLAREA table. The page moved.');
  }
  return parseHidden(html);
}

const DAY_FLAGS = [
  'DERIVED_CLASS_S_MONDAY_LBL$30$',
  'DERIVED_CLASS_S_TUESDAY_LBL',
  'DERIVED_CLASS_S_WEDNESDAY_LBL',
  'DERIVED_CLASS_S_THURSDAY_LBL',
  'DERIVED_CLASS_S_FRIDAY_LBL',
  'DERIVED_CLASS_S_SATURDAY_LBL',
  'DERIVED_CLASS_S_SUNDAY_LBL',
  'DERIVED_CLASS_S_SHOW_AM_PM',
  'DERIVED_CLASS_S_SSR_DISP_TITLE',
];

function buildBody(hidden, facilityId, week) {
  const form = new URLSearchParams();
  for (const [k, v] of hidden) form.set(k, v);
  form.set('ICAction', 'DERIVED_CLASS_S_SSR_REFRESH_CAL');
  form.set('OSR_DERIVED_RM_FACILITY_ID', facilityId);
  form.set('DERIVED_CLASS_S_START_DT', week);
  // The form defaults to 8:00AM-10:00PM and silently hides anything outside it,
  // which is much of what this sweep is for: the 7am blocks and the 10-11pm ones.
  form.set('DERIVED_CLASS_S_MEETING_TIME_START', '7:00AM');
  form.set('DERIVED_CLASS_S_MEETING_TIME_END', '11:00PM');
  form.set('OSR_DERIVED_RM_START_DT', '');
  form.set('OSR_DERIVED_RM_END_DT', '');
  const flags = [...DAY_FLAGS, 'OSR_DERIVED_RM_OSR_SHOW_ROOM', 'OSR_DERIVED_RM_OSR_SHOW_EVENTS'];
  for (const flag of flags) {
    form.set(flag, 'Y');
    form.set(`${flag}$chk`, 'Y');
  }
  return form.toString();
}

const fetchRoom = (hidden, facilityId, week) =>
  request(MATRIX_URL, {
    method: 'POST',
    body: buildBody(hidden, facilityId, week),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });

// ---------------------------------------------------------------- room parsing

// TRAP 1. An unknown facility id is not an error: the server re-renders the
// PREVIOUS room's grid and drops "Invalid value" into the page. Miss that and you
// file one room's bookings under another room's name.
export const isInvalid = (html) => html.includes('Invalid value');

// TRAP 2, independent of trap 1. Every booking's last line names its own building
// and room ("Enarson Classroom Building 322"). The room number has to be this
// room's; the building label is compared against whatever label this building
// number used in earlier responses, because SIS abbreviates seven of the 46
// buildings differently from the GIS names in data/buildings-*.json ("Scott Lab"
// against "Scott Laboratory"), so the repo's own names cannot be the reference.
function checkLocation(where, row, seenBuilding) {
  const parts = where.split(' ');
  const number = parts.pop();
  const building = parts.join(' ');
  if (number !== row.n) return `names room "${number}", expected "${row.n}" (cell said "${where}")`;
  const known = seenBuilding.get(row.b);
  if (known === undefined) seenBuilding.set(row.b, building);
  else if (known !== building) {
    return `building ${row.b} is "${building}" here but was "${known}" earlier (cell said "${where}")`;
  }
  return null;
}

export function parseRoom(html, facilityId, row, seenBuilding) {
  const grid = parseGrid(html);
  if (!grid) return { noGrid: true };

  const dayNames = grid.days.map((d) => d.split(' ')[0]);
  if (grid.days.length !== 7 || dayNames.some((d) => !WEEKDAYS.includes(d))) {
    return { error: `day header is ${JSON.stringify(grid.days)}, expected seven weekdays` };
  }
  // A row with more cells than free columns means the rowspan bookkeeping has
  // drifted, and drift files a booking under the wrong day. Never guess.
  if (grid.overflow) return { error: `${grid.overflow} rows overflowed the 8-column grid` };

  const occ = [];
  let classCells = 0;
  let classBookings = 0;
  let combined = 0;
  for (const cell of grid.cells) {
    const day = WEEKDAYS.indexOf(cell.dayLabel.split(' ')[0]);
    if (cell.combined) combined++;
    let classHere = 0;
    for (const parts of splitBookings(cell.text)) {
      const kind = classify(parts);
      const timeIdx = parts.findIndex((p) => TIME_RANGE.test(p));
      if (timeIdx < 0) return { error: `booking with no time range: "${parts.join(' | ')}"` };
      const t = parts[timeIdx].match(TIME_RANGE);
      if (timeIdx < parts.length - 1) {
        const problem = checkLocation(parts[parts.length - 1], row, seenBuilding);
        if (problem) return { error: problem };
      }
      if (kind === 'class') {
        classHere++;
        continue;
      }
      // The Registrar's free text is dropped here, at the parse boundary, and
      // never reaches the output. 23 of the 189 distinct labels on the week of
      // 08/31/2026 name a real person ("MTG - Dr X Training Mtg", "MTG - Office
      // Hours/<name>"), and no heuristic separates those from the org names
      // reliably enough to trust. Issue #7 already settled the same question for
      // instructors on class meetings; this is that rule applied to events.
      //
      // Nothing downstream needs the words. A busy interval needs a room, a day
      // and two clock times, and `type` is enough to tell a student that the
      // room is booked for a meeting rather than held by the Registrar.
      const label = parts
        .slice(0, timeIdx)
        .filter((p) => !/^\(\s*\d{9}\s*\)$/.test(p))
        .join(' | ');
      occ.push({
        kind,
        day,
        start: toMinutes(t[1], t[2], t[3]),
        end: toMinutes(t[4], t[5], t[6]),
        // An approved registered-event code for an event; null for a block.
        type: kind === 'event' ? (label.match(/^([A-Z]{3,4})\s+-\s+/)?.[1] ?? null) : null,
        eventId:
          kind === 'event'
            ? parts[1].match(/(\d{9})/)[1]
            : (parts[0].match(/-\s*(\S+)\s*$/)?.[1] ?? null),
      });
    }
    // A combined-section cell holds several class bookings, so cells and
    // bookings are different numbers (8288 against 9647 on 08/31/2026) and both
    // get reported rather than one of them wearing the other's name.
    if (classHere) {
      classCells++;
      classBookings += classHere;
    }
  }
  occ.sort((a, b) => a.day - b.day || a.start - b.start || a.end - b.end);
  return { occ, classCells, classBookings, combined, days: grid.days };
}

// ---------------------------------------------------------------- the analysis

const overlaps = (a1, a2, b1, b2) => a1 < b2 && a2 > b1;

// Union length of `ivs` clipped into [w1,w2). Two bookings in the same room on
// the same day would double-count minutes otherwise, and overlapping room-block
// reservations are the normal case rather than the exception.
function unionMinutes(ivs, w1, w2) {
  const clipped = ivs
    .map(([s, e]) => [Math.max(s, w1), Math.min(e, w2)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cs = -1;
  let ce = -1;
  for (const [s, e] of clipped) {
    if (s > ce) {
      if (ce > cs) total += ce - cs;
      cs = s;
      ce = e;
    } else ce = Math.max(ce, e);
  }
  if (ce > cs) total += ce - cs;
  return total;
}

function freeGaps(busy, w1, w2) {
  const gaps = [];
  let cursor = w1;
  const clipped = busy
    .map(([s, e]) => [Math.max(s, w1), Math.min(e, w2)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  for (const [s, e] of clipped) {
    if (s > cursor) gaps.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < w2) gaps.push([cursor, w2]);
  return gaps;
}

export function analyse(index, rooms, week) {
  const monday = mondayOf(week);
  const iso = (d) => d.toISOString().slice(0, 10);
  const weekStart = iso(monday);
  const weekEnd = iso(new Date(monday.getTime() + 6 * 86400000));
  const activeSessions = (index.sessions ?? [])
    .map(([a, b], i) => (a <= weekEnd && b >= weekStart ? i : -1))
    .filter((i) => i >= 0);

  const seen = { event: 0, block: 0 };
  const free = { event: 0, block: 0 };
  const freeInSession = { event: 0, block: 0 };
  for (const [fid, occ] of Object.entries(rooms)) {
    const busy = index.rooms[fid]?.busy ?? [];
    for (const o of occ) {
      seen[o.kind]++;
      if (!busy.some((b) => b[0] === o.day && overlaps(o.start, o.end, b[1], b[2]))) free[o.kind]++;
      const inSession = busy.some(
        (b) =>
          b[0] === o.day && activeSessions.includes(b[3]) && overlaps(o.start, o.end, b[1], b[2]),
      );
      if (!inSession) freeInSession[o.kind]++;
    }
  }

  const windows = [
    { name: 'weeknight 5-10pm (Mon-Fri)', days: [1, 2, 3, 4, 5], from: 17 * 60, to: 22 * 60 },
    { name: 'Saturday 8am-10pm', days: [6], from: 8 * 60, to: 22 * 60 },
  ].map((w) => {
    let windowMinutes = 0;
    let freeMinutes = 0;
    const inWindow = { event: 0, block: 0 };
    const inFreeGap = { event: 0, block: 0 };
    for (const fid of Object.keys(index.rooms)) {
      const busy = index.rooms[fid].busy ?? [];
      for (const day of w.days) {
        windowMinutes += w.to - w.from;
        const dayBusy = busy.filter((b) => b[0] === day).map((b) => [b[1], b[2]]);
        freeMinutes += w.to - w.from - unionMinutes(dayBusy, w.from, w.to);
        const gaps = freeGaps(dayBusy, w.from, w.to);
        for (const kind of ['event', 'block']) {
          const ivs = (rooms[fid] ?? [])
            .filter((o) => o.kind === kind && o.day === day)
            .map((o) => [o.start, o.end]);
          if (!ivs.length) continue;
          inWindow[kind] += unionMinutes(ivs, w.from, w.to);
          for (const [gs, ge] of gaps) inFreeGap[kind] += unionMinutes(ivs, gs, ge);
        }
      }
    }
    const pct = (n) => Number(((100 * n) / freeMinutes).toFixed(2));
    return {
      name: w.name,
      days: w.days,
      from: w.from,
      to: w.to,
      windowMinutes,
      freeMinutes,
      blockMinutesInWindow: inWindow.block,
      eventMinutesInWindow: inWindow.event,
      blockMinutesInsideFreeGaps: inFreeGap.block,
      eventMinutesInsideFreeGaps: inFreeGap.event,
      blockPctOfFree: pct(inWindow.block),
      eventPctOfFree: pct(inWindow.event),
      blockPctOfFreeStrict: pct(inFreeGap.block),
      eventPctOfFreeStrict: pct(inFreeGap.event),
    };
  });

  return {
    week,
    weekStart,
    weekEnd,
    activeSessions,
    landInFreeWindow: {
      events: `${free.event}/${seen.event}`,
      blocks: `${free.block}/${seen.block}`,
      eventsSessionScoped: `${freeInSession.event}/${seen.event}`,
      blocksSessionScoped: `${freeInSession.block}/${seen.block}`,
    },
    windows,
    definitions:
      'landInFreeWindow counts an occurrence as landing in free time when NO busy row in ' +
      'rooms-<term>.json overlaps it on that weekday, using every session. The *SessionScoped ' +
      'pair repeats that against only the sessions meeting this week. blockPctOfFree divides all ' +
      'block minutes inside the window by the free room-minutes in it; *Strict counts only block ' +
      'minutes that fall inside a free gap.',
  };
}

// ---------------------------------------------------------------------- driver

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// The matrix wants a Monday. The Sunday harvest prepares the week that starts
// tomorrow; asking for the current week's Monday expires the overlay that night.
// UTC matches the Actions runner and keeps the choice independent of a laptop's
// timezone. --week still permits an explicit historical or future sweep.
export function defaultWeek(now = new Date()) {
  const d = new Date(now);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? 1 : 1 - day));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()}`;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const fromCache = process.argv.includes('--from-cache');
  if (fromCache && !arg('week')) die('--from-cache requires an explicit --week.');
  const week = arg('week', defaultWeek());
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(week)) die(`--week wants MM/DD/YYYY, got "${week}"`);
  const monday = mondayOf(week);
  if (Number.isNaN(monday.getTime())) die(`--week ${week} is not a date`);
  if (monday.getUTCDay() !== 1) die(`--week ${week} is not a Monday. The matrix renders Mon-Sun.`);

  const indexPath = arg('index', join(ROOT, 'data', 'rooms-1268.json'));
  if (!existsSync(indexPath)) die(`no room index at ${indexPath}`);
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  const all = Object.keys(index.rooms).sort();

  const subset = arg('rooms');
  const partial = Boolean(subset);
  const rooms = partial ? subset.split(',').map((s) => s.trim()).filter(Boolean) : all;
  const unknown = rooms.filter((r) => !index.rooms[r]);
  if (unknown.length) die(`--rooms names ${unknown.join(', ')}, not in ${indexPath}`);
  if (!partial && all.length < MIN_ROOMS) {
    die(`the index holds ${all.length} rooms, under the ${MIN_ROOMS} floor.`);
  }

  const cacheDir = join(CACHE_DIR, week.replace(/\//g, '-'));
  if (!dryRun) await mkdir(cacheDir, { recursive: true });

  console.log(`term ${index.term}  week ${week}  ${rooms.length} rooms${partial ? ' (subset)' : ''}`);
  const started = Date.now();
  let hidden = fromCache ? null : await openSession();

  const out = {};
  const invalid = [];
  const noGrid = [];
  const seenBuilding = new Map();
  let classCells = 0;
  let classBookings = 0;
  let combinedCells = 0;

  for (let i = 0; i < rooms.length; i++) {
    const fid = rooms[i];
    let html = null;
    if (fromCache) {
      const cachePath = join(cacheDir, `${cacheName(fid)}.html.gz`);
      if (!existsSync(cachePath)) die(`missing cached Room Matrix page for ${fid}.`);
      html = gunzipSync(await readFile(cachePath)).toString('utf8');
    } else {
      for (let attempt = 0; attempt <= RETRIES; attempt++) {
        try {
          html = await fetchRoom(hidden, fid, week);
          if (looksLikeSignon(html)) throw new Error('session dropped to the signon page');
          break;
        } catch (err) {
          if (attempt === RETRIES) die(`${fid}: ${err.message}`);
          console.warn(`  warn  ${fid}: ${err.message}, retrying`);
          await sleep(1000 * 2 ** attempt);
          // A dropped session poisons every later POST, so reopen rather than
          // replay a stale ICStateNum at a server that has forgotten us.
          if (attempt >= 1) hidden = await openSession();
        }
      }
    }
    // The next POST needs THIS response's hidden set: ICStateNum advances per
    // response and PeopleSoft rejects a replayed one.
    if (!fromCache) hidden = parseHidden(html);

    if (isInvalid(html)) {
      invalid.push(fid);
      console.warn(`  warn  ${fid}: "Invalid value", skipped (that grid is the PREVIOUS room's)`);
      if (invalid.length > MAX_INVALID) {
        die(
          `${invalid.length} rooms came back "Invalid value" (${invalid.join(', ')}), ` +
            `over the ${MAX_INVALID} bound.`,
        );
      }
      if (!dryRun && !fromCache) {
        await writeAtomic(join(cacheDir, `${cacheName(fid)}.invalid.html.gz`), gzipSync(html));
      }
      continue;
    }

    const parsed = parseRoom(html, fid, index.rooms[fid], seenBuilding);
    if (parsed.error) die(`${fid}: ${parsed.error}`);
    if (parsed.noGrid) {
      noGrid.push(fid);
      console.warn(`  warn  ${fid}: no WEEKLY_SCHED_HTMLAREA table in the response`);
      if (noGrid.length > MAX_NO_GRID) {
        die(`${noGrid.length} rooms answered with no grid (${noGrid.join(', ')}). The page moved.`);
      }
      continue;
    }
    classCells += parsed.classCells;
    classBookings += parsed.classBookings;
    combinedCells += parsed.combined;
    // Every swept room gets a key, even an empty one. An absent key then means
    // "not swept" rather than "swept and clean", which is the difference between
    // no evidence and evidence of nothing.
    out[fid] = parsed.occ;

    // Gzipped: 425 responses is ~26 MB of HTML and this box runs at 97% full.
    if (!dryRun && !fromCache) await writeAtomic(join(cacheDir, `${cacheName(fid)}.html.gz`), gzipSync(html));

    if ((i + 1) % 50 === 0 || i + 1 === rooms.length) {
      console.log(
        `  ${i + 1}/${rooms.length}  ${((Date.now() - started) / 1000).toFixed(0)}s  ${requests} requests`,
      );
    }
    if (!fromCache && i + 1 < rooms.length) await sleep(DELAY_MS);
  }

  const wallClock = Number(((Date.now() - started) / 1000).toFixed(1));
  const occAll = Object.values(out).flat();
  const events = occAll.filter((o) => o.kind === 'event');
  const blocks = occAll.filter((o) => o.kind === 'block');
  const eventTypes = {};
  for (const e of events) {
    const code = e.type ?? 'UNTYPED';
    eventTypes[code] = (eventTypes[code] ?? 0) + 1;
  }

  const counts = {
    roomsRequested: rooms.length,
    roomsParsed: rooms.length - invalid.length - noGrid.length,
    events: events.length,
    distinctEventIds: new Set(events.map((e) => e.eventId)).size,
    roomsWithEvents: Object.values(out).filter((o) => o.some((x) => x.kind === 'event')).length,
    eventTypes,
    blockCells: blocks.length,
    distinctBlockIds: new Set(blocks.map((b) => b.eventId)).size,
    roomsWithBlocks: Object.values(out).filter((o) => o.some((x) => x.kind === 'block')).length,
    classCellsSeenAndDiscarded: classCells,
    classBookingsSeenAndDiscarded: classBookings,
    combinedSectionCells: combinedCells,
    invalidValue: invalid.length,
    noGrid: noGrid.length,
  };

  console.log(
    `\n${counts.events} events (${counts.distinctEventIds} ids) in ${counts.roomsWithEvents} rooms; ` +
      `${counts.blockCells} block cells (${counts.distinctBlockIds} ids) in ${counts.roomsWithBlocks} rooms; ` +
      `${classCells} class cells / ${classBookings} class bookings discarded`,
  );
  console.log(`${JSON.stringify(eventTypes)}`);
  console.log(`${requests} HTTP round trips, ${wallClock}s wall clock`);

  if (!partial && classCells < MIN_CLASS_CELLS) {
    die(
      `only ${classCells} class cells parsed, under the ${MIN_CLASS_CELLS} floor. ` +
        'The grid markup moved.',
    );
  }
  if (partial) console.log('subset run: the class-cell floor was not applied.');

  const analysis = analyse(index, out, week);
  console.log(`\nagainst ${indexPath}`);
  console.log(
    '  land in a window Vacant calls entirely free: ' +
      `${analysis.landInFreeWindow.events} events, ${analysis.landInFreeWindow.blocks} block cells`,
  );
  console.log(
    '  same, ignoring busy rows whose session does not meet this week: ' +
      `${analysis.landInFreeWindow.eventsSessionScoped} events, ` +
      `${analysis.landInFreeWindow.blocksSessionScoped} block cells`,
  );
  for (const w of analysis.windows) {
    console.log(
      `  ${w.name}: ${w.freeMinutes} free room-minutes of ${w.windowMinutes}; ` +
        `blocks cover ${w.blockMinutesInWindow} (${w.blockPctOfFree}%), ` +
        `events ${w.eventMinutesInWindow} (${w.eventPctOfFree}%)`,
    );
    console.log(
      `    counting only minutes inside a free gap: blocks ${w.blockMinutesInsideFreeGaps} ` +
        `(${w.blockPctOfFreeStrict}%), events ${w.eventMinutesInsideFreeGaps} (${w.eventPctOfFreeStrict}%)`,
    );
  }

  const payload = {
    _meta: {
      term: index.term,
      week,
      weekStart: analysis.weekStart,
      weekEnd: analysis.weekEnd,
      generated: localDate(),
      source: MATRIX_URL,
      requests,
      cacheReplay: fromCache,
      wallClockSeconds: wallClock,
      counts,
      partial,
      invalidValueRooms: invalid,
      noGridRooms: noGrid,
      schema:
        'rooms[facilityId] = [{kind event|block, day 0=Sun..6=Sat, start/end minutes from ' +
        'midnight, type, eventId}]. A facilityId present with an empty array was swept and ' +
        'had no non-class occupancy. Class cells are counted in counts and dropped; ' +
        'Vacant harvests those already.',
      labels:
        'The Registrar names each booking in free text; a measured 2026-08-31 week had ' +
        '23 person-naming labels among 189 distinct labels. That text is discarded at the parse boundary and is not in ' +
        'this file. Only `type` survives: MTG, TOUR, INFO, WRKS, SMNR, RCPT, INTV, FAIR or DISC ' +
        'for an event, null for ' +
        'a block.',
      windowNote:
        'The grid was queried 7:00AM-11:00PM. Times are read from the booking own text, not from ' +
        'the grid rows, so a booking that starts before 7am keeps its real start (KN0250 was 6:30AM ' +
        'in the 2026-08-31 sweep). What the window decides is which bookings the page renders at all: one lying ' +
        'entirely outside it is not shown and so is not in this file. The page defaults to ' +
        '8:00AM-10:00PM, which would have hidden the evening bookings this file exists for.',
      eventIdNote:
        'eventId is the parenthesised 9-digit reservation id for an event and the ROOM BLOCK ' +
        'number for a block. They are different id spaces.',
    },
    _analysis: analysis,
    rooms: out,
  };

  if (dryRun) {
    console.log('\nDRY RUN, nothing written.');
    return;
  }
  // A --rooms run is a spot check, not a harvest. It used to land on the same
  // path as the full sweep and quietly replace 425 rooms with three.
  const name = partial
    ? `room-events-${index.term}.subset.json`
    : `room-events-${index.term}.json`;
  const outPath = join(ROOT, 'data', name);
  const json = `${JSON.stringify(payload, null, 1)}\n`;

  // The same fatal scan fetch-building-hours.mjs runs before it writes. The
  // label is dropped inside parseRoom, so nothing here should ever fire; that
  // is the point. A record is {kind, day, start, end, type, eventId}, so any
  // run of letters outside the approved type codes means the drop stopped working.
  if (/[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(json)) die('an email address reached the output.');
  if (/\b\d{3}[-.]\d{3}[-.]\d{4}\b/.test(json)) die('a phone number reached the output.');
  for (const [fid, recs] of Object.entries(payload.rooms)) {
    for (const r of recs) {
      const stray = Object.keys(r).find((k) => !['kind', 'day', 'start', 'end', 'type', 'eventId'].includes(k));
      if (stray) die(`${fid} carries an unexpected field "${stray}"; free text must not reach the output.`);
      if (r.type !== null && !EVENT_TYPES.has(r.type)) {
        die(`${fid} has type "${r.type}", which is not an approved event code.`);
      }
    }
  }

  await writeAtomic(outPath, json);
  console.log(`\nwrote data/${name}`);
}

const invokedDirectly = process.argv[1]?.endsWith('fetch-room-events.mjs');
if (invokedDirectly) main().catch((err) => die(err.stack ?? err.message));
