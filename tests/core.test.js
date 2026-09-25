// Unit tests for cycle-core.js — the pure half of the app.
//
// Run with:  node --test tests/
// The timezone cases are the reason this file exists: run.sh executes it once
// per timezone, because the bug that shifted every prediction by a day only
// appeared east of UTC.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const core = require('../cycle-core.js');

const {
  dateStr, parseDate, addDays, diffDays, fmtDate, fmtRange, inDays, inDaysRange, inDaysSpan,
  todayStr,
  sortCycles, cycleGaps, calcAvgCycle, calcAvgPeriod, calcCycleSpread, buildPhases,
  cycleModel, startHalfWidth, predictNextCycle,
  makeDayClassifier, classifyDay, isValidCycle, normalPDF,
  MIN_CYCLE, MAX_CYCLE, PMS_DAYS, HELL_DAY_OFFSET, LUTEAL, FERTILE_BEFORE_OV, POPULATION,
  RECENT_GAPS,
} = core;

const TZ = process.env.TZ || 'system default';

// Four regular ~28 day cycles.
const CYCLES = [
  { id: 'c1', start: '2026-06-05', end: '2026-06-09' },
  { id: 'c2', start: '2026-07-03', end: '2026-07-07' },
  { id: 'c3', start: '2026-07-31', end: '2026-08-04' },
  { id: 'c4', start: '2026-08-28', end: '2026-09-01' },
];

describe(`dates (TZ=${TZ})`, () => {
  test('dateStr/parseDate round-trip without drifting a day', () => {
    for (const d of ['2026-01-01', '2026-03-29', '2026-06-12', '2026-10-25', '2026-12-31']) {
      assert.equal(dateStr(parseDate(d)), d, `round-trip failed for ${d}`);
    }
  });

  test('dateStr leaves strings alone', () => {
    assert.equal(dateStr('2026-09-12'), '2026-09-12');
  });

  test('addDays accepts a string and a Date and agrees', () => {
    assert.equal(dateStr(addDays('2026-09-12', 3)), '2026-09-15');
    assert.equal(dateStr(addDays(parseDate('2026-09-12'), 3)), '2026-09-15');
    assert.equal(dateStr(addDays('2026-09-12', -5)), '2026-09-07');
    assert.equal(dateStr(addDays('2026-09-12', 0)), '2026-09-12');
  });

  test('addDays crosses month and year boundaries', () => {
    assert.equal(dateStr(addDays('2026-01-31', 1)), '2026-02-01');
    assert.equal(dateStr(addDays('2026-12-31', 1)), '2027-01-01');
    assert.equal(dateStr(addDays('2026-03-01', -1)), '2026-02-28');
    assert.equal(dateStr(addDays('2028-03-01', -1)), '2028-02-29', 'leap year');
  });

  test('addDays survives DST transitions', () => {
    // Europe: last Sunday in March and October. US: second Sunday in March.
    for (const [from, n, want] of [
      ['2026-03-28', 2, '2026-03-30'],
      ['2026-10-24', 2, '2026-10-26'],
      ['2026-03-07', 2, '2026-03-09'],
      ['2026-11-30', -2, '2026-11-28'],
    ]) {
      assert.equal(dateStr(addDays(from, n)), want, `${from} + ${n}`);
    }
  });

  test('diffDays counts calendar days, DST included', () => {
    assert.equal(diffDays('2026-09-12', '2026-09-15'), 3);
    assert.equal(diffDays('2026-09-15', '2026-09-12'), -3);
    assert.equal(diffDays('2026-09-12', '2026-09-12'), 0);
    assert.equal(diffDays('2026-03-28', '2026-03-30'), 2, 'spring forward');
    assert.equal(diffDays('2026-10-24', '2026-10-26'), 2, 'fall back');
    assert.equal(diffDays('2026-01-01', '2027-01-01'), 365);
  });

  test('todayStr matches the local calendar day, not the UTC one', () => {
    const now = new Date();
    const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
                + `-${String(now.getDate()).padStart(2, '0')}`;
    assert.equal(todayStr(), local);
  });

  test('fmtDate renders German and handles empty input', () => {
    assert.equal(fmtDate(null), '–');
    assert.equal(fmtDate(''), '–');
    assert.match(fmtDate('2026-09-12'), /12\.\s*Sep/);
  });
});

