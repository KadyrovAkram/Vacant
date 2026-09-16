// Vacant. One question, then an answer.
//
// Boot order. Nothing may be inserted above step 5 that waits on a network or
// on a position, because the first paint is what the app is judged on and a
// cold phone on outdoor LTE has neither:
//
//   1  shell and question paint out of index.html    no network, no fix
//   2  read data/current.json -> term code
//   3  parse rooms-<term>.json and the term's building slice
//   4  getCurrentPosition, started at step 2 so the two waits overlap
//   5  fix arrives -> rank -> render the list
//
// The flyover is the LOADING STATE, not a gate. It must never add a second to
// the time from tap to answer.
//
// Screens, all of them one sheet over one map: the question, the ranked list,
// one room, the buildings screen for the hours no class covers, the building
// picker, and what the app believes. The sheet routes between them so the map,
// the highlight and the line stay on screen while you read.

import { toGrid } from './campus.js';
import { roomClaim } from './claim.js';
import { overlayForDate } from '../scripts/lib/club-occupancy.mjs';
import { blocksOn, classesOn, dayClaim } from './day.js';
// `query` arrives as `ladder` because js/app.js already holds a `state.query`,
// which is the buildings search box and has nothing to do with the engine.
import { MAX_WALK, activeSessions, calendarOn, distanceMetres, mark, measure, query as ladder, rank, shape, tally, walkMetres, walkMinutes } from './engine.js';
import { createRouter, decodeWalkGraph } from './route.js';
import { createDirections } from './directions.js';
// The deadline every request on the path to a first answer shares. It lives in
// js/firstrun.js because that is the module holding the rule it comes from.
import { NETWORK_TIMEOUT_MS } from './firstrun.js';
import { mapsHref } from './install.js';
import {
  ROOM_FEATURES,
  describeRoomPreferences,
  filterRoomsByPreferences,
  hasRoomPreferences,
  normalizeRoomPreferences,
  roomFeatureCoverage,
  roomFeatureLabels,
} from './preferences.js';
import {
  busyDayOf,
  clock,
  clockIsPinned,
  closedDayFor,
  diagnosticsBlock,
  dur,
  createWatch,
  followAction,
  followFix,
  roomSearchOn,
  inTermOn,
  isoDate,
  nextOpening,
  now as clockNow,
  openDoorCount,
  openingPhrase,
  pinClock,
  rankBuildings,
  resolveState,
  roomsPerBuilding,
  rungPhrase,
  spokenClock,
  staleness,
  unscheduledGate,
  windowPhrase,
} from './state.js';
import {
  FLYOVER_SPAN,
  SETTLED_SPAN,
  attachGestures,
  buildBasemap,
  clampView,
  createFrameLoop,
  drawFrame,
  drawTarget,
  drawYou,
  fitPair,
  footprintFor,
  makeView,
  panBy,
  pixelsPerGridFor,
  zoomBy,
} from './map.js';
import { bandFor, capFor, floorFor, lowPxFor, openAt, restPxFor, sheetAfterDrag } from './sheet.js';

const BASE = new URL('.', import.meta.url).pathname.replace(/js\/$/, '');

// Finder shares this origin, so the prefix is not optional.
const KEY_DURATION = 'vacant.duration';
const KEY_ORIGIN = 'vacant.origin';
const KEY_PICK = 'vacant.lastPick';

// Off-campus is a real state, not an error. Beyond this from the map centre the
// app cannot honestly rank by walk time. A first cut only: answer() asks the
// question this circle stands in for and falls back on that instead.
//
// MEASURED, and it is a line about walking, not about where campus ends. The
// farthest building holding a ranked classroom is Animal Science at 1.410 km
// from the Oval, MAX_WALK reaches 0.720 km of straight line, so nothing is
// walkable past 2.130 km, and a 360 bearing sweep in 10 m steps agrees to
// within one step. The 8 that shipped was nearly four times it, never go below.
//
// The comparison is a flat lat/lon conversion, not the engine's equirectangular
// distanceMetres: 0.2% here, 4.42 km against 4.43 at the issue #60 origin.
//
// It must never be read as "you are not on campus". 268 of the 612 buildings in
// data/buildings.json sit outside it, every one of them OSU property, and the
// farthest is Main St, 153 W at 19.32 km. That is why the note it prints is
// about the walk.
//
// That claim used to be made against data/buildings-1268.json, where seven of
// 96 buildings sat outside the gate. It cannot be any more, and the reason is
// worth keeping: the term slice is now 46 buildings, all of them within 1.407
// km of the Oval, because the room safety filter cut the index to the rooms
// Vacant will actually offer. The 96 in that sentence was a slice built on
// 2026-08-27 and left behind by its own room index. Nothing about the gate
// changed; what changed is that the slice stopped being a sample of OSU
// property and became a list of classroom buildings, so the full index is the
// only honest place to read this off now.
const OFF_CAMPUS_KM = 2.2;

// The fallback origin, and the sentence both screens that reach for it print:
// the gate below when the fix lands too far out, answer() when the ranking
// comes back with nothing walkable.
const OVAL = { lat: 39.9995, lon: -83.013 };
const ovalOrigin = () => ({ ...OVAL, accuracy: null, source: 'oval', label: 'the Oval', at: Date.now() });
const NO_WALK = 'No classroom close enough to walk to';
const NO_WALK_OVAL = `${NO_WALK}, showing from the Oval`;

// iOS documents its own geolocation timeout as unreliable in a standalone
// window, so a wall-clock watchdog runs beside it. Without this a bare await
// can hang forever with the user staring at a drifting map.
const FIX_TIMEOUT_MS = 8000;

// A room that frees up soon is a real fallback, which is what the README's
// ladder asks for. A room that frees up in seven hours is not an answer, it is
// a timetable. Past this wait the app says nothing is open rather than filling
// the list with tomorrow morning.
const MAX_WAIT_MIN = 90;

// A picked building is a point in the middle of a footprint, and the door is
// somewhere on its edge. Half a footprint is about this, and it sits under the
// 75 m coarse-fix line so the accuracy banner stays off for a choice the user
// made deliberately.
const PICKED_ACCURACY_M = 50;

// Places students stand rather than places classes meet, so this list is
// codes and not names: the label is read out of the shipped building table, and
// a code that leaves the table renders nothing instead of a dead button.
const SHORTCUTS = ['161', '050', '246', '005', '279', '274'];

// Where campus actually is, as a fraction of the map's bounding box. Measured
// from the shipped data: the room-weighted centroid of buildings holding ranked
// classrooms is x 0.661, and the Oval, the geolocation fallback, is x 0.723.
const CORE_X = 0.661;
const CORE_Y = 0.5;

// PEEK, FULL, ROOM_SHEET, REST and the dismiss travel live in js/sheet.js, where
// the suite can check them as numbers rather than as source.

// A fix this coarse turns every walk time into an estimate, so the row says
// "~4 min" and the accessible name says "about 4 minutes".
const COARSE_M = 75;

// Passing periods are 15 minutes and 40% of a day's free blocks are under 20,
// so a row each fills the room screen with corridor traffic. Anything shorter
// than this is drawn as a rule between two classes instead.
const SEAM_MIN = 20;

const COMPASS = ['north', 'north east', 'east', 'south east', 'south', 'south west', 'west', 'north west'];

const $ = (id) => document.getElementById(id);

const state = {
  campus: null,
  basemap: null,
  view: null,
  band: null,
  userMoved: false,
  // Whether a finger is on the sheet right now. Read by the watch in the
  // geolocation section: a position that lands mid-gesture may move the dot and
  // may not re-order the rows under it.
  dragging: false,
  rooms: null,
  classRooms: null,
  roomEvents: null,
  eventCoverage: null,
  buildings: null,
  counts: null,
  shorts: null,
  hours: null,
  hoursTerm: null,
  hoursSlug: null,
  current: null,
  origin: null,
  // Dev mode. Off for everyone who did not ask for it, and the only thing in
  // the app that reads it is which location controls exist.
  dev: false,
  accuracy: null,
  originIsGuess: true,
  duration: safeGet(KEY_DURATION) ?? '30',
  needed: 30,
  preferences: normalizeRoomPreferences(),
  preferencesDirty: false,
  preferenceStats: { matching: 0, total: 0 },
  featureCoverage: { known: 0, total: 0 },
  results: [],
  // How deep into the ranking the card screen is. Reset by answer(), because a
  // re-rank makes "the third one" a different room.
  cardIndex: 0,
  // The ids in data/photos.json, as a Set, or null until it arrives. Null is
  // not "none": it is "not known yet", and the card renders without a picture
  // rather than guessing and 404ing 118 times.
  photos: null,
  total: 0,
  // How many rooms are free, and free for long enough, counted once by
  // engine.js so the printed strip and the spoken sentence cannot disagree.
  // Written by answer() before it paints, and answer() is paintList()'s only
  // caller, so it is never read stale.
  tally: null,
  // The basemap fetch failed, so the canvas is gone and the list has to say so.
  // A missing map costs the map and nothing else, which is only true if the
  // black rectangle it leaves is explained.
  mapless: false,
  // Which constraint the fallback ladder gave up to reach an answer, and
  // whether it gave up anything at all. The engine has computed both since the
  // ladder shipped and nothing read them, so a list built by dropping the
  // room-type filter was headed by the same words as a list of classrooms.
  rung: null,
  relaxed: false,
  // What shape() removed to get from the ranked rows to the shown ones, which
  // neither the footer nor the empty screen can work out from state.results.
  bounds: null,
  day: clockNow().getDay(),
  soonest: null,
  selected: null,
  settled: false,
  ready: false,
  rankable: false,
  // Historical name for when the room search is offered; weekend daytime now
  // counts even though few classes meet then.
  scheduled: true,
  situation: null,
  groups: null,
  query: '',
  includeLocation: false,
  screen: 'ask',
  listScroll: 0,
};

function safeGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode; a remembered duration is not worth an error */
  }
}
function safeDel(k) {
  try {
    localStorage.removeItem(k);
  } catch {
    /* same */
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);

function needsFromControls() {
  return normalizeRoomPreferences({
    minSeats: $('need-seats').value,
    features: [...document.querySelectorAll('#need-features [data-feature]:checked')]
      .map((input) => input.dataset.feature),
  });
}

function paintNeedsSummary() {
  const count = describeRoomPreferences(state.preferences).length;
  $('needs-state').textContent = count ? `${count} selected` : 'optional';
  $('needs-clear').hidden = !hasRoomPreferences(state.preferences);
}

function syncNeedsControls() {
  $('need-seats').value = state.preferences.minSeats || '';
  for (const input of document.querySelectorAll('#need-features [data-feature]')) {
    input.checked = state.preferences.features.includes(input.dataset.feature);
  }
  paintNeedsSummary();
}

function changeNeeds() {
  state.preferences = needsFromControls();
  state.preferencesDirty = true;
  paintNeedsSummary();
}

function clearNeeds() {
  state.preferences = normalizeRoomPreferences();
  state.preferencesDirty = true;
  syncNeedsControls();
  if (state.ready && ['card', 'list'].includes(state.screen)) answer();
}

function paintNeedsAvailability() {
  const rooms = Object.values(state.rooms?.rooms ?? {});
  state.featureCoverage = roomFeatureCoverage(rooms);
  $('need-seats').disabled = !state.ready;
  for (const input of document.querySelectorAll('#need-features [data-feature]')) {
    input.disabled = !state.ready || state.featureCoverage.known === 0;
  }

  if (!state.ready) {
    $('needs-note').textContent = 'Room details are loading.';
  } else if (state.featureCoverage.known === 0) {
    $('needs-note').textContent = 'Furniture details are not loaded yet. Minimum seats works now.';
  } else if (state.featureCoverage.known < state.featureCoverage.total) {
    $('needs-note').textContent = `Furniture details are published for ${state.featureCoverage.known} of ${state.featureCoverage.total} rooms. Rooms with unknown details will not match.`;
  } else {
    $('needs-note').textContent = 'Every checked feature is required.';
  }
}

function attachNeeds() {
  $('need-features').innerHTML = ROOM_FEATURES.map((feature) => `
    <label><input type="checkbox" data-feature="${esc(feature.id)}" disabled><span>${esc(feature.label)}</span></label>`)
    .join('');
  $('need-seats').oninput = changeNeeds;
  // Canonicalise a pasted exponent or a fractional seat count once editing is
  // done, so the number in the control is the number the result screen names.
  $('need-seats').onchange = () => {
    changeNeeds();
    syncNeedsControls();
  };
  for (const input of document.querySelectorAll('#need-features [data-feature]')) {
    input.onchange = changeNeeds;
  }
  $('needs-clear').onclick = clearNeeds;
  syncNeedsControls();
  paintNeedsAvailability();
}

const say = (text) => {
  $('say').textContent = text;
};

// The only announcement that is not the result count. A screen that refuses has
// nothing to count, and a message nobody's focus lands on is a message nobody
// reads. focusVisible keeps the ring meant for controls off it; index.html says
// why, and carries the fallback for an engine that drops the option.
function focusHeading(el) {
  if (!el) return;
  el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true, focusVisible: false });
}

// ---------------------------------------------------------------- rendering

let flyoverStart = 0;
let lastSize = { w: 0, h: 0, dpr: 0 };
const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Assigning canvas.width or .height reallocates the backing store and resets
// every context property, even when the value is unchanged. Doing that per
// frame on a DPR-2 phone reallocates a full viewport bitmap sixty times a
// second, which is the cost the offscreen basemap exists to avoid.
function surface() {
  const c = $('map');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (w !== lastSize.w || h !== lastSize.h || dpr !== lastSize.dpr) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    lastSize = { w, h, dpr };
  }
  return c.getContext('2d');
}

// The install rail stands the sheet on top of it, so the map has that much less
// again. Read off the custom property js/install.js writes rather than off a
// rect, for the same reason viewport() is cached.
const railHeight = () => parseFloat(document.body.style.getPropertyValue('--bar-h')) || 0;

// Whether the canvas has a DESTINATION on it, which is the only reason to show
// a map. Your own dot is not one. js/sheet.js has the rest of this.
const targeted = () => Boolean(state.selected);

// Where the sheet rests and how high it may go THIS second, in pixels.
// Everything that used to write PEEK or FULL asks these, so the sheet's height
// and the map's visibility cannot come apart. The rail is in them because the
// sheet stands on it and it is the same headroom.
// `way` answers 0 through all three, because it is the map with one plate on it
// and has no panel for them to be about.
const restNow = () => restPxFor(state.screen, window.innerHeight, railHeight(), targeted());
const capNow = () => capFor(state.screen, window.innerHeight, railHeight(), targeted());
// How far down a gesture may take it, which is peek on every screen that has a
// map worth pulling open and the rest itself on one that is covering it.
const lowNow = () => lowPxFor(state.screen, window.innerHeight, railHeight(), targeted());

// The map's viewport is not the canvas box. `band` is the strip of canvas the
// sheet is not covering, and the map centres on the middle of THAT, which is
// what puts the you-dot back on screen.
//
// It is the strip at the screen's RESTING height, not at the sheet's current
// one, and REST is where that height is written down.
// `band` feeds both the vertical centring and the zoom, through
// `Math.min(width, band)` in js/map.js, so tracking the live drag meant the map
// zoomed out and slid upward under the thumb every time the sheet was pulled
// up. That is a map redrawing itself in response to a gesture that was not
// about the map. Freezing it at the resting layout makes the sheet slide OVER a
// map that stays where it was, which is what every map app does and what the
// gesture already looks like it is doing.
//
// Cached rather than measured, because reading the sheet's rect inside the
// frame loop forces layout sixty times a second.
function viewport() {
  const width = lastSize.w || window.innerWidth;
  const height = lastSize.h || window.innerHeight;
  return {
    width,
    height,
    band: bandFor(state.screen, height, railHeight()),
    dpr: lastSize.dpr || Math.min(window.devicePixelRatio || 1, 2),
  };
}

// One frame, and the answer to whether there needs to be another one.
//
// It used to re-request a frame on its first line whatever was on screen, which
// is what issue #75 caught: 290 callbacks in 2 seconds on a settled list with
// nothing selected, all painting the same pixels. Now the flyover is the only
// thing that asks for the next frame on its own, and everything else that
// changes what the map shows calls frames.wake() for a single one. Every one of
// those call sites is marked; miss one and the map silently keeps the old
// picture.
function render(now) {
  if (!state.basemap) return false;
  const ctx = surface();
  const vp = viewport();

  if (!state.settled && state.campus) {
    // Slow drift over campus. Nothing here is on the critical path: it is what
    // the unavoidable wait looks like.
    //
    // Centred on CORE_X, the room-weighted centroid of the buildings that
    // actually hold the ranked classrooms, measured at 0.661 with a median of
    // 0.663. The first attempt used 0.56 and put 51% of the ranked room stock
    // off screen, along with the Oval at 0.723, which is also the fallback
    // origin the map settles on.
    const t = reduceMotion ? 0 : (now - flyoverStart) / 1000;
    const g = state.campus.grid;
    state.view = makeView({
      cx: g * (CORE_X + Math.sin(t * 0.055) * 0.035),
      cy: g * (CORE_Y + Math.cos(t * 0.043) * 0.035),
      span: FLYOVER_SPAN + Math.sin(t * 0.05) * 0.02,
      rotation: reduceMotion ? 0 : Math.sin(t * 0.028) * 0.05,
    });
  }
  if (!state.view) return false;

  drawFrame(ctx, state.basemap, state.view, vp);

  const you = state.origin && state.campus ? toGrid([state.origin.lon, state.origin.lat], state.campus) : null;

  if (state.selected && state.campus) {
    const b = state.buildings?.[state.selected.building];
    const target = b ? toGrid([b.lon, b.lat], state.campus) : null;
    drawTarget(
      ctx,
      {
        footprint: footprintFor(state.campus, state.selected.building, target),
        from: you,
        to: target,
      },
      state.basemap,
      state.view,
      vp,
    );
  }

  // Your own position is not conditional on having picked a room. It draws in
  // every state, including the flyover and the empty list, and drawYou returns
  // on its own when there is no fix yet.
  drawYou(
    ctx,
    { at: you, accuracyM: state.accuracy ?? 0, guess: state.originIsGuess },
    state.basemap,
    state.view,
    vp,
  );

  // The drift over campus is the one thing on this canvas that moves by itself.
  // Under prefers-reduced-motion t is pinned to 0 above, so the flyover computes
  // the same view every frame and one paint is the whole of it.
  return !state.settled && Boolean(state.campus) && !reduceMotion;
}

// The loop, stopped whenever render() says nothing is moving.
const frames = createFrameLoop((cb) => requestAnimationFrame(cb), render);

function settle() {
  state.settled = true;
  $('map').classList.add('settled');
  frames.wake();
  if (!state.origin || !state.campus || !state.basemap || state.userMoved) return;
  const [cx, cy] = toGrid([state.origin.lon, state.origin.lat], state.campus);
  state.view = makeView({ cx, cy, span: SETTLED_SPAN, rotation: 0 });
}

// Put you and the building on screen together. Once a finger has moved the
// camera this stops firing, otherwise every row tap would undo the gesture.
function frame(r) {
  // Before the guards: a tap that does not move the camera still changes which
  // footprint is lit and where the line ends, and after a hand pan or on a
  // screen with no fix yet this function returns without touching the view.
  frames.wake();
  if (!state.basemap || !state.campus || state.userMoved || !state.origin) return;
  const b = state.buildings?.[r.building];
  if (!b || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) return;
  const you = toGrid([state.origin.lon, state.origin.lat], state.campus);
  const target = toGrid([b.lon, b.lat], state.campus);
  state.view = fitPair(you, target, state.basemap, viewport());
}

// ---------------------------------------------------------------- the sheet

const PANES = ['card', 'list', 'room', 'near', 'pick', 'about'];
let sheetH = 0;
// Which screen sheetH was measured on. A height dragged on the room screen is
// not the list's height, and viewport() reads the list's.
let sheetScreen = null;
// Assigned by attachSheet. Replacing a pane's markup resets its scrollTop
// without firing a scroll event, so the paint has to re-sync touch-action.
let syncPaneTouch = () => {};

