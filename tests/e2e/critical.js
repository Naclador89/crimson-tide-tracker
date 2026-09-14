// Regression tests for the five critical review findings (K1–K5)
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
// Read from the document so a version bump does not fail the suite
const APP_VERSION = (require('fs')
  .readFileSync(require('path').join(__dirname, '..', '..', 'index.html'), 'utf8')
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
  const check = (name, ok, detail = '') => {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail && !ok ? '\n           ' + detail : ''));
    if (!ok) fails++;
  };

  // ══ K1 — service worker ══
  console.log('\n=== K1  Service Worker ===');
  const c1 = await browser.newContext({ timezoneId: 'Europe/Berlin' });
  const p1 = await c1.newPage();
  await p1.addInitScript(seed => localStorage.setItem('crimson-tide-tracker', JSON.stringify(seed)), SEED);
  const errs = [];
  p1.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text()); });
  p1.on('pageerror', e => errs.push('pageerror: ' + e.message));
  await p1.goto(U);
  await p1.waitForTimeout(2500);
  const sw = await p1.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return {
      count: r ? 1 : 0,
      script: r ? (r.active || r.installing || r.waiting).scriptURL : null,
      state: r ? (r.active ? 'active' : r.installing ? 'installing' : 'waiting') : null,
    };
  });
  check('Registrierung vorhanden', sw.count === 1, JSON.stringify(sw));
  check('Worker aktiv', sw.state === 'active', JSON.stringify(sw));
  check(`Skript ist ./sw.js?v=${APP_VERSION} (kein blob:)`,
    !!sw.script && sw.script.includes('/sw.js?v=' + APP_VERSION), String(sw.script));
  check('keine Konsolenfehler', errs.length === 0, errs.join(' | '));

  // The runtime cache picks up every same-origin GET, so an offline load
  // succeeds even for a file the precache list forgot — it only breaks for
  // someone who installs and goes offline before visiting again. So check the
  // list itself: every local asset the document pulls in must be precached.
  {
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'index.html'), 'utf8');
    const sw = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'sw.js'), 'utf8');
    const assets = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map(m => m[1]);
    const missing = [...new Set(assets)].filter(a => !sw.includes(`'${a}'`));
    check('alle lokalen Assets stehen im Precache', missing.length === 0,
      'fehlt: ' + missing.join(', '));
  }

  console.log('\n=== K1b Offline-Fahigkeit ===');
  await p1.reload();
  await p1.waitForTimeout(1500);
  await c1.setOffline(true);
  let offStatus = 'ERR';
  try { offStatus = (await p1.goto(U)).status(); } catch (e) { offStatus = 'ERR: ' + e.message; }
  // Not just static markup: the app must actually run, which means
  // cycle-core.js came out of the cache too.
  const offlineOK = await p1.evaluate(() => {
    const staticOK = !!document.querySelector('header h1') && document.querySelectorAll('.tab').length === 5;
    const coreOK = typeof CycleCore === 'object' && typeof buildAllPhases === 'function';
    let renderOK = false;
    try {
      document.querySelector('[data-tab="cycles"]').click();
      renderOK = document.getElementById('cycle-list').children.length > 0;
    } catch (e) { renderOK = false; }
    return staticOK && coreOK && renderOK;
  }).catch(() => false);
  check('laedt offline aus dem Cache', offStatus === 200 && offlineOK, 'status=' + offStatus + ' rendered=' + offlineOK);
  await c1.setOffline(false);

  // ══ K1c — Update-Angebot ══
  //
  // Der Kern: ein wartender Worker uebernimmt erst, wenn jedes Fenster der App
  // geschlossen ist — oder wenn man ihm sagt, er soll das Warten ueberspringen.
  // Auf dem Handy, das die PWA im Hintergrund haelt, ist der Knopf also der
  // einzige Weg zum Update. Tat er nichts, kam nie eines an.
  //
  // Dafuer braucht es einen echten Deploy: eigener Server auf einer Kopie der
  // App, in der die Version waehrend des Tests hochgezaehlt wird.
  console.log('\n=== K1c Update-Angebot ===');
  {
    const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
    const root = path.join(__dirname, '..', '..');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-update-'));
    for (const f of fs.readdirSync(root)) {
      if (f === 'tests' || f === '.git') continue;
      const src = path.join(root, f);
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(dir, f));
    }
    const TYPES = { '.html': 'text/html', '.js': 'text/javascript',
      '.webmanifest': 'application/manifest+json', '.json': 'application/json',
      '.png': 'image/png', '.jpg': 'image/jpeg' };
    const server = http.createServer((req, res) => {
      let name = decodeURIComponent(req.url.split('?')[0]);
      if (name === '/') name = '/index.html';
      const file = path.join(dir, path.basename(name));
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        // no-store: der Browser-HTTP-Cache darf hier nichts verschleiern, der
        // Service Worker ist das Einzige, was cachen soll.
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
                             'Cache-Control': 'no-store' });
        res.end(buf);
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    const idx = path.join(dir, 'index.html');
    const version = () => (fs.readFileSync(idx, 'utf8')
      .match(/<meta name="app-version" content="([^"]+)"/) || [, '?'])[1];

    const c = await browser.newContext();
    const p = await c.newPage();
    const until = async (fn, ms = 15000) => {
      const end = Date.now() + ms;
      for (;;) {
        try { if (await fn()) return true; } catch (e) {}
        if (Date.now() > end) return false;
        await p.waitForTimeout(250);
      }
    };
    const shown = () => p.evaluate(() =>
      document.getElementById('update-banner').classList.contains('show'));

    await p.goto(base + '/index.html');
    const controlled = await until(() => p.evaluate(() => !!navigator.serviceWorker.controller));
    check('Worker uebernimmt die erste Seite', controlled, 'controller=' + controlled);
    await p.waitForTimeout(500);
    check('kein Update-Angebot bei frischer Installation', (await shown()) === false, '');

    // Deploy: neue Version ausliefern. Die erste Anfrage bekommt noch die alte
    // Seite aus dem Cache und frischt ihn im Hintergrund auf, erst die naechste
    // sieht die neue — genau wie beim echten Start der App.
    fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8')
      .replace(/(<meta name="app-version" content=")[^"]+/, '$19.9.9'));
    const arrived = await until(async () => {
      await p.reload();
      await p.waitForTimeout(600);
      return await p.evaluate(() =>
        document.querySelector('meta[name="app-version"]').content === '9.9.9');
    }, 20000);
    check('neue Version erreicht die Seite', arrived, 'version im Verzeichnis=' + version());

    const offered = await until(() => shown());
    check('Update-Angebot erscheint', offered, '');

    // Der eigentliche Fehler war, dass der Knopf nicht anklickbar war: er erbte
    // pointer-events:none vom Toast. Ein solches Element liefert elementFromPoint
    // nicht zurueck — der Tipper ging ins Leere.
    const hittable = await p.evaluate(() => {
      const b = document.getElementById('update-banner');
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { treffer: hit === b, stattdessen: hit ? hit.id || hit.className || hit.tagName : null,
               events: getComputedStyle(b).pointerEvents };
    });
    check('Knopf nimmt Klicks an', hittable.treffer === true, JSON.stringify(hittable));

    // Echter Klick mit Trefferpruefung, kein dispatchEvent: nur so faellt auf,
    // wenn der Knopf verdeckt oder nicht klickbar ist.
    await p.click('#update-banner', { timeout: 5000 }).catch(() => {});
    const took = await until(async () => {
      const u = await p.evaluate(() => navigator.serviceWorker.controller
        ? navigator.serviceWorker.controller.scriptURL : '');
      return u.includes('v=9.9.9');
    }, 15000);
    check('Klick uebernimmt den neuen Worker', took, '');

    // Der Klick laedt die Seite neu — bis das durch ist, wirft jedes evaluate.
    // until() schluckt das und fragt weiter, statt den Test abstuerzen zu lassen.
    const state = () => p.evaluate(() => ({
      banner: document.getElementById('update-banner').classList.contains('show'),
      version: document.querySelector('meta[name="app-version"]').content,
      body: document.body.classList.contains('update-pending'),
    }));
    const gone = await until(async () => {
      const r = await state();
      return r.banner === false && r.body === false && r.version === '9.9.9';
    });
    check('Angebot verschwindet, sobald die App aktuell ist', gone,
      JSON.stringify(await state().catch(() => 'Seite laedt noch')));

    // Und der zweite Teil der Beschwerde: ein Angebot, das stehen bleibt,
    // obwohl es nichts mehr anzuwenden gibt. Hier kuenstlich herbeigefuehrt —
    // Banner an, aber kein wartender Worker. Beim naechsten Blick auf die App
    // (visibilitychange) muss es von selbst verschwinden.
    await p.evaluate(() => {
      document.getElementById('update-banner').classList.add('show');
      document.body.classList.add('update-pending');
    });
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const selfHealed = await until(async () => (await state()).banner === false, 8000);
    check('stehengebliebenes Angebot raeumt sich beim naechsten Start weg',
      selfHealed, JSON.stringify(await state().catch(() => '?')));

    await c.close();
    await new Promise(r => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ══ K3 — manifest ══
  console.log('\n=== K3  Manifest ===');
  await p1.goto(U);
  await p1.waitForTimeout(700);
  const cdp = await c1.newCDPSession(p1);
  const man = await cdp.send('Page.getAppManifest');
  check('keine Manifest-Fehler', (man.errors || []).length === 0, JSON.stringify(man.errors));
  check('Manifest von echter URL geladen', /manifest\.webmanifest$/.test(man.url || ''), 'url=' + man.url);
  check('scope aufgeloest', !!(man.parsed && man.parsed.scope && man.parsed.scope.startsWith('http')), JSON.stringify(man.parsed));
  check('start_url im Manifest', /"start_url"\s*:\s*"\.\/"/.test(man.data || ''), '');
  let shortcuts = 0, icons = 0;
  try { const d = JSON.parse(man.data); shortcuts = (d.shortcuts || []).length; icons = (d.icons || []).length; } catch (e) {}
  // Icon purposes are asserted in push.js; here only that the manifest carries
  // both shortcuts and some icons at all.
  check('2 Shortcuts und Icons deklariert', shortcuts === 2 && icons >= 2, `shortcuts=${shortcuts} icons=${icons}`);
  const iconOK = await p1.evaluate(async () => {
    const r = await fetch('./icon-192.jpg');
    return r.ok && (r.headers.get('content-type') || '').includes('image');
  });
  check('Icon-Datei erreichbar', iconOK);
  await c1.close();

  // ══ K4 — timezones ══
  console.log('\n=== K4  Zeitzone ===');
  for (const tz of ['Europe/Berlin', 'UTC', 'America/New_York', 'Pacific/Auckland']) {
    const c = await browser.newContext({ timezoneId: tz });
    const p = await c.newPage();
    await p.addInitScript(seed => localStorage.setItem('crimson-tide-tracker', JSON.stringify(seed)), SEED);
    await p.goto(U);
    await p.waitForTimeout(600);
    const r = await p.evaluate(() => ({
      derived: buildAllPhases().slice(0, 4).map(x => x.start),
      real: sortedCycles().map(c => c.start),
      next: (nextPredictedPeriod() || {}).start,
      roundtrip: dateStr(parseDate('2026-09-12')),
      addDaysStr: dateStr(addDays('2026-09-12', 3)),
      addDaysNeg: dateStr(addDays(parseDate('2026-09-12'), -5)),
    }));
    check(`${tz}: Phasenstarts == eingetragene Starts`, JSON.stringify(r.derived) === JSON.stringify(r.real), JSON.stringify(r));
    check(`${tz}: dateStr/addDays roundtrip`, r.roundtrip === '2026-09-12' && r.addDaysStr === '2026-09-15' && r.addDaysNeg === '2026-09-07', JSON.stringify(r));
    check(`${tz}: naechste Prognose 2026-09-25`, r.next === '2026-09-25', 'next=' + r.next);
    await c.close();
  }
  const cM = await browser.newContext({ timezoneId: 'Europe/Berlin' });
  const pM = await cM.newPage();
  await pM.addInitScript(() => {
    const f = new Date('2026-09-11T22:30:00Z').getTime(); const D = Date;
    Date = class extends D { constructor(...a) { if (!a.length) super(f); else super(...a); } static now() { return f; } };
  });
  await pM.goto(U);
  await pM.waitForTimeout(500);
  const tM = await pM.evaluate(() => today());
  check('today() um 00:30 MESZ = 2026-09-12', tM === '2026-09-12', 'today()=' + tM);
  await cM.close();

  // ══ K5 — corrupt storage ══
  console.log('\n=== K5  Beschaedigter Speicher ===');
  const cases = [
    ['{"foo":1}', '{"foo":1}'],
    ['kaputtes JSON', '{nope'],
    ['leerer String', ''],
    ['ungueltige Eintraege', JSON.stringify({ cycles: [
      { id: 'ok1', start: '2026-08-28', end: '2026-09-01' },
      { id: 'x" onmouseover=alert(1)', start: '2026-07-01' },
      { start: 'nope' }, null, { id: 'bad', start: '2026-05-01', end: '2026-04-01' },
    ] })],
  ];
  for (const [label, val] of cases) {
    const c = await browser.newContext();
    const p = await c.newPage();
    const pe = [];
    p.on('pageerror', e => pe.push(e.message));
    await p.addInitScript(v => localStorage.setItem('crimson-tide-tracker', v), val);
    await p.goto(U);
    await p.waitForTimeout(700);
    const st = await p.evaluate(() => ({
      rendered: !!document.querySelector('header h1'),
      resetReachable: !!document.querySelector('[data-action="reset"]'),
      cycles: state.cycles.length,
      ids: state.cycles.map(c => c.id),
      warnDays: state.settings.warnDays,
      backup: !!localStorage.getItem('crimson-tide-tracker-backup'),
    })).catch(e => ({ error: e.message }));
    check(`"${label}": kein Absturz, App bedienbar`,
      pe.length === 0 && st.rendered && st.resetReachable && st.warnDays === 3,
      pe.join('|') + ' ' + JSON.stringify(st));
    if (label === 'ungueltige Eintraege') {
      check('   nur der gueltige Eintrag uebernommen + Backup gesichert',
        st.cycles === 1 && st.ids[0] === 'ok1' && st.backup, JSON.stringify(st));
    }
    await c.close();
  }

  // ══ K2 — notifications ══
  console.log('\n=== K2  Benachrichtigungen ===');
  const c2 = await browser.newContext({ timezoneId: 'Europe/Berlin' });
  await c2.grantPermissions(['notifications'], { origin: BASE });
  const p2 = await c2.newPage();
  await p2.addInitScript(seed => {
    const f = new Date('2026-09-23T10:00:00Z').getTime(); const D = Date;
    Date = class extends D { constructor(...a) { if (!a.length) super(f); else super(...a); } static now() { return f; } };
    localStorage.setItem('crimson-tide-tracker', JSON.stringify(seed));
  }, SEED);
  await p2.goto(U);
  await p2.waitForTimeout(3000);
  const n1 = await p2.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    const ns = await reg.getNotifications();
    return {
      count: ns.length, title: ns[0] && ns[0].title, body: ns[0] && ns[0].body,
      persisted: JSON.parse(localStorage.getItem('crimson-tide-tracker')).settings.lastNotifiedFor,
    };
  });
  check('Warnung wurde angezeigt', n1.count === 1, JSON.stringify(n1));
  check('Text nennt 2 Tage', /in 2 Tagen/.test(n1.body || ''), String(n1.body));
  check('lastNotifiedFor = 2026-09-25 persistiert', n1.persisted === '2026-09-25', String(n1.persisted));
  await p2.reload();
  await p2.waitForTimeout(2500);
  const n2 = await p2.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length);
  check('keine Doppelmeldung beim erneuten Oeffnen', n2 === 1, 'n=' + n2);
  await c2.close();

  // too early -> no notification
  const c4 = await browser.newContext({ timezoneId: 'Europe/Berlin' });
  await c4.grantPermissions(['notifications'], { origin: BASE });
  const p4 = await c4.newPage();
  await p4.addInitScript(seed => {
    const f = new Date('2026-09-15T10:00:00Z').getTime(); const D = Date;
    Date = class extends D { constructor(...a) { if (!a.length) super(f); else super(...a); } static now() { return f; } };
    localStorage.setItem('crimson-tide-tracker', JSON.stringify(seed));
  }, SEED);
  await p4.goto(U);
  await p4.waitForTimeout(2500);
  const n3 = await p4.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length);
  check('ausserhalb des Warnfensters keine Meldung', n3 === 0, 'n=' + n3);
  await c4.close();

  // The app's own off switch: inside the warning window, permission granted,
  // and still nothing — the only state the browser permission cannot express.
  const c6 = await browser.newContext({ timezoneId: 'Europe/Berlin' });
  await c6.grantPermissions(['notifications'], { origin: BASE });
  const p6 = await c6.newPage();
  await p6.addInitScript(seed => {
    const f = new Date('2026-09-23T10:00:00Z').getTime(); const D = Date;
    Date = class extends D { constructor(...a) { if (!a.length) super(f); else super(...a); } static now() { return f; } };
    localStorage.setItem('crimson-tide-tracker', JSON.stringify(
      { ...seed, settings: { ...seed.settings, notifyEnabled: false } }));
  }, SEED);
  await p6.goto(U);
  await p6.waitForTimeout(2500);
  const off = await p6.evaluate(async () => ({
    count: (await (await navigator.serviceWorker.ready).getNotifications()).length,
    persisted: JSON.parse(localStorage.getItem('crimson-tide-tracker')).settings.notifyEnabled,
  }));
  check('ausgeschaltet -> keine Meldung im Warnfenster', off.count === 0, JSON.stringify(off));
  check('notifyEnabled=false wird uebernommen', off.persisted === false, JSON.stringify(off));

  // Switching back on must warn about the period that is already running.
  await p6.evaluate(() => toggleNotifications());
  await p6.waitForTimeout(1500);
  const backOn = await p6.evaluate(async () => ({
    count: (await (await navigator.serviceWorker.ready).getNotifications()).length,
    persisted: JSON.parse(localStorage.getItem('crimson-tide-tracker')).settings.notifyEnabled,
  }));
  check('wieder eingeschaltet -> Warnung erscheint', backOn.count === 1, JSON.stringify(backOn));
  check('notifyEnabled=true persistiert', backOn.persisted === true, JSON.stringify(backOn));

  // Switching off again also takes the standing warning off the screen.
  await p6.evaluate(() => toggleNotifications());
  await p6.waitForTimeout(1500);
  const offAgain = await p6.evaluate(async () => ({
    count: (await (await navigator.serviceWorker.ready).getNotifications()).length,
    persisted: JSON.parse(localStorage.getItem('crimson-tide-tracker')).settings.notifyEnabled,
  }));
  check('ausschalten schliesst die stehende Meldung', offAgain.count === 0, JSON.stringify(offAgain));
  check('notifyEnabled=false persistiert', offAgain.persisted === false, JSON.stringify(offAgain));
  await c6.close();

  const c3 = await browser.newContext({ timezoneId: 'Europe/Berlin' });
  const p3 = await c3.newPage();
  // Headless Chromium reports 'denied' by default, so drive the branch directly.
  await p3.addInitScript(() => Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true }));
  await p3.goto(U);
  await p3.waitForTimeout(1000);
  const btn = await p3.evaluate(() => {
    renderSettings();
    const b = document.getElementById('notif-enable-btn');
    return { exists: !!b, visible: !!b && b.style.display !== 'none',
             status: document.getElementById('notif-status').textContent.slice(0, 40) };
  });
  check('Aktivieren-Button sichtbar bei permission=default', btn.exists && btn.visible, JSON.stringify(btn));
  const denied = await p3.evaluate(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'denied', configurable: true });
    renderSettings();
    const b = document.getElementById('notif-enable-btn');
    return { hidden: b.style.display === 'none', status: document.getElementById('notif-status').textContent };
  });
  check('Button verborgen + Hinweis bei permission=denied', denied.hidden && /blockiert/i.test(denied.status), JSON.stringify(denied));
  const granted = await p3.evaluate(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'granted', configurable: true });
    const read = () => {
      renderSettings();
      const t = document.getElementById('notif-toggle-btn');
      return { visible: t.style.display !== 'none', label: t.textContent,
               status: document.getElementById('notif-status').textContent };
    };
    state.settings.notifyEnabled = true;  const on  = read();
    state.settings.notifyEnabled = false; const off = read();
    return { on, off, enableHidden: document.getElementById('notif-enable-btn').style.display === 'none' };
  });
  check('Umschalter bietet bei granted+an das Ausschalten an',
    granted.on.visible && /ausschalten/i.test(granted.on.label) && /aktiv/.test(granted.on.status),
    JSON.stringify(granted.on));
  check('Umschalter bietet bei granted+aus das Einschalten an',
    granted.off.visible && /einschalten/i.test(granted.off.label) && /ausgeschaltet/.test(granted.off.status),
    JSON.stringify(granted.off));
  check('Aktivieren-Button bleibt bei granted verborgen', granted.enableHidden, JSON.stringify(granted));
  await c3.close();

  // ══ Regression: core flows still work ══
  console.log('\n=== Regression ===');
  const c5 = await browser.newContext({ timezoneId: 'Europe/Berlin' });
  const p5 = await c5.newPage();
  const pe5 = [];
  p5.on('pageerror', e => pe5.push(e.message));
  await p5.addInitScript(seed => localStorage.setItem('crimson-tide-tracker', JSON.stringify(seed)), SEED);
  await p5.goto(U);
  await p5.waitForTimeout(600);
  for (const t of ['calendar', 'cycles', 'stats', 'settings', 'home']) {
    await p5.evaluate(n => showTab(n, document.querySelector(`[onclick="showTab('${n}', this)"]`)), t);
    await p5.waitForTimeout(150);
  }
  const reg5 = await p5.evaluate(() => ({
    calDays: document.querySelectorAll('.cal-day:not(.empty)').length,
    rows: document.querySelectorAll('.cycle-row').length,
    stats: document.querySelectorAll('.stat-box').length,
    badge: document.getElementById('home-phase-badge').textContent.trim().slice(0, 40),
    events: document.querySelectorAll('#next-events .event-pill').length,
    canvasPainted: (() => { const c = document.getElementById('timeline-canvas'); return c.width > 100; })(),
  }));
  check('alle Tabs rendern ohne Fehler', pe5.length === 0, pe5.join('|'));
  check('Kalender/Liste/Statistik gefuellt', reg5.calDays >= 28 && reg5.rows === 4 && reg5.stats === 4, JSON.stringify(reg5));
  check('Zeitstrahl gezeichnet', reg5.canvasPainted, JSON.stringify(reg5));
  check('Ereignis-Pillen vorhanden', reg5.events > 0, JSON.stringify(reg5));

  // quick entry + open-cycle round trip
  const qe = await p5.evaluate(() => {
    quickStart();
    const added = state.cycles.some(c => c.start === today());
    quickEnd();
    const closed = state.cycles.find(c => c.start === today()).end === today();
    return { added, closed, n: state.cycles.length };
  });
  check('Schnelleingabe Start/Ende', qe.added && qe.closed && qe.n === 5, JSON.stringify(qe));

  // export/import round trip
  const io = await p5.evaluate(() => {
    const json = JSON.stringify(state);
    const before = state.cycles.length;
    state.cycles = [];
    const parsed = JSON.parse(json);
    const valid = parsed.cycles.filter(isValidCycle);
    return { before, valid: valid.length };
  });
  check('Export-Daten passieren die Validierung', io.before === io.valid, JSON.stringify(io));
  await c5.close();

  console.log('\n' + (fails === 0 ? '✔ Alle Pruefungen bestanden' : `✘ ${fails} Pruefung(en) fehlgeschlagen`));
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})();
