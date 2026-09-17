// Vacant's service worker. It exists for one student: the one standing outside a
// locked building on one bar of LTE who needs an answer now.
//
// Two caches, because the shell and the schedule change on different clocks. The
// shell is code and it changes when Enes deploys. The schedule is 39.1 KB
// gzipped, it changes weekly, and it changes its own filename at term rollover.
// One cache would either re-download the room index on every deploy or pin an
// installed icon to last month's app.js forever.
//
// Measured on 2026-09-16 over the committed blobs, which is the copy Pages serves:
// `git show HEAD:<file> | gzip -9 -c | wc -c`. Shell 170,601 bytes, data 115,028.
//
// The shell read 167,460 before a run of small fixes across js/ and index.html.
// It is 3,141 bytes, nearly all of it comment recording what each one was; no
// file was added to the list below and nothing new is fetched. The figure is
// restated here because it is the kind that goes stale silently: sw.test.mjs
// holds it to within a percent of the files, and the run that pushed it there
// is the one that has to move it.
// Run it exactly as written, through the pipe. `gzip -9 -c <file>` with the
// name as an argument stores each basename in the gzip FNAME header and reads
// 176 bytes higher across these seventeen files, which is most of a percent of
// the tolerance spent on nothing. An earlier draft of this line quoted that form
// and then explained the gap as two gzip versions disagreeing; there was no
// disagreement to explain. Through the pipe, GNU gzip 1.12 and node's zlib --
// the tool sw.test.mjs actually measures with -- agree to 0.0033%, and the one
// percent window is there for the day they do not.
//
// The shell read 84,201 before the ranking started reading the Registrar's
// general-assignment flag, which cost 2,582 gzipped bytes: 1,767 on
// js/engine.js and 815 on js/app.js, nearly all of it the comment recording
// what was measured. The data side more than doubled when the index
// started carrying which class is in the room: 2,024 course labels and one
// integer per block, so the room screen can draw a day instead of listing it.
// Running the same command over a Windows working tree gives a different
// answer, because git checks the text files out with CRLF. The first
// commit of this file guessed 32 and 30 KB without running anything, both were
// wrong; the correction then went stale by 758 bytes, and integrating the
// screens lane put it 34.3% out in one merge. scripts/test/sw.test.mjs
// recomputes both now.
//
// It read 146,240 before the ranking came back under the way and the corner got
// a menu instead of an arrow, which cost 4,045 with the review of it: 1,224 on
// index.html for the panel, its backdrop and the glyph, 2,340 on js/app.js for
// opening and closing it and for the six defects that review found, and 481 on
// js/sheet.js for a screen that rests where the list does and for a camera band
// that stopped collapsing on the card.
//
// It read 143,433 before taking a room became a screen of its own, which cost
// 2,807: 2,160 on js/app.js for the way -- the map with the walk drawn on it and
// one plate, which is where the tick goes now instead of the room's calendar --
// 524 on index.html for that screen and for the frosted plate over the
// photograph, and 123 on js/sheet.js for a screen that has no sheet at all.
//
// It read 130,647 before the map learned to stay off screen until a row is
// tapped, which cost 3,047 gzipped bytes over four files. 1,510 of them are on
// js/sheet.js, which was 1.5 KB: that file stopped assuming every screen rests
// at PEEK and every ceiling is FULL, and gained the pixels a back button and an
// install rail need on top of the fractions it already held.
//
// It read 138,629 before the card started showing the ROOM, and 3,634 of what
// is here now is that: the picture, the plate over it, the sheet losing its
// frame on that one screen, and drawWarp(), which is the thing that makes a 3:2
// photograph fill a 1:2.2 phone. The photographs themselves are 11.7 MB and
// none of it is here -- they are 306 files under data/photos/, fetched one at a
// time by the card that shows them and never precached.
//
// It read 133,694 before the answer became one card you swipe rather than a
// list you scan, which cost another 4,935: 3,082 on js/app.js for the deck, the
// two verdicts and the gesture, and 1,853 on index.html for the card itself.
//
// The shell read 155,377 and the data 93,566 before the walk followed pavement.
// That is the single largest thing this app has ever added to what a phone
// downloads, and it is worth naming the two halves separately.
//
// The shell grew 7,028: 4,000 of it is js/route.js, which decodes the graph and
// searches it, and the rest is the comment in js/engine.js recording what #115
// measured and why DETOUR no longer lives inside walkMinutes.
//
// The data grew 21,594, all of it data/walk-graph.json, and that is a 23.1%
// increase in what the app fetches to answer a question. It buys the difference
// between a walk that crosses the Olentangy where there is no bridge and one
// that goes round: measured over 4,574 rows from 169 standing points, the old
// constant understated 19.0% of walks by a minute or more and 4.7% by two or
// more. It is warmed rather than precached with the shell, so a deploy that
// does not touch the sidewalks does not re-fetch it, and OSU repaves on a far
// slower clock than Enes deploys.
//
// It read 98,246 while four modules js/app.js imports were missing from the
// list below. They are 23,296 gzipped bytes, so the figure was measuring a list
// 19.2% smaller than the shell it named. Recomputing it from the list is what
// kept that honest-looking: the arithmetic was right and the set was wrong,
// which is the failure a self-checking number cannot catch on its own.