describe('validation', () => {
  test('accepts a well-formed cycle', () => {
    assert.ok(isValidCycle({ id: 'c1', start: '2026-09-01', end: '2026-09-05' }));
    assert.ok(isValidCycle({ id: 'c1', start: '2026-09-01', end: null }), 'open cycle');
    assert.ok(isValidCycle({ id: 'c1', start: '2026-09-01' }), 'missing end');
  });

  test('rejects malformed entries', () => {
    const bad = [
      null, undefined, 42, 'nope', {},
      { start: '2026-09-01' },                              // no id
      { id: 'c1' },                                         // no start
      { id: 'c1', start: '01.09.2026' },                    // wrong format
      { id: 'c1', start: '2026-09-01', end: '2026-08-01' }, // end before start
      { id: 'c1', start: '2026-09-01', end: 'soon' },
      { id: 42, start: '2026-09-01' },                      // non-string id
    ];
    for (const c of bad) assert.equal(isValidCycle(c), false, JSON.stringify(c));
  });

  test('rejects ids that could break out of an HTML attribute', () => {
    assert.equal(isValidCycle({ id: 'x" onmouseover=alert(1)', start: '2026-09-01' }), false);
    assert.equal(isValidCycle({ id: '<script>', start: '2026-09-01' }), false);
    assert.equal(isValidCycle({ id: 'a'.repeat(65), start: '2026-09-01' }), false);
    assert.ok(isValidCycle({ id: 'c1714000000000', start: '2026-09-01' }), 'normal id still fine');
  });
});

describe('averages', () => {
  test('mean of consecutive starts', () => {
    assert.equal(calcAvgCycle(CYCLES), 28);
    assert.equal(calcAvgPeriod(CYCLES), 5);
  });

  test('falls back when there is not enough data', () => {
    assert.equal(calcAvgCycle([]), 28);
    assert.equal(calcAvgCycle([CYCLES[0]]), 28);
    assert.equal(calcAvgPeriod([]), 5);
    assert.equal(calcAvgPeriod([{ id: 'x', start: '2026-09-01', end: null }]), 5);
  });

  test('a skipped month does not drag the average up', () => {
    const withGap = [
      { id: 'a', start: '2026-01-05', end: '2026-01-09' },
      { id: 'b', start: '2026-02-02', end: '2026-02-06' },  // 28
      { id: 'c', start: '2026-08-28', end: '2026-09-01' },  // 207 -> excluded
    ];
    assert.equal(calcAvgCycle(withGap), 28);
  });

  test('gaps at the plausibility bounds are kept, beyond them dropped', () => {
    const at = n => calcAvgCycle([
      { id: 'a', start: '2026-01-01', end: null },
      { id: 'b', start: dateStr(addDays('2026-01-01', n)), end: null },
    ]);
    assert.equal(at(MIN_CYCLE), MIN_CYCLE, 'lower bound inclusive');
    assert.equal(at(MAX_CYCLE), MAX_CYCLE, 'upper bound inclusive');
    assert.equal(at(MIN_CYCLE - 1), 28, 'below bound -> fallback');
    assert.equal(at(MAX_CYCLE + 1), 28, 'above bound -> fallback');
  });

  test('period duration is inclusive of both days', () => {
    assert.equal(calcAvgPeriod([{ id: 'a', start: '2026-09-01', end: '2026-09-01' }]), 1);
    assert.equal(calcAvgPeriod([{ id: 'a', start: '2026-09-01', end: '2026-09-04' }]), 4);
  });
});

