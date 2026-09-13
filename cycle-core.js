// ══════════════════════════════════════════════════════════
// CRIMSON TIDE TRACKER — CYCLE CORE
//
// The side-effect-free half of the app: date handling, averages, the phase
// projection and the day classifier. It touches no DOM and no storage, so the
// browser and `node --test` can load the exact same code — which is the point.
// A timezone bug that shifted every prediction by a day survived for months
// because none of this was reachable from a test.
//
// Loaded as a classic script in the browser (it also publishes its exports as
// globals, the way the inline code used to define them) and via require() in
// Node.
// ══════════════════════════════════════════════════════════
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.CycleCore = api; Object.assign(root, api); }
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
'use strict';

// ── Plausibility bounds ──
const MIN_CYCLE = 15;  // shortest plausible cycle (days)
const MAX_CYCLE = 60;  // longest plausible single cycle (days)
const PMS_DAYS = 5;

// ── Validation ──
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE   = /^[A-Za-z0-9_-]{1,64}$/;

function isValidCycle(c) {
  if (!c || typeof c !== 'object') return false;
  if (typeof c.id !== 'string' || !ID_RE.test(c.id)) return false;
  if (typeof c.start !== 'string' || !DATE_RE.test(c.start)) return false;
  if (c.end != null) {
    if (typeof c.end !== 'string' || !DATE_RE.test(c.end)) return false;
    if (c.end < c.start) return false;
  }
  return true;
}

// ══════════════════════════════════════════════════════════
// DATES
//
// Everything here is a CALENDAR date, never an instant, so all conversions
// stay in LOCAL time. Never use toISOString() on a date built from local
// parts: it converts to UTC first, which shifts the calendar day by one for
// every timezone east of UTC, because local midnight is still the previous
// day in UTC.
// ══════════════════════════════════════════════════════════
function dateStr(d) {
  if (!(d instanceof Date)) return d;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}
function parseDate(s) {
  if (!s) return null;
  const [y,m,d] = s.split('-').map(Number);
  return new Date(y, m-1, d);
}
function addDays(date, n) {
  const d = date instanceof Date ? new Date(date) : parseDate(date);
  d.setDate(d.getDate()+n);
  return d;
}
function diffDays(a, b) {
  return Math.round((parseDate(dateStr(b)) - parseDate(dateStr(a))) / 86400000);
}
function fmtDate(s) {
  if(!s) return '–';
  const d = parseDate(s);
  return d.toLocaleDateString('de-DE',{day:'2-digit',month:'short',year:'numeric'});
}

// A date range, collapsed so the shared parts are not repeated:
//   same month  →  23.–27. Sep. 2026
//   same year   →  28. Sep. – 02. Okt. 2026
//   otherwise   →  28. Dez. 2026 – 03. Jan. 2027
function fmtRange(a, b) {
  if (!a || !b || a === b) return fmtDate(a || b);
  const da = parseDate(a), db = parseDate(b);
  const day = d => String(d.getDate()).padStart(2, '0');
  // Derive the short form from fmtDate rather than a second toLocaleDateString:
  // ICU abbreviates the month differently depending on which other fields are
  // present ("Sep" alone, "Sept." alongside a year).
  const withoutYear = ds => fmtDate(ds).replace(/\s*\d{4}$/, '');
  if (da.getFullYear() === db.getFullYear()) {
    if (da.getMonth() === db.getMonth()) return `${day(da)}.–${fmtDate(b)}`;
    return `${withoutYear(a)} – ${fmtDate(b)}`;
  }
  return `${fmtDate(a)} – ${fmtDate(b)}`;
}

// "heute" / "morgen" / "in n Tagen", and the same with a spread applied.
// The old wording produced "in 0 Tagen" and "in 1 Tagen".
function inDays(d) {
  if (d <= 0) return 'heute';
  if (d === 1) return 'morgen';
  return `in ${d} Tagen`;
}

function inDaysRange(d, spread) {
  if (!spread) return inDays(d);
  const lo = Math.max(0, d - spread), hi = d + spread;
  if (lo === 0) return `heute bis in ${hi} Tagen`;
  if (lo === hi) return inDays(lo);
  return `in ${lo}–${hi} Tagen`;
}

