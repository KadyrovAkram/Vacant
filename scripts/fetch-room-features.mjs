#!/usr/bin/env node
// Merge Ohio State's two published room-feature sources into one file keyed by
// Vacant facility id, and say plainly which rooms neither source covers.
//
// Usage:  node scripts/fetch-room-features.mjs
//         node scripts/fetch-room-features.mjs --dry-run
//         node scripts/fetch-room-features.mjs --refresh          ignore the page cache
//         node scripts/fetch-room-features.mjs --term 1268
//         node scripts/fetch-room-features.mjs --rooms <path>     default data/rooms-1268.json
//
// Vacant knows when a room is free and nothing about what is inside it. The
// Registrar's general assignment list publishes furniture, boards, windows and
// floor slope for 327 rooms. OTDI's Learning Spaces directory publishes seats,
// AV, darkening, photos and a 360 tour for 320. Neither covers the whole index,
// and neither is enough alone, because the two use the word "moveable" on
// different axes: the Registrar means NOT BOLTED TO THE FLOOR, Learning Spaces
// means ON CASTERS. Held together they give a three-level mobility scale that
// neither source publishes, so the merge is the point of this script rather
// than a convenience.
//
// 323 requests measured end to end on a cold cache: 1 Registrar index + 1 term
// page + 1 Learning Spaces index + 320 classroom pages. A warm re-run makes 0.
// The shared client's MAX_REQUESTS is 4,000 per process, so the cap is not in
// play here; the User-Agent's weekly ceiling is what this scraper moved.
//
// data/cache/registrar/ is committed and shared with fetch-ga-rooms.mjs.
// data/cache/learningspaces/ is 12 MB over 321 files and is NOT committed, so a
// clean checkout refetches those once and every run after that is free.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, fetchText, mapLimit, requests } from './lib/fetch.mjs';
import { termName } from './build-index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, 'data', 'cache');
const OUT_PATH = join(ROOT, 'data', 'room-features.json');
const DEFAULT_ROOMS = join(ROOT, 'data', 'rooms-1268.json');

const REGISTRAR_ORIGIN = 'https://registrar.osu.edu';
const REGISTRAR_INDEX =
  'https://registrar.osu.edu/staff-resources/class-catalog-and-space/general-assignment-rooms/';
const LS_INDEX = 'https://learningspaces.osu.edu/classrooms';

// Autumn 2026 publishes 327 Registrar rooms and 320 Learning Spaces pages. These
// are floors rather than equalities: the sources are allowed to gain and lose a
// room between terms, they are not allowed to collapse because markup moved.
const MIN_REGISTRAR_ROOMS = 300;
const MIN_LS_PAGES = 300;
const MIN_JOINED = 280;

// The Registrar's own legend, read off the page's first panel. Treated as an
// allow list with a safe default: an unrecognised code is printed and kept, it
// never drops the room.
const CHARACTERISTICS = {
  30: 'Moveable Tablet Arm Chairs',
  31: 'Stationary Tablet Arm Chairs',
  32: 'Moveable Tables/Chairs',
  33: 'Stationary Tables/Chairs',
  37: 'Sloped/Tiered Floors',
  39: 'Windows',
  40: 'No Windows',
  41: 'Black Out Shade',
  42: 'Variable Intensity Lighting',
  43: 'Chalkboards',
  44: 'Whiteboards',
  53: 'Computer Lab',
  54: 'Innovative Space',
};

const TABLET_CODES = new Set([30, 31]);
const TABLE_CODES = new Set([32, 33]);
const STATIONARY_CODES = new Set([31, 33]);

const LS_FAMILY = {
  'Fixed Tablet Arms': 'tablet-arm',
  'Moveable Tablet Arms': 'tablet-arm',
  'Movable Tables and Chairs': 'table-chair',
  'Fixed Table and Chairs': 'table-chair',
  'Group Seating': 'group',
};

// The only Learning Spaces furniture value that asserts wheels. Its "Fixed"
// means no casters, NOT bolted, so it can never decide bolted on its own.
const CASTER_FURNITURE = 'Moveable Tablet Arms';

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