describe('cycle spread', () => {
  const mk = starts => starts.map((s, i) => ({ id: 'c' + i, start: s, end: null }));

  test('gaps are the distances between consecutive starts', () => {
    assert.deepEqual(cycleGaps(CYCLES), [28, 28, 28]);
    assert.deepEqual(cycleGaps([]), []);
    assert.deepEqual(cycleGaps([CYCLES[0]]), []);
  });

  test('an implausible gap is left out of the list, not counted as a long cycle', () => {
    const gaps = cycleGaps(mk(['2026-01-05', '2026-02-02', '2026-08-28']));
    assert.deepEqual(gaps, [28], '207 days is a skipped month');
  });

  test('a perfectly regular cycle has no sample spread', () => {
    const s = calcCycleSpread(CYCLES);
    assert.equal(s.n, 3);
    assert.equal(s.mean, 28);
    assert.equal(s.sd, 0);
  });

  test('an irregular cycle reports its sample spread', () => {
    // gaps 24, 36, 24, 35 → mean 29.75, sample sd ≈ 6.65
    const s = calcCycleSpread(mk(['2026-06-01', '2026-06-25', '2026-07-31', '2026-08-24', '2026-09-28']));
    assert.equal(s.n, 4);
    assert.ok(Math.abs(s.mean - 29.75) < 1e-9, String(s.mean));
    assert.ok(Math.abs(s.sd - 6.652) < 0.01, String(s.sd));
  });

  test('uses the sample standard deviation, not the population one', () => {
    // gaps 26 and 30: population sd is 2, sample sd is √8 ≈ 2.83
    const s = calcCycleSpread(mk(['2026-01-01', '2026-01-27', '2026-02-26']));
    assert.ok(Math.abs(s.sd - Math.sqrt(8)) < 1e-9, String(s.sd));
  });

  test('a single gap has no spread, and no data falls back', () => {
    assert.equal(calcCycleSpread(mk(['2026-01-01', '2026-01-29'])).sd, 0);
    assert.equal(calcCycleSpread([]).sd, 0);
    assert.equal(calcCycleSpread([]).mean, 28, 'falls back like calcAvgCycle');
  });

  test('mean agrees with calcAvgCycle', () => {
    for (const c of [CYCLES, mk(['2026-06-01', '2026-06-25', '2026-07-31', '2026-08-24'])]) {
      assert.equal(Math.round(calcCycleSpread(c).mean), calcAvgCycle(c));
    }
  });

  test('a gap of about two usual cycles counts as a skipped month', () => {
    // 28, 28, 56, 28: the 56 is one unrecorded period, not a 56-day cycle.
    const starts = ['2026-01-01', '2026-01-29', '2026-02-26', '2026-04-23', '2026-05-21'];
    assert.deepEqual(cycleGaps(mk(starts)), [28, 28, 28]);
  });

  test('a merely long cycle is kept', () => {
    // 28, 28, 38, 28: 38 is not near a multiple of 28.
    const starts = ['2026-01-01', '2026-01-29', '2026-02-26', '2026-04-05', '2026-05-03'];
    assert.deepEqual(cycleGaps(mk(starts)), [28, 28, 38, 28]);
  });

  test('the skipped-month check needs a median worth trusting', () => {
    // Two gaps: 28 and 56 — too little to call either the usual one.
    assert.deepEqual(cycleGaps(mk(['2026-01-01', '2026-01-29', '2026-03-26'])), [28, 56]);
  });
});

describe('prediction model', () => {
  const mk = starts => starts.map((s, i) => ({ id: 'c' + i, start: s, end: null }));
  const every = (from, gap, n) => {
    const out = [from];
    for (let i = 1; i < n; i++) out.push(dateStr(addDays(out[i - 1], gap)));
    return mk(out);
  };

  test('without data it is the population', () => {
    const m = cycleModel([]);
    assert.equal(m.n, 0);
    assert.equal(m.mean, POPULATION.cycle.mean);
  });

  test('one gap is pulled towards the population, not taken as the truth', () => {
    const m = cycleModel(mk(['2026-01-01', '2026-01-23']));   // 22 days
    assert.ok(m.mean > 22 && m.mean < POPULATION.cycle.mean, String(m.mean));
  });

  test('with many cycles the own mean dominates', () => {
    const m = cycleModel(every('2025-01-01', 25, 13));
    assert.ok(Math.abs(m.mean - 25) < 0.3, String(m.mean));
  });

  test('only the recent cycles count', () => {
    // 12 old cycles of 34 days, then 12 of 26: the prediction follows the 26.
    const old = every('2024-01-01', 34, 13);
    const recent = every(old[old.length - 1].start, 26, 13).slice(1);
    const m = cycleModel([...old, ...recent]);
    assert.equal(m.n, RECENT_GAPS);
    assert.ok(Math.abs(m.mean - 26) < 0.3, String(m.mean));
  });

  test('perfectly regular data still leaves some uncertainty', () => {
    const m = cycleModel(every('2025-01-01', 28, 5));
    assert.ok(m.sd > 0, 'three identical gaps do not prove a zero-variance cycle');
  });

  test('the range narrows with more data', () => {
    const w = n => startHalfWidth(cycleModel(every('2024-01-01', 28, n + 1)), 1);
    assert.ok(w(3) > w(6) && w(6) > w(12), `${w(3)} ${w(6)} ${w(12)}`);
  });

  test('the range is wider than ±1 sd, as an 80 % prediction interval must be', () => {
    const cy = mk(['2026-06-01', '2026-06-25', '2026-07-31', '2026-08-24', '2026-09-28']);
    const m = cycleModel(cy);
    assert.ok(startHalfWidth(m, 1) > 1.28 * m.sd, String(startHalfWidth(m, 1)));
  });

  test('uncertainty grows with every cycle further ahead', () => {
    const m = cycleModel(CYCLES);
    const h = [1, 2, 3, 6].map(k => startHalfWidth(m, k));
    for (let i = 1; i < h.length; i++) assert.ok(h[i] > h[i - 1], JSON.stringify(h));
    // at least with √k
    assert.ok(h[2] >= h[0] * Math.sqrt(3) - 1e-9, JSON.stringify(h));
  });

  test('predicts the next start with a range around it', () => {
    const p = predictNextCycle(sortCycles(CYCLES), '2026-09-12');
    assert.equal(p.start, '2026-09-25');
    assert.ok(p.lo < p.start && p.hi > p.start, JSON.stringify(p));
    assert.equal(p.overdue, 0);
    assert.equal(p.coverage, 0.8);
  });

  test('a range never starts before today — a period that began would be recorded', () => {
    const p = predictNextCycle(sortCycles(CYCLES), '2026-09-24');
    assert.equal(p.lo, '2026-09-24');
    assert.equal(p.start, '2026-09-25');
  });

  test('a late period is reported as overdue, not skipped', () => {
    const p = predictNextCycle(sortCycles(CYCLES), '2026-09-27');
    assert.equal(p.start, '2026-09-25', 'still the same period');
    assert.equal(p.overdue, 2);
    assert.equal(p.beyondRange, false);

    const late = predictNextCycle(sortCycles(CYCLES), '2026-10-12');
    assert.equal(late.overdue, 17);
    assert.equal(late.beyondRange, true);
  });

  test('no cycles, no prediction', () => {
    assert.equal(predictNextCycle([], '2026-09-12'), null);
  });
});