function setSheet(px, snap) {
  // Both ends come from this screen, not from PEEK and FULL. They are still
  // peek and full wherever the map is on screen; a screen covering it cannot be
  // pulled down onto an empty canvas, and the grip keeps its travel below that.
  const h = Math.max(floorFor('grip', lowNow()), Math.min(capNow(), px));
  sheetH = h;
  sheetScreen = state.screen;
  const sheet = $('sheet');
  sheet.classList.toggle('snap', Boolean(snap));
  sheet.style.height = `${Math.round(h)}px`;
  paintMap();
}

// The map is on screen when it has an answer on it. The question screen is the
// exception: that is a blurred drifting background, not a map anybody reads.
//
// Written here because every screen change and every selection ends in a
// setSheet, so one call covers all of them and the class cannot lag a screen
// behind. showAsk() calls it directly, being the one transition that hides the
// sheet instead of sizing it.
function paintMap() {
  document.body.classList.toggle('nomap', state.screen !== 'ask' && !targeted());
}

// The menu. Three lines in the corner the back arrow has everywhere else, on
// the two screens that do not have one: the card, where a bordered pill over a
// photograph was the thing Enes called ugly, and the way, which is a map with a
// plate on it. Behind it are the choices those two screens had nowhere to put.
// Enes: "the top left should have the 3 lines thing, and when pressed it should
// have choices like to go back or other stuff".
//
// A disclosure and not role="menu". That role promises arrow keys move between
// the items, and announcing a keyboard model the app does not implement is
// worse than announcing none; Tab already walks five buttons in order.
let closeMenu = () => {};

function attachMenu() {
  const btn = $('menu');
  const pop = $('menu-pop');
  // The backdrop stops a finger and stops nothing else. Without inert, Tab walks
  // straight off the last choice onto the card behind it, where #c-top is
  // focusable and its keydown makes Enter, Space and ArrowRight take the room:
  // a reader could accept a room while looking at a menu. inert takes the whole
  // screen out of the tab order AND out of the accessibility tree, which is the
  // half aria-hidden alone would miss.
  const behind = ['sheet', 'way', 'ask'];
  const show = (on) => {
    pop.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
    document.body.classList.toggle('menuing', on);
    for (const id of behind) $(id).inert = on;
    if (on) pop.querySelector('.m-item').focus({ preventScroll: true });
    else if (!btn.hidden) btn.focus({ preventScroll: true });
  };
  // Every screen change closes it. A panel that outlives the screen it was
  // opened on is a set of choices about somewhere the reader has left.
  closeMenu = () => {
    if (pop.hidden) return;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('menuing');
    for (const id of behind) $(id).inert = false;
  };

  btn.onclick = () => show(pop.hidden);
  // #menu-pop is the whole viewport, so a press outside the panel is "not this".
  // On pointerdown rather than click, because a press that starts on the
  // backdrop and ends on a row underneath should close the menu and not also
  // take the room the finger happened to land on.
  pop.addEventListener('pointerdown', (e) => {
    if (e.target !== pop) return;
    // preventDefault on pointerdown is what stops the compatibility mouse
    // events. Without it a TOUCH press on the backdrop closes the menu at
    // touchstart, and the click synthesised at touchend is hit-tested against a
    // tree the panel has already left -- so pressing the dim area over a row on
    // the way screen would close the menu and take that room.
    e.preventDefault();
    show(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || pop.hidden) return;
    e.preventDefault();
    show(false);
  });

  const act = (id, go) => {
    $(id).onclick = () => {
      show(false);
      go();
    };
  };
  // Back first, because it is the one Enes named and the one both screens lack.
  // history.back() rather than a screen: from the card it is the question, from
  // the way it is the card that was taken, and both are the entry underneath.
  act('m-back', () => history.back());
  act('m-list', () => openList());
  act('m-pick', () => openPick());
  act('m-recheck', () => refresh());
  act('m-about', () => openAbout());
}

