// The days the class API is silent about, in both directions.
//
// A meeting's endDate is the last day of INSTRUCTION, so from December 10 to
// December 17 the busy list is empty for every room and Vacant would send
// someone into a 200-person final. And holidaySchedule is the literal string
// "OSUSIS" on all 4,931 sections sampled, so on November 11 the grid marks 788
// of 863 Wednesday busy rows occupied on a day nothing meets. Twelve wrong
// weekdays out of the 83 between the first class and the last final.
//
// Two sources, and neither is allowed to be the only one. The Registrar's
// five-year table is the publisher of record and is what ships. The vendored
// ICS is a third-party regeneration of the same calendar and is the check. They
// disagree, badly, and the build refuses rather than picking a winner.
//
// Pure. No node builtins, no fetch.

// offices-closed and no-classes are NOT shades of one thing.
//
// October 15 is Autumn Break: no classes and the doors open, which is the best
// day of the term for this app. September 7 is Labor Day: the same rooms behind
// locked doors. Nothing in the class API separates them, which is the whole
// reason this file exists.
export const OFFICES_CLOSED = 'offices-closed';
export const NO_CLASSES = 'no-classes';

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const SHORT_MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

export function addDays(date, n) {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

// Signed whole days from a to b. Both are plain dates read at UTC midnight, so
// no daylight-saving hour ever leaks into the subtraction.
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// The state a calendar row puts a day into, from the literal phrases the
// Registrar writes. A row that says neither is not classified: this returns
// null and the day does not ship. "Spring Break" alone is such a row.
export function stateOf(summary) {
  const s = String(summary ?? '').toLowerCase();
  if (s.includes('offices closed')) return OFFICES_CLOSED;
  if (s.includes('offices open')) return NO_CLASSES;
  return null;
}

// The holiday out of the row, so a refusal can say WHICH day it is refusing.
// "Thanksgiving Day, campus is closed" is a fact a student can check. "Campus
// is closed today" is the app asking to be believed.
//
// Two shapes on the same page. Most rows separate the name from the state with
// a dash, and Indigenous Peoples Day runs them together with no punctuation at
// all, so the state words are cut either way.
export function eventName(summary) {
  const cut = String(summary ?? '').trim().split(/\s+[-–—]\s+/)[0];
  return cut.replace(/\s+(?:no classes|offices)\b.*$/i, '').trim() || null;
}

// ---------------------------------------------------------------- ICS

// DTEND is EXCLUSIVE on a VALUE=DATE event, so 20261015..20261017 is October 15
// and 16, two days, not three.
export function parseIcs(text) {
  if (typeof text !== 'string' || !text.includes('BEGIN:VEVENT')) return [];
  // RFC 5545 folds long lines with a leading space. The vendored file has none
  // today, and unfolding costs one replace, so it is done rather than assumed.
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const out = [];
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const field = (key) => {
      const m = new RegExp(`^${key}(?:;[^:\\r\\n]*)?:(.*)$`, 'm').exec(block);
      return m ? m[1].trim() : null;
    };
    const asDate = (v) => (v && /^\d{8}/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null);
    const start = asDate(field('DTSTART'));
    if (!start) continue;
    const end = asDate(field('DTEND'));
    // The generator escapes commas and semicolons per the spec.
    const summary = (field('SUMMARY') ?? '').replace(/\\([,;\\])/g, '$1');
    const days = [];
    if (end && end > start) for (let d = start; d < end; d = addDays(d, 1)) days.push(d);
    else days.push(start);
    out.push({ start, end, summary, days });
  }
  return out;
}

// ------------------------------------------------- Registrar HTML tables

// &amp; comes after the numeric entities, not before them: expanded first it
// turns `&amp;#8211;` into `&#8211;` and the next line turns that into a dash,
// so an escaped entity in a holiday name reads as the character it names.
const stripTags = (html) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8211;|&ndash;/g, '-')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

export function parseTables(html) {
  const tables = [];
  for (const table of String(html ?? '').match(/<table[\s\S]*?<\/table>/gi) ?? []) {
    const rows = [];
    for (const row of table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
      rows.push((row.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) ?? []).map(stripTags));
    }
    tables.push(rows);
  }
  return tables;
}

// "Monday, September 7, 2026" -> 2026-09-07. Also reads the range form the
// winter recess row uses, "Monday, December 28, 2026 - Thursday, December 31,
// 2026", and returns both ends expanded.
export function parseLongDates(cell) {
  const out = [];
  for (const m of String(cell ?? '').matchAll(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/g)) {
    const month = MONTHS[m[1].toLowerCase()];
    if (!month) continue;
    out.push(iso(Number(m[3]), month, Number(m[2])));
  }
  if (out.length !== 2) return out;
  // A two-date cell is a range in this table, never two separate days.
  const days = [];
  for (let d = out[0]; d <= out[1]; d = addDays(d, 1)) days.push(d);
  return days;
}

