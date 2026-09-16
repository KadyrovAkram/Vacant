// Turn-by-turn walking steps, which is the one thing the bundled graph cannot
// answer.
//
// data/walk-graph.json throws away the shape of the pavement between two
// junctions and keeps only its length, because #44 settled that the line on the
// map is a direction and not a route. That is why the app can say "4 minutes"
// offline and can never say "turn right at 18th". A provider that has the
// geometry and the street names has to be asked, and asking costs money, needs
// a key, and sends the student's position somewhere. All three are new to this
// app and all three are handled here rather than at the call site.
//
// The contract deliberately mirrors js/route.js: you build it once, you ask it
// about buildings, and it answers null rather than throwing. Null is the
// caller's signal to keep the routed number it already has, which is the whole
// point -- the graph is the floor this sits on, not the thing it replaces.
//
// docs/research/walking-routes-115.md is why the ranking half is opt-in and not
// the default: measured against OSU's own service, Google disagreed with it more
// than the bundled graph does, so a live matrix is not obviously more accurate.
// It is here because #115's successor asks for steps, and a matrix is nearly
// free once the script is loaded.

// Google's own ceiling on destinations per DistanceMatrix request.
export const MATRIX_MAX = 25;

// Long enough for a cold script fetch on campus wifi, short enough that a
// student does not watch a spinner instead of reading the walk they already
// have.
export const TIMEOUT_MS = 6000;