let cacheHits = 0;

const cachePath = (source, slug) => join(CACHE_DIR, source, `${slug}.html`);

// A cache hit costs no request, which is what makes a re-run free. The response
// is validated before it overwrites the cache: a retired page redirects to an
// index and comes back as a healthy 200, and writing that destroys the only copy.
async function fetchCached(url, source, slug, { validate, refresh, dryRun }) {
  const path = cachePath(source, slug);
  if (!refresh && existsSync(path)) {
    cacheHits++;
    return { html: await readFile(path, 'utf8'), from: 'cache' };
  }
  let html;
  try {
    html = await fetchText(url);
    if (!html || html.length < 1000) {
      throw new Error(`suspiciously short response (${html?.length} bytes)`);
    }
    const problem = validate?.(html);
    if (problem) throw new Error(`response failed validation: ${problem}`);
  } catch (err) {
    if (existsSync(path)) {
      console.warn(`  warn  ${slug}: ${err.message}, falling back to the cache`);
      cacheHits++;
      return { html: await readFile(path, 'utf8'), from: 'cache' };
    }
    throw err;
  }
  if (!dryRun) {
    await mkdir(dirname(path), { recursive: true });
    await writeAtomic(path, html);
  }
  return { html, from: 'live' };
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  ndash: '–', mdash: '—',
};

function text(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*$/, '')
    .trim();
}

// EC0322 carries n "322" and SOE0004 carries n "E004", while the photo stems
// spell the same rooms 0322 and E0004. Collapsing every digit run to its integer
// makes the two spellings one string without touching a wing letter.
export const normRoom = (s) =>
  String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/\d+/g, (d) => String(Number(d)));

const normName = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const normBuilding = (s) => String(Number(String(s).replace(/\D/g, '')));

// "Autumn 2026" -> the link the index actually published, never a slug we built.
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
      url = new URL(href, `${REGISTRAR_ORIGIN}/`);
    } catch {
      continue;
    }
    if (url.origin !== REGISTRAR_ORIGIN) continue;
    const slug = url.pathname.replace(/\/+$/, '').split('/').pop();
    if (!slug || slug === 'general-assignment-rooms') continue;
    links.set(slug, url.href);
  }
  const hit = [...links.keys()].find((s) => s.includes(want));
  return { slug: hit ?? null, url: hit ? links.get(hit) : null, all: [...links.keys()] };
}

