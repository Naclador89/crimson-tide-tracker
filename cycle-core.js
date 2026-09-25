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

// ══════════════════════════════════════════════════════════
// REFERENCE VALUES
//
// Every number the prediction rests on is here, with where it comes from.
// Values marked "assumption" are modelling choices, not measurements — they
// only matter while there are few own cycles and fade out as data arrives.
// ══════════════════════════════════════════════════════════

// Population reference, also drawn as the grey curve in the statistics tab.
//   cycle:    Vollman 1977; Münster et al. 1992 (~30 000 cycles)
//   duration: Dasharathy et al. 2012 (NICHD BioCycle study)
const POPULATION = {
  cycle:    { mean: 28.4, std: 3.7 },
  duration: { mean: 4.7,  std: 1.4 },
};

// Luteal phase (ovulation → next period). Bull et al. 2019, npj Digital
// Medicine 2:83 (612 613 cycles): mean 12.4 days, 95 % range 7–17, i.e. an sd
// of about 2.5. The textbook "ovulation is 14 days before the period" is the
// classic mean from far smaller samples and sits at the upper end of this.
// The luteal phase is the stable part of the cycle; most of the variation in
// cycle length comes from the follicular phase, which is why ovulation is
// counted back from the next period and not forward from the last one.
const LUTEAL = { mean: 12.4, sd: 2.5 };

// Fertile window: the six days ending on the day of ovulation — Wilcox,
// Weinberg & Baird 1995, NEJM 333:1517. No conception in that study came from
// intercourse after the ovulation day.
const FERTILE_BEFORE_OV = 5;

// PMS: ACOG defines premenstrual syndrome by symptoms in the five days before
// menses. The "Hell Day" one week before is this app's own rule of thumb for
// the mid-to-late luteal mood dip, not a clinical definition.
const PMS_DAYS = 5;
const HELL_DAY_OFFSET = 7;

// Prior for the own cycle length (assumptions, see above):
//   PRIOR_WEIGHT — the population mean counts as this many own cycles, so a
//                  single recorded gap is not taken as the whole truth.
//   PRIOR_SD/DF  — within-person variation before any is measured. Creinin et
//                  al. 2004 (Contraception 70:289) found cycles varying by
//                  7+ days within six months in almost half of women who
//                  called themselves regular; an sd of 3 days reflects that.
//                  Weighted like two measured degrees of freedom.
const PRIOR_WEIGHT = 1;
const PRIOR_SD     = 3;
const PRIOR_DF     = 2;

// Only the most recent gaps describe the current cycle: length drifts with
// age (Bull et al. 2019: about −0.18 days per year between 25 and 45).
const RECENT_GAPS = 12;

// Coverage of every range the app shows. 80 % — narrow enough to be useful,
// honest enough that one prediction in five falling outside is expected,
// and said so in the UI.
const COVERAGE = 0.8;

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

function inDaysSpan(lo, hi) {
  lo = Math.max(0, lo);
  if (hi <= lo) return inDays(lo);
  if (lo === 0) return `heute bis in ${hi} ${hi === 1 ? 'Tag' : 'Tagen'}`;
  return `in ${lo}–${hi} Tagen`;
}