// Stamped by scripts/stamp-sw.mjs before the commit lands. The authored
// placeholder is __BUILD_ID__, and a committed sw.js still carrying it means the
// stamp did not run. scripts/test/sw.test.mjs fails on exactly that. Spelled out
// rather than built from CACHE_PREFIX, because the stamper rewrites this line.
const SHELL_CACHE = 'vacant-shell-25db7a3';
const DATA_CACHE = 'vacant-data-v1';

// CacheStorage is per origin, not per path, and enesyilmazcode.github.io also
// hosts Finder and the portfolio. Without this test the activate below deleted
// every cache on the origin that was not one of Vacant's two: measured, one
// deploy took finder-shell-v3 and portfolio-v1 with it and
// caches.match('/Finder/index.html') came back empty. The localStorage keys were
// namespaced for the same reason; the cache names were not.
const CACHE_PREFIX = 'vacant-';
function ours(name) {
  return name.startsWith(CACHE_PREFIX);
}

// A worker's scope cannot climb above its own URL, and GitHub Pages will not
// send Service-Worker-Allowed, so this file has to sit at the repo root and the
// scope is fixed at the project subpath. Capital V: Pages is case sensitive.
const SCOPE = '/Vacant/';
const DATA_PREFIX = SCOPE + 'data/';
const CURRENT = DATA_PREFIX + 'current.json';
const SHELL_DOC = SCOPE + 'index.html';

// The 306 room photographs. NOT precached and never warmed: they are 11.7 MB
// together, and a student who asks one question wants one of them. Each arrives
// with the card that shows it and is kept from then on.
const PHOTO = /\/data\/photos\/[^/]+\.webp$/;

// `/Vacant/` and `/Vacant/index.html` are the same bytes at two cache keys and a
// navigation can arrive as either, so both are precached.
//
// The js entries are the two modules index.html loads and everything they
// import, followed transitively. Four of them -- claim, day, sheet and state --
// were imported and never listed here, js/state.js among them, so install
// resolved having cached a js/app.js whose first statements ask for modules
// that are not in the cache. It never showed up as a bug because cacheFirst
// writes every ok response into this cache, so one completed online load
// repaired it; the window is between the worker installing and that load
// finishing, which is the phone that installs the icon and walks inside.
// scripts/test/sw.test.mjs derives this list from the imports now rather than
// restating it, because the restatement is what drifted.
//
// They are in addAll rather than a second best-effort pass, and that is the
// argued half: the four are 26,197 of the 150,656 gzipped bytes here, so
// install does 21.1% more work before it resolves, and a strict tier that fails
// fails the whole install. It is still right. A best-effort tier is for things
// the app is better with; js/app.js cannot evaluate without js/state.js. And a
// rejected install is retried where a resolved lie is not.
//
// What the half-cached shell actually does, driven in Chromium against a real
// registered worker with the server stopped: index.html is static, so it PAINTS
// -- the wordmark, all four duration buttons, "finding campus..." -- and then
// js/app.js fails to evaluate on the missing imports. The buttons are dead,
// because the handler that gives them meaning is in the module that did not
// load. So is bootFailed(), the app's own "could not load the schedule, try
// again" card. The student gets an app-shaped screen with no exit and nothing
// to press, which is worse than a blank one: a blank screen is at least legibly
// broken.
//
// The shell grew 5,055 for the words of a walk. 3,037 is js/directions.js, and
// the remaining 2,018 is the button, the list it fills and the one paragraph in
// index.html that holds the key, empty.
//
// Nothing was added to the DATA for it, which is the point: the steps are
// fetched from Google on a tap, for the one building a reader has already
// chosen, and are never cached. The walk the app quotes is still measured over
// the graph that is cached, so a phone with no signal loses the words and keeps
// every number.
//
// js/directions.js is precached even though it cannot work offline. It has to
// be: js/app.js imports it at the top, and install resolving without it would
// leave an app that fails to evaluate on a missing import -- the exact failure
// the paragraph above this one records.
//
// js/dev.js is deliberately absent. js/app.js reaches it through import() only
// when ?dev=1 asks for it, so a student who never asks never downloads it.
const SHELL_ASSETS = [
  SCOPE,
  SHELL_DOC,
  SCOPE + 'js/app.js',
  SCOPE + 'js/campus.js',
  SCOPE + 'js/claim.js',
  SCOPE + 'js/day.js',
  SCOPE + 'js/directions.js',
  SCOPE + 'js/engine.js',
  SCOPE + 'scripts/lib/club-occupancy.mjs',
  SCOPE + 'js/map.js',
  SCOPE + 'js/preferences.js',
  SCOPE + 'js/route.js',
  SCOPE + 'js/pwa.js',
  SCOPE + 'js/install.js',
  SCOPE + 'js/firstrun.js',
  SCOPE + 'js/sheet.js',
  SCOPE + 'js/state.js',
  SCOPE + 'manifest.webmanifest',
  SCOPE + 'apple-touch-icon.png',
  SCOPE + 'favicon.ico',
  SCOPE + 'icons/icon-192.png',
];

