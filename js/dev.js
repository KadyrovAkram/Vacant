// Dev mode: stand somewhere else, on a different day, at a different minute.
//
// Vacant's whole job is to be right about one place at one minute, and almost
// none of those minutes are reachable from a desk. Exam week is in December.
// Thanksgiving is once. The Saturday-at-3am refusal, the "your building is
// locked" tier and the between-terms screen are the three answers the project
// is most proud of and the three nobody could look at without waiting.
//
// So this panel moves the app's clock and the app's origin, and nothing else.
// It does not stub the ranking, it does not inject rows and it does not have a
// fixture. js/app.js exports devApply, which pins the same clock every screen
// reads and then calls the same refresh() a duration button calls, so what the
// panel shows is what a student standing there would see.
//
// Off unless asked for. Add ?dev=1 to the URL, or press D three times. The
// choice is kept in sessionStorage rather than the URL, because the app strips
// its own query string on the first history entry it writes.
//
// ?dev1 goes one further and opens the panel already standing somewhere, on a
// day, at a minute. See SCENES.

import { devApply, devReadout, devState } from './app.js';
import { NETWORK_TIMEOUT_MS } from './firstrun.js';

const KEY = 'vacant.dev';
const KEY_AT = 'vacant.dev.at';
const KEY_WHERE = 'vacant.dev.where';
// A dropped pin, written by dev/index.html. Any point on campus, not just a
// building, because "outside Thompson" and "inside Thompson" are different
// answers and only one of them is a building centroid.
const KEY_PIN = 'vacant.dev.pin';

function savedPin() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY_PIN) || 'null');
    if (raw && Number.isFinite(raw.lat) && Number.isFinite(raw.lon)) return raw;
  } catch {
    /* a corrupt key is the same as no key */
  }
  return null;
}

// The Oval, the app's own fallback origin and the point the screenshots are
// taken from.
const OVAL = { lat: 39.99944, lon: -83.01502 };

// Places worth one tap, because they are the arguments the app makes.
//
// A weekday mid-morning is the ordinary case. Saturday 3am is the refusal.
// Thanksgiving is offices-closed and Autumn Break is no-classes, which look the
// same in a schedule and are not the same fact. Finals week is out of term.
// Every date below is inside Autumn 2026 and is read from the committed
// calendar in data/rooms-1268.json, not asserted here.
const JUMPS = [
  ['Wed 10:20am', '2026-09-16T10:20'],
  ['Wed 4:10pm', '2026-09-16T16:10'],
  ['Fri 7:30pm', '2026-09-18T19:30'],
  ['Sat 3:00am', '2026-09-19T03:00'],
  ['Sun noon', '2026-09-20T12:00'],
  ['Labor Day', '2026-09-07T11:00'],
  ['Autumn Break', '2026-10-15T11:00'],
  ['Thanksgiving', '2026-11-26T11:00'],
  ['Finals week', '2026-12-14T11:00'],
  ['Winter break', '2027-01-05T11:00'],
];

// Named scenes: one URL each, for a minute the app cannot otherwise be looked
// at in. Enes asked for the first at 10pm on a Tuesday in September, when every
// building on campus is shut, the app is right to say so, and there is nothing
// on any screen to look at.
//
// `place` is a building code out of data/buildings-<term>.json. 279 is Dreese
// Laboratories, which is where he is. `day` is getDay(): 4 is Thursday.
const SCENES = {
  dev1: { place: '279', day: 4, hour: 14, minute: 15 },
};

const pad = (n) => String(n).padStart(2, '0');
const localValue = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