describe('wording', () => {
  test('day counts read like German, not like a counter', () => {
    assert.equal(inDays(0), 'heute');
    assert.equal(inDays(1), 'morgen');
    assert.equal(inDays(2), 'in 2 Tagen');
    assert.equal(inDays(-3), 'heute', 'a past date never reads as negative');
  });

  test('an asymmetric span reads the same way', () => {
    assert.equal(inDaysSpan(3, 9), 'in 3–9 Tagen');
    assert.equal(inDaysSpan(-2, 4), 'heute bis in 4 Tagen');
    assert.equal(inDaysSpan(0, 1), 'heute bis in 1 Tag');
    assert.equal(inDaysSpan(5, 5), 'in 5 Tagen');
  });

  test('a spread turns the count into a range', () => {
    assert.equal(inDaysRange(13, 2), 'in 11–15 Tagen');
    assert.equal(inDaysRange(13, 0), 'in 13 Tagen', 'no spread, no range');
    assert.equal(inDaysRange(5, 0), 'in 5 Tagen');
  });

  test('a range that would start in the past is clamped', () => {
    assert.equal(inDaysRange(2, 3), 'heute bis in 5 Tagen');
    assert.equal(inDaysRange(1, 1), 'heute bis in 2 Tagen');
  });

  test('date ranges collapse what the two ends share', () => {
    assert.match(fmtRange('2026-09-23', '2026-09-27'), /^23\.–27\./);
    assert.equal((fmtRange('2026-09-23', '2026-09-27').match(/2026/g) || []).length, 1);
    assert.equal((fmtRange('2026-09-28', '2026-10-02').match(/2026/g) || []).length, 1);
    assert.equal((fmtRange('2026-12-28', '2027-01-03').match(/20\d\d/g) || []).length, 2);
  });

  test('the month is abbreviated the same way on both ends', () => {
    const r = fmtRange('2026-09-28', '2026-10-02');
    const months = r.match(/[A-Za-zä]+\./g) || [];
    assert.ok(months.every(m => m.endsWith('.')), r);
  });

  test('a degenerate range is just a date', () => {
    assert.equal(fmtRange('2026-09-25', '2026-09-25'), fmtDate('2026-09-25'));
    assert.equal(fmtRange(null, '2026-09-25'), fmtDate('2026-09-25'));
  });
});

