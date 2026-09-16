// The other half of "free", copied out of js/app.js.
//
// engine.vendor.js is a byte copy of js/engine.js and holds the schedule rules.
// But rank() only knows about doors through the hoursFor callback the app hands
// it, and that callback lives in js/app.js, which is a DOM module a standalone
// page cannot import. So these two functions are copied by hand from
// js/app.js (pickHoursTerm, hoursFor), with the app's `state` lifted into an
// argument and nothing else changed.
//
// Copied by hand means it can drift. spikes/hours.vendor.test.mjs holds a
// tripwire on the app source and a behavioural check against the real table.

// The term the app is SERVING, not whichever table happens to be biggest.
// Picking the fullest one worked only because Autumn has 47 buildings against
// Summer's 46; during Summer term it would have ranked every room against
// Autumn's hours.
export function pickHoursTerm(hours, current) {
  const want = (current?.termName ?? '').toLowerCase().replace(/\s+/g, '-');
  const terms = Object.entries(hours?.terms ?? {});
  // Every slug startsWith(''), so a current.json with no termName would take
  // the first term in the table rather than none. Same guard as js/app.js.
  const exact = want ? terms.find(([slug]) => slug.startsWith(want)) : null;
  if (exact) return exact[1];
  return null;
}

// An [open, close] pair, null for published-closed, undefined for a building
// nobody publishes at all. The three are not interchangeable, and undefined is
// the majority case.
export function makeHoursFor(hoursTerm) {
  return function hoursFor(code, day) {
    const rec = hoursTerm?.buildings?.[code];
    if (!rec) return undefined;
    return rec.hours[day];
  };
}
