// Offline. Hand-built HTML in the exact shape of the live page. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { DAY_INDEX, extractDayList, parseClock, parseDayCell, parsePage, parseTitle } from '../lib/hours.mjs';
import { discoverTermLinks } from '../fetch-building-hours.mjs';

const li = (day, value) => `<li><strong>${day}: ${value}</strong></li>`;
const week = (v) =>
  ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    .map((d, i) => li(d, Array.isArray(v) ? v[i] : v))
    .join('');

const panel = (title, body) => `<div class="panel panel-default">
  <div class="panel-heading"><h3 class="panel-title">
    <a data-toggle="collapse" role="button" href="#c1" class="collapsed" aria-expanded="false" aria-controls="collapse-1">
      ${title} </a></h3></div>
  <div id="collapse-1" class="panel-collapse collapse"><div class="panel-body">${body}</div></div></div>`;

const dayHours = (v) => `<p>DAY HOURS:</p><ul>${week(v)}</ul>`;

test('day index is Sunday-first, matching Date.getDay', () => {
  assert.deepEqual(DAY_INDEX, {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  });
});

test('parseClock handles every format on the live pages', () => {
  assert.equal(parseClock('7am'), 420);
  assert.equal(parseClock('5:30pm'), 1050);
  assert.equal(parseClock('8:30am'), 510);
  assert.equal(parseClock('12pm'), 720, 'noon');
  assert.equal(parseClock('12:30pm'), 750);
  assert.equal(parseClock('5:00pm'), 1020, 'explicit :00 minutes');
  assert.equal(parseClock('6:30am'), 390);
  assert.equal(parseClock('11pm'), 1380);
});

test('a 12am CLOSE is 1440, not 0', () => {
  // "7am-12am" is a building open until midnight. Mapping it to 0 makes the
  // window negative and deletes the building from the whole evening.
  assert.equal(parseClock('12am', { isClose: true }), 1440);
  assert.equal(parseClock('12am'), 0, 'as an OPEN time midnight is 0');
  assert.deepEqual(parseDayCell('7am-12am'), [420, 1440]);
});

test('closed maps to null in either case', () => {
  assert.equal(parseDayCell('closed'), null);
  assert.equal(parseDayCell('Closed'), null);
  assert.equal(parseDayCell('CLOSED'), null);
  assert.equal(parseDayCell(' Closed '), null);
});

test('the "to" separator parses, as does the plain dash', () => {
  assert.deepEqual(parseDayCell('2pm to 6pm'), [840, 1080]);
  assert.deepEqual(parseDayCell('7am-5:00pm'), [420, 1020]);
  assert.deepEqual(parseDayCell('7am-11pm'), [420, 1380]);
  assert.deepEqual(parseDayCell('12:30pm-5pm'), [750, 1020]);
  assert.deepEqual(parseDayCell('5am-10:30pm'), [300, 1350]);
});

test('a cell with no am/pm on the close throws instead of guessing', () => {
  // The four live Caldwell Lab cells: "7am-10". A parser that picks 10am or
  // 10pm on its own is how the app starts lying.
  assert.throws(() => parseDayCell('7am-10'), /unparseable close/);
  assert.throws(() => parseDayCell('7am-5'), /unparseable close/);
  assert.throws(() => parseDayCell('7am-'), /unparseable close|separator/);
  assert.throws(() => parseDayCell(''), /empty cell/);
  assert.throws(() => parseDayCell('all day'), /separator/);
  assert.throws(() => parseDayCell('9pm-7am'), /close is not after open/);
});

test('the title yields name, abbreviation and address', () => {
  assert.deepEqual(parseTitle('Ag. Admin. (AA) | 2120 Fyffe Road'), {
    name: 'Ag. Admin.', abbr: 'AA', address: '2120 Fyffe Road',
  });
  // The live page is inconsistent about the space before the pipe.
  assert.equal(parseTitle('Knowlton Architecture Building (KN) |275 W. Woodruff Avenue').abbr, 'KN');
  // TFM is four characters and FL is 1018, so nothing may assume three digits
  // or two letters.
  assert.equal(parseTitle('Theatre, Film and Media Arts (TFM) | 1849 Cannon Dr').abbr, 'TFM');
});

test('ONLY the first week in a panel is taken, never the last', () => {
  // THE bug this parser exists to avoid. 9 of 47 Autumn 2026 buildings publish
  // a second full week for a library or a lab. The regex the research
  // recommends matches across the whole body and takes the last match per day,
  // so Ag. Admin. ships its library's 8am-6pm as the building's hours.
  const body =
    dayHours('7am-8pm') +
    '<p>LIBRARY HOURS: </p><p>Room 045 FAES</p><ul>' + week('8am-6pm') + '</ul>';
  const [row] = parsePage(panel('Ag. Admin. (AA) | 2120 Fyffe Road', body));
  assert.deepEqual(row.hours[DAY_INDEX.monday], [420, 1200], 'building hours, not library hours');
});