function attachSheet() {
  const sheet = $('sheet');
  const handle = $('handle');
  const panes = PANES.map($);
  const pane = () => panes.find((el) => !el.hidden) ?? panes[0];
  let drag = null;
  let swallow = false;

  // A pane scrolled to its top has no downward scroll left, so the browser must
  // not claim the gesture. touch-action has to say that before the finger
  // lands, which means it tracks scrollTop rather than sitting in the sheet.
  const syncTouch = () => {
    for (const el of panes) el.style.touchAction = el.scrollTop > 0 ? 'pan-y' : 'none';
  };
  for (const el of panes) el.addEventListener('scroll', syncTouch, { passive: true });
  syncPaneTouch = syncTouch;
  syncTouch();

  const begin = (e, mode) => {
    swallow = false;
    // Set on pointerDOWN, not on the first 8px of travel. The rule the flag
    // exists for is about the row somebody is reaching for, and they are
    // reaching for it before they have moved.
    state.dragging = true;
    drag = {
      id: e.pointerId,
      y0: e.clientY,
      h0: sheetH || sheet.getBoundingClientRect().height,
      lastY: e.clientY,
      lastT: e.timeStamp,
      v: 0,
      // Latched the first time the pointer is 8px from where it started, and
      // never cleared. lastY cannot answer this: it is the LAST sample, because
      // the velocity above needs it to be, so it measures net displacement.
      // An out-and-back returns it to y0 and the gesture reads as a press.
      travelled: false,
      mode,
      // Fixed at the start: a pending drag becomes a sheet drag on the first
      // 8px and must not pick up the grip's reach on the way.
      from: mode === 'sheet' ? 'grip' : 'pane',
      dismiss: false,
      pane: pane(),
    };
  };

  const capture = (el, id) => {
    try {
      el.setPointerCapture(id);
    } catch {
      /* the pane may already own the capture; the move events still arrive */
    }
  };

  handle.addEventListener('pointerdown', (e) => {
    begin(e, 'sheet');
    capture(handle, e.pointerId);
    e.preventDefault();
  });

  sheet.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#handle')) return;
    // The search field is a control, not a surface to drag from.
    if (e.target.closest('#find')) return;
    // Nor is the card. It owns the horizontal gesture, and a diagonal drag begun
    // on it would otherwise turn into a sheet drag on its eighth pixel and throw
    // the answer away mid-swipe.
    if (e.target.closest('.c-card')) return;
    begin(e, 'pending');
  });

  sheet.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if (drag.mode === 'pending') {
      if (Math.abs(dy) < 8) return;
      // Already scrolled: the pane keeps the gesture, momentum and all.
      if (drag.pane.scrollTop > 0) {
        drag = null;
        // Handed to the browser, so no pointerup of ours ends it. Left true
        // here the flag would hold the list frozen until the next tap.
        state.dragging = false;
        return;
      }
      // At full height a pull upward is the list, not the sheet. touch-action
      // is none at the top, so that one scroll is driven by hand; the next is
      // native again because scrollTop is no longer zero.
      drag.mode = dy < 0 && drag.h0 >= capNow() - 2 ? 'scroll' : 'sheet';
      capture(sheet, e.pointerId);
    }
    if (Math.abs(dy) >= 8) drag.travelled = true;
    const dt = e.timeStamp - drag.lastT;
    if (dt > 0) drag.v = (e.clientY - drag.lastY) / dt;
    drag.lastY = e.clientY;
    drag.lastT = e.timeStamp;
    // A finger that dragged is not a finger that tapped a row.
    swallow = true;
    if (drag.mode === 'scroll') drag.pane.scrollTop = Math.max(0, -dy);
    else {
      const pulled = sheetAfterDrag(drag.h0, dy, drag.from, lowNow(), capNow());
      drag.dismiss = pulled.dismiss;
      setSheet(pulled.h, false);
    }
    e.preventDefault();
  });

  const end = (e) => {
    // A pointer that ends with no drag on it still ends a finger's contact with
    // the sheet, which is what the flag tracks. A second pointer's up while the
    // first is still down is left alone.
    if (!drag) {
      state.dragging = false;
      return;
    }
    if (e.pointerId !== drag.id) return;
    const mode = drag.mode;
    const v = drag.v;
    const dismiss = drag.dismiss;
    // The same 8px the pending drag uses, so a mouse that shivered under a
    // finger-free click still counts as a click.
    //
    // Read off the latch, not off lastY. lastY is the last sample rather than
    // the furthest one, so `lastY - y0` is net displacement: measured in
    // Chromium at 390x844, a press on the grip taken 60px down and 60px back
    // read as a click and snapped the sheet 321 -> 658, and the same out-and-back
    // begun on a row collapsed it 780 -> 321. Both were no-ops before this
    // screen learned to toggle. An earlier comment here claimed a pane gesture
    // could not reach this line without having moved; it clears 8px once to
    // become a sheet drag and nothing holds it cleared.
    const moved = drag.travelled;
    // A toggle is a release affordance. pointercancel is the platform taking
    // the gesture away, which is not the user letting go of it.
    const released = e.type === 'pointerup';
    drag = null;
    state.dragging = false;
    syncTouch();
    if (mode !== 'sheet') return;
    // The two snap points. While the map is covered they are the same number, so
    // the sheet has no travel and the only thing left for a gesture to do is
    // dismiss -- opening would open onto an empty canvas. Everywhere else they
    // are peek and full, unchanged.
    const peek = lowNow();
    const full = capNow();
    // The grip, pulled through the whole travel below peek. A drag that started
    // on a pane bottoms out AT peek, so it never gets here.
    if (dismiss) {
      setSheet(peek, true);
      toAsk();
      return;
    }
    // A press on the grip that went nowhere. Dragging is a thumb gesture and it
    // was the only way out of peek, so a mouse had to learn to drag before it
    // could see the fifth row. Opening is the useful direction, so a click
    // opens from anywhere below full and only closes once it is there.
    if (!moved && released) {
      setSheet(sheetH >= full - 2 ? peek : full, true);
      return;
    }
    // Velocity wins over position, which is what makes a short flick work.
    let target;
    if (v > 0.5) target = peek;
    else if (v < -0.5) target = full;
    else target = sheetH - peek < full - sheetH ? peek : full;
    setSheet(target, true);
  };

  sheet.addEventListener('pointerup', end);
  sheet.addEventListener('pointercancel', end);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);

  // The finger flag, released from the window as well. A touch pointer is
  // implicitly captured by the element it went down on, so its up always comes
  // back to the two handlers above; a mouse released off the sheet does not, and
  // a flag left true would hold the ranking frozen for the rest of the session.
  // The drag itself is left alone here: it is the same mouse-only gap it always
  // had, and taking a gesture apart from the window is how a real drag ends up
  // cancelled by the wrong pointer.
  const release = () => {
    state.dragging = false;
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);

  // Pointer capture redirects pointer events but not the click a mouse still
  // synthesises, so without this a drag begun on a row would open that room.
  sheet.addEventListener(
    'click',
    (e) => {
      if (!swallow) return;
      swallow = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
}

// ---------------------------------------------------------------- answering

// The term the app is SERVING, not whichever table happens to be biggest.
// Picking the fullest one worked only because Autumn has 47 buildings against
// Summer's 46; during Summer term it would have ranked every room against
// Autumn's hours, and Sullivant would have read open until 19:30 when Summer
// publishes 17:00. That is the assumed-window failure the engine forbids.
function pickHoursTerm(hours, current) {
  const want = (current?.termName ?? '').toLowerCase().replace(/\s+/g, '-');
  const terms = Object.entries(hours?.terms ?? {});
  // `want` has to be checked before the prefix match, because every slug
  // startsWith(''). A current.json with no termName therefore took whichever
  // term the table happened to list first -- Summer, on the committed file --
  // and ranked an Autumn index against Summer doors, silently and with the
  // warning below skipped. No termName is no match.
  const exact = want ? terms.find(([slug]) => slug.startsWith(want)) : null;
  if (exact) return exact;
  // No table for the live term. Every building then reports unknown hours,
  // which is honest, rather than borrowing another term's doors.
  console.warn(`Vacant: no published hours for ${current?.termName}; all buildings will read unknown.`);
  return [null, null];
}

function hoursFor(code, day) {
  const rec = state.hoursTerm?.buildings?.[code];
  if (!rec) return undefined; // no published hours: shown, tiered below, never assumed
  return rec.hours[day]; // an [open, close] pair, or null for published-closed
}

const nowMinutes = (d) => d.getHours() * 60 + d.getMinutes();

// "rest of day" is not a constant. It is the minutes between now and the last
// minute the class schedule covers, read off the index, so a term whose
// evenings end at 20:15 does not get asked for a window running to 22:30.
function neededMinutes(now) {
  if (state.duration !== 'day') return Number(state.duration) || 30;
  const busyDay = busyDayOf(state.current, state.rooms);
  const left = busyDay ? busyDay.latestEnd - nowMinutes(now) : 0;
  return Math.max(30, left);
}

// Build one date from the immutable class index and the matching Room Matrix
// snapshot. On a Registrar no-class day, only class tuples are removed;
// registered non-class events remain busy.
function scheduleFor(date, classesSuspended = false) {
  return overlayForDate(state.classRooms, state.roomEvents, {
    date: typeof date === 'string' ? date : isoDate(date),
    classesSuspended,
  });
}

function answer() {
  // Whether the app may answer at all was settled before this ran, by
  // refusalFor() inside resolveState(). state.rankable is that verdict, and
  // deciding it again here is how one screen ends up offering 450 rooms while
  // the one behind it says nobody knows.
  if (!state.ready || !state.rankable) return;
  const now = clockNow();
  const minutes = nowMinutes(now);
  state.day = now.getDay();
  state.needed = neededMinutes(now);
  const allRooms = Object.entries(state.rooms.rooms).map(([id, r]) => ({ id, ...r }));
  const rooms = filterRoomsByPreferences(allRooms, state.preferences);
  state.preferencesDirty = false;
  state.preferenceStats = { matching: rooms.length, total: allRooms.length };
  const date = isoDate(now);
  const ask = {
    origin: state.origin,
    now: minutes,
    day: state.day,
    needed: state.needed,
    buildings: state.buildings,
    hoursFor,
    sessions: state.rooms.sessions,
    date,
    // Null off campus, and then every row falls back to the straight line
    // together. js/engine.js walkMetres is the only reader.
    field: state.walkField,
    // scheduleFor() already removed class tuples on a no-class day without
    // removing registered events, so the engine sweeps what remains.
    classesSuspended: false,
  };
  const results = rank(rooms, ask);

  const usable = results.filter((r) => r.wait <= MAX_WAIT_MIN);
  // rank() orders by tier, then walk. The FIRST building to open is not the
  // nearest one that opens: at 6am the nearest might open at 9:00 while one a
  // minute further opens at 7:00, and naming the wrong one is a wrong answer.
  // Off the unfiltered rows, not the shaped ones: after shape() this would say
  // "nothing is open" over the 180 rooms free further out at 2.18 km.
  state.soonest = results
    .filter((r) => r.wait > MAX_WAIT_MIN)
    .reduce((a, b) => (a && a.availableAt <= b.availableAt ? a : b), null);
  // The walk bound and the fold. rank() stays radius-free on purpose: the rows
  // shape() sets aside are the ones the footer and the empty screen name.
  state.bounds = shape(usable);
  state.total = usable.length;
  state.results = state.bounds.rows;
  // One count of the word free for both readers of it. paintList() prints the
  // strip off this and the live region below speaks off the same object, so the
  // two cannot answer "how many are free" differently again.
  state.tally = tally(state.results, usable);

  // Nothing walkable from here, and rooms out there that are. OFF_CAMPUS_KM
  // draws a circle around this question and gets it wrong on both sides: Wed
  // 2026-09-02 14:10, a 30 minute ask, an origin 2.190 km out got no rows and
  // no control that leads anywhere, and one 20 m further out fell back to the
  // Oval and got 40 tappable rows.
  const stranded = !state.results.length && state.bounds.beyond.count > 0;
  if (stranded && state.origin?.source === 'gps') {
    useOrigin(ovalOrigin(), NO_WALK_OVAL);
    return answer();
  }
  // A picked building stands: moving off it answers a question nobody asked.
  // The note is that screen's way out, because it carries #note-pick.
  if (state.origin?.source === 'picked') useOrigin(state.origin, stranded ? NO_WALK : null);

  // Which constraint had to be given up to answer at all. The ladder is a
  // second pass over the same rooms and the same minute, because rank() has no
  // ladder in it: it is the flat ranking the list has always been built from,
  // and shape() bounds that afterwards. So the disclosure costs one more sweep.
  // MEASURED under node on the committed index, 425 rooms, median of 200 warm
  // runs from the Oval at 2026-09-16 14:10 on a 60 minute ask: rank() 1.02 ms
  // and query() 1.01 ms, so an answer goes from about one millisecond to two.
  //
  // It runs AFTER the stranded fallback above, which re-enters answer() from
  // the Oval; running it earlier would sweep twice and throw the first away.
  //
  // No calendar goes in, and that is the same decision as `classesSuspended:
  // false` in `ask` above. scheduleFor() has ALREADY emptied the class tuples
  // on a no-classes day, and what it left behind is the week's registered
  // events. query() would turn a calendar into sweep's classesSuspended, which
  // replaces the gap list with the whole open window and so ignores those
  // events -- the ladder would call a room with a registered event in it free
  // all day while the rows beside it, from rank(), knew better. Both sweeps
  // read the one overlaid grid.
  // Nothing is selected until a finger picks one. Asserting row one here is
  // what made the highlight fire on load and never move again.
  state.selected = null;
  state.listScroll = 0;
  // A re-rank makes "the third one" a different room, so the deck goes back to
  // the top with it. Both screens are painted below; which one is on top is not
  // this function's business.
  state.cardIndex = 0;
  // The sheet and the map follow the selection, and this is the second place it
  // is dropped. showList() has the first and re-rests on its own; a re-rank does
  // not go through it. Measured with a row lit at 393x852, both ways in: Check
  // again in the list footer, and coming back to the tab. The row went dark and
  // the sheet stayed at 324 over a canvas with nothing left on it, which is the
  // band this screen stopped leaving.
  if (state.screen !== 'ask') sheetHeight();
  // paintList() runs before the new ladder result is ready. Clear the previous
  // answer first, otherwise broadening the room requirements can leave its old
  // fallback warning above a new exact answer.
  state.rung = null;
  state.relaxed = false;
  // Rows first, then the sweep that only the strip needs.
  //
  // The ladder is a SECOND full sweep of the index. Warm it is about a
  // millisecond beside rank()'s one, which is nothing; cold, unwarmed, on this
  // machine it is 10.5 ms against rank()'s 14.6, and a mid-range phone runs
  // that 5 to 10 times slower. In front of paintList() that is 50 to 100 ms
  // added between the tap and the first row, on the one path spike #29 exists
  // to measure. Behind it, it costs the first row nothing.
  //
  // Safe because state.rung and state.relaxed have exactly one reader between
  // them, relaxedLine(), and paintList() is the only caller of that. The strip
  // is repainted on the line after, off the same state paintList() just used.
  paintList();
  paintCard();
  const answered = ladder(rooms, ask);
  state.rung = answered.rung;
  state.relaxed = answered.relaxed;
  if (answered.relaxed) paintList();
  settle();
  // Free counts everything inside the 90 minute wait, not the shown rows, so
  // this line can honestly read "297 rooms free, 0 shown" over a heading saying
  // nothing was close enough. It used to count its own way as well, testing
  // wait alone where the strip tested published hours too; tally() is now the
  // only place either of them gets the word from.
  const free = state.tally.free;
  // What the strip admits in print, the live region says out loud, and it leads
  // for the same reason: it is about the whole answer, and the counts behind it
  // are about the rows. A disclosure only sighted readers get is not one.
  //
  // Only when there are rows, because that is the only screen the strip is on.
  // The empty screen already names the same fact in its own words, and a live
  // region reading out a sentence that is nowhere on the page is worse than one
  // that says nothing.
  const admitted = state.results.length ? relaxedLine()?.say : null;
  say(
    [
      admitted,
      state.results.length
        ? `${free} room${free === 1 ? '' : 's'} free, ${state.results.length} shown.`
        : `${$('list-h')?.textContent ?? ''} ${$('list').querySelector('.empty')?.textContent.replace(/\s+/g, ' ').trim() ?? ''}`.trim(),
      // Last, and not first like the rung line above it. The rung is about the
      // answer and changes what the rows mean; the missing map changes nothing
      // about them. It is here at all because the same rule that puts the rung
      // here applies: a strip only sighted readers get is not a disclosure. It
      // rides the one live region rather than getting a second one, which
      // docs/a11y-contract.md forbids.
      state.mapless ? MAPLESS : null,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

// A name over 24 characters with a dash in it is the Registrar's
// "department - building" form, and the half after the dash is the half
// written on the door.
function shortName(name) {
  const s = String(name ?? '');
  const cut = s.indexOf(' - ');
  return s.length > 24 && cut > 0 ? s.slice(cut + 3) : s;
}

function roomLabel(r) {
  const n = state.rooms?.rooms?.[r.id]?.n;
  const name = shortName(r.name);
  if (!name) return r.id;
  return n ? `${name} ${n}` : name;
}

// When the building locks today, or null when nobody publishes it.
function closeOf(code) {
  const h = hoursFor(code, state.day);
  return Array.isArray(h) ? h[1] : null;
}

function windowOf(r) {
  const p = windowPhrase(r, closeOf(r.building));
  const warn = p.tier === 'wait' || p.tier === 'unknown';
  return { html: warn ? `<span class="warn">${p.text}</span>` : p.text, say: p.say };
}

function seatsOf(r) {
  return r.seats
    ? { html: `${r.seats} seats`, say: `${r.seats} seats` }
    : { html: 'seats unknown', say: 'seat count not published' };
}

// The one word docs/BACKLOG.md's parked decision asked for, and the reason the
// row is where it is: the room is not on the Registrar's general-assignment
// list, so a department holds the key. 98 of the 425 shipped rooms, and the
// ranking now puts every one of them below a general-assignment room. Written
// out for a screen reader, because "departmental" alone next to a seat count is
// a word with no sentence around it.
//
// A room the index says nothing about is not labelled: `ga` is absent from
// every room of an index built before the general-assignment pull, and a label
// on all 425 rows would say nothing at all.
//
// Plain text in the window line, not a `<b>`. `.r-win b` is `--fg` at weight
// 650 on a line that is otherwise `--dim`, and it exists for the free-window --
// the promise the row is making. windowOf and seatsOf emit plain text, so a
// bolded caveat would have been the ONLY emphasised token on the row: the
// reason the room ranks low, shouting over the reason it is on screen at all. A
// word among numbers, after the same middot the seat count uses, is already
// distinct enough. No class either: the one it carried was never styled
// anywhere in index.html, and a hook nothing reaches for is a hook that
// misleads the next person who greps for it.
function deptOf(r) {
  return r.ga === false
    ? { html: ' &middot; departmental', say: ', departmental, not a general-assignment room' }
    : { html: '', say: '' };
}

const WALK_ICON = '<svg class="ico" aria-hidden="true"><use href="#i-walk"/></svg>';
const CHEV = '<svg class="ico" aria-hidden="true"><use href="#i-chev"/></svg>';

const FOOT_ACTS = `<p class="foot-acts">
  <button type="button" class="bar-btn" data-act="recheck">Check again</button>
  <button type="button" class="bar-btn" data-act="about">What Vacant knows</button>
</p>`;

// One sentence, said once, at the bottom where a reader lands after the rows.
// A per-row version of this was tried and rejected: a warning repeated on 98
// rows stops being read by row four.
function coverageCaveat(coverage) {
  return coverage === 'complete-room-sweep'
    ? 'Registered non-class events from the Room Matrix are included for this week. ROOM BLOCK holds, unscheduled use, and locked doors are not.'
    : 'Class schedule only for this date. Non-class event coverage is unavailable, doors get locked, and unscheduled use does not appear here.';
}

const caveatHtml = (coverage) => `<p class="foot">${esc(coverageCaveat(coverage))}</p>`;

// The list's statement of the question it answers. The duration chips used to
// be the only thing on this screen that said what was asked for, and they went
// with #85, so the words have to be somewhere: a list of room names alone does
// not say whether it is a list of rooms free for half an hour or for the rest
// of the day.
//
// Two decisions in one line, both about not lying:
//
// It says what was ASKED, not what is offered. "Free for 2h00" over these rows
// would be a promise the list does not keep: strip is empty as soon as ONE row
// meets the ask, and the rows below it can be shorter. "You asked for" is true
// in every one of the four states below, including the one whose strip says
// nothing near you is free for that long.
//
// It spends dur(state.needed), which is the same function and the same number
// the strip and the empty screen already print two lines away. The chips said
// "2h" and needed is minutes, so a second vocabulary for one figure on one
// screen is how two lines end up disagreeing about the same ask.
//
// "rest of day" is the exception, and it has to be, because needed is not the
// ask there. neededMinutes() returns Math.max(30, latestEnd - now), so inside
// the last half hour of the index's day the clamp wins and dur() renders the
// floor rather than what was pressed. Measured on the shipped index: Mon
// 21:26-21:54, Tue 21:16-21:44, Wed 21:21-21:49, Thu 21:16-21:44, Fri
// 20:06-20:34, Sat 15:31-15:59 all render "30 min" for a button that does not
// say 30 min, and are indistinguishable from the button that does. Naming the
// button instead is true at every minute of the day, including 08:00, where
// dur() would have printed the 12h15 the app derived rather than the thing the
// user actually chose.
//
// The empty screen above does not get this line. It is not a silent list: it
// opens with an h2 that states the answer in words, and its last branch already
// prints dur(state.needed) in a sentence of its own.
const asked = () => {
  const needs = describeRoomPreferences(state.preferences);
  const withNeeds = needs.length ? ` with <b>${esc(needs.join(', '))}</b>` : '';
  return `<p class="asked">You asked for <b>${state.duration === 'day' ? 'the rest of the day' : dur(state.needed)}</b>${withNeeds}.</p>`;
};

// The sentence the ladder's verdict is worth, or null when the answer gave
// nothing up. The strip and the live region both read it from here, so the two
// cannot end up saying different things about the same list.
const relaxedLine = () =>
  (state.relaxed
    ? rungPhrase(state.rung, {
      needed: state.needed,
      maxWalk: MAX_WALK,
      restOfDay: state.duration === 'day',
    })
    : null);

// #53's words, in one place because the live region says them too and a
// sentence written twice ends up written two ways.
const MAPLESS = 'No campus map on this phone yet.';

// What the list has to admit before the rows start, in the order it admits it:
// why campus is quiet first, because that is about the answer, then the missing
// map, which is only about the picture.
//
// The map line is a `.strip` and not a component of its own, because it is the
// same kind of sentence as the situation note and this list already has a place
// for those. A banner would have to earn its own contrast, its own reflow rule
// and its own slot in the reading order, for one sentence that appears when a
// fetch fails.
const notes = () =>
  [
    state.situation?.note ? esc(state.situation.note) : '',
    state.mapless ? MAPLESS : '',
  ]
    .filter(Boolean)
    .map((text) => `<p class="strip">${text}</p>`)
    .join('');

function paintList() {
  const list = $('list');
  const note = notes();

  if (!state.results.length) {
    const filtered = hasRoomPreferences(state.preferences);
    if (filtered && state.preferenceStats.matching === 0) {
      list.innerHTML =
        note +
        asked() +
        '<h2 class="msg" id="list-h" tabindex="-1">No rooms match those needs.</h2>' +
        `<p class="empty">No room in the current index satisfies every selected requirement.
          Missing room details do not count as a match.</p>
         <p class="foot-acts"><button type="button" class="bar-btn" data-act="clear-needs">Clear room needs</button></p>` +
        FOOT_ACTS;
      wireFootActs(list);
      focusHeading($('list-h'));
      syncPaneTouch();
      return;
    }
    // Rooms are free, they are just too far to walk to, which is a different
    // answer from "nothing is open" and one a shorter ask cannot fix. This is
    // the one screen that spends the word free on a count, so free here is
    // wait === 0 and the rooms that open later get their own sentence: at
    // 2026-09-15 09:00 from 40.0175, -83.013 it called Schoenbaum Hall the
    // nearest free room 115 minutes before the room opened.
    const empty = emptyAnswer();
    list.innerHTML =
      note +
      (filtered ? asked() : '') +
      `<h2 class="msg" id="list-h" tabindex="-1">${empty.heading}</h2>` +
      `<p class="empty">${empty.body}</p>` +
      FOOT_ACTS;
    wireFootActs(list);
    focusHeading($('list-h'));
    syncPaneTouch();
    return;
  }

  // Four states, because "open and long enough", "open but shorter than you
  // asked", "we do not know" and "nothing" are different answers, and only the
  // first one is a promise. The first is 94.1% of measured hours and prints
  // nothing at all, so the strip is absent unless the answer is degraded.
  let strip = '';
  let caveat = '';
  const { meets, shorter, waiting } = state.tally;

  if (meets) {
    strip = '';
  } else if (shorter) {
    strip = `<p class="strip">Nothing near you is free for ${dur(state.needed)}. Closest anyway:</p>`;
  } else if (waiting) {
    strip = `<p class="strip">Nothing is free this second.</p>`;
  } else {
    // Every building whose hours we actually have is closed. What is left is
    // rooms nobody publishes hours for, and saying "free" about those would be
    // the exact dishonesty this app exists to avoid.
    strip = '<p class="strip">Every building we have hours for is closed.</p>';
    caveat = `<p class="empty">These have <b>no published hours</b>, so Vacant cannot tell
       you whether the door is open. They are not a promise.</p>`;
  }

  // The rung wins the strip. Both are true at once often enough to matter:
  // MEASURED over 12,870 answers replayed from 99 origins around the Oval, Mon
  // to Fri 2026-09-14 to 18, the ladder had relaxed and the rows still asked
  // for a strip of their own on 131 of the 510 lists that had rows, 25.7%.
  // Printing both would stack a second paragraph over the list on every one of
  // them. The counts above describe the ROWS; the rung describes which question
  // the whole list is answering, so it replaces them rather than joining them.
  //
  // The caveat below is deliberately not touched. It is not a strip, and a list
  // of rooms nobody publishes hours for has to keep saying so whichever rung
  // found them.
  const relaxed = relaxedLine();
  if (relaxed) strip = `<p class="strip">${esc(relaxed.text)}</p>`;

  const coarse = Number.isFinite(state.accuracy) && state.accuracy > COARSE_M;
  // "N more further away" was wrong about most of them: 69.5% of the 40 the old
  // slice showed repeated a building already on screen, over 525 samples from
  // the Oval, every half hour 08:00 to 20:00 on the 22 September 2026 weekdays
  // at a 30 minute ask. Neither count below says free, so both count the rooms
  // that open later too.
  const rest = state.bounds?.cap.rest ?? 0;
  const past = state.bounds ? state.bounds.beyond.count + state.bounds.beyond.waiting.count : 0;
  const inside = rest ? `<b>${rest} more</b> within a ${MAX_WALK} minute walk` : '';
  const outside = past
    ? `<b>${past} more</b> ${rest ? 'past it' : `past a ${MAX_WALK} minute walk`}`
    : '';
  const foot = inside || outside
    ? `<p class="foot">${[inside, outside].filter(Boolean).join(', and ')}.</p>`
    : '';

  list.innerHTML =
    note +
    asked() +
    strip +
    caveat +
    state.results
      .map((r, i) => {
        const label = roomLabel(r);
        const win = windowOf(r);
        const seats = seatsOf(r);
        const dept = deptOf(r);
        const walkSay = coarse ? `about ${r.walk} minutes walk` : `${r.walk} minute walk`;
        // The visible row is glyphs and an icon. The name a screen reader gets
        // is written out, because the computed name would be "Page Hall 110B 4
        // min": no unit, no window, no caveat.
        const name = `${label}, ${walkSay}, ${win.say}, ${seats.say}${dept.say}. ${coverageCaveat(state.eventCoverage)}`;
        return `<button type="button" class="row" data-i="${i}" aria-label="${esc(name)}">
        <span class="r-name">${esc(label)}</span>
        <span class="r-walk">${WALK_ICON}${coarse ? '~' : ''}${r.walk} min</span>
        <span class="r-win">${win.html} &middot; ${seats.html}${dept.html}</span>
        <span class="r-chev"></span>
      </button>`;
      })
      .join('') +
    foot +
    caveatHtml(state.eventCoverage) +
    FOOT_ACTS;

  for (const el of list.querySelectorAll('.row')) {
    el.onclick = () => select(Number(el.dataset.i));
  }
  wireFootActs(list);
  markRows();
  syncPaneTouch();
}

// One empty answer for the list and the card. Repeating these branches made the
// list tell the truth while a late-weekend card called zero rows an exhausted
// deck and offered to show all zero of them.
function emptyAnswer() {
  const next = state.soonest;
  const far = state.bounds?.beyond;
  const later = far?.waiting;
  if (far?.count) {
    return {
      heading: 'Nothing close enough.',
      body: `Nothing within a ${MAX_WALK} minute walk is free.
        <b>${far.count} room${far.count === 1 ? '' : 's'}</b> ${far.count === 1 ? 'is' : 'are'} free further out, the nearest a
        <b>${far.nearest.walk} minute walk</b> to ${esc(shortName(far.nearest.name))}.`,
    };
  }
  if (later?.count) {
    return {
      heading: 'Nothing close enough.',
      body: `Nothing within a ${MAX_WALK} minute walk is free.
        <b>${later.count} room${later.count === 1 ? '' : 's'}</b> further out open${later.count === 1 ? 's' : ''} later, the nearest a
        <b>${later.nearest.walk} minute walk</b> to ${esc(shortName(later.nearest.name))}, from <b>${clock(later.nearest.availableAt)}</b>.`,
    };
  }
  if (next) {
    return {
      heading: 'Nothing open right now.',
      body: `Every classroom building near you is closed.
        The first one open is <b>${esc(next.name ?? next.id)}</b> at <b>${clock(next.availableAt)}</b>.`,
    };
  }
  return {
    heading: 'Nothing open right now.',
    body: `No room is free for ${dur(state.needed)} today. Try a shorter time.`,
  };
}

function wireFootActs(root) {
  for (const el of root.querySelectorAll('[data-act]')) {
    el.onclick = () => {
      if (el.dataset.act === 'clear-needs') clearNeeds();
      else if (el.dataset.act === 'about') openAbout();
      else refresh();
    };
  }
}

function markRows() {
  for (const el of $('list').querySelectorAll('.row')) {
    const on = state.results[Number(el.dataset.i)] === state.selected;
    el.classList.toggle('on', on);
    // A class alone is invisible to a screen reader, and the selected row is
    // the row driving the map.
    if (on) el.setAttribute('aria-current', 'true');
    else el.removeAttribute('aria-current');
    el.querySelector('.r-chev').innerHTML = on ? CHEV : '';
  }
}

// Tap an unselected row to light its building and reframe. Tap the selected
// row again to open the room. Both asks land on one gesture that way, and the
// chevron on the selected row is the promise that the second tap goes deeper.
function select(i) {
  const r = state.results[i];
  if (!r) return;
  if (state.selected === r) {
    openRoom(r.id);
    return;
  }
  state.selected = r;
  markRows();
  setSheet(restNow(), true);
  frame(r);
  // On the way screen the plate is the headline over the map, so it has to name
  // whatever the arrow points at. Tapping a row there is a change of
  // destination, not a preview of one. paintWay() announces the room itself,
  // and a live region only ever speaks its last value, so saying it twice in one
  // task means the first sentence is never heard.
  if (state.screen === 'way') paintWay(r.id, r);
  else say(`${roomLabel(r)}, ${r.walk} minute walk, shown on the map.`);
}

// ------------------------------------------------------------------ the card

// How far the card has to be thrown before letting go means something, and how
// fast a flick counts whatever distance it covered. Both in the units the
// gesture arrives in, so nothing here has to know the screen size.
const SWIPE_PX = 84;
const SWIPE_V = 0.45;

// The warp, in two numbers that are both about what a READER sees.
//
// A photograph in this screen is a 3-ish times aspect gap and something has to
// give. Cover gives the width away: 31% of it, and half of what is left is the
// carpet these are all shot across. This gives the CEILING away instead, which
// is flat and sits under the plate.
//
// WARP_WIDTH is how much of the source width the card keeps, centred.
// WARP_BOTTOM is how much taller than natural the BOTTOM of the picture may be
// drawn -- the part of the room you are actually looking at.
//
// The exponent is NOT a constant, because these are not all the same shape: 219
// of the 306 are 3:2, and the rest run from 4:3 to 16:9. A fixed exponent
// leaves a 16:9 room visibly more stretched at the bottom than a 4:3 one, so it
// is derived per photograph from the two numbers above and the aspect it
// actually has.
//
// 0.55 and 1.10 are Enes's, off dev/warp.html, picked over Orton Hall 110. They
// are a tighter crop and a straighter bottom than the first guess of 0.72 and
// 1.23: less of the room across, but what is there stands up rather than
// leaning, and the extra height all goes into ceiling nobody reads.
const WARP_WIDTH = 0.55;
const WARP_BOTTOM = 1.10;

// Horizontal bands the warp is drawn in. Each is a straight drawImage, so this
// is a piecewise approximation of the curve: at 240 the seams are under a
// device pixel at 393x852 and the whole draw is under 3ms.
const WARP_BANDS = 240;

// The exponent that puts the whole aspect gap into the TOP of the frame while
// leaving the bottom edge at WARP_BOTTOM times its natural height.
//
// The curve is source = sh * t ** p, so the local vertical scale at t is
// h / (sh * p * t ** (p - 1)), which at the bottom edge is h / (sh * p). Divide
// that by the horizontal scale w / sw and the ratio is h * sw / (sh * p * w),
// so p falls out of setting the ratio to WARP_BOTTOM. Floored at 1, which is a
// straight stretch: a picture already tall enough for the screen needs no warp
// and must not get a backwards one.
function warpPower(w, h, sw, sh) {
  return Math.max(1, (h * sw) / (sh * WARP_BOTTOM * w));
}

// Draw `img` into `canvas`, stretched so the room fills the screen.
//
// Every band takes a slice of the source and paints it into a taller slice of
// the destination, and the curve decides how much taller. Bands are drawn one
// pixel past their own bottom edge, because a fractional destination height
// otherwise leaves a hairline of background between them.
function drawWarp(canvas, img) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h || !img.naturalWidth) return false;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const sw = img.naturalWidth * WARP_WIDTH;
  const sx = (img.naturalWidth - sw) / 2;
  const sh = img.naturalHeight;
  const at = (t) => sh * t ** warpPower(w, h, sw, sh);

  for (let i = 0; i < WARP_BANDS; i++) {
    const t0 = i / WARP_BANDS;
    const t1 = (i + 1) / WARP_BANDS;
    const sy = at(t0);
    const sy1 = at(t1);
    // A band whose source slice rounds to nothing still has to paint, or the
    // stretched top of the frame comes out as gaps.
    ctx.drawImage(img, sx, sy, sw, Math.max(sy1 - sy, 0.5), 0, h * t0, w, h * (t1 - t0) + 1);
  }
  return true;
}

// The plate is one line of three facts on a photograph, so the window gets its
// short form there. "no class rest of today" is the list's wording, where a row
// has the width for it and the rest of the day is the thing being promised; on
// the card the words either side of it are two and three characters long and it
// swamped them. The list keeps the long one -- this is the card's copy, not a
// change to what the app believes.
function shortWindow(win) {
  return win.html.replace('no class rest of today', 'no class');
}

// The building and the room, apart. roomLabel() joins them for the list,
// where a row is one line; this screen exists because the room number is the
// thing you walk to, and it is the only text on it that gets to be 3.6rem.
function cardParts(r) {
  const name = shortName(r.name);
  const n = state.rooms?.rooms?.[r.id]?.n;
  return { building: n ? name : '', room: n || name || r.id };
}

// One room. The count and walk cap stay on the list. A missing event snapshot
// does need a short warning here because the card is a standalone answer.
//
// The strip does NOT stay on the list. It is the only thing that says the
// answer is degraded -- shorter than asked, nothing free this second, hours
// nobody publishes -- and a card that omits it is a card claiming more than the
// ranking does.
function paintCard() {
  const card = $('card');
  const r = state.results[state.cardIndex];

  if (!r) {
    const seen = state.results.length;
    if (seen === 0 && hasRoomPreferences(state.preferences)) {
      const noMatchingRoom = state.preferenceStats.matching === 0;
      card.innerHTML = `
        <h2 class="msg" id="card-h" tabindex="-1">${noMatchingRoom
          ? 'No rooms match those needs.' : 'No matching room is available nearby.'}</h2>
        <p class="c-end">${noMatchingRoom
          ? 'No room in the current index satisfies every selected requirement. Missing room details do not count as a match.'
          : 'Some rooms meet those needs, but none can be shown at this time and place.'}</p>
        <button type="button" class="c-more" id="c-clear-needs">Clear room needs</button>
        ${noMatchingRoom ? '' : '<button type="button" class="c-more" id="c-list">See the details</button>'}`;
      card.classList.add('done');
      $('c-clear-needs').onclick = clearNeeds;
      if (!noMatchingRoom) $('c-list').onclick = () => openList();
      focusHeading($('card-h'));
      syncPaneTouch();
      return;
    }
    if (seen === 0) {
      const empty = emptyAnswer();
      card.innerHTML = `
        <h2 class="msg" id="card-h" tabindex="-1">${empty.heading}</h2>
        <p class="c-end">${empty.body}</p>
        <button type="button" class="c-more" id="c-list">See the details</button>`;
      card.classList.add('done');
      $('c-list').onclick = () => openList();
      focusHeading($('card-h'));
      syncPaneTouch();
      return;
    }
    card.innerHTML = `
      <h2 class="msg" id="card-h" tabindex="-1">That is all of them.</h2>
      <p class="c-end">You went through ${seen} room${seen === 1 ? '' : 's'} within a
        ${MAX_WALK} minute walk.</p>
      <p class="c-acts">
        <button type="button" class="c-act" id="c-again" aria-label="Start again at the first room">
          <svg class="ico" aria-hidden="true"><use href="#i-back"/></svg>
        </button>
      </p>
      <button type="button" class="c-more" id="c-list">See all ${seen} in a list</button>`;
    $('card').classList.add('done');
    $('c-again').onclick = () => {
      state.cardIndex = 0;
      paintCard();
      say(`Back to the first of ${seen}.`);
    };
    $('c-list').onclick = () => openList();
    focusHeading($('card-h'));
    syncPaneTouch();
    return;
  }

  const { building, room } = cardParts(r);
  const photo = photoFor(r.id);
  const win = windowOf(r);
  const short = shortWindow(win);
  const seats = seatsOf(r);
  const dept = deptOf(r);
  const coarse = Number.isFinite(state.accuracy) && state.accuracy > COARSE_M;
  const walkSay = coarse ? `about ${r.walk} minutes walk` : `${r.walk} minute walk`;
  const total = state.results.length;
  const relaxed = relaxedLine();
  const strip = relaxed
    ? `<p class="strip">${esc(relaxed.text)}</p>`
    : state.tally?.meets
      ? ''
      : state.tally?.shorter
        ? `<p class="strip">Nothing near you is free for ${dur(state.needed)}. Closest anyway:</p>`
        : state.tally?.waiting
          ? '<p class="strip">Nothing is free this second.</p>'
          : '<p class="strip">Every building we have hours for is closed.</p>';

  // The card's own name is written out. The computed one would read "3 of 35
  // Cunz Hall 160 4 min 42 seats", with no units and nothing saying what the two
  // buttons under it do -- and it carries the two things the screen deliberately
  // does not print: where you are in the ranking, and the gesture that goes back.
  // Neither is on the picture. Enes: "dont have text that says swipe down, it
  // should be something ppl learn." But a gesture nothing announces is not
  // learnable at all by somebody who cannot see the card move, so it is said
  // here, where only a screen reader reads it.
  const coverageNote = state.eventCoverage === 'complete-room-sweep'
    ? ''
    : 'Class schedule only today; registered events not checked.';
  const matchedNeeds = describeRoomPreferences(state.preferences);
  const needsNote = matchedNeeds.length ? `Matches: ${matchedNeeds.join(', ')}` : '';
  const said = `${roomLabel(r)}, ${walkSay}, ${win.say}, ${seats.say}${dept.say}.` +
    (needsNote ? ` ${needsNote}.` : '') +
    (coverageNote ? ` ${coverageNote}` : '') +
    ` Room ${state.cardIndex + 1} of ${total}. Swipe down to start over.`;

  // The photograph is the SCREEN. One plate near the top carries everything the
  // card says, so the text has a single contrast problem to solve rather than
  // one per line; the two verdicts sit on the bottom corners where a thumb
  // already is; and the one line between them is both how deep into the ranking
  // you are and the way to the whole of it.
  //
  // Nothing else. The count, the hint and the list link used to be three
  // stacked lines UNDER the picture, and that band of dark under a small
  // photograph is the thing this layout exists to delete.
  //
  // notes() and the strip ride on the plate rather than above it, because the
  // deck is the whole viewport now and anything in the flow before it would be
  // painted over by the room. They are still not optional: the strip is the
  // only thing that says the answer is degraded.
  const admits = notes()
    + (needsNote ? `<p class="strip">${esc(needsNote)}</p>` : '')
    + (coverageNote ? `<p class="strip">${coverageNote}</p>` : '') + strip;
  card.innerHTML =
    `<div class="c-deck">
      <article class="c-card${photo ? '' : ' plain'}" id="c-top" tabindex="0"
        role="group" aria-label="${esc(said)}">
        ${photo ? `<canvas class="c-photo" id="c-img" aria-hidden="true"></canvas>` : ''}
        <span class="c-scrim" aria-hidden="true"></span>
        <span class="c-stamp no" aria-hidden="true">NEXT</span>
        <span class="c-stamp yes" aria-hidden="true">GO</span>
        <div class="c-plate">
          <p class="c-b">${esc(building ? `${building} ${room}` : room)}</p>
          <p class="c-facts">
            <span>${short}</span>
            <span class="sep">&middot;</span>
            <span>${coarse ? '~' : ''}${r.walk} min</span>
            <span class="sep">&middot;</span>
            <span>${seats.html}</span>${dept.html ? `<span class="sep">&middot;</span><span>departmental</span>` : ''}
          </p>
          ${admits ? `<div class="c-admits">${admits}</div>` : ''}
        </div>
        <p class="c-acts">
          <button type="button" class="c-act no" id="c-no" aria-label="Not this one, show the next room">
            <svg class="ico" aria-hidden="true"><use href="#i-bin"/></svg>
          </button>
          <button type="button" class="c-act yes" id="c-yes" aria-label="Take this room and show me the way">
            <svg class="ico" aria-hidden="true"><use href="#i-tick"/></svg>
          </button>
        </p>
      </article>
    </div>
`;

  $('card').classList.remove('done');
  $('c-no').onclick = () => rejectCard();
  $('c-yes').onclick = () => acceptCard();
  // Faded in on decode rather than on load, so the room does not appear as a
  // flash under words already being read. A photograph that 404s or is corrupt
  // leaves the plain card behind it, which is the same card 119 rooms get.
  const canvas = $('c-img');
  if (canvas && photo) {
    // The decode happens off the DOM: the canvas is what is on screen, and an
    // <img> in the tree as well would download nothing extra but would be a
    // second thing to keep in step. Faded in on draw rather than on load, so
    // the room does not appear as a flash under words already being read.
    const source = new Image();
    source.decoding = 'async';
    source.onload = () => {
      // The pane may have been repainted under a slow decode -- a swipe, or a
      // background re-rank -- and drawing into a canvas nothing holds any more
      // is how a stale room ends up under the right name.
      if (!canvas.isConnected) return;
      if (!drawWarp(canvas, source)) return;
      canvas.classList.add('on');
      // The bitmap is sized to the canvas BOX once and then stretched to fill it
      // by CSS, so every later change of that box squashes the room instead of
      // reflowing it. The install rail is the change that always happens: it
      // mounts seconds after boot, the sheet gives up its height, and the
      // photograph loses 9% of its own at 393x852. Rotation is the same failure,
      // larger. Guarded on the size actually differing, because observe() fires
      // once on its own and the draw is 240 drawImage calls.
      let box = `${canvas.clientWidth}x${canvas.clientHeight}`;
      const again = new ResizeObserver(() => {
        if (!canvas.isConnected) return again.disconnect();
        const now = `${canvas.clientWidth}x${canvas.clientHeight}`;
        if (now === box) return;
        box = now;
        drawWarp(canvas, source);
      });
      again.observe(canvas);
    };
    source.onerror = () => {
      canvas.remove();
      $('c-top')?.classList.add('plain');
    };
    source.src = photo;
  }
  attachSwipe($('c-top'));
  syncPaneTouch();
}

// Where a room's photograph lives, or null. `state.photos` is null until
// data/photos.json arrives and empty-ish for the 118 rooms OSU has never
// photographed; both cases render the plain card, which is why this returns one
// value rather than two.
function photoFor(id) {
  return state.photos?.has(id) ? `${BASE}data/photos/${encodeURIComponent(id)}.webp` : null;
}

// The two verdicts. Reject walks the ranking; accept goes to the way, which is
// the map with the walk line on it and one plate. Not the room screen: that one
// opens the day as a calendar, and the day stopped being the question the moment
// the room was taken.
function rejectCard() {
  const r = state.results[state.cardIndex];
  // paintCard() replaces this whole screen, so whatever was focused stops
  // existing: a keyboard user who pressed the left arrow lands on the body with
  // nothing left to press it on. Guarded on focus already being in here,
  // because answer() repaints this screen too, from a background refresh, and
  // stealing focus off another screen is worse than losing it on this one.
  const held = $('card').contains(document.activeElement);
  state.cardIndex += 1;
  paintCard();
  if (held) $('c-top')?.focus({ preventScroll: true });
  const next = state.results[state.cardIndex];
  say(next
    ? `${roomLabel(r)} skipped. Next, ${roomLabel(next)}, ${next.walk} minute walk.`
    : 'That was the last one.');
}

function acceptCard() {
  const r = state.results[state.cardIndex];
  if (!r) return;
  openWay(r.id);
}

// Drag, throw, or press an arrow key. Distance OR velocity commits, because a
// short flick is the gesture people actually make and a distance-only rule
// makes them drag the card halfway across the screen every time.
//
// The card carries `touch-action: none`, so the browser never claims the
// gesture, and attachSheet() steps aside for it: a diagonal drag begun on the
// card would otherwise become a sheet drag on its eighth pixel and take the
// answer away.
function attachSwipe(el) {
  const stamps = { no: el.querySelector('.c-stamp.no'), yes: el.querySelector('.c-stamp.yes') };
  let drag = null;

  const paint = (dx, dy = 0) => {
    el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 22}deg)`;
    stamps.no.style.opacity = String(Math.min(1, Math.max(0, -dx / SWIPE_PX)));
    stamps.yes.style.opacity = String(Math.min(1, Math.max(0, dx / SWIPE_PX)));
  };
  const rest = () => {
    el.classList.add('snap');
    paint(0);
  };
  // Pointer capture normally keeps the release on the card even when the
  // pointer has crossed its edge. A laptop can still take that capture away --
  // switching windows is one example -- and the capture request itself is
  // allowed to fail. The last pointermove has already written an inline
  // transform by then, so a release nobody hears leaves half a card on screen.
  // These fallbacks exist only for the life of one drag, otherwise every card
  // paint would leave another window listener holding its old element.
  const clearFallbacks = () => {
    window.removeEventListener('pointerup', end, true);
    window.removeEventListener('pointercancel', end, true);
    window.removeEventListener('blur', abandon);
  };
  const abandon = (e) => {
    if (!drag || (e?.pointerId != null && e.pointerId !== drag.id)) return;
    drag = null;
    clearFallbacks();
    rest();
  };
  // The card leaves the screen in the direction it was thrown, and the verdict
  // fires when it is gone rather than on release, so the answer does not change
  // under a card still sliding over it. Under reduced motion there is no
  // transition to wait for, so the timer is what carries both cases.
  const commit = (dir) => {
    el.classList.add('snap');
    paint(dir * window.innerWidth);
    el.style.opacity = '0';
    setTimeout(() => {
      // The 200ms is the card sliding off. A back gesture inside it lands on the
      // question, and firing then would drag the reader forward to a room they
      // had already left the screen to avoid.
      if (state.screen !== 'card') return;
      if (dir < 0) rejectCard();
      else acceptCard();
    }, reduceMotion ? 0 : 200);
  };

  el.addEventListener('pointerdown', (e) => {
    // A press that lands on a control is a press of that control. The sheet has
    // stepped aside for #handle, #find and the card itself since it learned to
    // drag; this is the same guard, and it was missing.
    //
    // Without it the card takes the pointer capture, and capture retargets
    // pointerup, mouseup AND click onto the CAPTURING element -- so every press
    // of the bin or the tick was delivered to the card and swallowed. Measured
    // with scripts/shoot.mjs: 120 presses of the bin left the first room still
    // on screen. Only the keyboard path worked, which is the reverse of what
    // these buttons are for.
    if (e.target.closest('button')) return;
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: e.timeStamp, dx: 0, dy: 0 };
    el.classList.remove('snap');
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* the window fallback still ends a release inside this document */
    }
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
    window.addEventListener('blur', abandon);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.dx = e.clientX - drag.x0;
    drag.dy = e.clientY - drag.y0;
    // One axis at a time, decided by which one moved further. Painting both
    // makes a diagonal drag look like it is about to do two things at once.
    const down = Math.abs(drag.dy) > Math.abs(drag.dx);
    paint(down ? 0 : drag.dx, down ? Math.max(0, drag.dy) : 0);
    e.preventDefault();
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { dx: movedX, dy: movedY, x0, y0, t0 } = drag;
    drag = null;
    clearFallbacks();
    const released = e.type === 'pointerup';
    // A fast mouse throw can go from down to up before the browser delivers a
    // useful pointermove. The release still carries its final coordinates, so
    // decide from those instead of treating the last sampled move as the end.
    // A cancellation has no decision to make and keeps the last painted point.
    const dx = released ? e.clientX - x0 : movedX;
    const dy = released ? e.clientY - y0 : movedY;
    // Down goes back to the question. The back arrow is gone from this screen --
    // it was one more piece of chrome on a photograph, and the duration is one
    // tap to set again -- so the way out is the one gesture the card was not
    // already using.
    if (released && dy > SWIPE_PX && Math.abs(dy) > Math.abs(dx)) {
      rest();
      toAsk();
      return;
    }
    const v = Math.abs(dx) / Math.max(1, e.timeStamp - t0);
    const thrown = Math.abs(dx) > SWIPE_PX || (v > SWIPE_V && Math.abs(dx) > 24);
    // pointercancel is the platform taking the gesture, not a decision.
    if (thrown && released) commit(Math.sign(dx));
    else rest();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('lostpointercapture', abandon);

  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') rejectCard();
    else if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') acceptCard();
    else if (e.key === 'ArrowDown') toAsk();
    else return;
    e.preventDefault();
  });
}

// ------------------------------------------------------------- the duration

// The four .opt buttons on the question screen are the only place the duration
// is chosen now. This used to paint a second copy of the same choice into the
// chip bar at the bottom of the sheet, with its own roving tabindex and its own
// arrow keys; #85 took the bar off the list and the pair of them went with it.
// What is left is one control, on one screen, and the list says in words which
// of the four it was answered with.
//
// The choice is said twice, in the accent fill and in `aria-pressed`, because
// colour is not a state. Accessibility.getFullAXTree at 216ba00 returned four
// identical `button "30 min" {}` nodes with nothing marking the chosen one; #76
// made that live rather than academic, since a returning user's remembered chip
// can be "2 hours".
//
// aria-pressed and not role="radio". A radio group promises the keyboard model
// the paragraph above says #85 deleted: one tab stop, entered on the checked
// radio, arrow keys moving focus and selection together. Announcing a model the
// app does not implement is worse than announcing nothing, and a radio reads as
// a choice you confirm later where these four re-rank campus on the press.
function paintDuration() {
  for (const el of document.querySelectorAll('#ask .opt[data-min]')) {
    const on = el.dataset.min === state.duration;
    el.classList.toggle('primary', on);
    el.setAttribute('aria-pressed', String(on));
  }
}

// ------------------------------------------------------- the buildings screen

// The first door, with the building named the way the rows name it. The
// question screen and the buildings screen both ask, so it is worked out in
// one place and they cannot answer it differently at the same minute.
//
// data/buildings-hours.json is purely weekly and hoursFor indexes it by weekday,
// so nothing in it knows about a holiday. The calendar lives here, at the call
// site: on Thanksgiving the buildings screen said "PAES opens at 5:00am" under
// its own heading saying campus is locked, and on the Sunday before Labor Day it
// said the same about the Monday. Both go back to the bare sentence.
function firstDoor(now) {
  const opening = nextOpening({
    buildings: state.buildings,
    counts: state.counts,
    hoursFor,
    day: now.getDay(),
    nowMin: nowMinutes(now),
  });
  if (!opening) return null;
  const ahead = (opening.day - now.getDay() + 7) % 7;
  const on = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead);
  if (closedDayFor(isoDate(on), state.current, state.rooms)?.state === 'offices-closed') return null;
  return { ...opening, name: shortName(opening.name) };
}

// The answer for 9:40pm on a Thursday and for every hour of every weekend. The
// schedule constrains roughly 943 of the 8,760 hours in a year, and outside it
// a ranked room list is a distance sort wearing the clothes of a schedule
// answer. The unit here is the building, because the real question is which
// door is even unlocked.
function paintNear(reason) {
  const now = clockNow();
  state.day = now.getDay();
  const groups = rankBuildings({
    origin: state.origin,
    buildings: state.buildings,
    counts: state.counts,
    hoursFor,
    day: state.day,
    nowMin: nowMinutes(now),
    field: state.walkField,
  });
  state.groups = groups;


  // Five doors, five sentences. A building the Registrar publishes as shut
  // today is a fact and reads as one; only a building nobody publishes anything
  // about gets "unknown" and the warning colour. The one line every row used to
  // share said "open till 6:00pm" at 9:40pm, three hours forty after the door
  // had already locked.
  const DOOR = {
    open: (b) => [`open till ${clock(b.closesAt)}`, `open until ${spokenClock(b.closesAt)}`],
    before: (b) => [`opens ${clock(b.opensAt)}`, `shut now, opens at ${spokenClock(b.opensAt)}`],
    after: (b) => [`locked ${clock(b.closesAt)}`, `locked since ${spokenClock(b.closesAt)}`],
    'closed-today': () => ['closed today', 'published as closed all day today'],
    unknown: () => ['hours unknown', 'opening hours not published'],
  };

  // An open row is a name and a walk. It used to carry a room count, an "open
  // every day" tag and a closing time as well, and none of the three changed
  // what anybody did next: the count is not a promise that any of them is free,
  // and the closing time is a fact about a door you have not walked to yet.
  //
  // The closed rows keep their door phrase, because inside a group already
  // labelled closed that phrase IS the payload: "opens 7:00am" and "closed
  // today" are different answers and the second one is not worth walking for.
  //
  // The spoken name keeps everything the visible row drops.
  const row = (b) => {
    const [hoursText, hoursSay] = DOOR[b.when](b);
    const rooms = `${b.rooms} classroom${b.rooms === 1 ? '' : 's'}`;
    const name = `${shortName(b.name)}, ${b.walk} minute walk, ${rooms}, ${hoursSay}`;
    const shut = b.when !== 'open';
    return `<button type="button" class="b-row" data-code="${esc(b.code)}" aria-label="${esc(name)}">
      <span class="r-name">${esc(shortName(b.name))}</span>
      <span class="r-walk">${WALK_ICON}${b.walk} min</span>
      ${shut ? `<span class="b-hours">${hoursText}</span>` : ''}
    </button>`;
  };

  // No header over the open rows. "Open now" was a label on the only group that
  // is not behind a disclosure, so it named the default, and the read date next
  // to it was provenance nobody acts on; it lives in Sources, which is one tap
  // away from every screen.
  const openGroup = groups.open.map(row).join('');
  // The unknown-hours group is gone with the rooms that fed it. A building the
  // Registrar publishes no hours for no longer reaches the index at all, so
  // this stays empty unless the hours table moves under a built index, and in
  // that case not showing a door we cannot describe is still the right answer.
  const closedGroup = groups.closed.length
    ? `<p class="grp"><button type="button" class="bar-btn" data-more="closed" aria-expanded="false"
         aria-label="${groups.closed.length} building${groups.closed.length === 1 ? ' is' : 's are'} closed now">
         ${groups.closed.length} closed</button></p>
       <div id="closed-list" hidden>${groups.closed.map(row).join('')}</div>`
    : '';

  // firstDoor is location-free and has to be, because nothing in js/state.js
  // knows where the reader is standing. This screen does, and the closed list
  // under the sentence is already sorted by walk. Three doors share 7:00am at
  // the weekend, and the sentence named Hitchcock Hall at 460 m while
  // Independence Hall opened the same minute 120 m away, 28 rows above it.
  const opening = firstDoor(now);
  const nearest =
    opening?.day === state.day
      ? groups.closed.find((b) => b.when === 'before' && b.opensAt === opening.opensAt)
      : null;
  const door = openingPhrase(nearest ? { ...opening, name: shortName(nearest.name) } : opening, state.day);
  const closedNow = door ? `Everything is closed. ${door}.` : 'Everything is closed right now.';

  $('near').innerHTML =
    `<h2 class="msg" id="near-h" tabindex="-1">${esc(reason.head)}</h2>
     <p class="why">${esc(reason.body)}</p>` +
    openGroup +
    // The one state this screen can reach with nothing at the top: every door
    // we have hours for is shut, which is most of the night. The old sentence
    // here blamed a missing coordinate, and no shipped building has ever been
    // missing one. It then said only that everything was closed, on a screen
    // already holding all 46 opening times, so it names the first one now and
    // keeps the bare sentence for a table with no doors in it.
    (groups.open.length ? '' : `<p class="empty">${esc(closedNow)}</p>`) +
    closedGroup +
    FOOT_ACTS;

  for (const el of $('near').querySelectorAll('.b-row')) {
    el.onclick = () => selectBuilding(el.dataset.code);
  }
  const more = $('near').querySelector('[data-more]');
  if (more) {
    more.onclick = () => {
      const box = $('closed-list');
      box.hidden = !box.hidden;
      more.setAttribute('aria-expanded', String(!box.hidden));
    };
  }
  wireFootActs($('near'));
  syncPaneTouch();
}

// The buildings screen lights a footprint like the ranked list does, but there
// is no room to open behind it, so a second tap is not a promise of anything.
function selectBuilding(code) {
  const b = state.buildings?.[code];
  if (!b) return;
  const found = [...state.groups.open, ...state.groups.unknown, ...state.groups.closed].find((x) => x.code === code);
  state.selected = { id: code, building: code, walk: found?.walk ?? null };
  setSheet(restNow(), true);
  frame(state.selected);
  say(`${shortName(b.name)}, shown on the map.`);
}

// Why the schedule cannot answer THIS MINUTE, which is the evening and the
// weekend. The other reason, a whole day with almost no classes in it, is a
// refusal rather than a routing decision: resolveState dresses it as
// SCHEDULE_DARK and it arrives here through state.situation, because saying
// "right now" on a day where nothing runs at any hour would point at the clock
// for a problem that is not about the clock.
const UNSCHEDULED = {
  head: 'Nearest buildings',
  // The heading used to be "Nothing is scheduled right now" over a paragraph
  // explaining that no class was meeting. Both said the same thing, and neither
  // was what the reader wanted: they are looking at a list of buildings, so the
  // heading may as well name it. showNear focuses this h2, so the element has
  // to stay whatever it says.
  body: '',
};

// Why this screen and not a room list. The locked-door caveat lives in this
// sentence rather than in a footer, because on this screen it is the answer
// rather than a disclaimer under it.
function nearReason() {
  const s = state.situation;
  const base = s && !s.ranked ? { head: s.heading, body: s.body } : UNSCHEDULED;
  // The one sentence this screen cannot drop. It is the only place on it that
  // says an open building is not an unlocked room, because paintNear renders no
  // caveat and #ask, which carries the other one, is hidden behind it.
  return {
    head: base.head,
    body: base.body
      ? `${base.body} An open building is not an unlocked room.`
      : 'An open building is not an unlocked room.',
  };
}

// ------------------------------------------------------------- the picker

// Not a consolation screen. On iOS a denied permission is terminal, there is no
// in-app way back to the prompt, and someone at home planning tomorrow never
// wanted a fix in the first place. What this emits is indistinguishable from a
// GPS fix everywhere downstream.
function paintPick() {
  const q = state.query.trim().toLowerCase();
  const codes = Object.keys(state.counts ?? {}).filter((c) => state.buildings?.[c]);

  const entry = (code) => {
    const b = state.buildings[code];
    const name = shortName(b.name);
    return { code, name, short: state.shorts?.[code] ?? null, rooms: state.counts[code] };
  };
  let rows = codes.map(entry);
  if (q) {
    // Prefix matches first, then anything containing it. No fuzzy scoring: a
    // list of 96 does not need one, and a wrong first hit costs a tap.
    const hit = (e) => `${e.name} ${e.short ?? ''}`.toLowerCase();
    const starts = rows.filter((e) => e.name.toLowerCase().startsWith(q) || (e.short ?? '').toLowerCase().startsWith(q));
    const contains = rows.filter((e) => !starts.includes(e) && hit(e).includes(q));
    rows = [...starts, ...contains];
  }
  rows.sort((a, b) => (q ? 0 : a.name.localeCompare(b.name)));

  const pickRow = (e) => {
    const rooms = `${e.rooms} room${e.rooms === 1 ? '' : 's'}`;
    const name = [e.name, e.short, rooms].filter(Boolean).join(', ');
    return `<button type="button" class="pick-row" data-code="${esc(e.code)}" aria-label="${esc(name)}">
      <span class="pn">${esc(e.name)}</span>
      ${e.short ? `<span class="ps">${esc(e.short)}</span>` : ''}
      <span class="pc">${rooms}</span>
    </button>`;
  };

  const shortcuts = SHORTCUTS.filter((c) => state.buildings?.[c])
    .map(
      (c) =>
        `<button type="button" class="bar-btn" data-code="${esc(c)}">${esc(shortName(state.buildings[c].name))}</button>`,
    )
    .join('');

  $('pick').innerHTML =
    '<h2 class="msg" id="pick-h" tabindex="-1">Where are you?</h2>' +
    (q ? '' : `<div class="shortcuts">${shortcuts}</div>`) +
    (rows.length
      ? rows.map(pickRow).join('')
      : `<p class="empty">No building matches ${esc(state.query)}.</p>`);

  for (const el of $('pick').querySelectorAll('[data-code]')) {
    el.onclick = () => pickBuilding(el.dataset.code);
  }
  // The abbreviations arrive after the first paint and repaint the whole list,
  // which drops focus on the floor unless it is put back.
  if (document.activeElement === document.body) focusHeading($('pick-h'));
  syncPaneTouch();
}

function pickBuilding(code) {
  const b = state.buildings?.[code];
  if (!b) return;
  const origin = {
    lat: b.lat,
    lon: b.lon,
    accuracy: PICKED_ACCURACY_M,
    source: 'picked',
    label: shortName(b.name),
    at: Date.now(),
  };
  safeSet(KEY_ORIGIN, JSON.stringify(origin));
  // Now, not at the next fix. startWatch() refuses a picked origin, but a pick
  // made mid-session happens while a watch is already open, and followAction
  // only returns 'stop' when a position arrives to be judged. With
  // maximumAge 0, no timeout and a student who has just walked indoors, that
  // next position can be minutes away or never, and privacy.html says the
  // following does not start at all on a picked building.
  stopWatch();
  useOrigin(origin, null);
  state.query = '';
  $('find-q').value = '';
  // The picker replaces itself in history rather than stacking, so back still
  // goes wherever the picker was opened from.
  const view = state.scheduled && state.rankable ? 'list' : 'near';
  history.replaceState({ v: view }, '', cleanUrl());
  if (view === 'list') {
    showList();
    answer();
  } else {
    showNear();
  }
  say(`Showing rooms from ${origin.label}.`);
}

function clearPickedOrigin() {
  safeDel(KEY_ORIGIN);
  locate().then((got) => {
    useOrigin(got.origin, got.note);
    // The pick is gone, so the fix is back in charge and the watch that a
    // picked origin turned off comes back with it.
    follow(got.origin);
    refresh();
    // The X always goes; on the Oval fallback the row it sits in stays. Focus
    // moves to whichever survives, or it lands on the body and is lost.
    ($('origin').hidden ? $('back') : $('origin-where')).focus({ preventScroll: true });
  });
}

function useOrigin(origin, note) {
  state.origin = origin;
  state.accuracy = origin.accuracy;
  // The walk is measured from here, so the field is rebuilt here and nowhere
  // else. One Dijkstra over 5,242 nodes, which is the only work the sidewalk
  // graph does per position; every room and every building then reads its
  // distance out of the result.
  //
  // No ceiling. data/walk-graph.json is already pruned to what a door can reach
  // in MAX_WALK minutes, so the prune IS the bound and a second one here would
  // only leave the far rows of the buildings picker on a different walk model
  // from the near ones.
  // A walk in the air was asked from where the reader used to be. Bumping the
  // generation drops it on arrival rather than letting it render against the
  // new origin, which is the rule docs/research/walking-routes-115.md sets for
  // any asynchronous provider.
  state.directions?.invalidate();
  state.walkField = Number.isFinite(origin?.lat) && Number.isFinite(origin?.lon)
    ? (state.router?.from(origin.lat, origin.lon, Infinity) ?? null)
    : null;
  // The dot, its accuracy ring and the end of the walk line all hang off this.
  frames.wake();
  // The one place the app branches on where the origin came from. Nothing in
  // ranking, the off-campus gate or the buildings screen reads it.
  state.originIsGuess = origin.source === 'oval';
  // The same sentence in two places, because it belongs to two screens.
  // #note floats over the map and answers "why is the walk measured from
  // there". #ask-where sits in the question column, because a fixed pill on
  // top of the wordmark, the question and the "1 hour" button was the bug.
  $('note-text').textContent = note ?? '';
  $('note').hidden = !note;
  $('note-pick').hidden = !note;
  $('ask-where').textContent = note ?? '';
  $('ask-where').hidden = !note;
  $('ask-pick').hidden = !note;
  paintOriginBar();
}

// Whether the "from <building>" row belongs on screen. It is a location CONTROL
// costing a full row at the top of the most-used screen, which is why
// docs/DECISIONS.md cut it to dev mode, and a phone with a real position has
// nothing to correct. It comes back for the two origins the app chose FOR them:
// a picked building is otherwise permanent, with no visible undo.
const originBarOn = (screen) =>
  (screen === 'list' || screen === 'near') &&
  (state.dev || state.origin?.source === 'picked' || state.originIsGuess);

function paintOriginBar() {
  const picked = state.origin?.source === 'picked';
  const label = picked ? state.origin.label : state.originIsGuess ? 'the Oval' : 'your location';
  const where = $('origin-where');
  where.querySelector('span').innerHTML = `from <b>${esc(label)}</b>`;
  where.setAttribute('aria-label', `Measuring from ${label}. Pick a different building.`);
  $('origin-clear').hidden = !picked;
  // Clearing a picked origin changes who the bar is for without changing screen,
  // so the row is hidden here as well as in showPane.
  $('origin').hidden = !originBarOn(state.screen);
}

// -------------------------------------------------------------- the room

// Which day the room screen is drawing. An offset in days from the app's own
// clock, not a date, so it survives the clock moving under it in dev mode.
let roomDayOffset = 0;

const dayShown = () => {
  const d = clockNow();
  d.setDate(d.getDate() + roomDayOffset);
  return d;
};

// One hour of the grid, in CSS pixels. 46 is the smallest that fits a course
// code and a time range on two lines inside a 55 minute class, which is the
// most common length on campus.
const HOUR_PX = 46;

const SHORT_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHORT_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The day as a calendar column, which is the shape a student already reads a
// timetable in.
//
// It replaced a list of rows that said "7:00am free 7h00 / 2:00pm in use". That
// list was accurate and nobody could see the shape of the day in it: the whole
// point of an empty-room app is that the empty parts are the answer, and on a
// grid the empty parts are simply the gaps. Every word the list spent saying
// "free" is now white space.
//
// Hours are always published for a shipped room, because a building with no
// published hours no longer ships at all, so there is exactly one unknown left
// to draw: a day the building is published as closed.
function dayGridHtml(room, bname, date, schedule) {
  const hours = hoursFor(room.b, date.getDay());
  const label = `${SHORT_DAY[date.getDay()]}, ${SHORT_MONTH[date.getMonth()]} ${date.getDate()}`;
  const head = `<div class="dnav">
      <button type="button" class="dstep" data-day="-1" aria-label="Previous day">
        <svg class="ico flip" aria-hidden="true"><use href="#i-chev"/></svg></button>
      <span>${esc(label)}</span>
      <button type="button" class="dstep" data-day="1" aria-label="Next day">
        <svg class="ico" aria-hidden="true"><use href="#i-chev"/></svg></button>
    </div>`;

  if (hours === null) return `${head}<p class="unknown">${esc(bname)} is closed.</p>`;

  const classes = classesOn(room, date, schedule.sessions, schedule.courses);
  // A shipped room's building always publishes hours, because one that does not
  // no longer reaches the index. `undefined` still has to be survivable: the
  // hours table is refetched on its own schedule and can drop a building while
  // a built index still names it. The grid then runs the classes it can see and
  // says so, rather than reading undefined[0] and rendering NaN.
  const doors = Array.isArray(hours);
  if (!doors && !classes.length) {
    return `${head}<p class="unknown">No class today, and no published hours.</p>`;
  }
  // The grid runs the building's own hours, snapped out to whole hours so the
  // labels land on the lines. A class that starts before the door officially
  // opens widens the window rather than being clipped: it happened, and hiding
  // it would draw the room as free during a class.
  const first = Math.min(...(doors ? [hours[0]] : []), ...classes.map((c) => c.from));
  const last = Math.max(...(doors ? [hours[1]] : []), ...classes.map((c) => c.to));
  const top = Math.floor(first / 60) * 60;
  const end = Math.ceil(last / 60) * 60;
  const span = Math.max(60, end - top);
  const pc = (m) => ((m - top) / span) * 100;

  const marks = [];
  for (let m = top; m <= end; m += 60) {
    marks.push(`<li style="top:${pc(m).toFixed(3)}%"><span>${esc(hourLabel(m))}</span></li>`);
  }

  const blocks = classes.map((c) => {
    const h = pc(c.to) - pc(c.from);
    const name = c.course ?? 'In use';
    const when = `${clock(c.from)} - ${clock(c.to)}`;
    return `<div class="blk${h < 4.5 ? ' tight' : ''}" style="top:${pc(c.from).toFixed(3)}%;height:${h.toFixed(3)}%"
      aria-label="${esc(`${name}, ${when}`)}"><b>${esc(name)}</b><span>${esc(when)}</span></div>`;
  });

  // The now line only means anything on the day it is on.
  const nowMin = nowMinutes(clockNow());
  const isToday = roomDayOffset === 0;
  const nowLine =
    isToday && nowMin >= top && nowMin <= end
      ? `<div class="nowline" style="top:${pc(nowMin).toFixed(3)}%" aria-hidden="true"></div>`
      : '';

  // A fixed height per hour, not a percentage of the sheet. A calendar whose
  // hour is 6px on a short screen and 30px on a tall one is two different
  // pictures of the same day; the pane scrolls instead.
  const px = Math.round((span / 60) * HOUR_PX);
  return `${head}<div class="day" style="height:${px}px;--hours:${span / 60}">
      <ul class="hrs">${marks.join('')}</ul>
      <div class="cols">${blocks.join('')}${nowLine}</div>
    </div>`;
}

// 7 AM, noon, 8 PM. No minutes, because every mark is on the hour.
function hourLabel(m) {
  const h = Math.floor(m / 60) % 24;
  if (h === 0) return '12 AM';
  if (h === 12) return 'noon';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

// The timeline, as rows. Free blocks are the content and classes are the
// frame, so a free block carries a start, the word and a length, and a class
// carries a start and nothing else.
function timelineRows(room, bname, nowMin, date, schedule) {
  const hours = hoursFor(room.b, date.getDay());
  const blocks = blocksOn(room, date, schedule.sessions);
  const known = Array.isArray(hours);
  if (hours === null) return { closed: true, rows: [] };

  // With no published hours the timeline is bounded by the room's own first
  // and last class. The app knows the door was open when a class met in it. It
  // knows nothing about the hour before.
  const open = known ? hours[0] : blocks.length ? blocks[0][0] : null;
  const close = known ? hours[1] : blocks.length ? blocks[blocks.length - 1][1] : null;
  if (open == null) return { known, rows: [], nothing: true };

  // Clipped to the window, because a block that runs past the close is not
  // evidence about a locked building.
  const inside = [];
  for (const [s, e] of blocks) {
    const c = [Math.max(s, open), Math.min(e, close)];
    if (c[1] > c[0]) inside.push(c);
  }

  const rows = [];
  if (known) rows.push({ kind: 'edge', t: open, text: `${bname} opens` });
  else rows.push({ kind: 'edge', text: `before ${clock(open)}, not known` });

  const gap = (from, to) => {
    const len = to - from;
    if (len <= 0) return;
    if (len < SEAM_MIN) {
      rows.push({ kind: 'seam' });
      return;
    }
    rows.push({ kind: 'free', t: from, end: to, len, now: nowMin != null && nowMin >= from && nowMin < to });
  };

  let cursor = open;
  for (const [s, e] of inside) {
    gap(cursor, s);
    rows.push({ kind: 'busy', t: s });
    cursor = Math.max(cursor, e);
  }
  gap(cursor, close);

  if (known) rows.push({ kind: 'edge', t: close, text: `${bname} closes` });
  else rows.push({ kind: 'edge', text: `after ${clock(close)}, not known` });

  return { known, rows, blocks: inside, open, close };
}

// The one line at the top that makes a claim, and the only place on the room
// screen that talks about now. js/claim.js decides what is true; this turns the
// verdict into a sentence.
//
// A building nobody publishes hours for gets sentences about CLASSES. The
// screen used to print "Thompson Library opens at 12:45pm" off the start of the
// first class, two lines above its own paragraph saying nobody knows when that
// door unlocks.
//
// Every duration on this screen is `c.yours`, which is the engine's formula
// with the walk in it, and it is absent rather than guessed when the walk is
// unknown. The room screen is the one place that can say how long you get, so
// it is the one place where an overstated figure sends somebody across campus.
function claimFor(tl, nowMin, bname, metres) {
  const c = roomClaim({ ...tl, now: nowMin, metres });
  // Kept short and kept at all: this only fires if the hours table drops a
  // building a built index still ships, which the room screen must survive.
  const noDoors = () => 'Door hours not published';

  switch (c.kind) {
    case 'opens':
      return {
        head: `Opens ${clock(c.at)}`,
        sub: c.next != null && c.yours > 0 ? `Free ${clock(c.next)} \u00b7 ${dur(c.yours)}` : '',
      };
    case 'before-first-class':
      return { head: `First class ${clock(c.at)}`, sub: '' };
    case 'closed-for-day':
      return { head: 'Closed for the day', sub: '' };
    case 'after-last-class':
      return { head: `Last class ended ${clock(c.at)}`, sub: '' };
    case 'in-class':
      return {
        head: `In use till ${clock(c.until)}`,
        sub:
          c.next == null
            ? 'Nothing free after it today'
            : c.yours > 0
              ? `Next free ${clock(c.next)}, for ${dur(c.yours)}`
              : `Next free ${clock(c.next)}`,
      };
    case 'no-class-today':
      return { head: 'No class today', sub: '' };
    case 'free':
      // With no published hours the sentence about the door outranks the
      // sentence about the window. "Yours for 45 min" under a headline that
      // already admits nobody knows when the building locks reads as a promise
      // the line above it just refused to make.
      if (!c.known) {
        return {
          head: c.until == null ? 'No class in here for the rest of today' : `No class in here till ${clock(c.until)}`,
          sub: noDoors(),
        };
      }
      return {
        head: c.until == null ? 'No class in here for the rest of today' : `Free till ${clock(c.until)}`,
        sub:
          c.yours == null
            ? ''
            : c.yours > 0
              ? `Yours for ${dur(c.yours)} once you get there`
              : 'It closes before you could walk there',
      };
    default:
      return { head: 'Nothing free now', sub: '' };
  }
}

// The same line for a date the user is not standing in. js/day.js decides what
// is true and this fetches what it needs, the calendar included: an empty busy
// list is not evidence of a free room on a day the app refuses to answer for.
function shapeFor(tl, date, schedule) {
  const iso = isoDate(date);
  return dayClaim({
    closed: tl.closed,
    blocks: tl.blocks,
    calendar: calendarOn(iso, schedule, state.current),
    inTerm: inTermOn(iso, state.current, schedule),
    term: state.current?.termName,
  });
}

const rad = (deg) => (deg * Math.PI) / 180;

// Great-circle initial bearing, degrees clockwise from true north.
function bearingTo(from, to) {
  const dLon = rad(to.lon - from.lon);
  const y = Math.sin(dLon) * Math.cos(rad(to.lat));
  const x = Math.cos(rad(from.lat)) * Math.sin(rad(to.lat)) - Math.sin(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.cos(dLon);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

function roomHtml(id) {
  const date = dayShown();
  const calendar = calendarOn(isoDate(date), state.classRooms, state.current);
  const overlaid = scheduleFor(date, !!calendar?.noClasses);
  const schedule = overlaid.index;
  const room = schedule.rooms[id];
  const b = state.buildings?.[room.b];
  const bname = shortName(b?.name ?? room.b);
  const now = clockNow();
  const nowMin = nowMinutes(now);
  const r = state.results.find((x) => x.id === id);
  // The walk belongs in the claim, so it has to be here whether or not the room
  // came off a ranked row: a shared link and the buildings screen both land on
  // this screen with state.results empty.
  const metres = Number.isFinite(r?.metres)
    ? r.metres
    : state.origin && b && Number.isFinite(b.lat) && Number.isFinite(b.lon)
      ? Math.round(walkMetres(state.origin, b, room.b, state.walkField))
      : null;

  // The day the screen is drawing, which is the day it has to describe.
  const today = roomDayOffset === 0;
  const tl = timelineRows(room, bname, today ? nowMin : null, date, schedule);
  const claim = !today
    ? shapeFor(tl, date, schedule)
    : tl.closed
      ? { head: 'Closed today', sub: '' }
      : tl.nothing
        ? { head: 'No class in here all day', sub: '' }
        : claimFor(tl, nowMin, bname, metres);

  // rank() rounds the metres it reports but keeps the walk it computed off the
  // unrounded distance, so re-deriving one from the other can disagree by a
  // minute with the row the user just tapped.
  const walk = r?.walk ?? (Number.isFinite(metres) ? walkMinutes(metres) : null);

  // The vocabulary ships in the room index. A second copy here is how five of
  // the eleven visible codes went missing from it, and 95 rooms, a conference
  // room and two dozen computer labs among them, rendered as bare untyped rows.
  const type = state.rooms?.types?.[room.type];
  // Every fact is its own element. Bare strings next to each other in a flex
  // row become one anonymous flex item, not three, so no gap landed between
  // them and the row rendered as "113 m28 seatsclassroom".
  // The metres used to sit beside the minutes. The minutes are computed FROM
  // the metres, so it was one number rendered twice.
  const facts = [
    walk == null ? '' : `<span class="w">${WALK_ICON}${walk} min walk</span>`,
    room.cap ? `<span>${room.cap} seats</span>` : '<span>seats unknown</span>',
    type ? `<span>${esc(type)}</span>` : '',
    ...roomFeatureLabels(room).map((label) => `<span>${esc(label)}</span>`),
    // The same word the row carries, on the screen a student lands on after
    // tapping it. A row that is ranked down for a reason has to be able to say
    // the reason once the reader asks for the room.
    //
    // It carries the sentence too. deptOf writes the word out for the list's
    // spoken name because "departmental" alone next to a seat count is a word
    // with no sentence around it; that argument does not stop being true one tap
    // later, and this line read as the bare word while the row it came from read
    // as the sentence.
    room.ga === false
      ? '<span>departmental<span class="sr">, not a general-assignment room</span></span>'
      : '',
  ].filter(Boolean);

  // The day, drawn. Every paragraph that used to sit here explained an absence
  // the grid now shows: a closed day is a grid that says closed, an empty day is
  // an empty grid, and there is no unpublished-hours case left to explain
  // because those rooms no longer ship.
  const body = dayGridHtml(room, bname, date, schedule);

  // Empty until asked, and filled in place rather than by redrawing the screen:
  // showRoom rebuilds this whole subtree, and a reader who has scrolled down to
  // the day grid should not be thrown back to the top by an answer arriving.
  const steps = state.directions ? '<div class="steps" id="steps" hidden></div>' : '';

  // The one control on this screen that leaves the app, and the reason #44's
  // straight line is allowed to stay a direction rather than a route: it is a
  // refusal to route only while there is a visible way out to something that
  // does. It says "Directions" because that is what it opens; "Maps" named a
  // place. js/install.js picks the URL, which is a question about the phone.
  const acts =
    b && Number.isFinite(b.lat)
      ? `<p class="acts">
          <button type="button" id="bearing" class="bar-btn" aria-label="Point the arrow at it">
            <svg class="ico" aria-hidden="true" hidden><use href="#i-arrow"/></svg>
            <span>Point me</span>
          </button>
          ${state.directions ? `<button type="button" class="bar-btn" data-act="directions" data-b="${esc(room.b)}" aria-label="The walk to ${esc(bname)}, street by street">Step by step</button>` : ''}
          <a class="bar-btn" aria-label="Walking directions to ${esc(bname)}, in your maps app"
             href="${esc(mapsHref({ lat: b.lat, lon: b.lon, origin: state.origin, ua: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints }))}">Directions</a>
          <button type="button" class="bar-btn" data-act="about" aria-label="What Vacant knows">Sources</button>
        </p>`
      : '';

  return `<h2 id="room-h" tabindex="-1">${esc(bname)} ${esc(room.n ?? '')}</h2>
    <p class="claim">${esc(claim.head)}${claim.sub ? `<span class="sub">${esc(claim.sub)}</span>` : ''}</p>
    <p class="facts">${facts.join('')}</p>
    ${acts}
    ${steps}
    ${body}
    ${caveatHtml(overlaid.coverage)}`;
}

// The steps, asked for and not fetched on sight.
//
// One tap, one request, for the one building the reader has already chosen. A
// card they swipe past costs nothing, which is the whole reason this is a button
// and not part of paintCard: 425 rooms over 50 buildings, fetched on sight,
// would be a bill and a battery for answers nobody read.
//
// The walk on this screen does not move. It was measured over OSU's sidewalks
// before the reader tapped, and Google's own duration is deliberately not
// written over it: docs/research/walking-routes-115.md measured the two against
// OSU's service and Google was not the closer of them. What Google is asked for
// is the thing the bundled graph cannot say, which is the words.
//
// Nothing here can leave the screen in a worse state than it found it. No key,
// no consent, offline, quota, timeout: js/directions.js answers null and this
// says so in one line, under a walk that is still correct.
async function askSteps(code) {
  const box = $('steps');
  const b = state.buildings?.[code];
  if (!box || !b || !state.origin) return;

  if (!state.googleConsent) {
    box.hidden = false;
    box.innerHTML = `<p class="steps-ask">Step-by-step directions send where you are
      standing to Google. Nothing else in Vacant does that.
      <button type="button" class="bar-btn" id="steps-ok">Allow and continue</button></p>`;
    $('steps-ok').onclick = () => {
      state.googleConsent = true;
      askSteps(code);
    };
    return;
  }

  box.hidden = false;
  box.innerHTML = '<p class="steps-wait">Asking Google for the walk...</p>';
  const got = await state.directions.steps(state.origin, b);

  // The reader may have left, or moved, while that was in the air.
  if ($('steps') !== box || !box.isConnected) return;
  if (!got) {
    box.innerHTML = `<p class="steps-none">No step-by-step directions right now.
      The ${esc(String(shortName(b.name)))} walk above still holds.</p>`;
    return;
  }

  box.innerHTML =
    `<ol class="steps-list">` +
    got.steps.map((st) => `<li>${esc(st.text)}${Number.isFinite(st.metres) ? ` <span class="steps-m">${st.metres} m</span>` : ''}</li>`).join('') +
    `</ol><p class="steps-src">Walking steps from Google. The minutes above are measured over OSU's own sidewalks.</p>`;
}

// The compass needle. It stays off until it is asked for, because iOS only
// grants orientation from inside a tap and a permission prompt nobody asked
// for is a prompt everybody denies.
let orientationOff = null;

function attachBearing(id) {
  const btn = $('bearing');
  if (!btn) return;
  const room = state.rooms.rooms[id];
  const b = state.buildings?.[room.b];
  const arrow = btn.querySelector('.ico');
  const label = btn.querySelector('span');
  const bearing = bearingTo(state.origin, b);
  const word = COMPASS[Math.round(bearing / 45) % 8];
  btn.setAttribute('aria-label', `${shortName(b.name)} is ${word} of you. Point the arrow live.`);

  btn.onclick = async () => {
    const ask = window.DeviceOrientationEvent?.requestPermission;
    if (typeof ask === 'function') {
      try {
        if ((await ask.call(window.DeviceOrientationEvent)) !== 'granted') {
          label.textContent = `${word}, no compass`;
          return;
        }
      } catch {
        label.textContent = `${word}, no compass`;
        return;
      }
    }
    if (!('DeviceOrientationEvent' in window)) {
      label.textContent = `${word}, no compass`;
      return;
    }
    const onTurn = (e) => {
      // webkitCompassHeading is already degrees clockwise from true north.
      // alpha counts the other way, so it has to be flipped before it means
      // the same thing.
      const heading = Number.isFinite(e.webkitCompassHeading)
        ? e.webkitCompassHeading
        : Number.isFinite(e.alpha)
          ? 360 - e.alpha
          : null;
      if (heading == null) return;
      // `hidden` is an HTMLElement property and this is an SVG element, so the
      // assignment sets a JS property nobody reads and leaves the attribute in
      // place. The needle would never have appeared.
      arrow.removeAttribute('hidden');
      arrow.style.transform = `rotate(${(bearing - heading + 360) % 360}deg)`;
      label.textContent = word;
    };
    window.addEventListener('deviceorientationabsolute', onTurn);
    window.addEventListener('deviceorientation', onTurn);
    orientationOff = () => {
      window.removeEventListener('deviceorientationabsolute', onTurn);
      window.removeEventListener('deviceorientation', onTurn);
      orientationOff = null;
    };
    label.textContent = word;
  };
}

// The complaint arrives after the walk, after the app was backgrounded and
// possibly killed, so the room the user tapped has to outlive the process.
function rememberPick(id) {
  const room = state.rooms?.rooms?.[id];
  if (!room) return;
  const r = state.results.find((x) => x.id === id);
  // The day the row was ranked on, not the day it was tapped on. A row still on
  // screen at 00:02 was answered yesterday, so the block list, the mask and the
  // label all take their weekday from state.day.
  const shown = clockNow();
  shown.setDate(shown.getDate() - ((shown.getDay() - state.day + 7) % 7));
  const busy = blocksOn(room, shown, state.rooms.sessions);
  const active = activeSessions(state.rooms.sessions, isoDate(shown));
  // Which session's class closes the gap. That is the number a maintainer needs
  // to tell a stale session mask from a wrong gap.
  const closer = (room.busy ?? []).find(
    (b) => Number(b[0]) === state.day && Number(b[1]) === r?.nextClassAt && (!active || active[b[3]] !== false),
  );
  // 83.4% of gaps end at the door rather than at a class, and "sess ?" reads as
  // a lookup that failed rather than as the answer.
  const session = closer ? closer[3] : r && r.nextClassAt === closeOf(room.b) ? 'door' : null;
  safeSet(
    KEY_PICK,
    JSON.stringify({
      id,
      type: room.type ?? null,
      cap: room.cap ?? null,
      building: room.b,
      metres: r?.metres ?? null,
      walk: r?.walk ?? null,
      gapStart: r?.availableAt ?? null,
      gapEnd: r?.nextClassAt ?? null,
      session,
      usable: r?.usable ?? null,
      // The minute the row was tapped, so the block can print the departure
      // deadline behind the usable figure. Reading the clock when the panel
      // opens instead would date-stamp a walk that already happened.
      nowMin: nowMinutes(clockNow()),
      busy,
      dayName: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][state.day],
      at: Date.now(),
    }),
  );
}