// Everything the first answer needs that is not code. These live in the data
// cache rather than the shell because campus.json alone is 37.9 KB gzipped and
// re-downloading it on every deploy is the waste this split exists to avoid.
//
// data/walk-graph.json is here and not in the shell for the same reason: it is
// OSU's sidewalk network, it changes when OSU repaves something rather than
// when Enes deploys, and at 21 KB gzipped it is not worth re-fetching on a
// deploy that did not touch it. js/app.js AWAITS it at boot, so the first
// ranking is never the one that gets the straight-line fallback and the second
// one the routed answer.
const WARM_ALWAYS = ['data/campus.json', 'data/buildings-hours.json', 'data/walk-graph.json'];

self.addEventListener('install', (event) => {
  // No skipWaiting here, deliberately. A worker that takes over a live page can
  // hand a new data shape to page JS that was loaded to read the old one.
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      await shell.addAll(SHELL_ASSETS);
      // Best effort. The page has already fetched all of this, so it is a
      // conditional hit, and a first visit that loses the network before the
      // second one still has an answer.
      await warmTerm().catch(() => {});
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable().catch(() => {});
      }
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => ours(n) && n !== SHELL_CACHE && n !== DATA_CACHE).map((n) => caches.delete(n)),
      );
      await evictOldTerms();
      // Without this the first visit's own fetches never reach the worker, so
      // the term data lands in no cache until the second visit, and an install
      // followed by a dead network answers nothing.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigate(event));
    return;
  }
  if (url.pathname.startsWith(DATA_PREFIX)) {
    // A room photograph never changes under its own name. Both other strategies
    // revalidate in the background, and for a 39 KB image nobody edited that is
    // 39 KB of somebody's data allowance for every card they look at -- on the
    // one screen this app exists to answer on one bar of LTE. This branch
    // returns the cached copy and stops asking.
    if (PHOTO.test(url.pathname)) {
      event.respondWith(immutable(request));
      return;
    }
    // The term pointer and dated event overlay must never be stale. The event
    // filename is stable for a whole term even though its covered week changes,
    // so an old cached response can otherwise hide the current week's events.
    // Both still fall back to the data cache when the network is unavailable.
    const needsFreshData =
      url.pathname === CURRENT || /\/room-events-\d+\.json$/.test(url.pathname);
    event.respondWith(
      needsFreshData ? networkFirst(request) : staleWhileRevalidate(event, request),
    );
    return;
  }
  event.respondWith(cacheFirst(event, request));
});

// Pages has no SPA fallback, so a wrong path under /Vacant/ returns a real 404
// page. Offline, the browser returns its own. Both become the shell instead.
async function navigate(event) {
  const shell = await caches.open(SHELL_CACHE);
  try {
    const preload = await event.preloadResponse;
    const response = preload || (await fetch(event.request));
    if (response && response.ok) {
      const path = new URL(event.request.url).pathname;
      if (path === SCOPE || path === SHELL_DOC) await shell.put(SHELL_DOC, response.clone());
      return response;
    }
  } catch {
    // No network. Fall through to the cached shell.
  }
  return (await shell.match(SHELL_DOC)) || (await shell.match(SCOPE)) || Response.error();
}