// Today as 'YYYY-MM-DD' in the viewer's own timezone.
function todayStr() { return dateStr(new Date()); }

// ── Cycles, oldest first. Returns a copy; never sorts in place. ──
function sortCycles(cycles) {
  return [...cycles].sort((a, b) => a.start > b.start ? 1 : -1);
}

// ══════════════════════════════════════════════════════════
// AVERAGES
// ══════════════════════════════════════════════════════════
// The distances between consecutive recorded starts, minus the implausible
// ones — a gap outside MIN_CYCLE..MAX_CYCLE means a month went unrecorded, not
// that the cycle was that long. Everything statistical builds on this list, so
// it lives in one place.
function cycleGaps(cycles) {
  const gaps = [];
  for (let i = 1; i < cycles.length; i++) {
    const gap = diffDays(cycles[i-1].start, cycles[i].start);
    if (gap >= MIN_CYCLE && gap <= MAX_CYCLE) gaps.push(gap);
  }
  return gaps;
}

function calcAvgCycle(cycles) {
  const gaps = cycleGaps(cycles);
  if (!gaps.length) return 28;
  return Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
}

// How much the cycle actually varies, as a whole number of days.
//
//   { n, mean, sd, spread }
//
// sd is the sample standard deviation (n-1), so a single gap yields no spread
// at all rather than a confident zero. spread is sd rounded for display and is
// what the prediction is widened by; it needs at least three gaps, because two
// measurements say almost nothing about variability.
//
// A prediction of "day X" was always a point estimate dressed up as a fact.
// mean ± sd is the honest version: for a typical cycle it covers roughly two
// thirds of the outcomes.
const MIN_GAPS_FOR_SPREAD = 3;

function calcCycleSpread(cycles) {
  const gaps = cycleGaps(cycles);
  const n = gaps.length;
  if (n < 2) return { n, mean: n ? gaps[0] : 28, sd: 0, spread: 0 };

  const mean = gaps.reduce((a, b) => a + b, 0) / n;
  const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  return {
    n,
    mean,
    sd,
    spread: n >= MIN_GAPS_FOR_SPREAD ? Math.round(sd) : 0,
  };
}

function calcAvgPeriod(cycles) {
  const durs = cycles.filter(c => c.end).map(c => diffDays(c.start, c.end) + 1);
  if (!durs.length) return 5;
  return Math.round(durs.reduce((a, b) => a + b, 0) / durs.length);
}

// ══════════════════════════════════════════════════════════
// PHASE PROJECTION
// buildPhases(cycles, todayStr, monthYear?, monthMonth?)
//   cycles must be sorted oldest first. todayStr anchors the window, and is a
//   parameter rather than a call to the clock so tests can fix the date.
// ══════════════════════════════════════════════════════════
function buildPhases(cycles, todayStr, monthYear, monthMonth) {
  if (!cycles.length) return [];

  const avgCycle  = calcAvgCycle(cycles);
  const avgPeriod = calcAvgPeriod(cycles);

  // Window bounds
  const now = parseDate(todayStr);
  const defaultWinEnd = dateStr(new Date(now.getFullYear(), now.getMonth() + 18, 0));
  let winStart = dateStr(new Date(now.getFullYear(), now.getMonth() - 18, 1));
  let winEnd   = defaultWinEnd;
  if (monthYear !== undefined) {
    const ms = dateStr(new Date(monthYear, monthMonth - 1, 1));
    const me = dateStr(new Date(monthYear, monthMonth + 2, 0));
    if (ms < winStart) winStart = ms;
    if (me > winEnd)   winEnd   = me;
  }

  const makeEntry = (d, avgPer) => ({
    start:     dateStr(d),
    end:       dateStr(addDays(d, avgPer - 1)),
    pmsStart:  dateStr(addDays(d, -PMS_DAYS)),
    hellDay:   dateStr(addDays(d, -7)),
    ovulation: dateStr(addDays(d, -14)),
  });

  const all = [];

  // ── 1. REAL phases from every recorded cycle ──
  // Each real start date gets its own PMS/ovulation/hellDay window.
  // Use the actual period duration where known, else avgPeriod.
  for (const c of cycles) {
    const dur = c.end ? diffDays(c.start, c.end) + 1 : avgPeriod;
    all.push(makeEntry(parseDate(c.start), dur));
  }

  // ── 2. PREDICTED phases to fill gaps and extend into the future ──
  const anchor = parseDate(cycles[cycles.length - 1].start);
  const realStarts = new Set(cycles.map(c => c.start));

  // Forward from last real cycle
  let fwd = addDays(anchor, avgCycle);
  for (let i = 0; i < 60; i++) {
    const ds = dateStr(fwd);
    if (ds > winEnd) break;
    if (!realStarts.has(ds)) all.push(makeEntry(fwd, avgPeriod));
    fwd = addDays(fwd, avgCycle);
  }

  // Backward to fill gaps before oldest real cycle
  let bwd = addDays(parseDate(cycles[0].start), -avgCycle);
  for (let i = 0; i < 60; i++) {
    const ds = dateStr(bwd);
    if (ds < winStart) break;
    if (!realStarts.has(ds)) all.push(makeEntry(bwd, avgPeriod));
    bwd = addDays(bwd, -avgCycle);
  }

  return all;
}

