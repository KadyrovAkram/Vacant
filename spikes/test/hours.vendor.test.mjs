// hours.vendor.js is a hand copy, so it needs two guards: the app source it was
// copied from must still say what it said, and the copy must still answer the
// real table the same way a direct read does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pickHoursTerm, makeHoursFor } from '../hours.vendor.js';

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
const read = (p) => readFileSync(at(p), 'utf8');
const json = (p) => JSON.parse(read(p));

test('js/app.js still resolves hours the way hours.vendor.js copied', () => {
  const app = read('../../js/app.js');
  for (const needle of [
    "const want = (current?.termName ?? '').toLowerCase().replace(/\\s+/g, '-');",
    'const exact = want ? terms.find(([slug]) => slug.startsWith(want)) : null;',
    'const rec = state.hoursTerm?.buildings?.[code];',
    'return rec.hours[day];',
  ]) {
    assert.ok(
      app.includes(needle),
      `js/app.js no longer contains ${JSON.stringify(needle)}. spikes/hours.vendor.js was copied from it and may now disagree with the app about which doors are open.`,
    );
  }
});

test('the vendored hoursFor answers the shipped table exactly', () => {
  const hours = json('../../data/buildings-hours.json');
  const current = json('../../data/current.json');
  const term = pickHoursTerm(hours, current);
  assert.ok(term, `no published hours table for ${current.termName}`);

  const hoursFor = makeHoursFor(term);
  let pairs = 0;
  let closed = 0;
  for (const [code, rec] of Object.entries(term.buildings)) {
    for (let day = 0; day < 7; day++) {
      assert.deepEqual(hoursFor(code, day), rec.hours[day]);
      if (Array.isArray(rec.hours[day])) pairs++;
      else if (rec.hours[day] === null) closed++;
    }
  }
  assert.ok(pairs > 0 && closed > 0, 'the table should hold both open windows and published-closed days');

  // The distinction the whole app rests on: a building absent from the table is
  // undefined, never null and never an assumed window.
  assert.equal(hoursFor('__no_such_building__', 1), undefined);
});

test('a term with no table yields unknown hours rather than another term\'s doors', () => {
  const hours = json('../../data/buildings-hours.json');
  const term = pickHoursTerm(hours, { termName: 'Spring 2099' });
  assert.equal(term, null);
  assert.equal(makeHoursFor(term)('106', 1), undefined);
});