test('a third block that runs Monday to Friday cannot splice onto the weekend', () => {
  // Orton Hall publishes three blocks and its Lab block has no Saturday or
  // Sunday, so a last-wins parse produces a week that exists nowhere on the
  // page: lab weekdays with building weekends.
  const body =
    dayHours(['7am-7pm', '7am-7pm', '7am-7pm', '7am-7pm', '7am-5pm', 'Closed', '2pm to 6pm']) +
    '<p>Library Hours:</p><ul>' + week('9am-7pm') + '</ul>' +
    '<p>Lab Hours:</p><ul>' +
    ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((d) => li(d, '8am-5pm')).join('') +
    '</ul>';
  const [row] = parsePage(panel('Orton Hall (OR) | 155 S. Oval Mall', body));
  assert.deepEqual(row.hours[DAY_INDEX.monday], [420, 1140], '7am-7pm from the DAY HOURS block');
  assert.deepEqual(row.hours[DAY_INDEX.sunday], [840, 1080], '2pm to 6pm, the building own');
  assert.equal(row.hours[DAY_INDEX.saturday], null);
});

test('a note paragraph between the heading and the list does not break it', () => {
  // Sullivant Hall does exactly this.
  const body =
    '<p>DAY HOURS: </p><p>*The below hours reflect the north entrance only</p><ul>' +
    week('7am-7:30pm') + '</ul>';
  const [row] = parsePage(panel('Sullivant Hall (SU) | 1813 N. High Street', body));
  assert.deepEqual(row.hours[DAY_INDEX.monday], [420, 1170]);
});

test('extractDayList prefers the DAY HOURS list and never the whole body', () => {
  const body = dayHours('7am-8pm') + '<ul>' + week('9am-9pm') + '</ul>';
  const list = extractDayList(body);
  assert.match(list, /7am-8pm/);
  assert.ok(!/9am-9pm/.test(list));
  assert.equal(extractDayList('<p>nothing here</p>'), null);
});

test('an unparseable cell is reported with its building and raw text, not swallowed', () => {
  const body = dayHours(['7am-10', '7am-10', '7am-9pm', '7am-9pm', '7am-9pm', 'closed', '12pm-10pm']);
  const [row] = parsePage(panel('Caldwell Lab (CL) | 2024 Neil Avenue', body));
  assert.equal(row.errors.length, 2);
  assert.equal(row.errors[0].raw, '7am-10');
  assert.equal(row.abbr, 'CL');
  assert.equal(row.hours[DAY_INDEX.monday], undefined, 'never filled with a guess');
  assert.deepEqual(row.hours[DAY_INDEX.sunday], [720, 1320], 'the good cells still parse');
});

test('the page has no tables, so a table parser would find nothing', () => {
  const html = panel('A Hall (AH) | 1 Road', dayHours('7am-8pm'));
  assert.ok(!/<table/i.test(html));
  assert.equal(parsePage(html).length, 1);
});

test('term pages are discovered by link, never by constructing a slug', () => {
  const index = `
    <a href="/staff-resources/class-catalog-and-space/classroom-pool-building-schedule/">index</a>
    <a href="/staff-resources/class-catalog-and-space/classroom-pool-building-schedule/autumn-2026-classroom-pool-building-schedule/">Autumn</a>
    <a href="/staff-resources/class-catalog-and-space/classroom-pool-building-schedule/summer-2026-classroom-pool-building-schedule/">Summer</a>
    <a href="/staff-resources/class-catalog-and-space/classroom-pool-building-schedule/winter-break-classroom-pool-building-schedule-2025-2026/">Winter break</a>`;
  const links = discoverTermLinks(index);
  const slugs = links.map((l) => l.slug).sort();
  assert.deepEqual(slugs, [
    'autumn-2026-classroom-pool-building-schedule',
    'summer-2026-classroom-pool-building-schedule',
    // The winter-break slug breaks the season-year pattern entirely, which is
    // why nothing may construct one.
    'winter-break-classroom-pool-building-schedule-2025-2026',
  ]);
  assert.ok(links.every((l) => l.url.startsWith('https://registrar.osu.edu/')));

  // And that holds against links the Registrar's page did not write: an offsite
  // host, and one the origin's own name is a prefix of.
  const offsite = discoverTermLinks(
    '<a href="https://example.com/autumn-2099-classroom-pool-building-schedule/">no</a>' +
    '<a href="https://registrar.osu.edu.example.com/spring-2099-classroom-pool-building-schedule/">no</a>',
  );
  assert.deepEqual(offsite, []);
  assert.equal(discoverTermLinks('<p>no links</p>').length, 0);
});

