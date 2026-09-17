// Parse the Registrar's classroom pool building schedule.
//
// Pure. No node builtins, no fetch. The HTML comes in as a string.
//
// Measured against the live Autumn 2026 and Summer 2026 pages: 47 buildings
// each, zero <table> elements, one div.panel.panel-default per building.

// 0 = Sunday through 6 = Saturday, matching Date.prototype.getDay().
export const DAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const DAY_NAMES = Object.keys(DAY_INDEX);

const strip = (html) => html.replace(/<[^>]+>/g, '');
const squash = (s) => s.replace(/\s+/g, ' ').trim();

// Entities the page actually uses.
// &amp; LAST. Decoded first it rebuilds the entities below it out of their own
// escaped forms -- `&amp;lt;` becomes `&lt;` becomes `<` -- and strip() has
// already run by the time this is called, so that `<` arrives as markup nothing
// downstream removes.
const decode = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

// "7am" -> 420, "5:30pm" -> 1050, "12:30pm" -> 750.
//
// A 12am CLOSE is 1440, not 0. "7am-12am" is a building open until midnight,
// and mapping it to 0 makes the open window negative and the room invisible.
export function parseClock(text, { isClose = false } = {}) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*$/i.exec(text ?? '');
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const pm = m[3].toLowerCase() === 'p';
  // Midnight. As an OPEN time 12:30am is 30 minutes past midnight. As a CLOSE
  // it is 24 hours and 30 minutes into the day the building opened. Handling
  // only the whole hour made "7am-12:30am" throw "close is not after open",
  // halting a term build and misreporting a well-formed cell as a typo.
  if (hour === 12 && !pm) return isClose ? 1440 + minute : minute;
  const base = hour === 12 ? 12 * 60 : hour * 60;
  return base + minute + (pm && hour !== 12 ? 720 : 0);
}

// One day cell. Returns null for a closed day, [open, close] for an open one,
// or throws so the caller can name the building and the raw text. Never guesses.
export function parseDayCell(raw) {
  const text = squash(decode(raw ?? '')).replace(/\.$/, '');
  if (!text) throw new Error('empty cell');
  if (/^closed$/i.test(text)) return null;

  // Observed separators: "-", "to", and the two dashes a CMS likes to insert.
  const m = /^(.+?)\s*(?:-|–|—|\bto\b)\s*(.+)$/i.exec(text);
  if (!m) throw new Error(`no open/close separator in ${JSON.stringify(text)}`);

  const open = parseClock(m[1]);
  const close = parseClock(m[2], { isClose: true });
  if (open == null) throw new Error(`unparseable open time in ${JSON.stringify(text)}`);
  // This is the Caldwell Lab case: "7am-10", a close with no am/pm. Four cells
  // live on the Autumn 2026 page and four more on Summer 2026. It is a
  // Registrar typo and it belongs to the Room and Class Scheduling Office, not
  // to a parser that quietly picks a meaning.
  if (close == null) throw new Error(`unparseable close time in ${JSON.stringify(text)}`);
  if (close <= open) throw new Error(`close is not after open in ${JSON.stringify(text)}`);
  return [open, close];
}

// "Ag. Admin. (AA) | 2120 Fyffe Road" -> { name, abbr, address }
export function parseTitle(raw) {
  const text = squash(decode(strip(raw ?? '')));
  const m = /^(.*?)\s*\(([A-Z0-9]{1,4})\)\s*\|?\s*(.*)$/.exec(text);
  if (!m) return null;
  return { name: m[1].trim(), abbr: m[2], address: m[3].trim() || null };
}

// Pull the day list out of one panel body.
//
// THE TRAP: a panel can hold more than one full week. 9 of the 47 Autumn 2026
// buildings do, and Orton Hall holds three: DAY HOURS, then Library Hours, then
// Lab Hours. The regex the research recommends, matching /(Monday|...):\s*(.*)/
// across the whole body, takes the LAST match for each day, so Ag. Admin.
// silently ships its library's 8am-6pm instead of the building's 7am-8pm.
//
// Orton makes it worse than wrong hours: its Lab block runs Monday to Friday
// only, so a last-wins parse splices lab hours onto the building's own weekend
// and produces a week that exists nowhere on the page.
//
// So: take the FIRST <ul> that follows the DAY HOURS heading. Sullivant Hall
// puts a note paragraph between the two, which is why paragraphs are skipped.
export function extractDayList(body) {
  const m = /DAY\s+HOURS\s*:?\s*<\/p>\s*(?:<p>.*?<\/p>\s*)*?<ul>([\s\S]*?)<\/ul>/i.exec(body);
  if (m) return m[1];
  // No DAY HOURS heading at all: fall back to the first list in the panel
  // rather than the whole body, so a second week still cannot win.
  const first = /<ul>([\s\S]*?)<\/ul>/i.exec(body);
  return first ? first[1] : null;
}

export function parsePanel(panel) {
  // Tolerate further attributes after aria-controls; the CMS is free to add them.
  const titleRaw = /aria-controls="[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(panel);
  const title = parseTitle(titleRaw ? titleRaw[1] : '');
  // A panel whose title markup drifts must NOT be dropped. Silently discarding
  // it puts the building into unknownHours, so the app reports "hours not
  // published" for a building whose hours are published, which is the exact
  // dishonesty this scraper exists to prevent.
  if (!title) {
    const raw = squash(decode(strip(titleRaw ? titleRaw[1] : panel.slice(0, 200))));
    return { unparseable: true, raw, hours: new Array(7).fill(undefined), errors: [], daysFound: 0 };
  }

  const bodyMatch = /panel-body["'\s>]([\s\S]*?)(?:<\/div>)/i.exec(panel);
  const body = bodyMatch ? bodyMatch[1] : '';
  const list = extractDayList(body);

  const hours = new Array(7).fill(undefined);
  const errors = [];

  if (list) {
    for (const day of DAY_NAMES) {
      const cell = new RegExp(`${day}\\s*:\\s*([\\s\\S]*?)</`, 'i').exec(list);
      if (!cell) continue;
      const raw = squash(decode(strip(cell[1])));
      try {
        hours[DAY_INDEX[day]] = parseDayCell(raw);
      } catch (err) {
        errors.push({ day, raw, message: err.message });
      }
    }
  }

  // daysFound is load bearing, not diagnostics. `undefined` means the day never
  // appeared in the list, and collapsing that to null would publish it as
  // CLOSED. A panel rendering "Monday-Thursday: 7am-10pm" as one <li> yields
  // daysFound 4 with zero errors, and would ship three days of a building open
  // until 10pm as closed.
  const missing = Object.entries(DAY_INDEX)
    .filter(([, i]) => hours[i] === undefined)
    .map(([day]) => day);
  return { ...title, hours, errors, daysFound: 7 - missing.length, missing };
}

export function parsePage(html) {
  // The page has zero <table> elements, so a table parser finds nothing.
  const panels = String(html).split('panel panel-default').slice(1);
  // Never .filter(Boolean) here. The caller has to see every panel, including
  // the ones that would not parse, or buildings vanish without a word.
  return panels.map(parsePanel);
}
