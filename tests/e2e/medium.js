// Regression tests for the medium review findings (M1, M3, M4, M6)
//
// Browser-level checks: service worker, PWA installability, notifications,
// storage recovery, accessibility and the rendered DOM — the parts that
// cannot be reached from a unit test.
//
// Run via tests/run.sh, which starts a local server and sets BASE_URL.
// Requires Playwright with the full Chromium build (the headless shell has no
// notification support, which several of these checks need).

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  try { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
  catch (e2) {
    console.log('SKIP: Playwright not installed — npm i -D playwright');
    process.exit(0);
  }
}
const BASE = process.env.BASE_URL || 'http://localhost:8790';
const U = BASE + '/index.html';

const SEED = {
  cycles: [
    { id: 'c1', start: '2026-06-05', end: '2026-06-09' },
    { id: 'c2', start: '2026-07-03', end: '2026-07-07' },
    { id: 'c3', start: '2026-07-31', end: '2026-08-04' },
    { id: 'c4', start: '2026-08-28', end: '2026-09-01' },
  ],
  settings: { warnDays: 3 },
};

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  let fails = 0;
  const check = (n, ok, d = '') => {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + n + (d && !ok ? '\n           ' + d : ''));
    if (!ok) fails++;
  };
  const seeded = async (ctxOpts, storage) => {
    const c = await browser.newContext(ctxOpts || {});
    const p = await c.newPage();
    await p.addInitScript(v => localStorage.setItem('crimson-tide-tracker', v),
      JSON.stringify(storage || SEED));
    await p.goto(U);
    await p.waitForTimeout(700);
    return { c, p };
  };

  // ══ M1 — open cycle label ══
  console.log('\n=== M1  Laufende Periode ===');
  {
    const { c, p } = await seeded({ timezoneId: 'Europe/Berlin' },
      { cycles: [{ id: 'o1', start: '2026-09-10', end: null }], settings: { warnDays: 3 } });
    const row = await p.evaluate(() => {
      document.querySelector('[data-tab="cycles"]').click();
      return document.querySelector('.cycle-row .dates').textContent;
    });
    check('offene Periode zeigt "offen"', /→\s*offen$/.test(row.trim()), row);
    const closed = await p.evaluate(() => {
      state.cycles[0].end = '2026-09-14'; renderCyclesList();
      return document.querySelector('.cycle-row .dates').textContent;
    });
    check('abgeschlossene Periode zeigt das Datum', /→\s*14\./.test(closed), closed);
    await c.close();
  }

  // ══ M3 — one classifier ══
  console.log('\n=== M3  Einheitliche Klassifikation ===');
  {
    const { c, p } = await seeded({ timezoneId: 'Europe/Berlin' });
    const agree = await p.evaluate(() => {
      const cy = sortedCycles(), ac = calcAvgCycle(cy), ap = calcAvgPeriod(cy);
      const ph = buildAllPhases();
      const badge = getCurrentPhase();
      const key = classifyDay(today(), cy, ph, ac, ap);
      return { badgeLabel: badge.label, key, meta: PHASE_META[key].label, phase: badge.phase };
    });
    check('Badge == classifyDay fuer heute', agree.badgeLabel === agree.meta,
      JSON.stringify(agree));

    // every day of a full cycle: badge label must equal the calendar's key
    const sweep = await p.evaluate(() => {
      const cy = sortedCycles(), ac = calcAvgCycle(cy), ap = calcAvgPeriod(cy);
      const ph = buildAllPhases();
      const bad = [];
      for (let i = -40; i <= 40; i++) {
        const ds = dateStr(addDays(today(), i));
        const key = classifyDay(ds, cy, ph, ac, ap);
        if (!PHASE_META[key]) bad.push(ds + ':' + key);
      }
      return bad;
    });
    check('jeder classifyDay-Schluessel hat ein Label', sweep.length === 0, sweep.join(','));

    // no "Keine Daten" badge while the timeline paints a phase
    const noGap = await p.evaluate(() => {
      const cy = sortedCycles(), ac = calcAvgCycle(cy), ap = calcAvgPeriod(cy);
      const key = classifyDay(today(), cy, buildAllPhases(), ac, ap);
      return { key, badge: getCurrentPhase().label };
    });
    check('kein "Keine Daten" bei gefaerbtem Tag',
      !(noGap.key !== 'unknown' && noGap.badge === 'Keine Daten'), JSON.stringify(noGap));
    await c.close();
  }

  // open cycle: consistent between badge and calendar, bounded by avgPeriod
  {
    const { c, p } = await seeded({ timezoneId: 'Europe/Berlin' }, {
      cycles: [
        { id: 'a', start: '2026-07-03', end: '2026-07-07' },
        { id: 'b', start: '2026-07-31', end: '2026-08-04' },
        { id: 'o', start: '2026-09-11', end: null },
      ], settings: { warnDays: 3 },
    });
    const open = await p.evaluate(() => {
      const cy = sortedCycles(), ac = calcAvgCycle(cy), ap = calcAvgPeriod(cy);
      const ph = buildAllPhases();
      const at = d => classifyDay(d, cy, ph, ac, ap);
      return {
        avgPeriod: ap,
        day1: at('2026-09-11'), day3: at('2026-09-13'),
        lastDay: at(dateStr(addDays('2026-09-11', ap - 1))),
        afterEnd: at(dateStr(addDays('2026-09-11', ap + 2))),
        badge: getCurrentPhase().label,
      };
    });
    check('laufende Periode gilt fuer die erwartete Dauer',
      open.day1 === 'period' && open.day3 === 'period' && open.lastDay === 'period',
      JSON.stringify(open));
    check('nach der erwarteten Dauer nicht mehr "period"', open.afterEnd !== 'period', JSON.stringify(open));
    check('Badge sagt "Periode" (heute = 11.9., offener Eintrag)', open.badge === 'Periode', JSON.stringify(open));
    await c.close();
  }

  // ══ M4 — import merge ══
  console.log('\n=== M4  Import-Zusammenfuehrung ===');
  {
    const { c, p } = await seeded({ timezoneId: 'Europe/Berlin' });
    const res = await p.evaluate(async () => {
      // Same periods, different device -> different ids. One of them adds an
      // end date the local copy is missing, one is brand new.
      const incoming = {
        cycles: [
          { id: 'phone-1', start: '2026-08-28', end: '2026-09-01' },  // pure duplicate by date
          { id: 'phone-2', start: '2026-09-20', end: '2026-09-24' },  // new
        ],
        settings: { warnDays: 5 },
      };
      const file = new File([JSON.stringify(incoming)], 'x.json', { type: 'application/json' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('import-file-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      document.getElementById('confirm-ok').click();
      await new Promise(r => setTimeout(r, 400));
      return {
        n: state.cycles.length,
        starts: sortedCycles().map(x => x.start),
        warnDays: state.settings.warnDays,
        toast: document.getElementById('toast').textContent,
      };
    });
    check('Datums-Duplikat nicht doppelt uebernommen', res.n === 5, JSON.stringify(res));
    check('kein doppeltes Startdatum im Bestand',
      new Set(res.starts).size === res.starts.length, JSON.stringify(res.starts));
    check('neuer Zyklus uebernommen', res.starts.includes('2026-09-20'), JSON.stringify(res.starts));
    check('Einstellung aus der Datei uebernommen', res.warnDays === 5, 'warnDays=' + res.warnDays);
    check('Toast meldet neu + bereits vorhanden',
      /1 neu/.test(res.toast) && /1 bereits vorhanden/.test(res.toast), res.toast);
    await c.close();
  }

  // open local record completed by an import that has the end date
  {
    const { c, p } = await seeded({ timezoneId: 'Europe/Berlin' },
      { cycles: [{ id: 'local', start: '2026-08-28', end: null }], settings: { warnDays: 3 } });
    const res = await p.evaluate(async () => {
      const incoming = { cycles: [{ id: 'other', start: '2026-08-28', end: '2026-09-01' }] };
      const dt = new DataTransfer();
      dt.items.add(new File([JSON.stringify(incoming)], 'x.json', { type: 'application/json' }));
      const input = document.getElementById('import-file-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      document.getElementById('confirm-ok').click();
      await new Promise(r => setTimeout(r, 400));
      return { n: state.cycles.length, end: state.cycles[0].end, toast: document.getElementById('toast').textContent };
    });
    check('offener Eintrag wird durch Import ergaenzt statt dupliziert',
      res.n === 1 && res.end === '2026-09-01', JSON.stringify(res));
    check('Toast meldet "ergaenzt"', /ergänzt/.test(res.toast), res.toast);
    await c.close();
  }

  // ══ M6 — dark mode charts ══
  console.log('\n=== M6  Dark Mode ===');
  const readChart = async scheme => {
    const c = await browser.newContext({ timezoneId: 'Europe/Berlin', colorScheme: scheme });
    const p = await c.newPage();
    await p.addInitScript(v => localStorage.setItem('crimson-tide-tracker', v), JSON.stringify(SEED));
    await p.goto(U);
    await p.waitForTimeout(1200);
    const r = await p.evaluate(() => {
      const pal = readPhaseColors();
      return {
        pal, ink: cssVar('--chart-ink'), muted: cssVar('--chart-muted'),
        lh: cssVar('--hormone-lh'), accent: cssVar('--chart-accent'),
        cardBg: getComputedStyle(document.querySelector('.card')).backgroundColor,
        legend: [...document.querySelectorAll('#timeline-legend span span')]
          .map(e => e.style.background).filter(Boolean),
      };
    });
    await c.close();
    return r;
  };
  const light = await readChart('light');
  const dark = await readChart('dark');
  check('Chart-Tinte wechselt mit dem Theme', light.ink !== dark.ink, `${light.ink} / ${dark.ink}`);
  check('Phasenpalette wechselt mit dem Theme',
    light.pal.predPeriod !== dark.pal.predPeriod && light.pal.pms !== dark.pal.pms,
    JSON.stringify({ l: light.pal.predPeriod, d: dark.pal.predPeriod }));
  check('Hormonfarben wechseln mit dem Theme', light.lh !== dark.lh, `${light.lh} / ${dark.lh}`);
  check('Legende nutzt die Theme-Palette', light.legend.length === 6 && dark.legend.length === 6
    && JSON.stringify(light.legend) !== JSON.stringify(dark.legend),
    JSON.stringify({ l: light.legend.length, d: dark.legend.length }));
  check('keine hartkodierten Hellwerte im Dark Mode uebrig',
    dark.ink !== '#2d1f2b' && dark.muted !== '#b89ab5', JSON.stringify(dark));

  // contrast of chart ink against the card it sits on
  const lum = hex => {
    const m = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map(i => parseInt(m.slice(i, i + 2), 16) / 255)
      .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const rgbLum = rgb => {
    const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map(v => v / 255)
      .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [x, y] = [a, b].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const darkContrast = ratio(lum(dark.ink), rgbLum(dark.cardBg));
  const lightContrast = ratio(lum(light.ink), rgbLum(light.cardBg));
  check('Chart-Tinte kontrastreich im Dark Mode (>=4.5:1)', darkContrast >= 4.5, 'ratio=' + darkContrast.toFixed(2));
  check('Chart-Tinte kontrastreich im Light Mode (>=4.5:1)', lightContrast >= 4.5, 'ratio=' + lightContrast.toFixed(2));

  // ══ Regression ══
  console.log('\n=== Regression ===');
  {
    const c = await browser.newContext({ timezoneId: 'Europe/Berlin' });
    const p = await c.newPage();
    const pe = [];
    p.on('pageerror', e => pe.push(e.message));
    p.on('console', m => { if (m.type() === 'error') pe.push('console: ' + m.text()); });
    await p.addInitScript(v => localStorage.setItem('crimson-tide-tracker', v), JSON.stringify(SEED));
    await p.goto(U);
    await p.waitForTimeout(900);
    for (const t of ['calendar', 'cycles', 'stats', 'data', 'home']) {
      await p.evaluate(n => showTab(n, document.querySelector(`[onclick="showTab('${n}', this)"]`)), t);
      await p.waitForTimeout(200);
    }
    const st = await p.evaluate(() => ({
      calDays: document.querySelectorAll('.cal-day:not(.empty)').length,
      painted: document.querySelectorAll('.cal-day.period-day, .cal-day.predicted-period, .cal-day.predicted-pms').length,
      rows: document.querySelectorAll('.cycle-row').length,
      stats: document.querySelectorAll('.stat-box').length,
      badge: document.getElementById('home-phase-badge').textContent.trim().slice(0, 30),
      events: document.querySelectorAll('#next-events .event-pill').length,
      canvas: document.getElementById('timeline-canvas').width > 100,
    }));
    check('alle Tabs ohne Fehler', pe.length === 0, pe.join(' | '));
    check('Kalender/Liste/Statistik/Zeitstrahl gefuellt',
      st.calDays >= 28 && st.painted > 0 && st.rows === 4 && st.stats === 3 && st.canvas, JSON.stringify(st));
    check('Badge und Ereignisse vorhanden', st.badge.length > 3 && st.events > 0, JSON.stringify(st));
    await c.close();
  }

  console.log('\n' + (fails === 0 ? '✔ Alle Pruefungen bestanden' : `✘ ${fails} Pruefung(en) fehlgeschlagen`));
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})();
