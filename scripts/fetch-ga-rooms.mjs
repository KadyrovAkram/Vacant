#!/usr/bin/env node
// Pull the Registrar's general assignment room list into data/ga-rooms.json.
//
// Usage:  node scripts/fetch-ga-rooms.mjs 1268
//         node scripts/fetch-ga-rooms.mjs 1268 --dry-run
//
// A general assignment room is one the Registrar schedules centrally rather than
// a department owning it. It is the second opinion on "may a student sit in
// here", and it disagrees with the room's own facilityType about a large slice
// of the inventory: 326 of the 621 rooms that pass the type filter are on this
// list, so 295 are not. Both are shipped and neither decides alone.
//
// Two requests. The index page is fetched to DISCOVER the term page rather than
// to construct its slug, the same reason fetch-building-hours.mjs discovers.

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchText } from './lib/fetch.mjs';
import { termName } from './build-index.mjs';

const INDEX_URL =
  'https://registrar.osu.edu/staff-resources/class-catalog-and-space/general-assignment-rooms/';
const ORIGIN = 'https://registrar.osu.edu';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, 'data', 'cache', 'registrar');
const OUT_PATH = join(ROOT, 'data', 'ga-rooms.json');

// Autumn 2026 publishes 327. A page whose markup moved parses as a handful, and
// a floor catches that even on a first run with nothing to compare against.
const MIN_ROOMS = 150;

// Against the last committed file. The list is a Registrar publication, not a
// live feed, so it should move by a room or two between terms, not by a tenth.
const MAX_DRIFT = 0.1;

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

// Facility IDs join to meetings[].facilityId exactly. No fuzzy matching, no
// case folding, no stripping: EA0160 on the page is EA0160 in the API.
export function parseFacilityIds(html) {
  const ids = [];
  const seen = new Set();
  for (const m of html.matchAll(/Facility ID:\s*([A-Z0-9]+)/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    ids.push(m[1]);
  }
  return ids.sort();
}

// "Autumn 2026" -> the link whose slug contains "autumn-2026". The slug is not
// built and fetched; it is matched against links the index actually published,
// so a renamed page fails loudly here instead of 404ing at the Registrar.
export function findTermLink(indexHtml, name) {
  const want = name.toLowerCase().replace(/\s+/g, '-');
  const links = new Map();
  for (const m of indexHtml.matchAll(/href="([^"]*general-assignment-rooms[^"]*)"/gi)) {
    const href = m[1];
    // On the Registrar, or not followed at all. These hrefs come off a page
    // this script does not control, and the url it picks here is fetched and
    // written into data/cache as a Registrar page. Its sibling in
    // scripts/fetch-calendar.mjs tests the origin; this one took any absolute
    // URL the index carried.
    let url;
    try {
      url = new URL(href, `${ORIGIN}/`);
    } catch {
      continue;
    }
    if (url.origin !== ORIGIN) continue;
    const slug = url.pathname.replace(/\/+$/, '').split('/').pop();
    if (!slug || slug === 'general-assignment-rooms') continue;
    links.set(slug, url.href);
  }
  const hit = [...links.keys()].find((slug) => slug.includes(want));
  return { slug: hit ?? null, url: hit ? links.get(hit) : null, all: [...links.keys()] };
}

async function fetchCached(url, slug, { validate, dryRun } = {}) {
  const cachePath = join(CACHE_DIR, `${slug}.html`);
  let html;
  try {
    html = await fetchText(url);
    if (!html || html.length < 1000) throw new Error(`suspiciously short response (${html?.length} bytes)`);
    // Validate before overwriting the cache. A removed term page redirects to
    // the index and comes back as a healthy 200, and writing that first would
    // destroy the only committed copy.
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
  // Outside the try, the way scripts/fetch-calendar.mjs's save() already does
  // it. A dry run still writes nothing. A write that fails -- no space, no permission, a read-only checkout --
  // is not a failed fetch, and inside the try it was caught as one: the run
  // discarded a good live page, silently fell back to the committed copy, and
  // printed "fetch failed" over a fetch that had worked.
  if (!dryRun) await writeAtomic(cachePath, html);
  return { html, from: 'live' };
}

async function main() {
  const term = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!/^\d{4}$/.test(term ?? '')) {
    console.error('usage: node scripts/fetch-ga-rooms.mjs <term> [--dry-run]');
    process.exit(2);
  }
  const name = termName(term);
  if (!name) die(`cannot name term ${term}, so there is no page to look for.`);

  await mkdir(CACHE_DIR, { recursive: true });

  const index = await fetchCached(INDEX_URL, 'ga-index', {
    validate: (html) => (/general-assignment-rooms/i.test(html) ? null : 'no GA room links'),
    dryRun,
  });
  const { slug, url, all } = findTermLink(index.html, name);
  if (!url) {
    die(`no general assignment page for ${name}. The index lists: ${all.join(', ') || '(nothing)'}`);
  }
  console.log(`ga index (${index.from}) -> ${slug}`);

  const page = await fetchCached(url, slug, {
    validate: (html) => (/Facility ID:/.test(html) ? null : 'no Facility ID rows'),
    dryRun,
  });
  const rooms = parseFacilityIds(page.html);
  console.log(`${slug} (${page.from}): ${rooms.length} facility ids`);

  if (rooms.length < MIN_ROOMS) {
    die(`parsed only ${rooms.length} rooms, under the ${MIN_ROOMS} floor. The page markup moved.`);
  }

  const previous = existsSync(OUT_PATH) ? JSON.parse(readFileSync(OUT_PATH, 'utf8')) : null;
  const before = previous?.rooms?.length ?? 0;
  if (before) {
    const drift = Math.abs(rooms.length - before) / before;
    if (drift > MAX_DRIFT) {
      die(
        `${rooms.length} rooms against ${before} already committed, ` +
          `${(drift * 100).toFixed(1)}% off, over the ${MAX_DRIFT * 100}% bound. ` +
          'Look at the page before committing this.',
      );
    }
    const added = rooms.filter((id) => !previous.rooms.includes(id));
    const gone = previous.rooms.filter((id) => !rooms.includes(id));
    if (added.length) console.log(`  + ${added.join(' ')}`);
    if (gone.length) console.log(`  - ${gone.join(' ')}`);
  }

  const payload = {
    _meta: {
      term,
      termName: name,
      pulled: localDate(),
      source: url,
      count: rooms.length,
    },
    rooms,
  };
  if (dryRun) {
    console.log('DRY RUN, nothing written.');
    return;
  }
  await writeAtomic(OUT_PATH, `${JSON.stringify(payload, null, 1)}\n`);
  console.log(`wrote data/ga-rooms.json`);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('fetch-ga-rooms.mjs');
if (invokedDirectly) main().catch((err) => die(err.message));