// ------------------------------------------------------------- diagnostics

async function cacheNames() {
  try {
    return await caches.keys();
  } catch {
    return [];
  }
}

async function paintAbout() {
  const names = await cacheNames();
  const shells = names.filter((n) => n.startsWith('vacant-shell-'));
  // A newer cache sitting beside an older controller is the "you are running
  // last week's code" state, and it is worth seeing.
  const build = shells.length === 1 ? shells[0].replace('vacant-shell-', '') : shells.length ? 'more than one' : 'unknown';
  const controlling = shells.length === 1 && Boolean(navigator.serviceWorker?.controller);

  let pick = null;
  try {
    pick = JSON.parse(safeGet(KEY_PICK) ?? 'null');
  } catch {
    pick = null;
  }

  const now = clockNow();
  const stale = staleness({ now, current: state.current });
  const block = diagnosticsBlock({
    build,
    controlling,
    // Whether the sidewalk graph answered for this origin, or the straight-line
    // fallback did.
    routed: !!state.walkField,
    term: state.current?.term,
    termName: state.current?.termName,
    generated: state.current?.generated,
    ageDays: stale.days,
    stateKind: state.situation?.kind ?? '?',
    rooms: Object.keys(state.rooms?.rooms ?? {}).length,
    buildings: Object.keys(state.buildings ?? {}).length,
    sessions: (state.rooms?.sessions ?? []).length,
    originSource: state.origin?.source,
    accuracy: state.accuracy,
    originAgeS: state.origin?.at ? Math.round((Date.now() - state.origin.at) / 1000) : null,
    lat: state.origin?.lat,
    lon: state.origin?.lon,
    includeLocation: state.includeLocation,
    hoursSource: state.hoursSlug,
    hoursGenerated: state.hours?.generated,
    clock: `${isoDate(now)} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    caches: names,
    room: pick,
    busy: pick?.busy,
    dayName: pick?.dayName,
  });

  const issue =
    'https://github.com/EnesYilmazcode/Vacant/issues/new?template=wrong-answer.yml&labels=wrong-answer&diagnostics=' +
    encodeURIComponent(block);

  $('about').innerHTML = `
    <h2 class="msg" id="about-h" tabindex="-1">What Vacant knows</h2>
    <p class="why">Everything on this screen came out of memory and the cache. Nothing left the
      phone to build it, and nothing leaves it now unless you tap one of the buttons.</p>
    <pre class="diag" id="diag">${esc(block)}</pre>
    <label class="optin"><input type="checkbox" id="loc-optin" ${state.includeLocation ? 'checked' : ''}>
      Include my coordinates, rounded to four decimals</label>
    <p class="acts">
      <button type="button" class="bar-btn" id="copy">Copy</button>
      <a class="bar-btn" id="report" href="${esc(issue)}" target="_blank" rel="noopener">This was wrong</a>
    </p>
    <p class="foot">A URL is not private. It lands in your address bar, your history and GitHub's
      logs, so your coordinates stay out of it until you tick the box.</p>
    <p class="foot">Class times come from Ohio State's public class search. Building open and close
      times come from the Registrar's classroom pool schedule. Building locations &copy; 2025 The
      Ohio State University, Facilities Information and Technology Services, GIS.
      <a href="${BASE}privacy.html">What this app does with your location</a></p>`;

  $('loc-optin').onchange = (e) => {
    state.includeLocation = e.target.checked;
    paintAbout();
  };
  $('copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(block);
      $('copy').textContent = 'Copied';
    } catch {
      // Clipboard access is denied outright in a few standalone iOS builds, so
      // the fallback is to select the block and say so rather than fail quietly.
      const pre = $('diag');
      pre.classList.add('picked');
      const range = document.createRange();
      range.selectNodeContents(pre);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      $('copy').textContent = 'Select this text and copy';
    }
  };
  syncPaneTouch();
  focusHeading($('about-h'));
}

// ---------------------------------------------------------------- screens

function showPane(name) {
  if (state.screen === 'room' && name !== 'room' && orientationOff) orientationOff();
  $('way').hidden = true;
  // The card screen is a photograph edge to edge, so the sheet it lives in has
  // no rounded top, no border and no grip there. index.html hangs those off the
  // body rather than the pane, because the sheet is what has to lose them.
  document.body.classList.toggle('carding', name === 'card');
  document.body.classList.remove('waying');
  for (const id of PANES) $(id).hidden = id !== name;
  $('find').hidden = name !== 'pick';
  $('origin').hidden = !originBarOn(name);
  $('ask').hidden = true;
  $('sheet').hidden = false;
  // One corner, two controls, never both. The card is a photograph and gets the
  // menu; everything else is a panel or a map and keeps the arrow.
  $('back').hidden = name === 'card';
  $('menu').hidden = name !== 'card';
  closeMenu();
  document.body.classList.remove('asking');
  const arrived = state.screen !== name;
  state.screen = name;
  syncPaneTouch();
  // Arriving re-composes the camera for the strip THIS screen leaves. Without
  // it the view stays fitted for the screen behind: leaving a room slid the walk
  // line 115px and stretched it 1.69x at 393x852, with state.view untouched.
  if (arrived) reframe();
}

function reframe() {
  frames.wake();
  if (!state.basemap || !state.view) return;
  if (state.selected) frame(state.selected);
  // frame() stands down once the camera has been moved by hand, and a cy
  // clamped for the room's 239px band is not inside the list's 528px one.
  state.view = clampView(state.view, state.basemap, viewport());
}

function showAsk() {
  state.screen = 'ask';
  $('way').hidden = true;
  $('ask').hidden = false;
  document.body.classList.add('asking');
  document.body.classList.remove('carding', 'waying');
  $('sheet').hidden = true;
  $('back').hidden = true;
  $('menu').hidden = true;
  closeMenu();
  for (const id of PANES) $(id).hidden = id !== 'list';
  state.settled = false;
  state.selected = null;
  state.listScroll = 0;
  state.userMoved = false;
  // The next answer opens where it rests, whatever height the last one was
  // dragged to.
  sheetH = 0;
  $('map').classList.remove('settled');
  paintMap();
  flyoverStart = performance.now();
  // Back to the question restarts the drift, which is the loop's own reason to
  // keep running.
  frames.wake();
  if (orientationOff) orientationOff();
}

function sheetHeight() {
  const h = openAt(state.screen, { screen: sheetScreen, h: sheetH }, restNow(), targeted());
  setSheet(h, sheetScreen !== state.screen);
}

function showCard() {
  // Cleared before showPane for the same reason showList clears it: the map is
  // covered on this screen and reframe() composes for what is selected. Nothing
  // is, and nothing should be -- the whole idea is that you do not see a map
  // until you have said yes to a room.
  state.selected = null;
  showPane('card');
  $('back').setAttribute('aria-label', 'Back to the question');
  $('card').scrollTop = 0;
  paintCard();
  sheetHeight();
}

function showList() {
  // Cleared before showPane, because reframe() in there composes the camera
  // for the band this screen leaves and the band now depends on it.
  //
  // Nothing else clears it on the way back. followAction reads state.selected
  // as "a finger is on a row somebody is reaching for" and returns 'hold', and
  // under 'hold' refresh() never runs, so answer() -- the only other thing that
  // nulls it -- never runs either. Open the app, tap a room, press back, walk:
  // the gate stays shut and the list holds boot values for the rest of the
  // session, which is exactly the staleness #87 exists to remove. Selection is
  // a property of the room screen; coming back to the list ends it.
  state.selected = null;
  showPane('list');
  // openList() pushes over whatever was showing, and the menu can open the list
  // from the way as well as from the card.
  $('back').setAttribute(
    'aria-label',
    history.state?.from === 'way' ? 'Back to the way' : 'Back to the card',
  );
  $('list').scrollTop = state.listScroll;
  sheetHeight();
}

function showNear() {
  state.listScroll = 0;
  showPane('near');
  $('back').setAttribute('aria-label', 'Back to the question');
  paintNear(nearReason());
  $('near').scrollTop = 0;
  sheetHeight();
  focusHeading($('near-h'));
  settle();
}

function showPick() {
  loadShorts();
  showPane('pick');
  $('back').setAttribute('aria-label', 'Back without picking a building');
  paintPick();
  $('pick').scrollTop = 0;
  setSheet(restNow(), true);
  focusHeading($('pick-h'));
}

function showAbout() {
  showPane('about');
  $('back').setAttribute('aria-label', 'Back');
  setSheet(restNow(), true);
  paintAbout();
}

// Everything the room screen's markup has to be given back after it is written.
// Split out of showRoom because a repaint driven by a moving fix has to restore
// the handlers WITHOUT re-entering the screen: showRoom also moves focus to the
// heading and re-snaps the sheet to rest, and a sheet that jumps back to rest
// under a reader is worse than a stale number.
function wireRoom(id) {
  attachBearing(id);
  // A week either way, and no clamp. Past the term's own bounds the grid comes
  // back empty and the sentence over it says the schedule does not reach there.
  for (const el of $('room').querySelectorAll('[data-day]')) {
    el.onclick = () => {
      roomDayOffset += Number(el.dataset.day);
      const at = $('room').scrollTop;
      showRoom(id, { keepDay: true });
      $('room').scrollTop = at;
    };
  }
  for (const el of $('room').querySelectorAll('[data-act]')) {
    el.onclick = el.dataset.act === 'directions' ? () => askSteps(el.dataset.b) : () => openAbout();
  }
}

// The room screen, redrawn where it stands, for a fix that landed while it was
// open. The ranking behind it does not move: the reader has already chosen, and
// re-ordering a list they are about to press back into is the thumb rule. What
// does move is every number on this screen measured from the origin, which is
// the walk minutes AND the "yours for" duration in the claim above them, since
// usableMinutes subtracts the walk from the window. Printing one of them from
// where the student used to be is the bug this whole change is about.
function repaintRoom() {
  const id = state.selected?.id;
  const room = id ? state.rooms?.rooms?.[id] : null;
  if (!room || $('room').hidden) return;
  // The compass first. The needle, its arrow and its label are built inside
  // roomHtml, so the innerHTML below detaches them -- but orientationOff still
  // closes over the OLD nodes and its two window listeners are still bound.
  // Left alone, the needle silently vanishes every FOLLOW_M of the walk it
  // exists for, the label reverts to "Point me", and tapping it again
  // overwrites the closure and orphans the first pair for good.
  if (orientationOff) orientationOff();
  const b = state.buildings?.[room.b];
  if (!b || !Number.isFinite(b.lat) || !Number.isFinite(b.lon) || !state.origin) return;
  const metres = Math.round(walkMetres(state.origin, b, room.b, state.walkField));
  const walk = walkMinutes(metres);
  // Nothing a reader can see has changed. A repaint costs them their place in
  // the day grid, and it is not worth spending on a number that came back the
  // same: FOLLOW_M is 40 m and a walk minute is 78 m of it.
  if (walk === state.selected.walk) return;
  // The row the list handed over carries the walk it was RANKED with, and
  // roomHtml prefers that over re-deriving one. Both fields are a function of
  // the origin, so both are rewritten, and they are rewritten off the same
  // rounded metres so the screen cannot disagree with itself by a minute. The
  // ORDER of state.results is not touched, which is the promise being kept.
  state.selected.metres = metres;
  state.selected.walk = walk;
  const at = $('room').scrollTop;
  // Focus by position, not by node: the markup is rebuilt, so whatever was
  // focused no longer exists. Same room, same shape, so the nth control is the
  // same control. A reader on the Directions link keeps it.
  const stops = () => [...$('room').querySelectorAll('a[href], button, [tabindex]')];
  const focused = stops().indexOf(document.activeElement);
  $('room').innerHTML = roomHtml(id);
  $('room').scrollTop = at;
  wireRoom(id);
  if (focused >= 0) stops()[focused]?.focus({ preventScroll: true });
}

function showRoom(id, { keepDay = false } = {}) {
  const room = state.rooms?.rooms?.[id];
  if (!room) return showList();
  // A room always opens on today. Stepping to Thursday and then tapping a
  // different room should not answer a question about Thursday.
  if (!keepDay) roomDayOffset = 0;
  if (!$('list').hidden) state.listScroll = $('list').scrollTop;
  $('room').innerHTML = roomHtml(id);
  // Before showPane, for the same reason showList clears it before showPane:
  // reframe() composes the camera for a band this decides.
  const r = state.results.find((x) => x.id === id);
  state.selected = r ?? { id, building: room.b, walk: null };
  // Both panes stay in the DOM. That is the whole scroll-restoration
  // mechanism: #list keeps its scrollTop because it was never destroyed.
  showPane('room');
  $('room').scrollTop = 0;
  // Back pops to the entry underneath this one, and openRoom wrote down which
  // screen that is. Outside scheduled hours the room screen opens over the
  // buildings screen, and the label promised a room list that is not there.
  $('back').setAttribute(
    'aria-label',
    history.state?.from === 'near'
      ? 'Back to the nearest buildings'
      : history.state?.from === 'way'
        ? 'Back to the way'
        : 'Back to the room list',
  );

  // frame() below runs only when the room is one of the ranked rows. Opened
  // from a link or out of hours it is not, and the footprint still has to light.
  frames.wake();
  wireRoom(id);
  focusHeading($('room-h'));
  // The sheet DOES grow for this screen now. It used to hold four or five text
  // rows and peek was enough; it holds a day as a calendar, and a calendar
  // whose first two hours are the only ones above the fold is a calendar
  // nobody scrolls. REST carries that height to viewport() as well, so the map
  // composes for the 239px this screen leaves rather than the list's 528.
  setSheet(restNow(), true);
  if (r) {
    markRows();
    frame(r);
  }
}

// Where the room is: the map with the footprint lit, an arrow to it, one plate
// naming it, and the ranking peeked underneath with that room's row lit.
//
// It is not the room screen. That one opens the day as a calendar, and Enes on
// the moment after you have said yes: "the room schedule, like the list of other
// classes is irrelevant". By then the question is which way to walk.
//
// The other ROOMS are a different matter, and they came back the same day they
// went: "the take it and the way should have the other nearby classes at the
// bottom back". One tap on a row moves the arrow and the plate to that room,
// which is the cheapest change of mind the app has.
//
// This does its own pane work rather than calling showPane('list'), because
// showPane names the screen after the pane and this screen is not the list: it
// has a plate, no back arrow, and a selection the list deliberately clears.
function showWay(id) {
  const room = state.rooms?.rooms?.[id];
  if (!room) return showCard();
  // The compass, before anything else, and the reason this line is not just
  // tidiness: the way is reachable FROM the room screen. Take a room, tap its
  // lit row for the calendar, press Point me, then go back. showPane() detaches
  // the two window listeners on the way out of 'room' and this does not go
  // through showPane, so without this they stay bound to nodes the next repaint
  // has already thrown away, and the next room's Point me overwrites the closure
  // that could still have removed them.
  if (orientationOff) orientationOff();
  const r = state.results.find((x) => x.id === id);
  // Before the panes, for the same reason showList and showRoom set it there:
  // reframe() composes the camera for the band this decides.
  state.selected = r ?? { id, building: room.b, walk: null };

  for (const pane of PANES) $(pane).hidden = pane !== 'list';
  $('find').hidden = true;
  $('origin').hidden = true;
  $('ask').hidden = true;
  $('sheet').hidden = false;
  $('back').hidden = true;
  $('menu').hidden = false;
  $('way').hidden = false;
  closeMenu();
  document.body.classList.remove('asking', 'carding');
  // The menu is this screen's only chrome, and it is the same button it was on
  // the card a tap ago, so it is drawn the same: no disc, 40px in a 60px target.
  document.body.classList.add('waying');
  const arrived = state.screen !== 'way';
  state.screen = 'way';
  syncPaneTouch();
  paintWay(id, r);
  markRows();
  sheetHeight();
  // The rows open showing the room the arrow points at. Bin nineteen and take
  // the twentieth and the ranking underneath was still parked at the top, so the
  // lit row -- the whole reason the list is on this screen -- was off the bottom
  // of it. Only when it is actually out of view: take the first room the deck
  // offers, which is the common case, and the lit row is row one already --
  // pinning that to the top would push "You asked for 2h00" off the pane to fix
  // nothing.
  const list = $('list');
  const row = list.querySelector('.row.on');
  if (row) {
    const top = row.offsetTop - list.offsetTop;
    if (top < list.scrollTop || top + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, top - 8);
    }
  }
  if (arrived) reframe();
  frames.wake();
  if (r) frame(r);
  focusHeading($('way-name'));
}

function paintWay(id, r) {
  const room = state.rooms.rooms[id];
  const name = roomLabel(r ?? { id, name: state.buildings?.[room.b]?.name });
  const win = r ? windowOf(r) : null;
  const seats = r ? seatsOf(r) : null;
  const coarse = Number.isFinite(state.accuracy) && state.accuracy > COARSE_M;
  $('way-name').textContent = name;
  $('way-facts').innerHTML = r
    ? [
      `<span>${shortWindow(win)}</span>`,
      '<span class="sep">&middot;</span>',
      `<span>${coarse ? '~' : ''}${r.walk} min</span>`,
      '<span class="sep">&middot;</span>',
      `<span>${seats.html}</span>`,
      // Joined on a newline rather than on nothing, so the line reads as words
      // when it is lifted off the screen -- by a screen reader, by the manifest
      // scripts/shoot.mjs writes, by anything that takes textContent. The flex
      // container drops a whitespace-only node, so nothing about the rendering
      // changes; the card's markup has always had the same gaps in it.
    ].join('\n')
    : '<span>on the map</span>';
  say(`${name}. ${r ? `${r.walk} minute walk. ` : ''}The map is showing you the way.`);
}

// Its own history entry, so the phone's back gesture, the menu's Back, and a
// pull on the sheet's grip all land on the card that was showing. The grip's
// dismiss travel is the sheet's own, unchanged: it calls toAsk(), which is
// history.back(), and from here that is one step.
function openWay(id) {
  history.pushState({ v: 'way', room: id }, '', `?room=${encodeURIComponent(id)}`);
  showWay(id);
}

function toAsk() {
  if (state.screen === 'ask') return;
  history.back();
}

const cleanUrl = () => location.pathname + location.hash;

function choose(min) {
  // Belt and braces. The controls carry `disabled` until boot() finishes, but a
  // caller reaching here early would read state.rooms as null and throw.
  if (!state.ready) return;
  state.duration = String(min);
  safeSet(KEY_DURATION, state.duration);
  paintDuration();
  if (!state.rankable) return;
  if (!state.scheduled) {
    if (state.screen !== 'near') {
      history.pushState({ v: 'near' }, '', cleanUrl());
      showNear();
    }
    return;
  }
  if (state.screen === 'ask') history.pushState({ v: 'card' }, '', cleanUrl());
  // Ranked BEFORE the screen is shown. The other way round, paintCard() ran once
  // against the previous answer -- on the first duration of a session that is no
  // rows at all, so the reader got "That is all of them. You went through 0
  // rooms", and focusHeading() moved focus onto a heading answer() then replaced,
  // dropping a keyboard reader on the body. answer() paints both screens itself,
  // and showCard() paints again over a deck that now exists.
  answer();
  showCard();
}

function openRoom(id) {
  rememberPick(id);
  // The screen underneath, kept in the entry rather than in a variable, so a
  // reopen from popstate names the same pane a press of back will reach.
  history.pushState({ v: 'room', room: id, from: state.screen }, '', `?room=${encodeURIComponent(id)}`);
  showRoom(id);
}

// The ranking, from the card. Its own history entry, so Back off the list
// lands on the card the reader came from rather than on the question.
function openList() {
  history.pushState({ v: 'list', from: state.screen }, '', cleanUrl());
  showList();
}

function openPick() {
  history.pushState({ v: 'pick' }, '', cleanUrl());
  showPick();
}

function openAbout() {
  history.pushState({ v: 'about' }, '', cleanUrl());
  showAbout();
}

function openNear() {
  history.pushState({ v: 'near' }, '', cleanUrl());
  showNear();
}

// A room link can arrive while dev mode is still restoring its saved clock.
// On a real-world refusal day (Labor Day is the useful example), boot cannot
// open the room yet; devApply retries this after the simulated minute has made
// the app rankable. Only retry from the question screen so changing the dev
// clock while already viewing a room does not grow browser history.
function openWantedRoom() {
  if (!state.ready || state.screen !== 'ask' || !state.rankable) return false;
  const wanted = new URLSearchParams(location.search).get('room');
  if (!wanted || !state.classRooms?.rooms?.[wanted]) return false;
  if (state.scheduled) {
    showCard();
    answer();
    history.replaceState({ v: 'card' }, '', cleanUrl());
  } else {
    showNear();
    history.replaceState({ v: 'near' }, '', cleanUrl());
  }
  openRoom(wanted);
  return true;
}

// Recompute. Never on a timer: a list that re-sorts under a thumb loses the row
// somebody was reaching for. This fires when the app comes back to the
// foreground, when the duration changes, and when the user asks.
function refresh() {
  if (!state.classRooms || !state.roomEvents) return;
  const now = clockNow();
  state.situation = resolveState({ now, current: state.current, index: state.classRooms });
  const overlaid = scheduleFor(now, !!state.situation?.classesSuspended);
  state.rooms = overlaid.index;
  state.eventCoverage = overlaid.coverage;
  state.situation = resolveState({ now, current: state.current, index: state.rooms });
  state.rankable = state.situation.ranked;
  state.scheduled = roomSearchOn({ now, current: state.current, index: state.rooms, ranked: state.rankable });
  paintGate();
  if (!state.rankable) {
    if (state.screen !== 'near' && state.screen !== 'about') showAsk();
    return;
  }
  if (!state.scheduled) {
    if (['card', 'list', 'room', 'way'].includes(state.screen)) showNear();
    else if (state.screen === 'near') paintNear(nearReason());
    return;
  }
  if (state.screen === 'near') showCard();
  // answer() drops the selection and rebuilds the deck, and on the way that
  // leaves a plate naming a room over a map paintMap() has just switched off:
  // nothing is targeted any more, so body.nomap goes on, taking the footprint
  // and the walk line with it. Two ways in, both new -- the menu's Check again,
  // and the same button in the list footer, which is now scrollable underneath
  // the plate. So the screen is re-entered after the re-rank, on the same room
  // if it survived it and on the card if it did not, which is the honest answer
  // to "check again" when the room you took has just been taken by a class.
  const held = state.screen === 'way' ? state.selected?.id : null;
  answer();
  if (!held) return;
  if (state.results.some((r) => r.id === held)) showWay(held);
  else {
    history.replaceState({ v: 'card' }, '', cleanUrl());
    showCard();
  }
}

// The question screen has three shapes, and which one it wears is decided
// before any room is ranked.
function paintGate() {
  const s = state.situation;
  const now = clockNow();
  const stale = staleness({ now, current: state.current });
  $('stale').hidden = stale.level === 'silent' || stale.level === 'gated';
  $('stale').textContent = stale.text;
  $('stale').classList.toggle('banner', stale.level === 'banner');
  const weekendSearch = (now.getDay() === 0 || now.getDay() === 6) && s?.ranked && state.scheduled;
  $('weekend-note').hidden = !weekendSearch;
  $('weekend-note').textContent = weekendSearch ? s.note ?? '' : '';

  // Cleared before the branch, so a gate hidden by a ranked minute cannot keep
  // the orange either. index.html says what the colour means.
  $('gate').classList.remove('refusal');

  if (!s || s.ranked) {
    $('gate').hidden = true;
    $('ask-q').hidden = false;
    if (!state.scheduled && state.ready) {
      $('ask-q').hidden = true;
      // Not UNSCHEDULED. That pair belongs to the buildings screen, and
      // borrowing it here printed "Nearest buildings" over an empty paragraph,
      // above a button reading "Show nearest buildings".
      const said = unscheduledGate({
        now,
        current: state.current,
        index: state.rooms,
        busyDay: busyDayOf(state.current, state.rooms),
        opening: firstDoor(now),
        openNow: openDoorCount({
          counts: state.counts,
          hoursFor,
          day: now.getDay(),
          nowMin: nowMinutes(now),
        }),
      });
      $('gate-h').textContent = said.heading;
      $('gate-p').textContent = said.body;
      $('gate-d').hidden = true;
      $('gate-go').hidden = false;
      $('gate-go').textContent = 'Show nearest buildings';
      const fresh = $('gate').hidden;
      $('gate').hidden = false;
      if (fresh) focusHeading($('gate-h'));
    }
    return;
  }

  $('ask-q').hidden = true;
  $('gate').classList.add('refusal');
  $('gate-h').textContent = s.heading;
  $('gate-p').textContent = s.body;
  $('gate-d').textContent = s.detail ?? '';
  $('gate-d').hidden = !s.detail;
  $('gate-go').hidden = !s.action;
  if (s.action) $('gate-go').textContent = s.action.label;
  const fresh = $('gate').hidden;
  $('gate').hidden = false;
  if (fresh) focusHeading($('gate-h'));
}

// ---------------------------------------------------------------- geolocation

// A deliberate choice does not expire the way a sensor reading does, so a
// picked building is read back before geolocation is ever asked.
function pickedOrigin() {
  try {
    const raw = JSON.parse(safeGet(KEY_ORIGIN) ?? 'null');
    if (raw && Number.isFinite(raw.lat) && Number.isFinite(raw.lon)) {
      return { accuracy: PICKED_ACCURACY_M, source: 'picked', ...raw };
    }
  } catch {
    /* a corrupt key is the same as no key */
  }
  return null;
}

// The circle OFF_CAMPUS_KM draws, in the flat conversion that constant is
// documented against. It is a function rather than a line inside locate()
// because it has to run on EVERY accepted position and not only the first: a
// student who walks out of the circle with the app open used to keep a ranking
// measured from the last point inside it, and never saw the note.
const offCampus = (here) => Math.hypot((here.lon - OVAL.lon) * 85, (here.lat - OVAL.lat) * 111) > OFF_CAMPUS_KM;

function locate() {
  const picked = pickedOrigin();
  if (picked) return Promise.resolve({ origin: picked, note: null });

  const oval = ovalOrigin();
  return new Promise((resolve) => {
    let done = false;
    const finish = (origin, note) => {
      if (done) return;
      done = true;
      resolve({ origin, note });
    };
    // The wall-clock watchdog. iOS documents its own timeout option as
    // unreliable in a standalone window.
    const watchdog = setTimeout(() => finish(oval, 'Location timed out, showing from the Oval'), FIX_TIMEOUT_MS);
    if (!navigator.geolocation) {
      clearTimeout(watchdog);
      return finish(oval, 'No location on this device, showing from the Oval');
    }
    const fail = (why) => {
      clearTimeout(watchdog);
      finish(oval, `${why}, showing from the Oval`);
    };
    try {
      navigator.geolocation.getCurrentPosition(
        (p) => {
          clearTimeout(watchdog);
          const here = { lon: p.coords.longitude, lat: p.coords.latitude };
          if (offCampus(here)) return finish(oval, NO_WALK_OVAL);
          finish(
            { ...here, accuracy: p.coords.accuracy, source: 'gps', label: null, at: Date.now() },
            null,
          );
        },
        (err) =>
          fail(err.code === 1 ? 'Location is off' : err.code === 2 ? 'Location unavailable' : 'Location timed out'),
        // A minute-old fix is accepted HERE and nowhere else. This call is on
        // the path to the first answer, the student has not walked anywhere
        // yet, and a cached position saves them the cold-start wait. The watch
        // below takes maximumAge 0 for the opposite reason.
        { enableHighAccuracy: false, timeout: FIX_TIMEOUT_MS, maximumAge: 60000 },
      );
    } catch {
      // A position source that throws on call is not a state the spec allows,
      // and it happens anyway inside locked-down webviews.
      fail('Location is unavailable');
    }
  });
}


// ---------------------------------------------------------------- the watch
//
// locate() answers once. This is what keeps the answer true while the student
// walks, which is the whole of issue #87: one fix at boot meant every walk
// figure described a place they had already left.
//
// What it must not do is re-sort the list under a thumb, the rule refresh() is
// written around. followAction() in js/state.js holds that line and this
// function does what it says: a position that lands on the room screen, on a
// selected row, under a finger or on a scrolled list moves the dot and nothing
// else.
// The handle lives in js/state.js as a state machine, with the geolocation
// object and the visibility predicate injected, because js/app.js cannot be
// imported under node and a suite that can only regex this file is a suite that
// misses clearWatch(0). See createWatch's comment for the five mutations that
// survived while this was inline.
//
// The last position acted on, which is deliberately not state.origin. Off
// campus, and on a stranded ranking, state.origin is the Oval, and measuring
// the next fix against the Oval would accept every one of them.
let lastFix = null;
let lastFixAt = 0;

const watch = createWatch({
  geolocation: () => navigator.geolocation,
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  onFix,
  onError: onWatchError,
  options: {
    // Unchanged from the boot fix, and load-bearing. High accuracy is what
    // holds the GPS chip awake, and ranking by walk minutes across a campus
    // 2.2 km wide has never needed 5 m.
    enableHighAccuracy: false,
    // Zero, where the boot fix takes one up to a minute old. A minute of
    // walking is 78 m at WALK_MPM, nearly twice FOLLOW_M, so a cached fix here
    // is exactly the staleness this watch exists to remove.
    maximumAge: 0,
  },
});

function startWatch() {
  watch.start(state.origin);
}

// A watch left running behind a locked screen keeps asking the phone where it
// is for a list nobody can see, which is a battery complaint and nothing else.
// Nothing is lost by dropping it: the page comes back through refresh().
function stopWatch() {
  watch.stop();
}

function onWatchError(err) {
  // A denied permission is terminal on iOS, with no way back to the prompt from
  // inside a web page, so nothing will ever arrive and the watch is closed
  // rather than left holding the callback.
  if (err?.code === 1) stopWatch();
  // Every other code is a fix that did not turn up. The origin on screen is
  // then as old as it would have been before any of this existed, so nothing is
  // said and nothing already on screen is thrown away.
}

function onFix(p) {
  // Asked BEFORE anything is written, because the first answer is a refusal to
  // write at all.
  const act = followAction({
    screen: state.screen,
    selected: state.selected,
    dragging: state.dragging,
    picked: state.origin?.source === 'picked',
    scrolled: PANES.some((id) => !$(id).hidden && $(id).scrollTop > 0),
  });
  // A building was picked while the watch was running. A deliberate choice is
  // not a sensor reading and must never be overwritten by one.
  if (act === 'stop') return stopWatch();

  const here = { lon: p.coords.longitude, lat: p.coords.latitude };
  const at = Date.now();
  const moved = followFix({
    movedM: lastFix ? distanceMetres(lastFix, here) : Infinity,
    sinceMs: lastFix ? at - lastFixAt : Infinity,
  });
  if (!moved) return;
  lastFix = here;
  lastFixAt = at;

  const far = offCampus(here);
  useOrigin(
    far ? ovalOrigin() : { ...here, accuracy: p.coords.accuracy, source: 'gps', label: null, at },
    far ? NO_WALK_OVAL : null,
  );

  // The dot and the line are drawn off state.origin on the next frame, so both
  // have already moved by the time this runs. All that is left to decide is who
  // is allowed to re-order.
  if (act === 'rank') refresh();
  else if (act === 'room') repaintRoom();
}

// Called once the boot fix has landed. The watch starts AFTER it, not beside
// it: two position callbacks racing to be the first origin is two answers to
// the question the app opens with.
function follow(origin) {
  if (origin?.source === 'gps') {
    lastFix = { lat: origin.lat, lon: origin.lon };
    lastFixAt = origin.at ?? Date.now();
  }
  startWatch();
}

// ---------------------------------------------------------------- boot

// The abbreviation on the door lives in the full building table, which is 167 KB
// and has nothing else the app wants. It is fetched only when the picker opens,
// so it never sits on the path to a first answer, and the picker works without
// it: the rows are already tappable, the codes just arrive late.
let shortsPending = null;
function loadShorts() {
  if (state.shorts || shortsPending) return shortsPending;
  shortsPending = fetch(`${BASE}data/buildings.json`)
    .then((r) => r.json())
    .then((d) => {
      state.shorts = Object.fromEntries(Object.entries(d.buildings).map(([code, b]) => [code, b.short]));
      if (state.screen === 'pick') paintPick();
    })
    .catch(() => {
      /* the picker keeps working, without the two-letter codes */
    });
  return shortsPending;
}

// The room index is 191 KB of the 241 KB of JSON the first answer waits on, so
// it is the parse worth naming. `r.json()` hides it inside the fetch, and a
// cold phone spends real time in there. The engine marks the answer and the
// session mask with the same two calls.
async function parsedIndex(url, signal) {
  const text = await fetch(url, { signal }).then(answered).then((r) => r.text());
  mark('vacant:parse:start');
  const out = JSON.parse(text);
  mark('vacant:parse:end');
  measure('vacant:parse', 'vacant:parse:start', 'vacant:parse:end');
  return out;
}

// fetch resolves on a 5xx, so an error page reaches JSON.parse as if it were the
// schedule. Measured against a server answering 503 with the body "503": that is
// valid JSON, state.rooms became the number 503, and the app went on to blame
// its own weekly build for reading too few rooms.
function answered(r) {
  if (!r.ok) throw new Error(`${r.status} for ${r.url}`);
  return r;
}

async function boot() {
  // A network that stalls does not fail. Nothing rejects, so every step below
  // sits on it forever. One deadline covers the whole path to a first answer and
  // rejects into the same catch a 503 does. The position carries its own.
  const signal = AbortSignal.timeout(NETWORK_TIMEOUT_MS);
  const json = (f) => fetch(`${BASE}data/${f}`, { signal }).then(answered).then((r) => r.json());

  flyoverStart = performance.now();
  frames.wake();

  // Geolocation starts immediately and runs beside the fetches, so the two
  // waits overlap instead of queueing.
  const fix = locate();

  // The map is a layer, not the app. A missing or broken campus.json costs the
  // map and nothing else, so it is not awaited with the data the list needs.
  json('campus.json')
    .then((campus) => {
      state.campus = campus;
      const shorter = Math.min(window.innerWidth, window.innerHeight) || 390;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      state.basemap = buildBasemap(campus, pixelsPerGridFor(campus, shorter, dpr));
      // The first frame with anything to draw on it. render() paints nothing and
      // asks for nothing while state.basemap is null, so without this the map
      // stays black until the next tap.
      frames.wake();
      if (state.settled) settle();
    })
    .catch(() => {
      $('map').hidden = true;
      // The canvas going away leaves the sheet resting where it always rests
      // and nothing above it: measured at 393x852 with data/campus.json blocked
      // over CDP, the sheet's top edge is y=528, so 62.0% of the phone is black
      // with no explanation on it. state.mapless is what paintList() prints and
      // what the live region reads out. #53
      state.mapless = true;
      // The fetch goes out in boot()'s first tick and the first answer needs a
      // position and three more files, so in every run measured this lands long
      // before any list exists. The repaint is for the run where it does not,
      // which a 20 second AbortSignal timeout can produce.
      if (state.results.length) paintList();
      console.warn('Vacant: no basemap. The list still answers.');
    });

  const current = await json('current.json');
  state.current = current;

  // Which rooms have a photograph. Off the critical path on purpose, the same
  // way campus.json is: it is 2 KB and the answer does not need it, so a card
  // painted before it lands is a card without a picture rather than a card that
  // waited. Repaints when it arrives, but only if the card is what is on screen.
  json('photos.json')
    .then((list) => {
      state.photos = new Set(list.rooms ?? []);
      if (state.screen === 'card') paintCard();
    })
    .catch(() => {
      // No manifest, no pictures, every other thing this app does still works.
      state.photos = new Set();
    });

  const [rooms, roomEvents, buildings, hours, walkGraph, located] = await Promise.all([
    parsedIndex(`${BASE}${current.rooms}`, signal),
    fetch(`${BASE}${current.events}`, { signal }).then(answered).then((r) => r.json()),
    fetch(`${BASE}${current.buildings}`, { signal }).then(answered).then((r) => r.json()).then((d) => d.buildings),
    json('buildings-hours.json').catch(() => null),
    // AWAITED, unlike the photo manifest below, and that is the whole reason
    // the walk model cannot flip under a reader. A graph that arrived after the
    // first ranking would reorder a list already on screen, which is the
    // asynchronous failure #115 names. It is 21 KB gzipped, it is in the
    // service worker's shell, and offline it comes from the cache.
    json('walk-graph.json').catch(() => null),
    fix,
  ]);
  state.classRooms = rooms;
  state.roomEvents = roomEvents;
  const now = clockNow();
  state.situation = resolveState({ now, current, index: rooms });
  const overlaid = scheduleFor(now, !!state.situation?.classesSuspended);
  state.rooms = overlaid.index;
  state.eventCoverage = overlaid.coverage;
  state.buildings = buildings;
  // Built once, before useOrigin below asks it for a field. A missing or
  // unreadable file leaves this null and every walk falls back to the straight
  // line, which is what the app did before #115 and still does off campus.
  state.router = createRouter(decodeWalkGraph(walkGraph), buildings);
  // Beside the router and not instead of it. An empty or missing key builds
  // null, which is the signal roomHtml reads to render no Directions button at
  // all -- a key nobody has configured must not leave a control that cannot
  // work. Consent is read on every call rather than captured here, so it is
  // still the student's to give and to take back.
  state.directions = createDirections({
    key: document.querySelector('meta[name="google-maps-key"]')?.content?.trim() ?? '',
    consent: () => state.googleConsent === true,
  });
  state.counts = roomsPerBuilding(rooms);
  state.hours = hours;
  const [slug, table] = pickHoursTerm(hours, current);
  state.hoursSlug = slug;
  state.hoursTerm = table;
  useOrigin(located.origin, located.note);
  follow(located.origin);

  state.situation = resolveState({ now, current, index: state.rooms });
  state.rankable = state.situation.ranked;
  // state.rooms, the overlaid index, and not the raw class index. refresh()
  // asks the same question of the overlaid one, and the two are not the same
  // index: the overlay adds the week's registered events and a one-date
  // session, which moves both the share scheduleDarkOn reads and the quantiles
  // busyDayOf measures. Boot and the first repaint could answer differently
  // about the same minute.
  state.scheduled = roomSearchOn({ now, current, index: state.rooms, ranked: state.rankable });

  state.ready = true;
  for (const el of document.querySelectorAll('#ask [data-min][disabled]')) el.disabled = false;
  paintNeedsAvailability();
  $('ask').classList.add('ready');
  paintDuration();
  paintGate();
  performance.mark('vacant:ready');

  // A shared link opens on the room it names, with one screen behind it. Which
  // screen is not a detail: the ranked list is a claim about the whole campus,
  // and outside scheduled hours that claim is exactly the one this app refuses
  // to make. Opening the list here anyway put 40 rows one back press behind a
  // link tapped at 3am on a Saturday, with the reason sentence nowhere.
  openWantedRoom();
}

// Nothing came back, or what came back was not a schedule. The old catch left
// the spinner turning over four dead buttons and one sentence with no button on
// it, so the only exit was knowing to reload. It refuses in the card every other
// refusal uses instead, with the one control that can still change the answer.
function bootFailed() {
  // js/firstrun.js owns the refusal when nothing is cached, and its card is
  // modal and opaque. A second one under it is unreadable and still tabbable.
  if ($('cold')) return;
  $('ask-q').hidden = true;
  $('gate-h').textContent = 'Could not load the schedule.';
  $('gate-p').textContent = 'Vacant needs the network once to read this term.';
  $('gate-d').hidden = true;
  $('gate-go').hidden = false;
  $('gate-go').textContent = 'Try again';
  // A reload, not a second boot(): boot() starts a render loop and a position
  // request, and running it twice on one page is not a state this app has.
  $('gate-go').onclick = () => location.reload();
  $('gate').hidden = false;
  // "finding campus..." is keyed to #ask:not(.ready), which never clears here.
  $('ask').classList.add('failed');
  focusHeading($('gate-h'));
}

window.addEventListener('DOMContentLoaded', () => {
  attachNeeds();
  for (const b of document.querySelectorAll('#ask [data-min]')) {
    b.onclick = () => choose(b.dataset.min);
  }
  $('back').onclick = () => history.back();
  $('gate-go').onclick = () => openNear();
  $('ask-pick').onclick = () => openPick();
  $('note-pick').onclick = () => openPick();
  $('origin-where').onclick = () => openPick();
  $('origin-clear').onclick = () => clearPickedOrigin();
  $('find').onsubmit = (e) => e.preventDefault();
  $('find-q').oninput = (e) => {
    state.query = e.target.value;
    paintPick();
  };

  window.addEventListener('popstate', (e) => {
    const v = e.state?.v;
    if (v === 'room') showRoom(e.state.room);
    else if (v === 'way') showWay(e.state.room);
    else if (v === 'card') {
      if (state.preferencesDirty) answer();
      showCard();
    }
    else if (v === 'list') {
      if (state.preferencesDirty) answer();
      showList();
    }
    else if (v === 'near') showNear();
    else if (v === 'pick') showPick();
    else if (v === 'about') showAbout();
    else showAsk();
  });

  // Coming back to the foreground is the one moment the answer on screen is
  // certainly stale: the walk happened, the class started, and it may not even
  // be the same day.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return stopWatch();
    startWatch();
    // The question screen is in this list because the night gate's heading is a
    // live minute. Left out, a card booted at 11:40pm on a Monday still read
    // "Monday, 11:40pm" at 10:00am on the Tuesday, on a minute the app ranks.
    if (['card', 'list', 'near', 'ask'].includes(state.screen)) refresh();
  });

  attachSheet();
  attachMenu();
  window.addEventListener('resize', () => {
    if (state.screen !== 'ask') sheetHeight();
    // surface() reallocates the backing store on the next frame and the band
    // moves with the height, so a resize that does not reach the loop leaves a
    // stretched bitmap composed for the old screen.
    frames.wake();
  });

  // js/install.js writes --bar-h on the body when the install rail mounts or is
  // dismissed, and railHeight() feeds the band the map centres in. That is the
  // one layout change the app makes that no event announces, and --bar-h is the
  // only inline style anything sets on the body.
  //
  // It resizes the SHEET as well now, not just the map: a screen covering the
  // map stops where the back button is, the rail stands the sheet on top of
  // itself, and both come out of the same headroom. Left out, the rail arriving
  // under a 776px list at 393x852 put the sheet's top edge at -4px and took the
  // grip and the back button off screen with it.
  new MutationObserver(() => {
    if (state.screen !== 'ask') sheetHeight();
    frames.wake();
  }).observe(document.body, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // Drag to pan, wheel or pinch to zoom. Once a finger has moved the camera the
  // app stops reframing on selection, otherwise every row tap would undo it.
  attachGestures($('map'), {
    onPan: (dx, dy) => {
      if (!state.basemap || !state.view) return;
      state.view = panBy(state.view, dx, dy, state.basemap, viewport());
      state.userMoved = true;
      frames.wake();
    },
    onZoom: (factor, anchor) => {
      if (!state.basemap || !state.view) return;
      state.view = zoomBy(state.view, factor, state.basemap, viewport(), anchor);
      state.userMoved = true;
      frames.wake();
    },
  });

  armDev();

  boot().catch(bootFailed);
});

// ------------------------------------------------------------- the dev seam
//
// Three functions, imported by js/dev.js and by nothing else. They exist
// because the interesting states of this app are all somewhere else: exam week,
// Thanksgiving, 9pm on a Saturday, standing in Kottman Hall. Every one of them
// used to need a plane ticket or a December.
//
// The clock and origin are not mocks: devApply moves the same values the app
// reads, then calls the same refresh() the duration buttons call.

export { state as devState };

// Move the clock, the place, or both, and repaint whatever screen is up.
export function devApply({ at, origin, note } = {}) {
  if (at !== undefined) pinClock(at);
  if (origin !== undefined) useOrigin(origin, note ?? null);
  if (!state.ready) return;
  state.day = clockNow().getDay();
  refresh();
  if (!openWantedRoom() && state.screen === 'ask') paintGate();
}

// What the app currently believes, for the panel's readout. A copy, so the
// panel cannot write to it by accident.
export function devReadout() {
  return {
    ready: state.ready,
    screen: state.screen,
    when: clockNow().toString(),
    // Whether the minute on screen is the real one. The panel says so out
    // loud, because a simulated clock that looks live is how you end up
    // reporting a bug against a Tuesday in November.
    simulated: clockIsPinned(),
    day: state.day,
    rankable: state.rankable,
    scheduled: state.scheduled,
    refused: state.situation?.refused ?? null,
    heading: state.situation?.heading ?? null,
    duration: state.duration,
    total: state.total ?? null,
    origin: state.origin ? { ...state.origin } : null,
    top: (state.results ?? []).slice(0, 3).map((r) => ({
      id: r.id,
      name: r.name,
      walk: r.walk,
      usable: r.usable,
      hoursKnown: r.hoursKnown,
    })),
  };
}

// --------------------------------------------------------------- arming dev
//
// js/dev.js is loaded on demand and is not in the service worker's shell list,
// so a student who never asks for it never downloads it: it costs the shipped
// app one import() call and nothing over the wire. Ask for it with ?dev=1 in
// the URL, with #dev, or by pressing D three times.
//
// The choice is remembered in sessionStorage, because the app rewrites its own
// URL on the first history entry it pushes and a query string does not survive
// that.
const DEV_KEY = 'vacant.dev';

// A SCENE goes further: one URL that also stands you somewhere, on a day, at a
// minute. `?dev=1` opens the panel on the live moment, which at 10pm is a
// campus with every door shut and an app correctly refusing to answer -- true,
// and impossible to look at. `?dev1` opens the same panel already somewhere
// worth looking at. js/dev.js owns what each name means.
//
// Three spellings because all three get typed, and the difference between
// `?dev=1` and `?dev1` is one character.
const SCENE = /^dev\d+$/;

function devScene(url, hash) {
  for (const key of url.keys()) if (SCENE.test(key)) return key;
  const value = url.get('dev');
  if (value && SCENE.test(value)) return value;
  const name = hash.replace(/^#/, '');
  return SCENE.test(name) ? name : null;
}

function openDev(scene) {
  if (document.getElementById('dev')) return;
  import('./dev.js')
    .then((m) => m.start(scene))
    .catch(() => {
      /* a dev panel that will not load is not worth breaking the app over */
    });
}

function armDev() {
  let armed = false;
  let scene = null;
  try {
    const url = new URLSearchParams(location.search);
    scene = devScene(url, location.hash);
    if (url.get('dev') === '1' || location.hash === '#dev' || scene) {
      sessionStorage.setItem(DEV_KEY, '1');
    }
    armed = sessionStorage.getItem(DEV_KEY) === '1';
  } catch {
    /* private mode with storage off is simply not in dev mode */
  }
  if (armed) {
    state.dev = true;
    openDev(scene);
  }

  let hits = [];
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'd' && e.key !== 'D') return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const t = Date.now();
    hits = hits.filter((h) => t - h < 2000);
    hits.push(t);
    if (hits.length < 3) return;
    hits = [];
    try {
      sessionStorage.setItem(DEV_KEY, '1');
    } catch {
      /* still opens, just does not survive a reload */
    }
    state.dev = true;
    openDev();
  });
}
