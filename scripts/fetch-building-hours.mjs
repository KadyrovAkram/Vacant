#!/usr/bin/env node
// Scrape the Registrar's classroom pool building schedule into
// data/buildings-hours.json.
//
// This is the dataset the whole project exists for. Recomputed from the file
// this script actually writes, a flat 7am-10pm assumption overstates open
// minutes by 16% Mon-Fri and 798% at weekends for Autumn 2026, and by 39% and
// 3580% for Summer 2026. The research quotes 27% and 837%; neither term
// produces those. Only 5 of the 47 Autumn pool buildings open Saturday and 11
// open Sunday. Without this, Vacant names free rooms behind locked doors, which
// is the precise failure the README calls out in every other app.
//
// Usage:  node scripts/fetch-building-hours.mjs
//         node scripts/fetch-building-hours.mjs --dry-run
//
// Term pages are DISCOVERED by following links from the pool index, never by
// constructing a slug: winter-break-classroom-pool-building-schedule-2025-2026
// breaks the season-year pattern, and it is unknown whether an old term's page
// survives once the next is posted. Every page fetched is cached in-repo, and a
// failed fetch falls back to the cached copy rather than failing the build.

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gunzipSync } from 'node:zlib';

import { fetchText, requests } from './lib/fetch.mjs';
import { formatFunnel, isRealRoom, newCounter, toMinutes } from './lib/funnel.mjs';
import { DAY_INDEX, parseDayCell, parsePage } from './lib/hours.mjs';

const INDEX_URL =
  'https://registrar.osu.edu/staff-resources/class-catalog-and-space/classroom-pool-building-schedule/';
const ORIGIN = 'https://registrar.osu.edu';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, 'data', 'cache', 'registrar');
const OUT_PATH = join(ROOT, 'data', 'buildings-hours.json');
const BUILDINGS_PATH = join(ROOT, 'data', 'buildings.json');
const OVERRIDES_PATH = join(ROOT, 'data', 'registrar-hours-overrides.json');

// Both published terms carry 47 buildings. 40 is a floor that survives a term
// with a few fewer, and catches a page whose markup moved.
const MIN_BUILDINGS = 40;

// A published close that lands before the last class of the day is not
// necessarily a data error. Hopkins Hall publishes a 6:30pm close and runs
// classes to 8:45pm, and its own Registrar comment explains why: art students
// have swipe card access outside building hours. A late class proves badge
// access, not an open door, so this WARNS and never rewrites the hours.
//
// Never derive hours from the class schedule as a fallback. Cunz Hall makes the
// same point at finer grain, locking floor 2 and above at 6pm while floor 1
// stays open, so building-level hours are already optimistic for some rooms.
const OVERRUN_ALLOWLIST = { HH: 'Hopkins Hall: swipe card access for art students outside building hours' };

// Which committed archive, if any, covers a term page.
const TERM_FOR_SLUG = {
  'summer-2026-classroom-pool-building-schedule': '1264',
  'autumn-2026-classroom-pool-building-schedule': '1268',
};

// Latest class end per buildingCode per weekday, read straight from the archive.
function lastClassEndByBuilding(term, isKnownBuilding, counter) {
  const dir = join(ROOT, 'data', 'raw', term);
  if (!existsSync(dir)) return null;
  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const latest = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json.gz'))) {
    const page = JSON.parse(gunzipSync(readFileSync(join(dir, file))));
    for (const course of page?.data?.courses ?? []) {
      for (const section of course.sections ?? []) {
        for (const meeting of section.meetings ?? []) {
          if (!isRealRoom(meeting, section, counter, { isKnownBuilding })) continue;
          const end = toMinutes(meeting.endTime);
          if (end == null) continue;
          if (!latest.has(meeting.buildingCode)) latest.set(meeting.buildingCode, new Array(7).fill(0));
          const row = latest.get(meeting.buildingCode);
          for (let i = 0; i < 7; i++) if (meeting[DAYS[i]] === true) row[i] = Math.max(row[i], end);
        }
      }
    }
  }
  return latest;
}

function die(message) {
  console.error(`\nFATAL  ${message}`);
  process.exit(1);
}

const localDate = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

async function writeAtomic(path, text) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

