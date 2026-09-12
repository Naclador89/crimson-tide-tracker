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
  dateStr, parseDate, addDays, diffDays, fmtDate, todayStr,
  sortCycles, calcAvgCycle, calcAvgPeriod, buildPhases,
  makeDayClassifier, classifyDay, isValidCycle, normalPDF,
  MIN_CYCLE, MAX_CYCLE, PMS_DAYS,
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
    assert.equal(p.hellDay, dateStr(addDays(p.start, -7)));
    assert.equal(p.ovulation, dateStr(addDays(p.start, -14)));
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