// A datetime-local value is wall clock with no zone, which is exactly what is
// wanted: "10:20 on campus" means 10:20 in the browser's own timezone.
const parseLocal = (value) => {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The DATE a scene lands on is asked of the shipped index rather than written
// down. rooms-<term>.json carries the teaching range, the closed days and the
// exam window, so "a Thursday in term" is a question the data can answer -- and
// a literal 2026-09-17 in this file would be a Thursday in a term that has ended
// the day Spring 1272 ships, with nothing to catch it.
//
// The first teaching Thursday that is neither closed nor inside exams. Any of
// them would do: a class schedule is keyed to the day of the week, so every
// Thursday in term carries the same grid, and the only thing that separates them
// is the calendar this skips.
function sceneClock({ day, hour, minute }) {
  const index = devState.rooms;
  if (!Array.isArray(index?.teaching)) return null;
  const [from, to] = index.teaching;
  const closed = index.closed ?? {};
  const exams = index.exams;
  const end = new Date(`${to}T12:00`);
  for (const d = new Date(`${from}T12:00`); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== day) continue;
    const date = localValue(d).slice(0, 10);
    if (closed[date]) continue;
    if (exams?.start && date >= exams.start && date <= exams.end) continue;
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
  }
  return null;
}

function styles() {
  const css = `
  #dev {
    position: fixed; left: .5rem; bottom: calc(.5rem + var(--safe-b)); z-index: 9;
    width: min(22rem, calc(100vw - 1rem)); max-height: 70vh; overflow: auto;
    background: rgba(9,11,14,.94); border: 1px solid var(--you); border-radius: 14px;
    color: var(--fg); font-size: .78rem; padding: .6rem .7rem;
    display: flex; flex-direction: column; gap: .5rem;
    backdrop-filter: blur(6px);
  }
  #dev[data-open="0"] { width: auto; max-height: none; padding: .35rem .6rem; }
  #dev[data-open="0"] > :not(#dev-bar) { display: none; }
  #dev-bar { display: flex; align-items: center; gap: .5rem; }
  #dev-bar b { color: var(--you); font-weight: 700; letter-spacing: .04em; }
  #dev-bar .sp { flex: 1 1 auto; }
  #dev button, #dev select, #dev input {
    font: inherit; color: var(--fg); background: var(--card);
    border: 1px solid var(--line); border-radius: 8px; padding: .3rem .45rem;
  }
  #dev button { cursor: pointer; }
  #dev button.go { border-color: var(--you); }
  #dev label { display: flex; flex-direction: column; gap: .2rem; color: var(--dim); }
  #dev label > span { font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; }
  #dev .row { display: flex; gap: .4rem; align-items: end; }
  #dev .row > * { flex: 1 1 auto; min-width: 0; }
  #dev .jumps { display: flex; flex-wrap: wrap; gap: .3rem; }
  #dev .jumps button { font-size: .72rem; padding: .25rem .45rem; }
  #dev input[type="range"] { padding: 0; background: none; border: 0; }
  #dev .out {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: .72rem; line-height: 1.5; color: var(--dim);
    white-space: pre-wrap; border-top: 1px solid var(--line); padding-top: .45rem; margin: 0;
  }
  #dev .out b { color: var(--fg); font-weight: 600; }
  #dev .out .warn { color: var(--warn); }
  `;
  const el = document.createElement('style');
  el.textContent = css;
  document.head.append(el);
}

