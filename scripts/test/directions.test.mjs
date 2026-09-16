// Offline, against a fake Google. Nothing here reaches the network and nothing
// here needs a key.
//
// What this file is really guarding is the FALLBACK. js/directions.js exists to
// add steps the bundled graph cannot produce, and the graph stays the floor
// underneath it: every failure -- no key, no consent, offline, quota, timeout,
// a stale answer, a half-filled matrix -- has to come back as null, because
// null is what makes js/app.js keep the routed minutes it already had. A
// provider that threw, or that returned a partial matrix, would either break
// the screen or sort one list on two models, which is the failure #115 names.
//
// The consent tests are the other half. This app sent no position anywhere
// before this module, and the rule is that no coordinate leaves the device
// until the student says so. That is checked by asserting the fake service was
// never constructed, not merely that the answer was null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MATRIX_MAX, createDirections, plainText } from '../../js/directions.js';

// A stand-in for google.maps, counting what it was asked.
const fakeMaps = ({ leg, elements, fail, hang } = {}) => {
  const calls = { route: 0, matrix: 0, origins: [] };
  const g = {
    TravelMode: { WALKING: 'WALKING' },
    DirectionsService: class {
      route(req) {
        calls.route += 1;
        calls.origins.push(req.origin);
        if (fail) return Promise.reject(new Error('quota'));
        if (hang) return new Promise(() => {});
        return Promise.resolve({ routes: [{ legs: [leg] }] });
      }
    },
    DistanceMatrixService: class {
      getDistanceMatrix(req) {
        calls.matrix += 1;
        calls.origins.push(req.origins[0]);
        if (fail) return Promise.reject(new Error('quota'));
        if (hang) return new Promise(() => {});
        return Promise.resolve({ rows: [{ elements }] });
      }
    },
  };
  return { maps: () => Promise.resolve(g), calls };
};

const ORIGIN = { lat: 39.9995, lon: -83.013 };
const BUILDING = { lat: 39.99945284, lon: -83.00874701 };
const LEG = {
  duration: { value: 240 },
  distance: { value: 318 },
  steps: [
    { instructions: 'Head <b>north</b> on <b>College Rd</b>', distance: { value: 120 }, duration: { value: 90 } },
    { instructions: 'Turn right onto <b>W 18th Ave</b>', distance: { value: 198 }, duration: { value: 150 } },
  ],
};

const yes = () => true;
const no = () => false;

// --- the HTML Google actually sends

test('instructions come back as text, not markup', () => {
  assert.equal(plainText('Head <b>north</b> on <b>College Rd</b>'), 'Head north on College Rd');
  assert.equal(plainText('Walk<div>Pass the Oval</div>'), 'Walk • Pass the Oval');
  assert.equal(plainText('Neil &amp; 11th'), 'Neil & 11th');
  assert.equal(plainText('a  <b>b</b>   c'), 'a b c');
  assert.equal(plainText(undefined), '');
  // A tag that a template would have had to escape never reaches the template.
  assert.ok(!plainText('<script>x</script>y').includes('<'));
});

// --- no key is not a broken app

test('no key builds no provider at all', () => {
  assert.equal(createDirections({ key: '' }), null);
  assert.equal(createDirections({}), null);
});

// --- consent, checked by what was NOT sent

test('without consent no coordinate is sent and the answer is null', async () => {
  const { maps, calls } = fakeMaps({ leg: LEG });
  const d = createDirections({ key: 'k', consent: no, maps });
  assert.equal(await d.steps(ORIGIN, BUILDING), null);
  assert.equal(await d.matrix(ORIGIN, { 106: BUILDING }), null);
  assert.equal(calls.route, 0);
  assert.equal(calls.matrix, 0);
  assert.deepEqual(calls.origins, []);
});

test('consent withdrawn between calls stops the next one', async () => {
  const { maps, calls } = fakeMaps({ leg: LEG });
  let allowed = true;
  const d = createDirections({ key: 'k', consent: () => allowed, maps });
  assert.ok(await d.steps(ORIGIN, BUILDING));
  allowed = false;
  assert.equal(await d.steps(ORIGIN, BUILDING), null);
  assert.equal(calls.route, 1);
});

// --- steps