// ══════════════════════════════════════════════════════════
// DAY CLASSIFICATION
// ══════════════════════════════════════════════════════════
function makeDayClassifier(cycles, allPhases, avgCycle, avgPeriod) {
  // Recorded periods outrank everything, so they get their own set.
  const real = new Set();
  for (const c of cycles) {
    const end = c.end || dateStr(addDays(c.start, avgPeriod - 1));
    for (let d = parseDate(c.start), ds = dateStr(d); ds <= end; d = addDays(d, 1), ds = dateStr(d)) {
      real.add(ds);
    }
  }

  const phaseDays = new Map();
  const put = (ds, key) => { if (!phaseDays.has(ds)) phaseDays.set(ds, key); };
  for (const p of allPhases) {
    for (let d = parseDate(p.start), ds = dateStr(d); ds <= p.end; d = addDays(d, 1), ds = dateStr(d)) {
      put(ds, 'predPeriod');
    }
    put(p.hellDay, 'hellDay');
    for (let d = parseDate(p.pmsStart), ds = dateStr(d); ds < p.start; d = addDays(d, 1), ds = dateStr(d)) {
      put(ds, 'pms');
    }
    put(p.ovulation, 'ovulation');
    const ov = parseDate(p.ovulation);
    for (let fd = -5; fd <= 1; fd++) put(dateStr(addDays(ov, fd)), 'fertile');
  }

  const last = cycles.length ? cycles[cycles.length - 1] : null;

  return function (ds) {
    if (real.has(ds)) return 'period';
    const hit = phaseDays.get(ds);
    if (hit) return hit;

    // Fallback via modulo, for dates outside the generated window
    if (last) {
      const d   = diffDays(last.start, ds);
      const pos = ((d % avgCycle) + avgCycle) % avgCycle;
      if (pos < avgPeriod)          return 'predPeriod';
      if (pos < avgCycle - 14 - 5)  return 'unknown';
      if (pos < avgCycle - 14 + 2)  return 'fertile';
      return 'unknown';
    }
    return 'unknown';
  };
}

function classifyDay(ds, cycles, allPhases, avgCycle, avgPeriod) {
  return makeDayClassifier(cycles, allPhases, avgCycle, avgPeriod)(ds);
}

// ── Statistics ──
function normalPDF(x, mean, std) {
  return (1 / (std * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * Math.pow((x - mean) / std, 2));
}

return {
  MIN_CYCLE, MAX_CYCLE, PMS_DAYS, DATE_RE, ID_RE,
  isValidCycle,
  dateStr, parseDate, addDays, diffDays, fmtDate, fmtRange, inDays, inDaysRange, todayStr,
  sortCycles, cycleGaps, calcAvgCycle, calcAvgPeriod, calcCycleSpread,
  MIN_GAPS_FOR_SPREAD,
  buildPhases, makeDayClassifier, classifyDay, normalPDF,
};
});
