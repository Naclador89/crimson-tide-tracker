// Regression tests for the small review findings (G1–G9) and chart labelling
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
const fs = require('fs');
const BASE = process.env.BASE_URL || 'http://localhost:8790';
const U = BASE + '/index.html';
const ROOT = require('path').join(__dirname, '..', '..');
const APP_VERSION = (fs.readFileSync(ROOT + '/index.html', 'utf8')
  .match(/<meta name="app-version" content="([^"]+)"/) || [, '?'])[1];

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
  const open = async (opts = {}, storage = SEED) => {
    const c = await browser.newContext({ timezoneId: 'Europe/Berlin', ...opts });
    const p = await c.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    await p.addInitScript(v => localStorage.setItem('crimson-tide-tracker', v), JSON.stringify(storage));
    await p.goto(U);
    await p.waitForTimeout(900);
    return { c, p, errs };
  };

  // ══ G1 — payload ══
  console.log('\n=== G1  Auslieferungsgroesse ===');
  {
    const html = fs.readFileSync(ROOT + '/index.html');
    const b64 = (html.toString().match(/base64,[A-Za-z0-9+/=]*/g) || []).join('').length;
    check('index.html unter 200 KB', html.length < 200_000, html.length + ' bytes');
    check('Base64-Anteil unter 50 %', b64 / html.length < 0.5,
      `${b64} von ${html.length} (${(100 * b64 / html.length).toFixed(0)}%)`);
    const faces = (html.toString().match(/@font-face/g) || []).length;
    check('nur noch 4 Font-Faces (300 + Serif-Italic entfernt)', faces === 4, 'n=' + faces);

    const { c, p, errs } = await open();
    const fontsOK = await p.evaluate(async () => {
      await document.fonts.ready;
      // every glyph the UI renders must still resolve in the subset
      const probe = 'ÄÖÜäöüß–—„“·→σ0123456789';
      const cv = document.createElement('canvas').getContext('2d');
      cv.font = "400 16px 'DM Sans'";
      const w1 = cv.measureText(probe).width;
      cv.font = '400 16px sans-serif';
      const w2 = cv.measureText(probe).width;
      return {
        loaded: [...document.fonts].filter(f => f.status === 'loaded').map(f => `${f.family} ${f.weight} ${f.style}`),
        differs: Math.abs(w1 - w2) > 0.5,
      };
    });
    check('Schriften laden', fontsOK.loaded.length >= 2, JSON.stringify(fontsOK.loaded));
    check('Umlaute/Typografie im Subset vorhanden', fontsOK.differs,
      'DM Sans rendert wie Fallback -> Zeichen fehlen');
    check('keine Konsolenfehler', errs.length === 0, errs.join(' | '));
    await c.close();
  }

  // ══ G2 — version ══
  console.log('\n=== G2  Version ===');
  {
    const { c, p } = await open();
    const v = await p.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return {
        meta: document.querySelector('meta[name="app-version"]').content,
        script: reg && (reg.active || reg.installing || reg.waiting).scriptURL,
        caches: await caches.keys(),
      };
    });
    check('Version ist nicht mehr die eingefrorene 1.0.0', v.meta !== '1.0.0' && v.meta === APP_VERSION, v.meta);
    check('Cache-Name traegt die Version',
      v.caches.some(k => k === 'ctt-v' + APP_VERSION), JSON.stringify(v.caches));
    check('SW-URL traegt die Version',
      (v.script || '').includes('v=' + APP_VERSION), String(v.script));
    await c.close();
  }

  // ══ G3 — only the visible tab renders ══
  console.log('\n=== G3  Nur sichtbarer Tab ===');
  {
    const { c, p } = await open();
    const counts = await p.evaluate(() => {
      const hits = { home: 0, calendar: 0, cycles: 0, stats: 0, settings: 0 };
      const wrap = (name, fn) => function (...a) { hits[name]++; return fn.apply(this, a); };
      renderHome = wrap('home', renderHome);
      renderCalendar = wrap('calendar', renderCalendar);
      renderCyclesList = wrap('cycles', renderCyclesList);
      renderStats = wrap('stats', renderStats);
      renderSettings = wrap('settings', renderSettings);
      TAB_RENDERERS.home = renderHome; TAB_RENDERERS.calendar = renderCalendar;
      TAB_RENDERERS.cycles = renderCyclesList; TAB_RENDERERS.stats = renderStats;
      TAB_RENDERERS.settings = renderSettings;
      document.querySelector('[data-tab="calendar"]').click();
      return hits;
    });
    check('Tab-Wechsel rendert nur den Zieltab',
      counts.calendar === 1 && counts.stats === 0 && counts.cycles === 0 && counts.home === 0,
      JSON.stringify(counts));

    // A card outside every .section belongs to no tab, and therefore shows
    // under all of them. That was the case for a long time: one stray </div>
    // cut export, import and reset out of the tab, leaving the "delete
    // everything" button on every screen.
    const orphans = await p.evaluate(() =>
      [...document.querySelectorAll('.card')]
        .filter(el => !el.closest('.section'))
        .map(el => el.querySelector('.card-title')?.textContent.trim() || el.id || '?'));
    check('jede Karte liegt in einem Tab', orphans.length === 0, orphans.join(' | '));

    const loose = await p.evaluate(() => {
      document.querySelector('[data-tab="home"]').click();
      const btn = document.querySelector('[data-action="reset"]');
      return { sichtbar: !!(btn && btn.getClientRects().length), tab: activeTab };
    });
    check('kein Loesch-Button auf der Uebersicht',
      loose.sichtbar === false, JSON.stringify(loose));

    // The order inside the options tab is what the menu structure says: first
    // what the app does, then what happens to your data, destructive last.
    const cards = await p.evaluate(() => {
      document.querySelector('[data-tab="settings"]').click();
      return [...document.querySelectorAll('#tab-settings .card .card-title')]
        .map(t => t.textContent.replace(/[^\p{L}\s]/gu, '').trim());
    });
    check('Optionen-Tab zeigt die vier Karten in der geplanten Reihenfolge',
      JSON.stringify(cards) === JSON.stringify(
        ['Erscheinungsbild', 'Benachrichtigungen', 'Sicherung', 'App zurücksetzen']),
      JSON.stringify(cards));
    await c.close();
  }

  // ══ G4 — debounced resize ══
  console.log('\n=== G4  Resize-Debounce ===');
  {
    const { c, p } = await open();
    const n = await p.evaluate(async () => {
      let calls = 0;
      const orig = drawTimeline;
      drawTimeline = function (...a) { calls++; return orig.apply(this, a); };
      for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('resize'));
      await new Promise(r => setTimeout(r, 400));
      return calls;
    });
    check('20 resize-Events -> genau 1 Neuzeichnung', n === 1, 'calls=' + n);
    await c.close();
  }

  // ══ G5 — classification performance ══
  console.log('\n=== G5  Klassifikations-Performance ===');
  {
    const { c, p } = await open();
    const perf = await p.evaluate(() => {
      const cy = sortedCycles(), ac = calcAvgCycle(cy), ap = calcAvgPeriod(cy);
      const ph = buildAllPhases();
      const days = [];
      for (let i = -200; i < 200; i++) days.push(dateStr(addDays(today(), i)));

      const t0 = performance.now();
      const cl = makeDayClassifier(cy, ph, ac, ap);
      const fast = days.map(cl);
      const t1 = performance.now();
      const slow = days.map(d => classifyDay(d, cy, ph, ac, ap));
      const t2 = performance.now();
      return {
        identical: JSON.stringify(fast) === JSON.stringify(slow),
        indexed: t1 - t0, perCall: t2 - t1,
        sample: fast.filter(k => k !== 'unknown').length,
      };
    });
    check('indizierte und Einzelabfrage liefern identische Ergebnisse', perf.identical, JSON.stringify(perf));
    check('400 Tage indiziert deutlich schneller als einzeln',
      perf.indexed < perf.perCall / 5, `index=${perf.indexed.toFixed(1)}ms einzeln=${perf.perCall.toFixed(1)}ms`);
    check('Klassifikation liefert echte Phasen', perf.sample > 100, 'n=' + perf.sample);
    await c.close();
  }

  // ══ G6 — no inline handlers ══
  console.log('\n=== G6  Keine Inline-Handler ===');
  {
    const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
    check('kein onclick/onchange im Markup', !/\son(?:click|change)=/.test(html),
      (html.match(/\son(?:click|change)=[^\s]*/g) || []).slice(0, 3).join(' '));

    // every delegated action actually fires
    const { c, p, errs } = await open();
    const acts = await p.evaluate(async () => {
      const fired = [];
      for (const k of Object.keys(ACTIONS)) { const o = ACTIONS[k]; ACTIONS[k] = () => fired.push(k); }
      document.querySelector('[data-tab="settings"]').click();
      for (const el of document.querySelectorAll('[data-action]')) el.click();
      return { fired, buttons: document.querySelectorAll('[data-action]').length };
    });
    check('jede data-action ist verdrahtet', acts.fired.length === acts.buttons, JSON.stringify(acts));
    check('keine Fehler durch die Delegation', errs.length === 0, errs.join(' | '));
    await c.close();
  }

  // real interaction through the delegated handlers
  {
    const { c, p, errs } = await open();
    const flow = await p.evaluate(async () => {
      document.querySelector('[data-action="quick-start"]').click();
      const added = state.cycles.some(x => x.start === today());
      document.querySelector('[data-action="quick-end"]').click();
      const closed = state.cycles.find(x => x.start === today()).end === today();
      document.querySelector('[data-tab="calendar"]').click();
      const label = document.getElementById('cal-month-label').textContent;
      document.querySelector('[data-action="month-next"]').click();
      const moved = document.getElementById('cal-month-label').textContent !== label;
      return { added, closed, moved };
    });
    check('Schnelleingabe und Monatsnavigation ueber Delegation',
      flow.added && flow.closed && flow.moved, JSON.stringify(flow));
    check('keine Fehler im Ablauf', errs.length === 0, errs.join(' | '));
    await c.close();
  }

  // ══ G7 — accessibility ══
  console.log('\n=== G7  Zugaenglichkeit ===');
  {
    const { c, p } = await open();
    const a11y = await p.evaluate(() => {
      document.querySelector('[data-tab="calendar"]').click();
      const day = document.querySelector('.cal-day[data-date]');
      return {
        tablist: !!document.querySelector('[role="tablist"]'),
        tabsSelected: document.querySelectorAll('.tab[aria-selected]').length,
        activeSelected: document.querySelector('.tab.active').getAttribute('aria-selected'),
        panels: document.querySelectorAll('[role="tabpanel"]').length,
        grid: !!document.querySelector('#cal-grid[role="grid"]'),
        cellFocusable: day.tabIndex === 0,
        cellLabel: day.getAttribute('aria-label'),
        todayCurrent: !!document.querySelector('.cal-day[aria-current="date"]'),
        navLabels: [...document.querySelectorAll('.cal-nav')].map(b => b.getAttribute('aria-label')),
        toastLive: document.getElementById('toast').getAttribute('aria-live'),
        canvasLabelled: !!document.querySelector('#timeline-canvas[aria-label]'),
      };
    });
    check('Tabs sind eine Tablist mit aria-selected',
      a11y.tablist && a11y.tabsSelected === 5 && a11y.activeSelected === 'true' && a11y.panels === 5,
      JSON.stringify(a11y));
    check('Kalender ist ein Grid mit fokussierbaren Zellen',
      a11y.grid && a11y.cellFocusable, JSON.stringify(a11y));
    check('Zelle nennt Datum und Phase als Text (nicht nur Farbe)',
      /\d{2}\./.test(a11y.cellLabel) && a11y.cellLabel.length > 12, a11y.cellLabel);
    check('heutiger Tag ist als aria-current markiert', a11y.todayCurrent);
    check('Monatsnavigation beschriftet', a11y.navLabels.every(Boolean), JSON.stringify(a11y.navLabels));
    check('Toast ist eine Live-Region', a11y.toastLive === 'polite');
    check('Canvas hat eine Textalternative', a11y.canvasLabelled);

    // keyboard: arrow keys along the tabstrip, Enter on a calendar day
    const kb = await p.evaluate(async () => {
      const first = document.querySelector('[data-tab="home"]');
      first.focus();
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      const afterArrow = document.querySelector('.tab.active').dataset.tab;

      document.querySelector('[data-tab="calendar"]').click();
      const day = [...document.querySelectorAll('.cal-day[data-date]')]
        .find(d => d.dataset.date <= today());
      day.focus();
      day.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const opened = document.getElementById('modal-overlay').classList.contains('open');
      const preset = document.getElementById('m-start').value;
      return { afterArrow, opened, preset, expected: day.dataset.date };
    });
    check('Pfeiltasten wechseln den Tab', kb.afterArrow === 'calendar', kb.afterArrow);
    check('Enter auf einem Kalendertag oeffnet den Dialog', kb.opened, JSON.stringify(kb));
    check('Dialog uebernimmt das angeklickte Datum', kb.preset === kb.expected, JSON.stringify(kb));

    // escape closes and focus goes back
    const esc = await p.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return {
        closed: !document.getElementById('modal-overlay').classList.contains('open'),
        focusBack: document.activeElement.classList.contains('cal-day'),
      };
    });
    check('Escape schliesst den Dialog', esc.closed, JSON.stringify(esc));
    check('Fokus kehrt zum Ausloeser zurueck', esc.focusBack, JSON.stringify(esc));

    await p.evaluate(() => { document.querySelector('[data-tab="home"]').click(); document.body.focus(); });
    let focusStyle = { outline: 'none' };
    for (let i = 0; i < 25; i++) {
      await p.keyboard.press('Tab');
      await p.waitForTimeout(260);   // .tab has transition:all .2s — let the ring finish
      focusStyle = await p.evaluate(() => {
        const el = document.activeElement;
        const cs = getComputedStyle(el);
        return { tag: el.tagName, cls: el.className, outline: cs.outlineStyle, width: cs.outlineWidth };
      });
      if (focusStyle.outline !== 'none') break;
    }
    check('Fokus ist per Tastatur sichtbar',
      focusStyle.outline !== 'none' && parseFloat(focusStyle.width) >= 2, JSON.stringify(focusStyle));

    // a closed dialog must not be reachable by Tab
    const reachable = await p.evaluate(() => {
      const sel = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
      const scoped = sel.split(', ').map(x => '.modal-overlay:not(.open) ' + x).join(', ');
      return [...document.querySelectorAll(scoped)]
        .filter(el => getComputedStyle(el).visibility !== 'hidden'
                   && getComputedStyle(el).display !== 'none').length;
    });
    check('geschlossene Dialoge sind nicht fokussierbar', reachable === 0, 'erreichbar=' + reachable);
    await c.close();
  }

  // ══ G8 — duplicate check on edit ══
  console.log('\n=== G8  Duplikat beim Bearbeiten ===');
  {
    const { c, p } = await open();
    const r = await p.evaluate(() => {
      // move c1 onto c2's start date -> must be refused
      openEditModal('c1');
      document.getElementById('m-start').value = '2026-07-03';
      document.getElementById('m-end').value = '2026-07-07';
      saveModal();
      const refused = state.cycles.find(x => x.id === 'c1').start === '2026-06-05';
      const toast = document.getElementById('toast').textContent;

      // editing an entry without moving it must still work
      openEditModal('c1');
      document.getElementById('m-end').value = '2026-06-10';
      saveModal();
      const ownDateOK = state.cycles.find(x => x.id === 'c1').end === '2026-06-10';
      return { refused, ownDateOK, toast };
    });
    check('Kollision mit fremdem Eintrag wird abgelehnt', r.refused, JSON.stringify(r));
    check('Hinweis erscheint', /bereits einen Eintrag/.test(r.toast), r.toast);
    check('eigenes Startdatum behalten ist weiterhin erlaubt', r.ownDateOK, JSON.stringify(r));
    await c.close();
  }

  // ══ G9 — confirm modal, stats note, meta ══
  console.log('\n=== G9  Restliches ===');
  {
    const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
    check('meta description vorhanden', /<meta name="description"/.test(html));
    check('Open-Graph-Tags vorhanden', /og:title/.test(html) && /og:image/.test(html));
    check('kein globaler URL-Shadow im Service Worker',
      !/const URL\s*=/.test(fs.readFileSync(ROOT + '/sw.js', 'utf8')));

    const { c, p, errs } = await open();
    let nativeDialog = false;
    p.on('dialog', d => { nativeDialog = true; d.dismiss(); });
    const imp = await p.evaluate(async () => {
      const dt = new DataTransfer();
      dt.items.add(new File([JSON.stringify({ cycles: [{ id: 'n1', start: '2026-09-20' }] })],
        'x.json', { type: 'application/json' }));
      const input = document.getElementById('import-file-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      const overlay = document.getElementById('confirm-overlay');
      const shown = overlay.classList.contains('open');
      const title = document.getElementById('confirm-title').textContent;
      document.getElementById('confirm-ok').click();
      await new Promise(r => setTimeout(r, 300));
      return { shown, title, merged: state.cycles.some(x => x.start === '2026-09-20') };
    });
    check('Import fragt im App-Dialog, nicht via confirm()', imp.shown && !nativeDialog, JSON.stringify(imp));
    check('Dialogtitel passt zur Aktion', /importieren/i.test(imp.title), imp.title);
    check('Bestaetigung fuehrt den Import aus', imp.merged, JSON.stringify(imp));
    check('keine Fehler', errs.length === 0, errs.join(' | '));
    await c.close();
  }

  // stats note about excluded gaps
  {
    const { c, p } = await open({}, {
      cycles: [
        { id: 'a', start: '2026-01-05', end: '2026-01-09' },
        { id: 'b', start: '2026-02-02', end: '2026-02-06' },
        { id: 'c', start: '2026-08-28', end: '2026-09-01' }, // >60 day gap -> excluded
      ], settings: { warnDays: 3 },
    });
    const note = await p.evaluate(() => {
      document.querySelector('[data-tab="stats"]').click();
      return document.getElementById('stats-grid').textContent;
    });
    check('Statistik weist verworfene Abstaende aus',
      /außerhalb von 15–60 Tagen/.test(note), note.slice(-160));
    await c.close();
  }

  // ══ hormone labels ══
  console.log('\n=== Hormon-Beschriftung ===');
  {
    const { c, p } = await open();
    const boxes = await p.evaluate(async () => {
      await document.fonts.ready;
      const captured = [];
      const cv = document.getElementById('hormone-canvas');
      const ctx = cv.getContext('2d');
      const origFill = ctx.fillText.bind(ctx);
      const names = ['Östrogen', 'LH', 'FSH', 'Progesteron'];
      ctx.fillText = function (t, x, y) {
        if (names.includes(t)) {
          const w = this.measureText(t).width;
          captured.push({ t, left: this.textAlign === 'right' ? x - w : x, right: (this.textAlign === 'right' ? x - w : x) + w, y });
        }
        return origFill(t, x, y);
      };
      drawHormones();
      return captured;
    });
    check('alle vier Hormone beschriftet', boxes.length === 4, JSON.stringify(boxes.map(b => b.t)));
    let overlaps = [];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.left < b.right && b.left < a.right && Math.abs(a.y - b.y) < 9)
          overlaps.push(`${a.t}/${b.t}`);
      }
    check('keine ueberlappenden Beschriftungen mehr', overlaps.length === 0, overlaps.join(', '));
    await c.close();
  }

  // ══ Regression ══
  console.log('\n=== Regression ===');
  {
    const { c, p, errs } = await open();
    for (const t of ['calendar', 'cycles', 'stats', 'settings', 'home']) {
      await p.evaluate(n => document.querySelector(`[data-tab="${n}"]`).click(), t);
      await p.waitForTimeout(200);
    }
    const st = await p.evaluate(() => {
      document.querySelector('[data-tab="calendar"]').click();
      const painted = document.querySelectorAll('.cal-day.period-day, .cal-day.predicted-period, .cal-day.predicted-pms').length;
      document.querySelector('[data-tab="cycles"]').click();
      const rows = document.querySelectorAll('.cycle-row').length;
      document.querySelector('[data-tab="stats"]').click();
      const stats = document.querySelectorAll('.stat-box').length;
      document.querySelector('[data-tab="home"]').click();
      return {
        painted, rows, stats,
        badge: document.getElementById('home-phase-badge').textContent.trim().slice(0, 30),
        events: document.querySelectorAll('#next-events .event-pill').length,
        canvas: document.getElementById('timeline-canvas').width > 100,
        legend: document.querySelectorAll('#timeline-legend span span').length,
      };
    });
    check('alle Tabs ohne Fehler', errs.length === 0, errs.join(' | '));
    check('Inhalte vollstaendig',
      st.painted > 0 && st.rows === 4 && st.stats === 4 && st.canvas && st.events > 0 && st.legend === 6,
      JSON.stringify(st));
    check('Badge gesetzt', st.badge.length > 3, st.badge);
    await c.close();
  }

  console.log('\n' + (fails === 0 ? '✔ Alle Pruefungen bestanden' : `✘ ${fails} Pruefung(en) fehlgeschlagen`));
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})();