describe('sortCycles', () => {
  test('sorts oldest first and does not mutate the input', () => {
    const input = [CYCLES[2], CYCLES[0], CYCLES[3], CYCLES[1]];
    const copy = [...input];
    const out = sortCycles(input);
    assert.deepEqual(out.map(c => c.start),
      ['2026-06-05', '2026-07-03', '2026-07-31', '2026-08-28']);
    assert.deepEqual(input, copy, 'input was mutated');
  });
});

describe(`phase projection (TZ=${TZ})`, () => {
  const TODAY = '2026-09-12';
  const phases = buildPhases(sortCycles(CYCLES), TODAY);

  test('a recorded start produces a phase on exactly that date', () => {
    // This is the regression test for the timezone bug: the projected starts
    // came out one day early everywhere east of UTC.
    const starts = phases.slice(0, CYCLES.length).map(p => p.start);
    assert.deepEqual(starts, CYCLES.map(c => c.start));
  });

  test('phase offsets follow the documented model', () => {
    const p = phases[0];
    assert.equal(p.start, '2026-06-05');
    assert.equal(p.end, '2026-06-09', 'real duration, not the average');
    assert.equal(p.pmsStart, dateStr(addDays(p.start, -PMS_DAYS)));
    assert.equal(p.hellDay, dateStr(addDays(p.start, -HELL_DAY_OFFSET)));
    assert.equal(p.ovulation, dateStr(addDays(p.start, -Math.round(LUTEAL.mean))),
      'counted back by the measured luteal phase, not the textbook 14');
    assert.equal(p.k, 0);
    assert.equal(p.spread, 0, 'a recorded start is not uncertain');
  });

  test('the fertile window is the Wilcox window, widened by the luteal variation', () => {
    const p = phases[0];
    assert.ok(p.fertileStart <= dateStr(addDays(p.ovulation, -FERTILE_BEFORE_OV)), JSON.stringify(p));
    assert.ok(p.fertileEnd >= p.ovulation, JSON.stringify(p));
    const days = diffDays(p.fertileStart, p.fertileEnd) + 1;
    // Calendar methods land at about 12 days (Standard Days Method: days 8–19).
    assert.ok(days >= 10 && days <= 14, String(days));
  });

  test('projected cycles carry a growing range, and no fertile window past the next one', () => {
    const proj = phases.filter(p => p.k > 0).sort((a, b) => a.k - b.k);
    assert.equal(proj[0].k, 1);
    for (let i = 1; i < proj.length; i++) assert.ok(proj[i].spread >= proj[i - 1].spread);
    assert.ok(proj[0].fertileStart, 'the next cycle has a window');
    const nextWindow = diffDays(proj[0].fertileStart, proj[0].fertileEnd);
    assert.ok(nextWindow > diffDays(phases[0].fertileStart, phases[0].fertileEnd),
      'wider than for a recorded cycle');
    assert.equal(proj[1].fertileStart, null);
  });

  test('projection does not drift from rounding the mean', () => {
    // Gaps alternate 28/29 → mean 28.5. Rounding it first projects 28 or 29
    // days per cycle and is six days off after a year.
    const starts = ['2025-01-01'];
    for (let i = 1; i <= 12; i++) starts.push(dateStr(addDays(starts[i - 1], i % 2 ? 28 : 29)));
    const cy = starts.map((s, i) => ({ id: 'd' + i, start: s, end: null }));
    const m = cycleModel(cy);
    const ph = buildPhases(cy, starts[12]);
    const k12 = ph.find(p => p.k === 12);
    assert.equal(k12.start, dateStr(addDays(starts[12], Math.round(12 * m.mean))));
  });

  test('nothing is invented before the first record', () => {
    assert.ok(phases.every(p => p.start >= CYCLES[0].start));
  });

  test('projects the next period one average cycle past the last record', () => {
    const next = phases.filter(p => p.start > TODAY).sort((a, b) => a.start > b.start ? 1 : -1)[0];
    assert.equal(next.start, '2026-09-25', '2026-08-28 + 28');
    assert.equal(next.end, '2026-09-29');
  });

  test('an open cycle falls back to the average duration', () => {
    const [p] = buildPhases([{ id: 'o', start: '2026-09-01', end: null }], TODAY);
    assert.equal(p.start, '2026-09-01');
    assert.equal(p.end, '2026-09-05', 'start + avgPeriod - 1');
  });

  test('no cycles, no phases', () => {
    assert.deepEqual(buildPhases([], TODAY), []);
  });

  test('the month window extends the projection', () => {
    const far = buildPhases(sortCycles(CYCLES), TODAY, 2028, 5);
    assert.ok(far.some(p => p.start >= '2028-05-01' && p.start <= '2028-08-31'),
      'requested month is not covered');
    assert.ok(far.length > phases.length);
  });

  test('projected starts never collide with recorded ones', () => {
    const recorded = new Set(CYCLES.map(c => c.start));
    const projected = phases.slice(CYCLES.length).map(p => p.start);
    for (const s of projected) assert.ok(!recorded.has(s), `${s} projected over a real cycle`);
  });
});