// Fetch, cache, and fall back to the cache on failure. The in-repo cache is the
// answer to "it is unknown whether an old term's page survives".
async function fetchCached(url, slug, { validate, dryRun } = {}) {
  const cachePath = join(CACHE_DIR, `${slug}.html`);
  let html;
  try {
    html = await fetchText(url);
    if (!html || html.length < 1000) throw new Error(`suspiciously short response (${html?.length} bytes)`);
    // Validate BEFORE overwriting the cache. fetch follows redirects, so a
    // removed term page that 301s to the pool index comes back as a healthy 200
    // with a 40 KB body. Writing that first destroys the committed copy, which
    // is the only reason the cache exists. A WAF interstitial or a CMS 404
    // served as 200 does the same.
    if (validate) {
      const problem = validate(html);
      if (problem) throw new Error(`response failed validation: ${problem}`);
    }
  } catch (err) {
    if (existsSync(cachePath)) {
      console.warn(`  warn  ${slug}: fetch failed (${err.message}), using the committed cache`);
      return { html: readFileSync(cachePath, 'utf8'), from: 'cache' };
    }
    throw err;
  }
  // A dry run must not touch committed files, and the write sits outside the
  // try, the way scripts/fetch-calendar.mjs's save() already does it. A write
  // that fails -- no space, no permission, a read-only checkout --
  // is not a failed fetch, and inside the try it was caught as one: the run
  // discarded a good live page, silently fell back to the committed copy, and
  // printed "fetch failed" over a fetch that had worked.
  if (!dryRun) await writeAtomic(cachePath, html);
  return { html, from: 'live' };
}