// The term columns the five-year view is carrying today, in page order.
//
// The page is republished and the columns roll: the copy on disk runs Autumn
// 2023 to Autumn 2027 and will not carry Autumn 2026 forever. Anything that
// names a column in a string constant refuses a healthy page for a wrong
// reason the first time a term rolls over.
export function parseFiveYearColumns(html) {
  const out = [];
  for (const rows of parseTables(html)) {
    for (const cell of rows[0] ?? []) {
      const m = /^(AUTUMN|SPRING|SUMMER)\s+(\d{4})$/i.exec(cell.trim());
      if (m) out.push(`${m[1].toUpperCase()} ${m[2]}`);
    }
  }
  return out;
}

// The five-year view, read down one column. `column` is the header label, for
// example "AUTUMN 2026". Returns one entry per calendar row that resolves to at
// least one date.
export function parseFiveYear(html, column) {
  const want = String(column ?? '').toLowerCase().trim();
  const out = [];
  for (const rows of parseTables(html)) {
    if (!rows.length) continue;
    const header = rows[0].map((c) => c.toLowerCase().trim());
    const at = header.indexOf(want);
    if (at < 0) continue;
    for (const cells of rows.slice(1)) {
      if (cells.length <= at) continue;
      const days = parseLongDates(cells[at]);
      if (!days.length) continue;
      out.push({ summary: cells[0], days });
    }
  }
  return out;
}

// The finals page, for the window only.
//
// The class-time-to-exam-slot map on the same page is useless without the exam
// ROOM, which lives in a separate Final Assignment List the Registrar marks
// coming soon. So this reads the days and nothing else.
//
// Two spellings of the same day appear on the page and both are read, so a
// change to one is caught by the other: "Monday Dec 14" in the three lookup
// tables and "Monday 12/14" in the matrix header.
//
// The comma and the trailing year are optional because the Summer page writes
// the same day three ways. "Monday, August 3" in its lookup tables and "Monday
// August 3, 2026" in its matrix header, where Autumn writes "Monday Dec 14" and
// "Monday 12/14". Requiring Autumn's spelling parsed the whole Summer page to
// zero days, and a page that parses to nothing is a build that dies.
export function parseFinalsWindow(html, year) {
  const days = new Set();
  for (const rows of parseTables(html)) {
    for (const cells of rows) {
      for (const cell of cells) {
        const slash = /^(?:Mon|Tues|Tue|Wednes|Wed|Thurs|Thu|Fri)[a-z]*\s+(\d{1,2})\/(\d{1,2})$/i.exec(cell);
        if (slash) {
          days.add(iso(year, Number(slash[1]), Number(slash[2])));
          continue;
        }
        const named =
          /^(?:Mon|Tues|Tue|Wednes|Wed|Thurs|Thu|Fri)[a-z]*,?\s+([A-Za-z]{3,})\.?\s+(\d{1,2})(?:,\s*(\d{4}))?$/i.exec(cell);
        if (named) {
          const month = SHORT_MONTHS[named[1].slice(0, 3).toLowerCase()];
          // A cell that names a year has to name the one we asked for, or the
          // page is not the term it was cached as.
          if (month && (!named[3] || Number(named[3]) === year)) {
            days.add(iso(year, month, Number(named[2])));
          }
        }
      }
    }
  }
  const sorted = [...days].sort();
  return sorted.length ? { start: sorted[0], end: sorted[sorted.length - 1], days: sorted } : null;
}

// ---------------------------------------------------------------- shaping