// One panel per building, then a run of rooms inside it. The split is on the
// literal "Facility ID:" rather than the anchor that wraps it. Both currently
// yield all 327 rooms, but the text is the thing the Registrar is committed to
// and the link is decoration. A whole-panel regex is wrong for a different
// reason: some rooms repeat the codes inline as "Room Characteristics: 32, 39,
// 41, 44" ahead of the <ul>.
//
// The page opens with a LEGEND listing all 13 codes once each, before the first
// Facility ID. Splitting on the marker leaves it in the head and out of every
// room, which is why the per-room totals sit exactly one under a raw <li> count.
export function parseRegistrar(html) {
  const rooms = new Map();
  const buildings = [];
  const unknownCodes = new Map();
  const numberDisagreements = [];

  for (const panel of html.split(/<div class="panel panel-default">/).slice(1)) {
    const segments = panel.split(/Facility ID:\s*/).slice(1);
    if (!segments.length) continue; // the legend panel, which lists codes and no rooms

    const name = text(panel.match(/data-toggle="collapse"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '');
    const fromMap = panel.match(/osu\.edu\/map\/building\/(\d+)/)?.[1] ?? null;
    const fromText = panel.match(/Building Number:\s*(\d+)/)?.[1] ?? null;
    // Enarson's panel prints 027 and links building 072. The map link is the one
    // that agrees with the ArcGIS layer, so it wins and the split is reported.
    const number = fromMap ?? fromText;
    if (fromMap && fromText && normBuilding(fromMap) !== normBuilding(fromText)) {
      numberDisagreements.push({ building: name, mapLink: fromMap, panelText: fromText, used: fromMap });
    }
    buildings.push({ name, number, rooms: segments.length });

    for (const segment of segments) {
      const id = segment.match(/^([A-Z0-9]+)/)?.[1];
      if (!id) continue;
      const capacity = Number(segment.match(/Capacity:\s*(\d+)/)?.[1] ?? NaN);
      const list = segment.match(/<ul>([\s\S]*?)<\/ul>/)?.[1] ?? '';
      const characteristics = [];
      for (const m of list.matchAll(/<li>\s*(\d+)[\s ]*-\s*([\s\S]*?)<\/li>/g)) {
        const code = Number(m[1]);
        const label = text(m[2]);
        if (!CHARACTERISTICS[code]) unknownCodes.set(code, label);
        characteristics.push({ code, label: CHARACTERISTICS[code] ?? label });
      }
      rooms.set(id, {
        facilityId: id,
        buildingName: name,
        buildingNumber: number,
        capacity: Number.isFinite(capacity) ? capacity : null,
        characteristics,
        codes: characteristics.map((c) => c.code),
      });
    }
  }
  return { rooms, buildings, unknownCodes, numberDisagreements };
}

// One card per classroom, grouped under a per-building accordion. The card
// carries the front photo, which is the join key, and the accordion title is the
// fallback for the handful of cards that have no photo.
export function parseLearningSpacesIndex(html) {
  const cards = [];
  for (const group of html.split(/bux-accordion__heading/).slice(1)) {
    const building = text(group.match(/bux-accordion__title">([\s\S]*?)\(\d+<span/)?.[1] ?? '');
    for (const cell of group.split(/<div class="bux-grid__cell[^"]*\bclassroom">/).slice(1)) {
      const href = cell.match(/href="(https:\/\/learningspaces\.osu\.edu\/classroom\/[^"]+)"/)?.[1];
      if (!href) continue;
      cards.push({
        building,
        title: text(cell.match(/aria-label="([^"]*)"/)?.[1] ?? ''),
        url: href,
        slug: href.replace(/\/+$/, '').split('/').pop(),
        photo: cell.match(/src="(https:\/\/rooms\.app\.it\.osu\.edu\/[^"]+)"/)?.[1] ?? null,
      });
    }
  }
  return cards;
}

// Drupal renders every field as field--name-<machine name>, which survives a
// theme change better than the rendered label text does.
function fieldChunk(html, name) {
  const marker = `field--name-${name} `;
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const rest = html.slice(i + marker.length);
  const next = rest.search(/field--name-field-classroom-|<\/article>/);
  return next < 0 ? rest.slice(0, 8000) : rest.slice(0, next);
}

function fieldValues(html, name) {
  const chunk = fieldChunk(html, name);
  if (chunk === null) return [];
  return [...chunk.matchAll(/class="field__item">([\s\S]*?)<\/div>/g)].map((m) => text(m[1])).filter(Boolean);
}

const fieldValue = (html, name) => fieldValues(html, name)[0] ?? null;

function fieldBool(html, name) {
  const v = fieldValue(html, name);
  if (v === 'Yes') return true;
  if (v === 'No') return false;
  return null;
}

export function parseLearningSpacesPage(html, { url, slug }) {
  const tour = fieldChunk(html, 'field-classroom-360-tour')?.match(/href="([^"]+)"/)?.[1] ?? null;
  const photos = [
    ...new Set([...html.matchAll(/https:\/\/rooms\.app\.it\.osu\.edu\/[^"'\s]+/g)].map((m) => m[0])),
  ];
  return {
    slug,
    url,
    title: text(html.match(/<h1 class="page-title"><span>([\s\S]*?)<\/span>/)?.[1] ?? ''),
    campus: fieldValue(html, 'field-classroom-campus'),
    address: fieldValue(html, 'field-classroom-location'),
    supportGroup: fieldValues(html, 'field-classroom-support-group'),
    seats: Number(fieldValue(html, 'field-classroom-number-of-seats')) || null,
    furnitureType: fieldValue(html, 'field-classroom-furniture-type'),
    darkeningQuality: fieldValue(html, 'field-classroom-darkening-qual'),
    airConditioning: fieldBool(html, 'field-classroom-air-conditioning'),
    carpeted: fieldBool(html, 'field-classroom-carpeted'),
    heightAdjustableLectern: fieldBool(html, 'field-classroom-ht-adj-lectern'),
    bestAffordance: text(html.match(/<h3>Best Affordance:\s*([\s\S]*?)<\/h3>/)?.[1] ?? '') || null,
    boardType: fieldValues(html, 'field-classroom-board-type'),
    microphoneType: fieldValues(html, 'field-classroom-microphone-type'),
    inRoomCamera: fieldValues(html, 'field-classroom-in-room-camera'),
    displayInputs: fieldValues(html, 'field-classroom-display-inputs'),
    additionalAV: [
      ...new Set([...html.matchAll(/additional-av">([\s\S]*?)aria-label="([^"]*)"/g)].map((m) => text(m[2]))),
    ],
    photos: { front: photos.find((p) => /-front\.jpg$/i.test(p)) ?? null, all: photos },
    tour360: tour ? (tour.startsWith('http') ? tour : `https://learningspaces.osu.edu${tour}`) : null,
  };
}

// The Registrar decides bolted, Learning Spaces decides wheels, and only the two
// together separate a chair you can drag from a chair you can roll.
// Only two Learning Spaces values speak to wheels. "Moveable Tablet Arms" means
// casters and "Fixed Tablet Arms" means none, both verified against the OTDI
// photographs. The other three say nothing either way: "Movable Tables and
// Chairs" and "Group Seating" describe the furniture, not how it moves, and
// "Fixed Table and Chairs" duplicates what the Registrar already said.
//
// Treating any non-caster value as proof of no wheels was claiming two-source
// support on 68 rooms that only one source had an opinion about.
const NO_CASTER_FURNITURE = 'Fixed Tablet Arms';
const speaksToWheels = (f) => f === CASTER_FURNITURE || f === NO_CASTER_FURNITURE;

function deriveMobility(codes, furnitureType) {
  if (codes) {
    if (codes.some((c) => STATIONARY_CODES.has(c))) return { mobility: 'bolted', basis: 'registrar' };
    if (codes.some((c) => c === 30 || c === 32)) {
      if (!speaksToWheels(furnitureType)) return { mobility: 'freestanding', basis: 'registrar' };
      return {
        mobility: furnitureType === CASTER_FURNITURE ? 'casters' : 'freestanding',
        basis: 'registrar+learningSpaces',
      };
    }
  }
  // Learning Spaces alone can assert casters and nothing else: its "Fixed" means
  // no wheels, which is true of both a bolted chair and one you can drag.
  if (furnitureType === CASTER_FURNITURE) return { mobility: 'casters', basis: 'learningSpaces' };
  return { mobility: null, basis: null };
}

export function derive(reg, ls) {
  const codes = reg ? reg.codes : null;
  const has = (c) => (codes ? codes.includes(c) : null);
  const regFamily = !codes
    ? null
    : codes.some((c) => TABLET_CODES.has(c))
      ? 'tablet-arm'
      : codes.some((c) => TABLE_CODES.has(c))
        ? 'table-chair'
        : null;
  const lsFamily = ls?.furnitureType ? (LS_FAMILY[ls.furnitureType] ?? null) : null;
  const { mobility, basis } = deriveMobility(codes, ls?.furnitureType ?? null);

  let windows = null;
  if (codes) {
    const yes = codes.includes(39);
    const no = codes.includes(40);
    if (yes !== no) windows = yes;
  }

  let boards = null;
  if (codes) boards = { chalk: codes.includes(43), white: codes.includes(44) };
  else if (ls?.boardType?.length) {
    boards = { chalk: ls.boardType.includes('Chalk'), white: ls.boardType.includes('Dry Erase') };
  }

  return {
    seatingFamily: regFamily ?? lsFamily,
    seatingFamilyBy: { registrar: regFamily, learningSpaces: lsFamily },
    seatingFamilyAgrees: regFamily && lsFamily ? regFamily === lsFamily : null,
    mobility,
    mobilityBasis: basis,
    // True when the two sources describe furniture that cannot both be right,
    // so the mobility above rests on a contradiction rather than a consensus.
    // Registrar "Stationary Tables/Chairs" against Learning Spaces "Movable
    // Tables and Chairs" is the clearest case, and the four table-on-casters
    // rooms are all of this kind.
    mobilityContested:
      regFamily && lsFamily
        ? regFamily !== lsFamily ||
          (codes.some((c) => STATIONARY_CODES.has(c)) && ls?.furnitureType?.startsWith('Movable'))
        : false,
    boards,
    windows,
    blackoutShade: has(41),
    variableLighting: has(42),
    tieredFloor: has(37),
    computerLab: has(53),
    innovativeSpace: has(54),
    airConditioned: ls ? ls.airConditioning : null,
    carpeted: ls ? ls.carpeted : null,
    heightAdjustableLectern: ls ? ls.heightAdjustableLectern : null,
    darkeningQuality: ls ? ls.darkeningQuality : null,
    bestAffordance: ls ? ls.bestAffordance : null,
  };
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const refresh = process.argv.includes('--refresh');
  const term = arg('--term', '1268');
  const roomsPath = arg('--rooms', DEFAULT_ROOMS);
  const name = termName(term);
  if (!name) die(`cannot name term ${term}, so there is no Registrar page to look for.`);
  if (!existsSync(roomsPath)) die(`no room index at ${roomsPath}. Pass --rooms <path>.`);

  const index = JSON.parse(await readFile(roomsPath, 'utf8'));
  const vacant = index.rooms;
  const vacantKeys = Object.keys(vacant);
  console.log(`vacant index: ${vacantKeys.length} rooms, term ${index.term}`);

  // (building number, room) -> facility id, both sides normalised the same way.
  const byBuildingRoom = new Map();
  for (const key of vacantKeys) {
    byBuildingRoom.set(`${normBuilding(vacant[key].b)}|${normRoom(vacant[key].n)}`, key);
  }

  await mkdir(CACHE_DIR, { recursive: true });

  // ---- Source A: the Registrar's general assignment list, two requests.
  const regIndex = await fetchCached(REGISTRAR_INDEX, 'registrar', 'ga-index', {
    validate: (h) => (/general-assignment-rooms/i.test(h) ? null : 'no GA room links'),
    refresh,
    dryRun,
  });
  const { slug, url, all } = findTermLink(regIndex.html, name);
  if (!url) die(`no general assignment page for ${name}. The index lists: ${all.join(', ') || '(nothing)'}`);
  const regPage = await fetchCached(url, 'registrar', slug, {
    validate: (h) => (/Facility ID:/.test(h) ? null : 'no Facility ID rows'),
    refresh,
    dryRun,
  });
  const registrar = parseRegistrar(regPage.html);
  console.log(
    `registrar ${slug} (${regPage.from}): ${registrar.rooms.size} rooms in ${registrar.buildings.length} buildings`,
  );
  if (registrar.rooms.size < MIN_REGISTRAR_ROOMS) {
    die(
      `parsed ${registrar.rooms.size} Registrar rooms, under the ${MIN_REGISTRAR_ROOMS} floor. The markup moved.`,
    );
  }
  for (const [code, label] of registrar.unknownCodes) {
    console.warn(`  warn  unrecognised room characteristic ${code} "${label}", kept as published`);
  }
  for (const d of registrar.numberDisagreements) {
    console.warn(`  warn  ${d.building}: panel says ${d.panelText}, map link says ${d.mapLink}, using ${d.used}`);
  }

  // Building name -> number, for cards whose photo is missing.
  const buildingNumberByName = new Map();
  for (const b of registrar.buildings) {
    if (b.name && b.number) buildingNumberByName.set(normName(b.name), normBuilding(b.number));
  }

  // ---- Source B: the Learning Spaces directory. One index, then one page each.
  const lsIndex = await fetchCached(LS_INDEX, 'learningspaces', 'index', {
    validate: (h) => (/learningspaces\.osu\.edu\/classroom\//.test(h) ? null : 'no classroom links'),
    refresh,
    dryRun,
  });
  const cards = parseLearningSpacesIndex(lsIndex.html);
  console.log(`learning spaces index (${lsIndex.from}): ${cards.length} classroom cards`);
  if (cards.length < MIN_LS_PAGES) {
    die(`parsed ${cards.length} Learning Spaces cards, under the ${MIN_LS_PAGES} floor. The markup moved.`);
  }

  // Photo stem "<building>-<floor>-<room>-front.jpg" is the join, and the
  // building number a group's photographed rooms agree on covers the rest.
  const groupBuilding = new Map();
  for (const card of cards) {
    const stem = card.photo?.split('/').pop().replace(/-(front|back|rear)\.jpg$/i, '').split('-');
    if (!stem || stem.length < 3) continue;
    card.photoBuilding = normBuilding(stem[0]);
    card.photoRoom = normRoom(stem[2]);
    const tally = groupBuilding.get(card.building) ?? new Map();
    tally.set(card.photoBuilding, (tally.get(card.photoBuilding) ?? 0) + 1);
    groupBuilding.set(card.building, tally);
  }
  const buildingForGroup = new Map(
    [...groupBuilding].map(([g, tally]) => [g, [...tally].sort((a, b) => b[1] - a[1])[0][0]]),
  );

  const unmatchedCards = [];
  for (const card of cards) {
    if (card.photoBuilding) {
      card.key = byBuildingRoom.get(`${card.photoBuilding}|${card.photoRoom}`) ?? null;
      card.matchedBy = card.key ? 'photo' : null;
    }
    if (!card.key) {
      // "Campbell Hall 193" -> building 018, from its photographed siblings or
      // from the Registrar's panel for that building name.
      const room = normRoom(card.title.split(/\s+/).pop());
      const building = buildingForGroup.get(card.building) ?? buildingNumberByName.get(normName(card.building));
      if (building && room) {
        card.key = byBuildingRoom.get(`${building}|${room}`) ?? null;
        card.matchedBy = card.key ? 'title' : null;
      }
    }
    if (!card.key) unmatchedCards.push({ title: card.title, url: card.url, photo: card.photo });
  }

  const matched = cards.filter((c) => c.key);
  const byPhoto = matched.filter((c) => c.matchedBy === 'photo').length;
  const byTitle = matched.filter((c) => c.matchedBy === 'title').length;
  console.log(
    `learning spaces join: ${matched.length} of ${cards.length} cards -> ` +
      `${new Set(matched.map((c) => c.key)).size} rooms (${byPhoto} by photo, ${byTitle} by title)`,
  );
  if (matched.length < MIN_JOINED) {
    die(`only ${matched.length} Learning Spaces cards joined to the room index, under the ${MIN_JOINED} floor.`);
  }

  let live = 0;
  const readPage = async (card) => {
    const got = await fetchCached(card.url, 'learningspaces', card.slug, {
      validate: (h) => (/node--type--classroom/.test(h) ? null : 'not a classroom node'),
      refresh,
      dryRun,
    });
    if (got.from === 'live') live++;
    return parseLearningSpacesPage(got.html, { url: card.url, slug: card.slug });
  };

  // The shared mapLimit paces every item it walks. A cache hit issues no
  // request, so pacing one is politeness aimed at nobody and costs a warm
  // re-run eighty seconds. Hits are read straight through, misses walk.
  const cold = cards
    .map((_, i) => i)
    .filter((i) => refresh || !existsSync(cachePath('learningspaces', cards[i].slug)));
  console.log(
    `${cards.length} classroom pages, ${cold.length} to fetch ` +
      `${config.CONCURRENCY} at a time, ${config.DELAY_MS} ms apart...`,
  );
  const isCold = new Set(cold);
  const pages = new Array(cards.length);
  for (const [i, card] of cards.entries()) if (!isCold.has(i)) pages[i] = await readPage(card);
  const fetched = await mapLimit(cold, (i) => readPage(cards[i]));
  cold.forEach((i, n) => {
    pages[i] = fetched[n];
  });
  console.log(`  ${live} fetched live, ${cards.length - live} from cache`);

  // ---- Merge.
  const out = {};
  const duplicates = [];
  const capacityDisagreements = [];
  const familyDisagreements = [];

  for (const [id, reg] of registrar.rooms) {
    if (!vacant[id]) continue;
    out[id] = { sources: ['registrar'], registrar: reg };
  }
  const registrarUnmatched = [...registrar.rooms.keys()].filter((id) => !vacant[id]);

  cards.forEach((card, i) => {
    if (!card.key) return;
    const page = pages[i];
    page.matchedBy = card.matchedBy;
    page.indexPhoto = card.photo;
    if (out[card.key]?.learningSpaces) {
      duplicates.push({ key: card.key, kept: out[card.key].learningSpaces.slug, dropped: page.slug });
      return;
    }
    out[card.key] = out[card.key] ?? { sources: [] };
    out[card.key].sources.push('learningSpaces');
    out[card.key].learningSpaces = page;
  });

  for (const [key, room] of Object.entries(out)) {
    const reg = room.registrar ?? null;
    const ls = room.learningSpaces ?? null;
    if (ls && !ls.photos.front && ls.indexPhoto) ls.photos.front = ls.indexPhoto;
    room.derived = derive(reg, ls);

    const capacity = {
      index: vacant[key].cap || null,
      registrar: reg?.capacity ?? null,
      learningSpaces: ls?.seats ?? null,
    };
    const seen = [...new Set(Object.values(capacity).filter((v) => v != null))];
    capacity.agree = seen.length <= 1;
    if (!capacity.agree) capacityDisagreements.push({ key, ...capacity });
    room.capacity = capacity;

    if (room.derived.seatingFamilyAgrees === false) {
      const by = room.derived.seatingFamilyBy;
      familyDisagreements.push({
        key,
        // Group Seating is its own published value, so a room the Registrar calls
        // tables and Learning Spaces calls group is a softer disagreement than
        // one where the two swap tablet arms for tables.
        kind: by.learningSpaces === 'group' || by.registrar === 'group' ? 'group-vs-seat' : 'tablet-vs-table',
        registrar: by.registrar,
        registrarCodes: reg.codes.filter((c) => TABLET_CODES.has(c) || TABLE_CODES.has(c)),
        learningSpaces: ls.furnitureType,
      });
    }
  }

  // ---- Coverage. "No data" and "no whiteboard" have to read differently.
  const covered = Object.keys(out);
  const uncovered = vacantKeys.filter((k) => !out[k]);
  const uncoveredByType = {};
  let uncoveredDepartmental = 0;
  for (const k of uncovered) {
    const t = vacant[k].type ?? 'unknown';
    uncoveredByType[t] = (uncoveredByType[t] ?? 0) + 1;
    if (vacant[k].ga === false) uncoveredDepartmental++;
  }

  const mobility = {};
  for (const room of Object.values(out)) {
    const m = room.derived.mobility ?? 'unknown';
    const f = room.derived.seatingFamily ?? 'unknown';
    mobility[m] = mobility[m] ?? {};
    mobility[m][f] = (mobility[m][f] ?? 0) + 1;
  }

  const withRegistrar = Object.values(out).filter((r) => r.registrar).length;
  const withLs = Object.values(out).filter((r) => r.learningSpaces).length;
  const withBoth = Object.values(out).filter((r) => r.registrar && r.learningSpaces).length;

  const payload = {
    _meta: {
      generated: localDate(),
      term,
      termName: name,
      // A warm run serves all 322 pages from disk and makes zero requests, so a
      // bare count here reads as "nothing was fetched" rather than "nothing
      // needed fetching". Both numbers, and which cache the bytes came from.
      requests: requests(),
      pagesFromCache: cacheHits,
      fetchMode: requests() === 0 ? 'fully cached' : cacheHits ? 'partial cache' : 'cold',
      sources: {
        registrar: {
          name: 'OSU Registrar, general assignment rooms',
          index: REGISTRAR_INDEX,
          page: url,
          rooms: registrar.rooms.size,
          matchedToIndex: withRegistrar,
          unmatched: registrarUnmatched,
          buildingNumberDisagreements: registrar.numberDisagreements,
          unknownCharacteristicCodes: [...registrar.unknownCodes].map(([code, label]) => ({ code, label })),
        },
        learningSpaces: {
          name: 'OTDI Classroom Services, Learning Spaces Directory',
          index: LS_INDEX,
          pages: cards.length,
          matchedToIndex: withLs,
          matchedByPhoto: byPhoto,
          matchedByTitle: byTitle,
          unmatched: unmatchedCards,
          duplicatePages: duplicates,
        },
      },
      attribution:
        'Room characteristics and capacity: The Ohio State University Registrar, general assignment room list. ' +
        'Seats, furniture, AV, photos and 360 tours: OTDI Classroom Services, Learning Spaces Directory. ' +
        'Photos remain the property of the university and are linked, not copied.',
      coverage: {
        vacantRooms: vacantKeys.length,
        registrar: withRegistrar,
        learningSpaces: withLs,
        both: withBoth,
        union: covered.length,
        noFeatureData: uncovered.length,
        noFeatureDataByType: uncoveredByType,
        noFeatureDataDepartmental: uncoveredDepartmental,
        noFeatureDataRooms: uncovered,
      },
      mobilityScale: {
        note:
          'Registrar "moveable" means not bolted to the floor; Learning Spaces "Moveable Tablet Arms" means on ' +
          'casters and its "Fixed" means no casters, not bolted. bolted/freestanding/casters is the three-level ' +
          'scale the pair supports and neither source publishes. mobilityBasis names the sources that decided.',
        counts: mobility,
      },
      seatingFamilyDisagreements: familyDisagreements,
      capacityDisagreements,
    },
    rooms: out,
  };

  // ---- stdout summary.
  const cov = payload._meta.coverage;
  const comparable = Object.values(out).filter((r) => r.derived.seatingFamilyAgrees !== null).length;
  console.log('');
  console.log(`room features, ${name} (term ${term})`);
  console.log(`  registrar        ${String(cov.registrar).padStart(3)} of ${cov.vacantRooms} vacant rooms`);
  console.log(`  learning spaces  ${String(cov.learningSpaces).padStart(3)}`);
  console.log(`  both             ${String(cov.both).padStart(3)}`);
  console.log(`  union            ${String(cov.union).padStart(3)}`);
  console.log(
    `  no feature data  ${String(cov.noFeatureData).padStart(3)}  (${cov.noFeatureDataDepartmental} departmental; ` +
      `${Object.entries(cov.noFeatureDataByType)
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${n} ${t}`)
        .join(', ')})`,
  );
  console.log('  mobility');
  for (const [m, fams] of Object.entries(mobility).sort()) {
    const fam = Object.entries(fams)
      .sort()
      .map(([f, n]) => `${n} ${f}`)
      .join(', ');
    console.log(`    ${m.padEnd(13)} ${fam}`);
  }
  const hardDisagreements = familyDisagreements.filter((d) => d.kind === 'tablet-vs-table').length;
  console.log(
    `  seating family disagreements ${familyDisagreements.length} of ${comparable} comparable ` +
      `(${hardDisagreements} tablet vs table, ${familyDisagreements.length - hardDisagreements} group vs seat)`,
  );
  console.log(`  capacity disagreements       ${capacityDisagreements.length}`);
  for (const d of capacityDisagreements) {
    console.log(`    ${d.key}: index ${d.index}, registrar ${d.registrar}, learning spaces ${d.learningSpaces}`);
  }
  console.log(`  requests ${requests()}`);

  if (dryRun) {
    console.log('\nDRY RUN, nothing written.');
    return;
  }
  await writeAtomic(OUT_PATH, `${JSON.stringify(payload, null, 1)}\n`);
  console.log(`\nwrote ${OUT_PATH}`);
}

// Importing this file for its parsers must not make 323 requests.
const invokedDirectly = process.argv[1]?.endsWith('fetch-room-features.mjs');
if (invokedDirectly) main().catch((err) => die(err.stack ?? err.message));
