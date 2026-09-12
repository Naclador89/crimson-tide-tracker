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

// Today as 'YYYY-MM-DD' in the viewer's own timezone.
function todayStr() { return dateStr(new Date()); }

// ── Cycles, oldest first. Returns a copy; never sorts in place. ──
function sortCycles(cycles) {
  return [...cycles].sort((a, b) => a.start > b.start ? 1 : -1);
}

// ══════════════════════════════════════════════════════════
// AVERAGES
// ══════════════════════════════════════════════════════════
function calcAvgCycle(cycles) {
  if (cycles.length < 2) return 28;
  const validGaps = [];
  for (let i = 1; i < cycles.length; i++) {
    const gap = diffDays(cycles[i-1].start, cycles[i].start);
    if (gap >= MIN_CYCLE && gap <= MAX_CYCLE) validGaps.push(gap);
  }
  if (!validGaps.length) return 28;
  return Math.round(validGaps.reduce((a, b) => a + b, 0) / validGaps.length);
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
  dateStr, parseDate, addDays, diffDays, fmtDate, todayStr,
  sortCycles, calcAvgCycle, calcAvgPeriod,
  buildPhases, makeDayClassifier, classifyDay, normalPDF,
};
});