function inDaysRange(d, spread) {
  return spread ? inDaysSpan(d - spread, d + spread) : inDays(d);
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
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// A gap of roughly two (or three…) usual cycles is far more likely an
// unrecorded period than one very long cycle. Urteaga et al. 2021 (Journal of
// Biomedical Informatics 123) showed that such skipped entries are the main
// thing that throws off app predictions; they model them explicitly. This is
// the simple version: a gap within 15 % of a multiple ≥ 2 of the median gap.
// Needs a median worth trusting, so it only applies from three gaps on.
const MIN_GAPS_FOR_SKIP_CHECK = 3;

function looksSkipped(gap, med) {
  const k = Math.round(gap / med);
  return k >= 2 && Math.abs(gap - k * med) <= 0.15 * k * med;
}

// The distances between consecutive recorded starts, minus the implausible
// ones — a gap outside MIN_CYCLE..MAX_CYCLE, or one that looks like a whole
// multiple of the usual cycle, means a month went unrecorded, not that the
// cycle was that long. Everything statistical builds on this list, so it
// lives in one place.
function cycleGaps(cycles) {
  const gaps = [];
  for (let i = 1; i < cycles.length; i++) {
    const gap = diffDays(cycles[i-1].start, cycles[i].start);
    if (gap >= MIN_CYCLE && gap <= MAX_CYCLE) gaps.push(gap);
  }
  if (gaps.length < MIN_GAPS_FOR_SKIP_CHECK) return gaps;
  const med = median(gaps);
  return gaps.filter(g => !looksSkipped(g, med));
}

// The plain average of the own data, for display. Predictions use
// cycleModel(), which also accounts for how little data there may be.
function calcAvgCycle(cycles) {
  const gaps = cycleGaps(cycles);
  if (!gaps.length) return 28;
  return Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
}

// How much the own cycle varies — descriptive, for the statistics tab.
//
//   { n, mean, sd }
//
// sd is the sample standard deviation (n-1), so a single gap yields no spread
// at all rather than a confident zero.
function calcCycleSpread(cycles) {
  const gaps = cycleGaps(cycles);
  const n = gaps.length;
  if (n < 2) return { n, mean: n ? gaps[0] : 28, sd: 0 };

  const mean = gaps.reduce((a, b) => a + b, 0) / n;
  const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { n, mean, sd: Math.sqrt(variance) };
}

// ══════════════════════════════════════════════════════════
// PREDICTION MODEL
//
// cycleModel(cycles) → { n, mean, sd, df, kappa }
//
// A normal model for the own cycle length with a conjugate prior (normal /
// scaled-inverse-χ²), fitted to the last RECENT_GAPS gaps:
//
//   mean  = (PRIOR_WEIGHT·μ₀ + n·x̄) / (PRIOR_WEIGHT + n)
//   sd²   = (PRIOR_DF·σ₀² + Σ(x−x̄)²) / (PRIOR_DF + n − 1)
//
// With no data this is the population; with a dozen cycles it is essentially
// the own sample. The next cycle length then follows a Student-t with df
// degrees of freedom and scale sd·√(1 + 1/kappa) — the second term is the
// uncertainty about the mean itself, which ±1 sd used to ignore.
// ══════════════════════════════════════════════════════════

// Upper 90 % quantiles of Student's t (→ two-sided 80 %), df 1…30.
const T90 = [NaN,
  3.078, 1.886, 1.638, 1.533, 1.476, 1.440, 1.415, 1.397, 1.383, 1.372,
  1.363, 1.356, 1.350, 1.345, 1.341, 1.337, 1.333, 1.330, 1.328, 1.325,
  1.323, 1.321, 1.319, 1.318, 1.316, 1.315, 1.314, 1.313, 1.311, 1.310];
const Z90 = 1.2816;
function t90(df) { return df <= 30 ? T90[Math.max(1, Math.floor(df))] : Z90; }

function cycleModel(cycles) {
  const gaps = cycleGaps(cycles).slice(-RECENT_GAPS);
  const n = gaps.length;
  const xbar = n ? gaps.reduce((a, b) => a + b, 0) / n : 0;
  const ss = gaps.reduce((a, g) => a + (g - xbar) ** 2, 0);
  const kappa = PRIOR_WEIGHT + n;
  const df = PRIOR_DF + Math.max(0, n - 1);
  return {
    n,
    mean: (PRIOR_WEIGHT * POPULATION.cycle.mean + n * xbar) / kappa,
    sd: Math.sqrt((PRIOR_DF * PRIOR_SD ** 2 + ss) / df),
    df,
    kappa,
  };
}

// Half-width in days of the COVERAGE range for the start of the k-th period
// after the last recorded one. Each cycle adds its own variance, and the
// uncertain mean is multiplied by k:  Var = k·sd² + k²·sd²/kappa.
function startHalfWidth(model, k) {
  return t90(model.df) * model.sd * Math.sqrt(k + k * k / model.kappa);
}

// Half-width of the range for the ovulation day: the uncertainty of the
// period it is counted back from, plus the luteal phase's own.
function ovulationHalfWidth(startHalf) {
  return Math.sqrt(startHalf ** 2 + (Z90 * LUTEAL.sd) ** 2);
}

// predictNextCycle(cycles, todayStr) → null | {
//   start        most likely start date
//   lo, hi       COVERAGE range for it; lo never lies before today, because a
//                period that had started would have been recorded
//   overdue      days past `start` (0 when not overdue)
//   beyondRange  today is past `hi` as well
//   n, mean, sd, coverage
// }
function predictNextCycle(cycles, todayStr) {
  if (!cycles.length) return null;
  const m = cycleModel(cycles);
  const last = cycles[cycles.length - 1].start;
  const half = startHalfWidth(m, 1);
  const at = off => dateStr(addDays(last, Math.round(off)));

  const start = at(m.mean);
  // Never before the shortest plausible cycle, however wide the range.
  let lo = at(Math.max(MIN_CYCLE, m.mean - half));
  const hi = at(m.mean + half);
  if (todayStr > lo) lo = todayStr > hi ? hi : todayStr;

  return {
    start, lo, hi,
    overdue: todayStr > start ? diffDays(start, todayStr) : 0,
    beyondRange: todayStr > hi,
    n: m.n, mean: m.mean, sd: m.sd, coverage: COVERAGE,
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
//
// One entry per recorded cycle (k = 0) and per projected one (k = 1, 2, …
// counted from the last record):
//   { start, end, pmsStart, hellDay, ovulation, fertileStart, fertileEnd,
//     k, spread }
// spread is the half-width in days of the COVERAGE range for `start`; it is 0
// for a recorded start and grows with k. The fertile window is the Wilcox
// window widened by the uncertainty of the ovulation day. Beyond the next
// cycle that uncertainty covers most of the month, so a window would say
// nothing — fertileStart/fertileEnd are null there.
//
// Nothing is projected backwards from the first record: a period before the
// user started tracking is not data, and inventing one was wrong.
// ══════════════════════════════════════════════════════════
function buildPhases(cycles, todayStr, monthYear, monthMonth) {
  if (!cycles.length) return [];

  const model     = cycleModel(cycles);
  const avgPeriod = calcAvgPeriod(cycles);

  // Window end: 18 months ahead, or the end of the requested month view.
  const now = parseDate(todayStr);
  let winEnd = dateStr(new Date(now.getFullYear(), now.getMonth() + 18, 0));
  if (monthYear !== undefined) {
    const me = dateStr(new Date(monthYear, monthMonth + 2, 0));
    if (me > winEnd) winEnd = me;
  }

  const lutealDays = Math.round(LUTEAL.mean);
  const makeEntry = (d, dur, k, startHalf) => {
    const ov = addDays(d, -lutealDays);
    const ovHalf = Math.round(ovulationHalfWidth(startHalf));
    const withWindow = k <= 1;
    return {
      start:        dateStr(d),
      end:          dateStr(addDays(d, dur - 1)),
      pmsStart:     dateStr(addDays(d, -PMS_DAYS)),
      hellDay:      dateStr(addDays(d, -HELL_DAY_OFFSET)),
      ovulation:    dateStr(ov),
      fertileStart: withWindow ? dateStr(addDays(ov, -ovHalf - FERTILE_BEFORE_OV)) : null,
      fertileEnd:   withWindow ? dateStr(addDays(ov, ovHalf)) : null,
      k,
      spread:       Math.round(startHalf),
    };
  };

  const all = [];

  // ── 1. REAL phases from every recorded cycle ──
  // Each real start date gets its own PMS/ovulation/hellDay window.
  // Use the actual period duration where known, else avgPeriod.
  for (const c of cycles) {
    const dur = c.end ? diffDays(c.start, c.end) + 1 : avgPeriod;
    all.push(makeEntry(parseDate(c.start), dur, 0, 0));
  }

  // ── 2. PREDICTED phases from the last record into the future ──
  // Each start is anchor + round(k · mean): rounding the mean first let the
  // error pile up — 28.4 rounded to 28 is five days off after a year.
  const anchor = cycles[cycles.length - 1].start;
  for (let k = 1; k <= 60; k++) {
    const d = addDays(anchor, Math.round(k * model.mean));
    if (dateStr(d) > winEnd) break;
    all.push(makeEntry(d, avgPeriod, k, startHalfWidth(model, k)));
  }

  return all;
}

// ══════════════════════════════════════════════════════════
// DAY CLASSIFICATION
//
// makeDayClassifier(...) returns ds → key. The function also carries
// .spread(ds): for a predicted period day, the half-width of its range in
// days (0 otherwise), so views can mark far-off predictions as uncertain.
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

  const each = (from, to, fn) => {
    for (let d = parseDate(from), ds = dateStr(d); ds <= to; d = addDays(d, 1), ds = dateStr(d)) fn(ds);
  };

  const phaseDays = new Map();
  const spreadDays = new Map();
  const put = (ds, key) => { if (!phaseDays.has(ds)) phaseDays.set(ds, key); };
  let covered = null;   // last day the projection speaks about
  for (const p of allPhases) {
    each(p.start, p.end, ds => {
      put(ds, 'predPeriod');
      if (p.k && !spreadDays.has(ds)) spreadDays.set(ds, p.spread || 0);
    });
    put(p.hellDay, 'hellDay');
    each(p.pmsStart, dateStr(addDays(p.start, -1)), ds => put(ds, 'pms'));
    put(p.ovulation, 'ovulation');
    if (p.fertileStart) each(p.fertileStart, p.fertileEnd, ds => put(ds, 'fertile'));
    if (!covered || p.end > covered) covered = p.end;
  }

  const last = cycles.length ? cycles[cycles.length - 1] : null;
  const lutealDays = Math.round(LUTEAL.mean);

  const classify = function (ds) {
    if (real.has(ds)) return 'period';
    const hit = phaseDays.get(ds);
    if (hit) return hit;

    // Modulo fallback, only for dates past everything projected. Inside the
    // window a day without a phase simply has none; letting the fallback
    // paint there, on a slightly different cadence, produced stray days.
    if (last && covered && ds > covered) {
      const d   = diffDays(last.start, ds);
      const pos = ((d % avgCycle) + avgCycle) % avgCycle;
      if (pos < avgPeriod)                    return 'predPeriod';
      if (pos === avgCycle - lutealDays)      return 'ovulation';
      if (pos === avgCycle - HELL_DAY_OFFSET) return 'hellDay';
      if (pos >= avgCycle - PMS_DAYS)         return 'pms';
    }
    return 'unknown';
  };
  classify.spread = ds => spreadDays.get(ds) || 0;
  return classify;
}

function classifyDay(ds, cycles, allPhases, avgCycle, avgPeriod) {
  return makeDayClassifier(cycles, allPhases, avgCycle, avgPeriod)(ds);
}

// ── Statistics ──
function normalPDF(x, mean, std) {
  return (1 / (std * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * Math.pow((x - mean) / std, 2));
}

return {
  MIN_CYCLE, MAX_CYCLE, PMS_DAYS, HELL_DAY_OFFSET, DATE_RE, ID_RE,
  POPULATION, LUTEAL, FERTILE_BEFORE_OV, COVERAGE, RECENT_GAPS,
  isValidCycle,
  dateStr, parseDate, addDays, diffDays, fmtDate, fmtRange, inDays, inDaysRange, inDaysSpan,
  todayStr,
  sortCycles, cycleGaps, calcAvgCycle, calcAvgPeriod, calcCycleSpread,
  cycleModel, startHalfWidth, predictNextCycle,
  buildPhases, makeDayClassifier, classifyDay, normalPDF,
};
});