// Google returns instructions as HTML, with <b> around street names and
// <div> for sub-steps. The app renders text, so the tags come out here and not
// in a template where an escape could be forgotten.
export function plainText(html) {
  return String(html ?? '')
    .replace(/<div[^>]*>/gi, ' • ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    // LAST, and that order is the whole point. `&amp;` decoded first turns
    // `&amp;lt;` -- which is how a literal "&lt;" arrives -- into `&lt;`, and
    // the next line then turns that into a real `<`. A step name carrying
    // `&amp;lt;script&amp;gt;` came out of here as `<script>`, which is the
    // one thing the tag strip above exists to prevent.
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// The Maps JavaScript API, fetched once and only when something actually asks.
//
// Not the REST Routes endpoints, and that is a shipping constraint rather than a
// preference: this app is a static site on GitHub Pages with no backend, a REST
// key cannot be restricted by HTTP referrer, and a key in a public repo's
// bundle is a key anyone can bill. The JS API services run in the page and work
// with a referrer-locked key. docs/google-setup.md is the lock.
// Two steps and not one, which cost a live debugging session to learn. The
// script's own load event fires BEFORE the library is populated under
// `loading=async`, so reading google.maps.DirectionsService off the global there
// finds nothing and looks exactly like a broken key: the script 200s, routes.js
// 200s, and no directions request is ever made. The documented bootstrap is a
// callback for "the loader is ready" and then importLibrary for "this part of it
// is ready", and this waits for both.
const CALLBACK = '__vacantMapsReady';

function loadMaps(key, doc = document) {
  if (!key) return Promise.reject(new Error('no key'));

  loadMaps.pending ??= new Promise((resolve, reject) => {
    const routes = () => resolve(globalThis.google.maps.importLibrary('routes'));
    if (globalThis.google?.maps?.importLibrary) return routes();

    globalThis[CALLBACK] = () => {
      delete globalThis[CALLBACK];
      routes();
    };
    const el = doc.createElement('script');
    el.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&loading=async&callback=${CALLBACK}`;
    el.async = true;
    el.onerror = () => {
      // The failure is retried on the next tap, so this attempt has to leave
      // nothing behind. Without the cleanup the global callback stayed bound to
      // this promise's resolve and the dead <script> stayed in the head, one
      // more of each per retry, on the offline path where retrying is normal.
      delete globalThis[CALLBACK];
      el.remove();
      reject(new Error('maps script failed'));
    };
    doc.head.appendChild(el);
  }).catch((err) => {
    // A failed load is retried on the next tap rather than remembered forever:
    // the usual cause is no network, and the usual fix is walking indoors.
    loadMaps.pending = null;
    throw err;
  });

  return loadMaps.pending;
}

// The loser of the race has to be cleaned up. Without the clear, every call
// left a live timer holding its reject closure for the full TIMEOUT_MS after
// the answer had already arrived and the sheet had already been painted: six
// seconds of a page that cannot go idle per tap, and a node process that will
// not exit for six seconds after the last call.
const withTimeout = (promise, ms) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

// One provider, built once. `consent` is asked on every call and not once at
// construction, because the answer is the student's and they can withdraw it:
// until it returns true no coordinate leaves the device and every method
// answers null, which is indistinguishable to the caller from being offline.
export function createDirections({ key, consent = () => false, maps = loadMaps, doc = undefined } = {}) {
  if (!key) return null;

  let generation = 0;

  const ready = () => (consent() && globalThis.navigator?.onLine !== false ? maps(key, doc) : Promise.reject(new Error('unavailable')));

  return {
    // Bumped by the caller whenever the origin or the date moves. A response
    // that comes back against an old generation is dropped rather than
    // rendered, which is the rule docs/research/walking-routes-115.md sets: a
    // stale answer must never reorder or relabel a list already on screen.
    get generation() {
      return generation;
    },
    invalidate() {
      generation += 1;
      return generation;
    },

    // The steps for one walk. Returns null on every failure -- no key, no
    // consent, offline, quota, timeout, zero results -- so the caller renders
    // the routed minutes it already had and says steps are unavailable.
    async steps(origin, building) {
      const at = generation;
      try {
        const g = await withTimeout(ready(), TIMEOUT_MS);
        const service = new g.DirectionsService();
        const res = await withTimeout(
          service.route({
            origin: { lat: origin.lat, lng: origin.lon },
            destination: { lat: building.lat, lng: building.lon },
            travelMode: 'WALKING',
          }),
          TIMEOUT_MS,
        );
        if (at !== generation) return null;
        const leg = res?.routes?.[0]?.legs?.[0];
        if (!leg?.steps?.length) return null;
        return {
          seconds: leg.duration?.value ?? null,
          metres: leg.distance?.value ?? null,
          steps: leg.steps.map((s) => ({
            text: plainText(s.instructions ?? s.html_instructions),
            metres: s.distance?.value ?? null,
            seconds: s.duration?.value ?? null,
          })),
        };
      } catch {
        return null;
      }
    },

    // Walking seconds to many buildings in one request, for ranking. Returns a
    // Map of code to seconds, or null.
    //
    // Buildings and not rooms: 425 rooms share 50 buildings, and the ranking
    // only ever needs the building. Over MATRIX_MAX destinations it returns
    // null rather than paging, because a half-filled matrix would sort one list
    // on two models -- the failure mode #115 names.
    async matrix(origin, buildings) {
      const at = generation;
      const codes = Object.keys(buildings ?? {});
      if (!codes.length || codes.length > MATRIX_MAX) return null;
      try {
        const g = await withTimeout(ready(), TIMEOUT_MS);
        const service = new g.DistanceMatrixService();
        const res = await withTimeout(
          service.getDistanceMatrix({
            origins: [{ lat: origin.lat, lng: origin.lon }],
            destinations: codes.map((c) => ({ lat: buildings[c].lat, lng: buildings[c].lon })),
            travelMode: 'WALKING',
          }),
          TIMEOUT_MS,
        );
        if (at !== generation) return null;
        const row = res?.rows?.[0]?.elements;
        if (!row || row.length !== codes.length) return null;
        const out = new Map();
        row.forEach((el, i) => {
          if (el?.status === 'OK' && Number.isFinite(el.duration?.value)) out.set(codes[i], el.duration.value);
        });
        // All or nothing, for the same reason the graph's fallback is per origin
        // and never per building.
        return out.size === codes.length ? out : null;
      } catch {
        return null;
      }
    },
  };
}