describe(`day classification (TZ=${TZ})`, () => {
  const TODAY = '2026-09-12';
  const cycles = sortCycles(CYCLES);
  const phases = buildPhases(cycles, TODAY);
  const avgCycle = calcAvgCycle(cycles);
  const avgPeriod = calcAvgPeriod(cycles);
  const at = makeDayClassifier(cycles, phases, avgCycle, avgPeriod);

  test('recorded period days classify as period', () => {
    for (const c of CYCLES) {
      assert.equal(at(c.start), 'period', c.start);
      assert.equal(at(c.end), 'period', c.end);
    }
  });

  test('a recorded period outranks any projection', () => {
    assert.equal(at('2026-08-30'), 'period');
  });

  test('projected phases land on the documented offsets', () => {
    const next = phases.filter(p => p.start > TODAY).sort((a, b) => a.start > b.start ? 1 : -1)[0];
    assert.equal(at(next.start), 'predPeriod');
    assert.equal(at(next.hellDay), 'hellDay');
    assert.equal(at(next.ovulation), 'ovulation');
    assert.equal(at(dateStr(addDays(next.start, -1))), 'pms');
    assert.equal(at(next.fertileStart), 'fertile');
  });

  test('predicted period days report their range, recorded ones none', () => {
    const next = phases.find(p => p.k === 1);
    assert.equal(at.spread(next.start), next.spread);
    assert.ok(at.spread(next.start) > 0);
    assert.equal(at.spread(CYCLES[0].start), 0);
  });

  test('no phases before the first record', () => {
    assert.equal(at(dateStr(addDays(CYCLES[0].start, -40))), 'unknown');
  });

  test('an open cycle counts for the expected duration, then stops', () => {
    const open = [
      { id: 'a', start: '2026-07-03', end: '2026-07-07' },
      { id: 'b', start: '2026-07-31', end: '2026-08-04' },
      { id: 'o', start: '2026-09-11', end: null },
    ];
    const cy = sortCycles(open);
    const ap = calcAvgPeriod(cy);
    const f = makeDayClassifier(cy, buildPhases(cy, TODAY), calcAvgCycle(cy), ap);
    assert.equal(f('2026-09-11'), 'period', 'first day');
    assert.equal(f(dateStr(addDays('2026-09-11', ap - 1))), 'period', 'last expected day');
    assert.notEqual(f(dateStr(addDays('2026-09-11', ap + 2))), 'period', 'past the expected end');
  });

  test('the indexed classifier matches the single-day wrapper', () => {
    for (let i = -400; i <= 400; i += 7) {
      const ds = dateStr(addDays(TODAY, i));
      assert.equal(at(ds), classifyDay(ds, cycles, phases, avgCycle, avgPeriod), ds);
    }
  });

  test('every returned key is one the UI knows', () => {
    const known = new Set(['period', 'predPeriod', 'hellDay', 'pms', 'ovulation',
                           'fertile', 'follicular', 'luteal', 'unknown']);
    for (let i = -400; i <= 400; i++) {
      const key = at(dateStr(addDays(TODAY, i)));
      assert.ok(known.has(key), `unexpected key ${key}`);
    }
  });

  test('without any data everything is unknown', () => {
    const f = makeDayClassifier([], [], 28, 5);
    assert.equal(f(TODAY), 'unknown');
  });
});

describe('normalPDF', () => {
  test('peaks at the mean and is symmetric', () => {
    const peak = normalPDF(28.4, 28.4, 3.7);
    assert.ok(normalPDF(25, 28.4, 3.7) < peak);
    assert.ok(normalPDF(32, 28.4, 3.7) < peak);
    assert.ok(Math.abs(normalPDF(25.4, 28.4, 3.7) - normalPDF(31.4, 28.4, 3.7)) < 1e-12);
  });

  test('matches the closed form at the mean', () => {
    const std = 3.7;
    assert.ok(Math.abs(normalPDF(0, 0, std) - 1 / (std * Math.sqrt(2 * Math.PI))) < 1e-12);
  });
});