test('a leg becomes the steps the screen renders', async () => {
  const { maps } = fakeMaps({ leg: LEG });
  const d = createDirections({ key: 'k', consent: yes, maps });
  const r = await d.steps(ORIGIN, BUILDING);
  assert.equal(r.seconds, 240);
  assert.equal(r.metres, 318);
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[0].text, 'Head north on College Rd');
  assert.equal(r.steps[1].metres, 198);
});

test('a route with no legs is null and not an empty list', async () => {
  const { maps } = fakeMaps({ leg: { steps: [] } });
  const d = createDirections({ key: 'k', consent: yes, maps });
  assert.equal(await d.steps(ORIGIN, BUILDING), null);
});

test('a rejected request is null rather than a throw', async () => {
  const { maps } = fakeMaps({ fail: true });
  const d = createDirections({ key: 'k', consent: yes, maps });
  assert.equal(await d.steps(ORIGIN, BUILDING), null);
  assert.equal(await d.matrix(ORIGIN, { 106: BUILDING }), null);
});

// --- the stale answer, which is the one that would corrupt a screen

test('an answer against an old generation is dropped', async () => {
  const { maps } = fakeMaps({ leg: LEG });
  const d = createDirections({ key: 'k', consent: yes, maps });
  const pending = d.steps(ORIGIN, BUILDING);
  d.invalidate();
  assert.equal(await pending, null);
});

test('invalidate counts up so a caller can tell generations apart', () => {
  const { maps } = fakeMaps({ leg: LEG });
  const d = createDirections({ key: 'k', consent: yes, maps });
  assert.equal(d.generation, 0);
  assert.equal(d.invalidate(), 1);
  assert.equal(d.invalidate(), 2);
  assert.equal(d.generation, 2);
});

// --- the matrix, all or nothing

test('a full row becomes seconds per building code', async () => {
  const { maps } = fakeMaps({
    elements: [
      { status: 'OK', duration: { value: 200 } },
      { status: 'OK', duration: { value: 310 } },
    ],
  });
  const d = createDirections({ key: 'k', consent: yes, maps });
  const m = await d.matrix(ORIGIN, { 106: BUILDING, 110: BUILDING });
  assert.equal(m.get('106'), 200);
  assert.equal(m.get('110'), 310);
  assert.equal(m.size, 2);
});

test('one unreachable destination voids the whole matrix', async () => {
  // Half a matrix would rank part of one list on Google and part on the graph.
  const { maps } = fakeMaps({
    elements: [{ status: 'OK', duration: { value: 200 } }, { status: 'ZERO_RESULTS' }],
  });
  const d = createDirections({ key: 'k', consent: yes, maps });
  assert.equal(await d.matrix(ORIGIN, { 106: BUILDING, 110: BUILDING }), null);
});

test('more destinations than Google allows is null and is not sent', async () => {
  const { maps, calls } = fakeMaps({ elements: [] });
  const d = createDirections({ key: 'k', consent: yes, maps });
  const many = {};
  for (let i = 0; i <= MATRIX_MAX; i += 1) many[String(i)] = BUILDING;
  assert.equal(Object.keys(many).length, MATRIX_MAX + 1);
  assert.equal(await d.matrix(ORIGIN, many), null);
  assert.equal(calls.matrix, 0);
});

test('no buildings asks nothing', async () => {
  const { maps, calls } = fakeMaps({ elements: [] });
  const d = createDirections({ key: 'k', consent: yes, maps });
  assert.equal(await d.matrix(ORIGIN, {}), null);
  assert.equal(calls.matrix, 0);
});

// --- offline

test('offline answers null without asking', async () => {
  const { maps, calls } = fakeMaps({ leg: LEG });
  const real = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
  try {
    const d = createDirections({ key: 'k', consent: yes, maps });
    assert.equal(await d.steps(ORIGIN, BUILDING), null);
    assert.equal(calls.route, 0);
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: real, configurable: true });
  }
});

// --- the committed key

// The meta in index.html is the one place a key can reach a public bundle, and
// the comment above it, docs/google-setup.md and this test all say the same
// thing: it ships empty and the deploy fills it. A real key landed there once,
// in the commit that added the comment saying it must not.
test('index.html ships no Google key', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const meta = /<meta name="google-maps-key" content="([^"]*)">/.exec(html);
  assert.ok(meta, 'index.html has no google-maps-key meta at all');
  assert.equal(meta[1], '', 'a Google API key is committed in index.html');
});