test('the committed output carries no phone number, address identifier or email', () => {
  const path = new URL('../../data/buildings-hours.json', import.meta.url);
  const json = readIfPresent(path);
  if (!json) return; // not built yet in a fresh checkout
  assert.equal(json.match(/\b\d{3}[-.]\d{3}[-.]\d{4}\b/), null, 'phone number');
  assert.equal(json.match(/[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+/), null, 'email address');
  assert.equal(json.match(/\b[a-z]+\.\d{1,4}\b/i), null, 'OSU name.n identifier');
  assert.equal(json.match(/Comment/i), null, 'the comment block is never written to output');
});

test('the committed output never assumes hours it does not have', () => {
  const json = readIfPresent(new URL('../../data/buildings-hours.json', import.meta.url));
  if (!json) return;
  const data = JSON.parse(json);
  for (const term of Object.values(data.terms)) {
    for (const [code, b] of Object.entries(term.buildings)) {
      assert.ok(['registrar', 'override'].includes(b.hoursSource), `${code} ${b.hoursSource}`);
      assert.equal(b.hours.length, 7);
      for (const h of b.hours) {
        if (h === null) continue;
        assert.equal(h.length, 2);
        assert.ok(h[1] > h[0], `${code} close must follow open`);
        assert.ok(h[1] <= 1440 && h[0] >= 0);
      }
    }
  }
  assert.ok(Array.isArray(data.unknownHours) && data.unknownHours.length > 0,
    'buildings with no published hours are listed explicitly, never given a default');
});

// The built file is committed, but a fresh checkout that has not run the
// scraper yet should skip these rather than fail.
function readIfPresent(url) {
  return existsSync(url) ? readFileSync(url, 'utf8') : null;
}

// --- regressions found by the PR #32 review ---

test('a combined day cell is reported missing, never shipped as closed', () => {
  // A panel rendering one <li> for "Monday-Thursday" yields FOUR days found and
  // ZERO errors. Collapsing the three undefined slots to null publishes a
  // building open until 10pm as closed on three weekdays, past every guard.
  const body =
    '<p>DAY HOURS:</p><ul>' +
    li('Monday-Thursday', '7am-10pm') +
    li('Friday', '7am-6pm') +
    li('Saturday', 'closed') +
    li('Sunday', 'closed') +
    '</ul>';
  const [row] = parsePage(panel('A Hall (AH) | 1 Road', body));
  assert.equal(row.errors.length, 0, 'nothing throws, which is what makes it dangerous');
  assert.equal(row.daysFound, 4);
  assert.deepEqual(row.missing.sort(), ['monday', 'tuesday', 'wednesday'].sort());
  assert.equal(row.hours[DAY_INDEX.monday], undefined, 'undefined, NOT null');
  assert.notEqual(row.hours[DAY_INDEX.monday], null, 'null would mean closed');
});

test('a missing single day is caught the same way', () => {
  const body =
    '<p>DAY HOURS:</p><ul>' +
    ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Sunday']
      .map((d) => li(d, '7am-8pm'))
      .join('') +
    '</ul>';
  const [row] = parsePage(panel('A Hall (AH) | 1 Road', body));
  assert.deepEqual(row.missing, ['saturday']);
  assert.equal(row.daysFound, 6);
});

test('a panel whose title drifts is reported, not silently dropped', () => {
  // Dropping it puts the building into unknownHours, so the app claims "hours
  // not published" about a building that publishes them. With a floor of 40
  // against 47 panels, seven could vanish without a word.
  for (const title of [
    'Ag. Admin. - 2120 Fyffe Road',
    'Ag. Admin. (AgAdmin1) | x',
    'Ag. Admin. [AA] | x',
  ]) {
    const rows = parsePage(panel(title, dayHours('7am-8pm')));
    assert.equal(rows.length, 1, `${title}: the panel is still returned`);
    assert.equal(rows[0].unparseable, true, title);
    assert.ok(rows[0].raw.length > 0, 'the raw title is carried for the error message');
  }
});

test('an extra attribute after aria-controls does not lose the panel', () => {
  const p = panel('A Hall (AH) | 1 Road', dayHours('7am-8pm')).replace(
    'aria-controls="collapse-1"',
    'aria-controls="collapse-1" data-x="y"',
  );
  const [row] = parsePage(p);
  assert.equal(row.unparseable, undefined);
  assert.equal(row.abbr, 'AH');
});

test('a 12:30am close is 1470, not 30', () => {
  // Handling only the whole hour made a well-formed cell throw "close is not
  // after open", halting a term build and misreporting it as a Registrar typo.
  assert.equal(parseClock('12:30am', { isClose: true }), 1470);
  assert.equal(parseClock('12:45am', { isClose: true }), 1485);
  assert.equal(parseClock('12:30am'), 30, 'as an OPEN time it is still 30');
  assert.deepEqual(parseDayCell('7am-12:30am'), [420, 1470]);
  assert.deepEqual(parseDayCell('7am-12am'), [420, 1440]);
});
