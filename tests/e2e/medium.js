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

  // ══ Spread instead of a point prediction ══
  console.log('\n=== Prognose mit Spanne ===');
  {
    // Regular cycles: nothing to spread, so the old exact wording stands.
    const { c, p } = await seeded({ timezoneId: 'Europe/Berlin' });
    const pills = await p.evaluate(() =>
      [...document.querySelectorAll('#next-events .event-pill')].map(e => e.textContent.trim()));
    check('regelmaessiger Zyklus zeigt weiter einen Tag',
      pills.some(t => /Periode in \d+ Tagen/.test(t)) && !pills.some(t => /–/.test(t)),
      JSON.stringify(pills));
    check('kein Spannen-Hinweis ohne Schwankung',
      !(await p.evaluate(() => document.getElementById('next-events').textContent.includes('Spanne'))));
    await c.close();
  }

  {
    // Irregular: gaps 24, 36, 24, 35 → sd ≈ 6.65 → ±7 days.
    const { c, p } = await seeded({ timezoneId: 'Europe/Berlin' }, {
      cycles: [
        { id: 'a', start: '2026-06-01', end: '2026-06-05' },
        { id: 'b', start: '2026-06-25', end: '2026-06-29' },
        { id: 'c', start: '2026-07-31', end: '2026-08-04' },
        { id: 'd', start: '2026-08-24', end: '2026-08-28' },
        { id: 'e', start: '2026-09-28', end: '2026-10-02' },
      ], settings: { warnDays: 3 },
    });
    const r = await p.evaluate(() => ({
      spread: CycleCore.calcCycleSpread(sortedCycles()).spread,
      pills: [...document.querySelectorAll('#next-events .event-pill')].map(e => e.textContent.trim()),
      note: document.getElementById('next-events').textContent,
    }));
    check('unregelmaessiger Zyklus liefert eine Spanne', r.spread === 7, 'spread=' + r.spread);
    check('jede Pille nennt eine Tagesspanne',
      r.pills.length > 0 && r.pills.every(t => /in \d+–\d+ Tagen|heute bis in \d+ Tagen/.test(t)),
      JSON.stringify(r.pills));
    check('Datumsangaben sind ebenfalls Spannen',
      r.pills.filter(t => /\(/.test(t)).every(t => /\(\d{2}\.[–\s]/.test(t)),
      JSON.stringify(r.pills));
    check('Herkunft der Spanne wird einmal erklaert',
      /Spanne aus der Schwankung/.test(r.note) && (r.note.match(/Spanne aus/g) || []).length === 1,
      r.note.slice(-90));
    await c.close();
  }

  {
    // Two gaps are not enough to claim anything about variability.
    const { c, p } = await seeded({ timezoneId: 'Europe/Berlin' }, {
      cycles: [
        { id: 'a', start: '2026-07-20', end: '2026-07-24' },
        { id: 'b', start: '2026-08-15', end: '2026-08-19' },
        { id: 'c', start: '2026-09-14', end: '2026-09-18' },
      ], settings: { warnDays: 3 },
    });
    const r = await p.evaluate(() => ({
      n: CycleCore.calcCycleSpread(sortedCycles()).n,
      sd: CycleCore.calcCycleSpread(sortedCycles()).sd,
      spread: CycleCore.calcCycleSpread(sortedCycles()).spread,
      text: document.getElementById('next-events').textContent,
    }));
    check('bei zwei Luecken wird trotz Abweichung keine Spanne behauptet',
      r.n === 2 && r.sd > 0 && r.spread === 0, JSON.stringify(r));
    check('und kein Spannen-Hinweis erscheint', !/Spanne aus/.test(r.text));
    await c.close();
  }

  {
    // Statistics tab reports the variation as its own figure.
    const { c, p } = await seeded({ timezoneId: 'Europe/Berlin' });
    const boxes = await p.evaluate(() => {
      document.querySelector('[data-tab="stats"]').click();
      return [...document.querySelectorAll('.stat-box')].map(b => b.textContent.replace(/\s+/g, ' ').trim());
    });
    check('Statistik zeigt die Schwankung als eigene Kennzahl',
      boxes.length === 4 && boxes.some(b => /Schwankung/.test(b)), JSON.stringify(boxes));
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

  // ── Kontrast jedes sichtbaren Textes gegen seinen tatsaechlichen Hintergrund.
  //    Der Dark Mode war nicht an einer Stelle kaputt, sondern an einem Dutzend:
  //    Kalenderzellen, die nur einen Hintergrund setzten und die Tinte erbten,
  //    Akzentfarben aus dem Light-Theme, hartkodierte Hex-Werte in Inline-Styles.
  //    Einzelchecks haetten die naechste Stelle wieder durchgelassen — deshalb
  //    faehrt diese Pruefung ueber jeden Textknoten der ganzen App.
  const sweep = async scheme => {
    const c = await browser.newContext({ timezoneId: 'Europe/Berlin', colorScheme: scheme });
    const p = await c.newPage();
    await p.addInitScript(v => localStorage.setItem('crimson-tide-tracker', v), JSON.stringify(SEED));
    await p.goto(U);
    await p.waitForTimeout(900);
    for (const t of await p.$$('.tab')) { await t.click(); await p.waitForTimeout(250); }
    const bad = await p.evaluate(() => {
      const rl = rgb => {
        const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(v => v / 255)
          .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const cr = (a, b) => { const [x, y] = [a, b].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
      // The nearest ancestor that actually paints something opaque enough to
      // read against — a coloured cell inside a card inside the page.
      const bgOf = el => {
        for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
          const a = getComputedStyle(n).backgroundColor.match(/[\d.]+/g);
          if (a && (a.length < 4 || parseFloat(a[3]) > 0.6)) return getComputedStyle(n).backgroundColor;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      document.querySelectorAll('.section').forEach(s => s.classList.add('active'));
      const out = [];
      document.querySelectorAll('body *').forEach(el => {
        const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
        if (!own) return;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return;
        const r = cr(rl(cs.color), rl(bgOf(el)));
        if (r < 4.5) out.push(`${el.className || el.tagName} ${r.toFixed(2)}:1 (${cs.color} auf ${bgOf(el)})`);
      });
      return [...new Set(out)];
    });
    await c.close();
    return bad;
  };
  const darkBad = await sweep('dark');
  check('jeder Text im Dark Mode >= 4.5:1', darkBad.length === 0, darkBad.slice(0, 8).join('\n           '));

  // Eine eingefaerbte Kalenderzelle muss ihre Tinte selbst setzen. Erbt sie
  // --text, steht im Dark Mode Weiss auf Pastell.
  {
    const c = await browser.newContext({ timezoneId: 'Europe/Berlin', colorScheme: 'dark' });
    const p = await c.newPage();
    await p.addInitScript(v => localStorage.setItem('crimson-tide-tracker', v), JSON.stringify(SEED));
    await p.goto(U);
    await p.waitForTimeout(900);
    const cells = await p.evaluate(() => {
      document.querySelector('[data-tab="calendar"]').click();
      const text = getComputedStyle(document.documentElement).getPropertyValue('--text').trim();
      const toRgb = h => { const m = h.replace('#', ''); return 'rgb(' + [0, 2, 4].map(i => parseInt(m.slice(i, i + 2), 16)).join(', ') + ')'; };
      const inherited = toRgb(text);
      return [...document.querySelectorAll('.cal-day')]
        .filter(d => getComputedStyle(d).backgroundColor !== 'rgba(0, 0, 0, 0)')
        .filter(d => getComputedStyle(d).color === inherited)
        .map(d => d.className);
    });
    check('keine eingefaerbte Kalenderzelle erbt die Standardtinte',
      cells.length === 0, [...new Set(cells)].join(' | '));
    await c.close();
  }

  // ══ M7 — Theme-Auswahl (Systemstandard / Hell / Dunkel) ══
  console.log('\n=== M7  Theme-Auswahl ===');
  {
    const THEME_KEY = 'crimson-tide-tracker-theme';
    // Everything downstream hangs off data-theme on <html>, so that attribute
    // and the card colour together say what is actually applied.
    const readTheme = p => p.evaluate(() => ({
      attr: document.documentElement.dataset.theme,
      card: getComputedStyle(document.querySelector('.card')).backgroundColor,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      sel: document.getElementById('settings-theme').value,
      stored: localStorage.getItem('crimson-tide-tracker-theme'),
    }));
    const open = async (system, stored) => {
      const c = await browser.newContext({ timezoneId: 'Europe/Berlin', colorScheme: system });
      const p = await c.newPage();
      await p.addInitScript(([v, t, k]) => {
        localStorage.setItem('crimson-tide-tracker', v);
        if (t) localStorage.setItem(k, t);
      }, [JSON.stringify(SEED), stored || '', THEME_KEY]);
      await p.goto(U);
      await p.waitForTimeout(900);
      await p.click('[data-tab="data"]');
      await p.waitForTimeout(300);
      return { c, p };
    };

    // Ohne Auswahl gilt der Systemstandard — in beide Richtungen.
    {
      const a = await open('light'), b = await open('dark');
      const la = await readTheme(a.p), db = await readTheme(b.p);
      check('ohne Auswahl steht "Systemstandard" im Feld',
        la.sel === 'system' && db.sel === 'system' && la.stored === null,
        JSON.stringify({ la: la.sel, db: db.sel, stored: la.stored }));
      check('Systemstandard folgt dem System',
        la.attr === 'light' && db.attr === 'dark' && la.card !== db.card,
        JSON.stringify({ hell: la.attr, dunkel: db.attr }));
      await a.c.close(); await b.c.close();
    }

    // Eine Auswahl schlaegt das System — der eigentliche Zweck der Einstellung.
    {
      const { c, p } = await open('light');
      const before = await readTheme(p);
      await p.selectOption('#settings-theme', 'dark');
      await p.waitForTimeout(400);
      const after = await readTheme(p);
      check('"Dunkel" schaltet trotz hellem System um',
        after.attr === 'dark' && after.card !== before.card && after.scheme === 'dark',
        JSON.stringify(after));
      check('Auswahl wird gespeichert', after.stored === 'dark', String(after.stored));
      await p.reload();
      await p.waitForTimeout(900);
      await p.click('[data-tab="data"]');
      await p.waitForTimeout(300);
      const reloaded = await readTheme(p);
      check('Auswahl ueberlebt den Reload',
        reloaded.attr === 'dark' && reloaded.sel === 'dark', JSON.stringify(reloaded));
      await c.close();
    }

    // Wann das Attribut gesetzt wird, entscheidet ueber den Farbblitz beim
    // Laden: kommt es vom Bootstrap-Skript im <head>, steht es, bevor es einen
    // <body> zum Zeichnen gibt. Kommt es erst vom Hauptskript am Seitenende,
    // ist der Body laengst geparst — die Seite erscheint dann hell und springt
    // einen Frame spaeter um. Genau das misst dieser Test, und nur das:
    // waehrend welcher Parsephase das data-theme-Attribut erscheint.
    {
      const c = await browser.newContext({ timezoneId: 'Europe/Berlin', colorScheme: 'light' });
      const p = await c.newPage();
      await p.addInitScript(() => {
        // Laeuft vor jedem Seitenskript — zu dem Zeitpunkt gibt es noch kein
        // documentElement, deshalb haengt der Observer am document.
        window.__themeStamp = 'nie gesetzt';
        new MutationObserver((recs, obs) => {
          for (const r of recs) {
            if (r.type === 'attributes' && r.attributeName === 'data-theme'
                && r.target === document.documentElement) {
              window.__themeStamp = { bodyExists: !!document.body, readyState: document.readyState };
              obs.disconnect();
              return;
            }
          }
        }).observe(document, { attributes: true, subtree: true, childList: true });
      });
      await p.addInitScript(k => localStorage.setItem(k, 'dark'), THEME_KEY);
      await p.goto(U);
      await p.waitForTimeout(900);
      const st = await p.evaluate(() => window.__themeStamp);
      const applied = await p.evaluate(() => getComputedStyle(document.querySelector('.card')).backgroundColor);
      check('Theme steht schon vor dem <body> — kein Umspringen beim Laden',
        st && st.bodyExists === false && st.readyState === 'loading' && applied === 'rgb(26, 45, 69)',
        JSON.stringify({ st, applied }));
      await c.close();
    }

    // Umgekehrt: helles Theme auf einem dunklen System.
    {
      const { c, p } = await open('dark', 'light');
      const r = await readTheme(p);
      check('"Hell" schaltet trotz dunklem System um',
        r.attr === 'light' && r.scheme === 'light' && r.sel === 'light', JSON.stringify(r));
      await c.close();
    }

    // Ein Systemwechsel zur Laufzeit: bei "Systemstandard" mitgehen, bei einer
    // ausdruecklichen Wahl nicht. Die Canvas-Farben backen beim Zeichnen ein,
    // deshalb zaehlt nicht nur das Attribut, sondern ob neu gezeichnet wurde.
    {
      const hash = p => p.evaluate(() => {
        const cv = document.getElementById('timeline-canvas');
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0;
        return h;
      });
      const { c, p } = await open('light');
      await p.click('[data-tab="home"]');
      await p.waitForTimeout(600);
      const h0 = await hash(p);
      await p.emulateMedia({ colorScheme: 'dark' });
      await p.waitForTimeout(700);
      const t1 = await p.evaluate(() => document.documentElement.dataset.theme);
      const h1 = await hash(p);
      check('Systemstandard folgt einem Wechsel zur Laufzeit', t1 === 'dark', t1);
      check('Zeitstrahl wird beim Themewechsel neu gezeichnet', h0 !== h1, `${h0} / ${h1}`);

      await p.click('[data-tab="data"]');
      await p.waitForTimeout(300);
      await p.selectOption('#settings-theme', 'light');
      await p.waitForTimeout(400);
      await p.click('[data-tab="home"]');
      await p.waitForTimeout(600);
      const h2 = await hash(p);
      await p.emulateMedia({ colorScheme: 'light' });
      await p.waitForTimeout(300);
      await p.emulateMedia({ colorScheme: 'dark' });
      await p.waitForTimeout(700);
      const t3 = await p.evaluate(() => document.documentElement.dataset.theme);
      check('ausdrueckliche Wahl ignoriert den Systemwechsel',
        t3 === 'light' && (await hash(p)) === h2, `${t3} / ${h2}`);
      await c.close();
    }

    // Muell im Storage darf die App nicht in ein viertes Theme schicken.
    {
      const { c, p } = await open('dark', 'neon');
      const r = await readTheme(p);
      check('unbekannter gespeicherter Wert faellt auf Systemstandard zurueck',
        r.attr === 'dark' && r.sel === 'system', JSON.stringify(r));
      await c.close();
    }

    // Die Auswahl ist eine Geraeteeinstellung, keine Zyklusdaten.
    {
      const { c, p } = await open('light', 'dark');
      const exported = await p.evaluate(() => JSON.stringify(state));
      check('Theme steht nicht im Export', !/theme/i.test(exported), exported.slice(0, 80));
      await c.close();
    }
  }

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
      st.calDays >= 28 && st.painted > 0 && st.rows === 4 && st.stats === 4 && st.canvas, JSON.stringify(st));
    check('Badge und Ereignisse vorhanden', st.badge.length > 3 && st.events > 0, JSON.stringify(st));
    await c.close();
  }

  console.log('\n' + (fails === 0 ? '✔ Alle Pruefungen bestanden' : `✘ ${fails} Pruefung(en) fehlgeschlagen`));
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})();