export function discoverTermLinks(indexHtml) {
  const found = new Map();
  const re = /href="([^"]*classroom-pool-building-schedule[^"]*)"/gi;
  let m;
  while ((m = re.exec(indexHtml))) {
    const href = m[1];
    // Resolved against the origin and compared as one. The test below has
    // always asserted every url comes back on registrar.osu.edu, and nothing
    // here enforced it: an absolute href was taken as given, and whatever it
    // named would be fetched and written into data/cache/registrar as a
    // Registrar hours page.
    let url;
    try {
      url = new URL(href, `${ORIGIN}/`);
    } catch {
      continue;
    }
    if (url.origin !== ORIGIN) continue;
    const slug = url.pathname.replace(/\/+$/, '').split('/').pop();
    // The index links to itself; that is the container, not a term.
    if (!slug || slug === 'classroom-pool-building-schedule') continue;
    found.set(slug, url.href);
  }
  return [...found.entries()].map(([slug, url]) => ({ slug, url }));
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  await mkdir(CACHE_DIR, { recursive: true });

  if (!existsSync(BUILDINGS_PATH)) die('data/buildings.json is missing. Run fetch-buildings.mjs first.');
  const buildings = JSON.parse(readFileSync(BUILDINGS_PATH, 'utf8')).buildings;

  // The join is on buildingCode only, via the GIS layer's own
  // SchedulingAbbreviation. All 47 registrar abbreviations resolve this way with
  // no ambiguity, which is why there is no hand-maintained alias table here.
  const byAbbr = new Map();
  for (const [code, b] of Object.entries(buildings)) {
    if (!b.short) continue;
    if (!byAbbr.has(b.short)) byAbbr.set(b.short, []);
    byAbbr.get(b.short).push(code);
  }

  const overrideFile = existsSync(OVERRIDES_PATH)
    ? JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'))
    : { overrides: {} };

  const looksLikeTermPage = (html) =>
    html.includes('panel panel-default') ? null : 'no panel panel-default markup';
  const looksLikeIndex = (html) =>
    /classroom-pool-building-schedule/i.test(html) ? null : 'no pool schedule links';

  const index = await fetchCached(INDEX_URL, 'pool-index', { validate: looksLikeIndex, dryRun });
  const terms = discoverTermLinks(index.html);
  if (!terms.length) die('no term links found on the pool index. The page markup moved.');
  console.log(`pool index (${index.from}): ${terms.length} term pages\n`);

  const out = {};

  for (const { slug, url } of terms) {
    const page = await fetchCached(url, slug, { validate: looksLikeTermPage, dryRun });
    const all = parsePage(page.html);
    const broken = all.filter((r) => r.unparseable);
    const rows = all.filter((r) => !r.unparseable);
    const termOverrides = overrideFile.overrides?.[slug] ?? {};

    // A panel whose title markup drifted used to be dropped silently. With a
    // floor of 40 against 47 panels, seven buildings could vanish, and each one
    // then lands in unknownHours, so the app says "hours not published" about a
    // building that publishes them.
    if (broken.length) {
      die(
        `${slug}: ${broken.length} panel(s) did not parse:\n` +
          broken.map((b) => `         ${JSON.stringify(b.raw.slice(0, 80))}`).join('\n'),
      );
    }
    if (rows.length < MIN_BUILDINGS) {
      die(`${slug}: parsed only ${rows.length} buildings, under the ${MIN_BUILDINGS} floor.`);
    }

    const buildingsOut = {};
    let overridden = 0;
    const unresolvedCells = [];
    const unjoined = [];

    const appliedOverrides = new Set();
    const missingDays = [];

    for (const row of rows) {
      // Repair what the override file covers, and only what it covers.
      let appliedHere = 0;
      for (const err of row.errors) {
        const fix = termOverrides[row.abbr]?.[err.day];
        if (!fix) {
          unresolvedCells.push({ abbr: row.abbr, day: err.day, raw: err.raw });
          continue;
        }
        row.hours[DAY_INDEX[err.day]] = parseDayCell(fix.value);
        appliedOverrides.add(`${row.abbr}.${err.day}`);
        appliedHere++;
        overridden++;
      }

      // A day that never appeared in the list is NOT a closed day, and shipping
      // it as null publishes a closed building. One <li> reading
      // "Monday-Thursday: 7am-10pm" produces exactly this with zero errors.
      //
      // Recomputed here rather than read off row.missing, because an
      // unparseable cell also leaves the slot undefined and an override has
      // just filled it. Only a slot still undefined after overrides is a day
      // the page genuinely never published.
      const stillMissing = Object.entries(DAY_INDEX)
        .filter(([, i]) => row.hours[i] === undefined)
        .map(([day]) => day);
      if (stillMissing.length) missingDays.push({ abbr: row.abbr, missing: stillMissing });

      const codes = byAbbr.get(row.abbr);
      if (!codes) {
        unjoined.push(row.abbr);
        continue;
      }
      // Set from what was actually applied, not from an entry merely existing.
      // When the Registrar fixes a typo, row.errors is empty, nothing is
      // replaced, and a fully scraped record would still claim to be
      // hand-supplied.
      const hasOverride = appliedHere > 0;
      for (const code of codes) {
        buildingsOut[code] = {
          abbr: row.abbr,
          name: buildings[code].name,
          hoursSource: hasOverride ? 'override' : 'registrar',
          hours: row.hours.map((h) => (h === undefined ? null : h)),
        };
      }
    }

    // An unparseable cell with no override stops the build and names the
    // building and the raw text. It is a Registrar typo, and a parser that
    // quietly picks a meaning is how an app starts lying.
    if (unresolvedCells.length) {
      die(
        `${slug}: ${unresolvedCells.length} unparseable day cell(s) with no override:\n` +
          unresolvedCells
            .map((c) => `         ${c.abbr} ${c.day}: ${JSON.stringify(c.raw)}`)
            .join('\n') +
          `\n       Add them to data/registrar-hours-overrides.json with a documented reason.`,
      );
    }
    if (missingDays.length) {
      die(
        `${slug}: ${missingDays.length} building(s) are missing a day from the published list:\n` +
          missingDays.map((m) => `         ${m.abbr}: no ${m.missing.join(', ')}`).join('\n') +
          `\n       A day that never appeared is not a closed day. Check the page markup.`,
      );
    }

    // A stale override shadows the real value, which the overrides file's own
    // _doc says must not happen. Nothing else would ever tell you.
    for (const [abbr, days] of Object.entries(termOverrides)) {
      for (const day of Object.keys(days)) {
        if (appliedOverrides.has(`${abbr}.${day}`)) continue;
        console.warn(
          `  warn  ${slug}: override ${abbr}.${day} matched no unparseable cell. ` +
            `The Registrar may have fixed it; delete the entry.`,
        );
      }
    }

    if (unjoined.length) {
      die(`${slug}: ${unjoined.length} abbreviation(s) did not resolve to a buildingCode: ${unjoined.join(', ')}`);
    }

    // Does any class run past the published close?
    const archiveTerm = TERM_FOR_SLUG[slug];
    const overrunCounter = newCounter();
    const latest = archiveTerm
      ? lastClassEndByBuilding(archiveTerm, (c) => c in buildings, overrunCounter)
      : null;
    // Saying nothing reads exactly like "checked, all clear".
    if (!latest) {
      console.log(
        `  note  no class-past-close cross-check: ` +
          (archiveTerm ? `no archive at data/raw/${archiveTerm}` : 'no term mapped for this page'),
      );
    } else if (overrunCounter.usable === 0) {
      die(`${slug}: the ${archiveTerm} archive yielded 0 usable meetings. ${formatFunnel(overrunCounter)}`);
    } else {
      console.log(`  cross-check against ${archiveTerm}: ${formatFunnel(overrunCounter)}`);
    }
    if (latest) {
      const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const overruns = [];
      for (const [code, rec] of Object.entries(buildingsOut)) {
        const ends = latest.get(code);
        if (!ends) continue;
        for (let i = 0; i < 7; i++) {
          const h = rec.hours[i];
          if (!ends[i]) continue;
          if (h === null) overruns.push({ code, rec, day: names[i], close: 'closed', end: ends[i] });
          else if (h && ends[i] > h[1]) overruns.push({ code, rec, day: names[i], close: h[1], end: ends[i] });
        }
      }
      const flagged = overruns.filter((o) => !OVERRUN_ALLOWLIST[o.rec.abbr]);
      const excused = overruns.length - flagged.length;
      if (overruns.length) {
        const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        console.log(`  ${overruns.length} class-past-close overruns (${excused} on the allowlist):`);
        for (const o of flagged.slice(0, 8)) {
          console.log(
            `    warn  ${o.rec.abbr} ${o.day}: closes ${o.close === 'closed' ? 'closed' : hhmm(o.close)}` +
              `, last class ends ${hhmm(o.end)}`,
          );
        }
        if (flagged.length > 8) console.log(`    ... and ${flagged.length - 8} more`);
      }
    }

    const openDays = (i) => Object.values(buildingsOut).filter((b) => b.hours[i]).length;
    out[slug] = {
      slug,
      source: url,
      fetchedFrom: page.from,
      buildingCount: Object.keys(buildingsOut).length,
      overriddenCells: overridden,
      buildings: buildingsOut,
    };
    console.log(
      `${slug} (${page.from})\n` +
        `  ${rows.length} buildings parsed, ${Object.keys(buildingsOut).length} joined, ` +
        `${overridden} cells from overrides\n` +
        `  open Sunday ${openDays(0)}, Saturday ${openDays(6)}, Monday ${openDays(1)}`,
    );
  }

  // Every building that is NOT in the pool list has no published hours at all.
  // That is the majority path by building count and it must never be filled in
  // with a plausible guess. Recorded explicitly so the app can say "hours not
  // published" as a fact rather than hedge.
  const covered = new Set(Object.values(out).flatMap((t) => Object.keys(t.buildings)));
  const unknown = Object.keys(buildings).filter((c) => !covered.has(c));

  console.log(
    `\n${covered.size} of ${Object.keys(buildings).length} buildings have published hours, ` +
      `${unknown.length} do not.`,
  );
  console.log(`${requests()} requests.`);

  if (dryRun) {
    console.log('DRY RUN, nothing written.');
    return;
  }

  const payload = {
    generated: localDate(),
    source: INDEX_URL,
    attribution: 'Ohio State University Office of the University Registrar',
    dayIndex: '0 = Sunday through 6 = Saturday. [openMinute, closeMinute] or null for closed.',
    note: 'A building absent from every term below has NO published hours. It must be shown as unknown, never as assumed or usually open.',
    terms: out,
    unknownHours: unknown,
  };
  const json = `${JSON.stringify(payload, null, 1)}\n`;

  // The panel bodies carry staff names, keycard contacts and phone numbers in
  // their Comment blocks. None of that is parsed, and this proves none of it
  // leaked through anyway.
  if (/\b\d{3}[-.]\d{3}[-.]\d{4}\b/.test(json)) die('a phone number reached the output.');
  if (/[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+/.test(json)) die('an email address reached the output.');
  if (/\b[a-z]+\.\d{1,4}\b/i.test(json)) die('an OSU name.n identifier reached the output.');

  await writeAtomic(OUT_PATH, json);
  console.log(`wrote data/buildings-hours.json (${(json.length / 1024).toFixed(0)} KB)`);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('fetch-building-hours.mjs');
if (invokedDirectly) main().catch((err) => die(err.message));