// One entry per day inside the window that a calendar row put into a state.
export function closedDays(events, [from, to]) {
  const byDate = new Map();
  for (const event of events) {
    const state = stateOf(event.summary);
    if (!state) continue;
    for (const date of event.days) {
      if (date < from || date > to) continue;
      // offices-closed wins a collision. A day that is both is a locked door.
      if (byDate.get(date)?.state === OFFICES_CLOSED) continue;
      byDate.set(date, { date, state, name: eventName(event.summary) });
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Windows where the grid is misleading but the day is not closed. Autumn 2026's
// first-session finals are October 13 and 14: full-term classes meet normally,
// and the seven-week rooms hold exams that are in no busy list.
//
// The five-year table writes one row per exam day and the ICS writes one range,
// so contiguous days are merged and the two sources land on the same shape.
export function lowConfidence(events, [from, to]) {
  const days = new Set();
  for (const event of events) {
    if (!/final examinations for first-session/i.test(event.summary)) continue;
    for (const d of event.days) if (d >= from && d <= to) days.add(d);
  }
  const out = [];
  for (const day of [...days].sort()) {
    const last = out[out.length - 1];
    if (last && addDays(last.end, 1) === day) last.end = day;
    else out.push({ start: day, end: day, reason: 'session-1-finals' });
  }
  return out;
}

// The exam window as the calendar states it, first day to last.
//
// The five-year view writes one row per exam day and the ICS writes one range,
// so both reduce to the same pair. This is the cross-check on the finals page,
// which is the only source that also carries the time-of-day matrix.
// `after` is required for the ICS, which carries 2021 to 2030 in one file and
// would otherwise answer with a ten-year window. The five-year view is already
// one term per column.
export function examWindow(events, after) {
  const limit = after ? addDays(after, 60) : null;
  const days = [];
  for (const event of events) {
    if (!/^Final examinations for (semester|Summer Term)/i.test(String(event.summary ?? ''))) continue;
    for (const d of event.days) {
      if (after && (d <= after || d > limit)) continue;
      days.push(d);
    }
  }
  if (!days.length) return null;
  days.sort();
  return { start: days[0], end: days[days.length - 1] };
}

// The term's teaching window, from the Registrar's own rows. Never the min and
// max of harvested meeting dates: Anatomy 6511 runs 2026-08-10 to 2026-12-11 and
// Pharmacy 7110 to 2026-12-10, because the professional colleges keep their own
// calendars, and taking the max stretches Autumn 2026 straight through the exam
// window it is supposed to end before.
export function termWindow(events) {
  const begins = [];
  const ends = [];
  for (const event of events) {
    const s = String(event.summary ?? '');
    if (/classes begin$/i.test(s)) begins.push(...event.days);
    if (/^Last day of regularly scheduled/i.test(s)) ends.push(...event.days);
  }
  if (!begins.length || !ends.length) return null;
  return { first: begins.sort()[0], last: ends.sort()[ends.length - 1] };
}

// Every date the two sources put into a state inside the window, compared, and
// split by whether a slid holiday explains the difference.
//
// `tolerance` is how many days a holiday may have moved before the difference
// stops being the ICS generator's known defect and starts being news. 0 means
// the two sources must agree exactly, which is what Autumn gets: it has never
// needed anything else. See the ICS_SHIFT_DAYS note in build-index.mjs for the
// measurement the other two seasons come from.
//
// `shifted` is reported and `unexplained` is fatal, so a source that names the
// right holiday on the wrong day does not stop a term shipping, and a source
// that invents a holiday still does.
export function diffCalendars(a, b, window, { tolerance = 0, labels = ['registrar', 'ics'] } = {}) {
  const map = (events) => new Map(closedDays(events, window).map((c) => [c.date, c]));
  const left = map(a);
  const right = map(b);
  const line = (date) =>
    `${date}  ${labels[0]}=${left.get(date)?.state ?? 'nothing'}  ` +
    `${labels[1]}=${right.get(date)?.state ?? 'nothing'}`;

  const leftOnly = [];
  const rightOnly = [];
  const unexplained = [];
  for (const date of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const l = left.get(date)?.state;
    const r = right.get(date)?.state;
    if (l === r) continue;
    // One date, two states, is never a slid holiday. It is one source calling a
    // locked door an open one, which is the disagreement that matters most.
    if (l && r) unexplained.push(line(date));
    else if (l) leftOnly.push(date);
    else rightOnly.push(date);
  }

  // Nearest pair first, so two holidays inside one tolerance window cannot swap
  // partners and leave both sides looking explained.
  const candidates = [];
  for (const l of leftOnly) {
    for (const r of rightOnly) {
      if (left.get(l).state !== right.get(r).state) continue;
      const gap = Math.abs(daysBetween(l, r));
      if (gap > tolerance) continue;
      candidates.push({ l, r, gap });
    }
  }
  candidates.sort((x, y) => x.gap - y.gap || x.l.localeCompare(y.l) || x.r.localeCompare(y.r));

  const shifted = [];
  const usedLeft = new Set();
  const usedRight = new Set();
  for (const c of candidates) {
    if (usedLeft.has(c.l) || usedRight.has(c.r)) continue;
    usedLeft.add(c.l);
    usedRight.add(c.r);
    shifted.push(
      `${left.get(c.l).name ?? left.get(c.l).state}: ${labels[0]} ${c.l}, ` +
        `${labels[1]} ${c.r}, ${c.gap} day(s) off`,
    );
  }
  for (const date of [...leftOnly, ...rightOnly]) {
    if (usedLeft.has(date) || usedRight.has(date)) continue;
    unexplained.push(line(date));
  }
  return { shifted: shifted.sort(), unexplained: unexplained.sort() };
}