function buildingOptions() {
  const buildings = devState.buildings ?? {};
  const counts = devState.counts ?? {};
  return Object.entries(buildings)
    .filter(([code]) => counts[code])
    .map(([code, b]) => ({ code, name: b.name, lat: b.lat, lon: b.lon, rooms: counts[code] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function panel() {
  styles();
  const el = document.createElement('aside');
  el.id = 'dev';
  el.dataset.open = '1';
  el.setAttribute('aria-label', 'Dev mode: simulate a place and a time');
  el.innerHTML = `
    <div id="dev-bar">
      <b>DEV</b><span class="sp"></span>
      <button type="button" id="dev-fold" aria-label="Collapse dev panel">–</button>
      <button type="button" id="dev-off" aria-label="Turn dev mode off">x</button>
    </div>
    <label><span>When</span>
      <input type="datetime-local" id="dev-when">
    </label>
    <input type="range" id="dev-slide" min="0" max="1439" step="5" aria-label="Time of day">
    <div class="jumps">${JUMPS.map(
      (j, i) => `<button type="button" data-jump="${i}">${j[0]}</button>`,
    ).join('')}</div>
    <label><span>Standing at</span>
      <select id="dev-where"></select>
    </label>
    <div class="row">
      <button type="button" class="go" id="dev-live">Back to now and here</button>
    </div>
    <p class="out" id="dev-out"></p>
  `;
  document.body.append(el);

  const where = el.querySelector('#dev-where');
  const places = buildingOptions();
  where.innerHTML =
    (savedPin() ? `<option value="pin">the pin you dropped</option>` : '') +
    `<option value="live">my real location</option>` +
    `<option value="oval">the Oval</option>` +
    places
      .map((b) => `<option value="${b.code}">${b.name} (${b.rooms})</option>`)
      .join('');
  return { el, places };
}

// The panel's own state, kept in sessionStorage so a reload lands on the same
// simulated minute. Null in either field means "use the real one".
function saved() {
  const at = Number(sessionStorage.getItem(KEY_AT));
  return {
    at: Number.isFinite(at) && at > 0 ? at : null,
    where: sessionStorage.getItem(KEY_WHERE) || 'live',
  };
}

function paintOut(out) {
  const r = devReadout();
  if (!r.ready) {
    out.textContent = 'the app has not finished loading its index yet';
    return;
  }
  const d = new Date(r.when);
  const lines = [];
  lines.push(
    `<b>${DAY_NAMES[d.getDay()]}</b> ${d.toLocaleString()}` +
      (r.simulated ? '  <span class="warn">simulated</span>' : '  (live clock)'),
  );
  const from = r.origin
    ? r.origin.label ?? `${r.origin.lat.toFixed(5)}, ${r.origin.lon.toFixed(5)}`
    : 'nowhere';
  lines.push(`from <b>${from}</b>  (${r.origin?.source ?? '?'})`);
  if (!r.rankable) {
    const why = r.refused ? `refuses: ${r.refused}` : 'refuses to rank';
    lines.push(`<span class="warn">${why}</span>  ${r.heading ?? ''}`);
  } else if (!r.scheduled) {
    lines.push('<span class="warn">outside scheduled hours</span>, so it shows buildings');
  } else {
    if (r.total == null) {
      lines.push('no ranked answer on screen yet');
    } else {
      lines.push(`asking for <b>${r.duration}</b>, <b>${r.total}</b> rooms free`);
    }
    for (const t of r.top) {
      const window = t.hoursKnown ? `${t.usable} min` : 'hours unknown';
      lines.push(`  ${t.id}  ${t.walk} min walk  ${window}  ${t.name}`);
    }
  }
  out.innerHTML = lines.join('\n');
}

export function start(scene) {
  const { el, places } = panel();
  const when = el.querySelector('#dev-when');
  const slide = el.querySelector('#dev-slide');
  const where = el.querySelector('#dev-where');
  const out = el.querySelector('#dev-out');
  const byCode = new Map(places.map((b) => [b.code, b]));
  let live = null; // the origin the app resolved on its own, kept to go back to

  const apply = ({ at, place }) => {
    const patch = {};
    if (at !== undefined) {
      patch.at = at;
      if (at == null) sessionStorage.removeItem(KEY_AT);
      else sessionStorage.setItem(KEY_AT, String(at));
    }
    if (place !== undefined) {
      sessionStorage.setItem(KEY_WHERE, place);
      if (place === 'live') {
        patch.origin = live;
        patch.note = null;
      } else if (place === 'pin') {
        const pin = savedPin();
        if (pin) {
          patch.origin = {
            lat: pin.lat, lon: pin.lon, accuracy: null, source: 'picked',
            label: pin.label || 'a dropped pin', at: Date.now(),
          };
          patch.note = null;
        }
      } else if (place === 'oval') {
        patch.origin = { ...OVAL, accuracy: null, source: 'picked', label: 'the Oval', at: Date.now() };
        patch.note = 'Dev mode: standing on the Oval';
      } else {
        const b = byCode.get(place);
        if (b) {
          patch.origin = {
            lat: b.lat, lon: b.lon, accuracy: null, source: 'picked', label: b.name, at: Date.now(),
          };
          patch.note = `Dev mode: standing at ${b.name}`;
        }
      }
    }
    devApply(patch);
    sync();
  };

  // Push the app's own clock back into the controls, so the panel never claims
  // a minute the app is not actually on.
  const sync = () => {
    const r = devReadout();
    const d = new Date(r.when);
    when.value = localValue(d);
    slide.value = String(d.getHours() * 60 + d.getMinutes());
    paintOut(out);
  };

  when.oninput = () => {
    const ms = parseLocal(when.value);
    if (ms != null) apply({ at: ms });
  };
  slide.oninput = () => {
    const base = parseLocal(when.value) ?? Date.now();
    const d = new Date(base);
    const m = Number(slide.value);
    d.setHours(Math.floor(m / 60), m % 60, 0, 0);
    apply({ at: d.getTime() });
  };
  for (const b of el.querySelectorAll('[data-jump]')) {
    b.onclick = () => {
      const ms = parseLocal(JUMPS[Number(b.dataset.jump)][1]);
      if (ms != null) apply({ at: ms });
    };
  }
  where.onchange = () => apply({ place: where.value });
  el.querySelector('#dev-live').onclick = () => {
    where.value = 'live';
    apply({ at: null, place: 'live' });
  };
  el.querySelector('#dev-fold').onclick = () => {
    el.dataset.open = el.dataset.open === '1' ? '0' : '1';
  };
  el.querySelector('#dev-off').onclick = () => {
    sessionStorage.removeItem(KEY);
    sessionStorage.removeItem(KEY_AT);
    sessionStorage.removeItem(KEY_WHERE);
    sessionStorage.removeItem(KEY_PIN);
    apply({ at: null, place: 'live' });
    el.remove();
  };

  // Wait for the index. The controls are inert until then, and the readout says
  // so rather than rendering an empty answer.
  //
  // Bounded, because the wait can be forever. boot() rejects on a dead network
  // and js/app.js paints its own card without ever setting state.ready, and
  // this had no way out of that: it polled eight times a second for as long as
  // the tab stayed open, on the one screen that is already telling the reader
  // the network is gone. NETWORK_TIMEOUT_MS is boot's own ceiling, so anything
  // past it is not slow, it has failed.
  const giveUp = Date.now() + NETWORK_TIMEOUT_MS + 5000;
  const ready = setInterval(() => {
    if (!devReadout().ready) {
      if (Date.now() < giveUp) return;
      clearInterval(ready);
      out.textContent = 'the app never loaded its index, so there is nothing to simulate against';
      return;
    }
    clearInterval(ready);
    live = devState.origin ? { ...devState.origin } : null;

    // The building list is only knowable once the index has loaded, and it is
    // built BEFORE anything is applied: a scene names its place by building code
    // and apply() resolves that code through this map.
    if (!where.options.length || where.options.length < 3) {
      const places2 = buildingOptions();
      where.innerHTML =
        (savedPin() ? `<option value="pin">the pin you dropped</option>` : '') +
        `<option value="live">my real location</option>` +
        `<option value="oval">the Oval</option>` +
        places2.map((b) => `<option value="${b.code}">${b.name} (${b.rooms})</option>`).join('');
      for (const b of places2) byCode.set(b.code, b);
    }

    // A scene, if the URL named one. It goes through the same apply() every
    // control goes through, so it writes the same two session keys and survives
    // the reload that strips the query string -- and the panel's own controls
    // come up reading the scene rather than contradicting it.
    //
    // A place the index does not have falls back to the Oval instead of quietly
    // leaving the origin alone, which would be a scene that only moved the clock
    // and never said so.
    const want = scene ? SCENES[scene] : null;
    const s = saved();
    if (want) {
      apply({
        at: sceneClock(want) ?? s.at ?? null,
        place: byCode.has(want.place) ? want.place : 'oval',
      });
    } else {
      // Always apply, even with nothing restored. devApply runs the same
      // refresh() a duration button runs, which is what fills in the ranked
      // answer the readout prints. Without it the panel opens claiming 0 rooms
      // free, which is true only in the sense that nothing has been asked yet.
      apply({ at: s.at ?? null, place: s.where });
    }
    where.value = saved().where;
  }, 120);
}

// Arming lives in js/app.js, which is the module the browser already has. This
// file is loaded on demand and never reaches a student who did not ask for it,
// which is also why it is absent from the service worker's shell list.