async function cacheFirst(event, request) {
  const shell = await caches.open(SHELL_CACHE);
  const cached = await shell.match(request);
  const update = fetch(request)
    .then(async (response) => {
      if (response && response.ok) await shell.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(update);
    return cached;
  }
  return (await update) || Response.error();
}

async function networkFirst(request) {
  const data = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request, {
      cache: request.cache === 'no-store' ? 'no-store' : 'no-cache',
    });
    if (response && response.ok) {
      await data.put(request, response.clone());
      return response;
    }
  } catch {
    // No network. Fall through to the cached pointer.
  }
  // Except for a no-store request, which is the page asking whether the network
  // is there at all. js/firstrun.js sends exactly one of those, and answering it
  // from the cache turns the question into "is there a cache": measured with the
  // server killed, the probe came back 200 from here and the offline card never
  // rendered.
  if (request.cache === 'no-store') return Response.error();
  return (await data.match(request)) || Response.error();
}

// Written once, kept. A new photograph is a deploy rather than an edit, so the
// only thing that can strand an old one is a room being rephotographed under the
// same id, which would need DATA_CACHE bumping to reach a phone that has it.
// That is the trade: one stale picture in a case that has not happened yet,
// against a re-download on every single card.
async function immutable(request) {
  const data = await caches.open(DATA_CACHE);
  const cached = await data.match(request);
  if (cached) return cached;
  let response;
  try {
    response = await fetch(request);
  } catch {
    return Response.error();
  }
  // The write is outside the try on purpose. 306 photographs at 39 KB is 11.7 MB
  // of a quota nothing here caps, and a QuotaExceededError inside the try threw
  // away a response that had already arrived: the card fell back to the plain
  // one over a picture the phone was holding.
  if (response && response.ok) await data.put(request, response.clone()).catch(() => {});
  return response;
}

async function staleWhileRevalidate(event, request) {
  const data = await caches.open(DATA_CACHE);
  const cached = await data.match(request);
  const update = fetch(request)
    .then(async (response) => {
      if (!response || !response.ok) return null;
      const moved = cached ? changed(cached, response) : false;
      await data.put(request, response.clone());
      if (moved) await announce(request.url);
      return response;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(update);
    return cached;
  }
  return (await update) || Response.error();
}

// Only ever used to claim the file MOVED. A false alarm shows the user a refresh
// bar for nothing, so a header missing on either side means "say nothing" rather
// than "assume it changed", and a same-length rewrite is a miss rather than a
// lie. Pages sends ETag and Last-Modified. The local dev server answers chunked
// with none of the three, measured, so against it this correctly stays quiet and
// the refresh bar had to be verified against a server that sends them.
function changed(before, after) {
  for (const header of ['ETag', 'Last-Modified', 'Content-Length']) {
    const a = before.headers.get(header);
    const b = after.headers.get(header);
    if (a && b) return a !== b;
  }
  return false;
}

async function announce(url) {
  const windows = await self.clients.matchAll({ type: 'window' });
  for (const client of windows) client.postMessage({ type: 'vacant:data-updated', url });
}

async function warmTerm() {
  const data = await caches.open(DATA_CACHE);
  const response = await fetch(CURRENT, { cache: 'no-cache' });
  if (!response.ok) return;
  await data.put(CURRENT, response.clone());
  const current = await response.json();
  const files = [current.rooms, current.events, current.buildings, ...WARM_ALWAYS].filter(Boolean);
  await Promise.all(
    files.map(async (file) => {
      const url = SCOPE + String(file).replace(/^\//, '');
      const hit = await fetch(url);
      if (hit.ok) await data.put(url, hit);
    }),
  );
}

// Rollover day leaves last term's files on the server, which is right: a shared
// link to a room in a term that just ended should still resolve. What must not
// survive is the copy on the phone, taking space and sitting one bad code path
// away from being ranked as if it were current.
async function evictOldTerms() {
  const data = await caches.open(DATA_CACHE);
  const pointer = await data.match(CURRENT);
  if (!pointer) return;
  let term;
  try {
    term = (await pointer.json()).term;
  } catch {
    return;
  }
  if (!term) return;
  // Digits, not \w. A term is a four digit code, and `buildings-hours.json` is
  // not term keyed: \w matched it, captured "hours", compared that to "1268" and
  // evicted the Registrar's building hours on the first activate. Measured, the
  // app then booted from cache with no hours file and never reached ready.
  for (const request of await data.keys()) {
    const match = new URL(request.url).pathname.match(/\/data\/(?:rooms|room-events|buildings)-(\d+)\.json$/);
    if (match && match[1] !== String(term)) await data.delete(request);
  }
}
