// Offline. Every assertion reads the committed cache, never the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { finalsLinks } from '../fetch-calendar.mjs';
import { parseFiveYearColumns } from '../lib/calendar.mjs';

const file = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the finals index gives up every dated page, and only those', () => {
  // The old loop asked for two hand-written term names. The Summer page was on
  // this index the whole term and was never cached, so the Summer build had no
  // third source for its exam window.
  const links = finalsLinks(file('../../data/cache/registrar/finals-index.html'));
  assert.deepEqual(links.dated, [
    'autumn-2026-finals-schedule',
    'spring-2027-finals-schedule',
    'summer-2026-finals-schedule',
  ]);
  // The session-1 pages are listed and are not fetched: their slugs carry no
  // year, so build-index.mjs, which looks a page up by the term it is
  // building, can never ask for one.
  assert.deepEqual(
    links.all.filter((s) => !links.dated.includes(s)),
    ['autumn-session-1-finals-schedule', 'spring-session-1-finals-schedule'],
  );
  assert.match(links.url('summer-2026-finals-schedule'), /^https:\/\/registrar\.osu\.edu\//);
});

test('an offsite link that mentions finals is not followed', () => {
  const html =
    '<a href="https://example.com/finals-schedule/">no</a>' +
    // A host the Registrar's own name is a PREFIX of. The old string test let
    // this one through and cached whatever it served.
    '<a href="https://registrar.osu.edu.example.com/spring-2030-finals-schedule/">no</a>' +
    '<a href="//example.com/summer-2030-finals-schedule/">no</a>' +
    '<a href="/x/autumn-2030-finals-schedule/">yes</a>';
  assert.deepEqual(finalsLinks(html).dated, ['autumn-2030-finals-schedule']);
  assert.equal(finalsLinks(html).url('autumn-2030-finals-schedule'), `${'https://registrar.osu.edu'}/x/autumn-2030-finals-schedule/`);
  assert.deepEqual(finalsLinks(null).all, []);
});

test('nothing in fetch-calendar.mjs names a term', () => {
  // This is the script whose own header says to run it when a term rolls over,
  // and it used to die on "the five-year view parsed to zero Autumn 2026 rows"
  // the moment that column left the page: a healthy page refused for a wrong
  // reason. A term name in a comment is a measurement. A term name in the code
  // is a bomb with a date on it.
  const code = file('../fetch-calendar.mjs').replace(/^\s*\/\/.*$/gm, '');
  assert.deepEqual(code.match(/(?:autumn|spring|summer)[- ]\d{4}/gi), null);
});

test('the term columns come off the page, all fifteen of them', () => {
  const columns = parseFiveYearColumns(
    file('../../data/cache/registrar/academic-calendar-5-year-view.html'),
  );
  assert.equal(columns.length, 15);
  assert.ok(columns.includes('AUTUMN 2026'));
  assert.ok(columns.includes('SUMMER 2028'));
  assert.deepEqual(parseFiveYearColumns('<p>no tables</p>'), []);
});
