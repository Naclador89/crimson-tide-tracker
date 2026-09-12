// Regression tests for the maskable icon and Web Push.
//
// The push path is exercised for real: a stub relay stands in for
// push-server/, and the push itself is delivered through the Chrome DevTools
// Protocol (ServiceWorker.deliverPushMessage), so the worker's push handler
// runs exactly as it would in the field.
//
// Run via tests/run.sh, which starts a local server and sets BASE_URL.

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
const path = require('path');
const http = require('http');
const BASE = process.env.BASE_URL || 'http://localhost:8790';
const U = BASE + '/index.html';
const ROOT = path.join(__dirname, '..', '..');

const SEED = {
  cycles: [
    { id: 'c1', start: '2026-06-05', end: '2026-06-09' },
    { id: 'c2', start: '2026-07-03', end: '2026-07-07' },
    { id: 'c3', start: '2026-07-31', end: '2026-08-04' },
    { id: 'c4', start: '2026-08-28', end: '2026-09-01' },
  ],
  settings: { warnDays: 3 },
};

// A real VAPID public key is required: subscribe() validates applicationServerKey.
const VAPID_PUBLIC = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkFZZoJSodyllfCEA'
                   + 'Ii1oaFYcM5PBUUXTsl2FMH7MTVsBnjEDLZWa9c';

// Stub relay: records what the app sends so the tests can assert on it.
function startStubRelay() {
  const received = { subscribe: [], unsubscribe: [], vapid: 0 };
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    if (req.url === '/vapid') {
      received.vapid++;
      return res.writeHead(200, { ...cors, 'Content-Type': 'application/json' })
                .end(JSON.stringify({ publicKey: VAPID_PUBLIC }));
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try { received[req.url.slice(1)]?.push(JSON.parse(body || '{}')); } catch (e) {}
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
  });
  return new Promise(resolve => {
    server.listen(0, () => resolve({ server, received, url: 'http://localhost:' + server.address().port }));
  });
}

// A hang must fail loudly rather than stall a CI run.
setTimeout(() => {
  console.error('\n\u2718 Zeitueberschreitung \u2014 die Suite haengt');
  process.exit(1);
}, 120000).unref();

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  let fails = 0;
  const check = (n, ok, d = '') => {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + n + (d && !ok ? '\n           ' + d : ''));
    if (!ok) fails++;
  };

  // ══ Maskable icon ══
  console.log('\n=== Maskierbares Icon ===');
  {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
    const maskable = manifest.icons.filter(i => (i.purpose || '').split(/\s+/).includes('maskable'));
    const any = manifest.icons.filter(i => (i.purpose || '').split(/\s+/).includes('any'));
    check('maskable und any sind getrennt deklariert',
      maskable.length >= 2 && any.length >= 2, JSON.stringify(manifest.icons.map(i => i.purpose)));
    check('kein Icon ist gleichzeitig any und maskable',
      !manifest.icons.some(i => /any/.test(i.purpose) && /maskable/.test(i.purpose)),
      'ein Icon ohne Sicherheitsrand darf nicht als maskable gelten');
    check('maskable-Icons sind PNG in 192 und 512',
      maskable.every(i => i.type === 'image/png') &&
      maskable.map(i => i.sizes).sort().join() === '192x192,512x512',
      JSON.stringify(maskable));

    for (const icon of maskable) {
      const file = path.join(ROOT, icon.src.replace(/^\.\//, ''));
      check(`${icon.src} existiert`, fs.existsSync(file));
    }

    // The real guarantee: nothing but background outside the central 80%.
    // Android may crop anything beyond that circle.
    const p = await (await browser.newContext()).newPage();
    await p.goto(BASE + '/icon-maskable-512.png');
    const safe = await p.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      const at = (x, y) => { const i = (y * c.width + x) * 4; return [data[i], data[i+1], data[i+2]]; };
      const bg = at(2, 2);
      const cx = c.width / 2, cy = c.height / 2;
      const safeR = c.width * 0.4;   // the 80% safe circle
      let outside = 0, differing = 0, worst = 0;
      for (let y = 0; y < c.height; y += 2) {
        for (let x = 0; x < c.width; x += 2) {
          if (Math.hypot(x - cx, y - cy) <= safeR) continue;
          outside++;
          const px = at(x, y);
          const d = Math.max(...px.map((v, i) => Math.abs(v - bg[i])));
          if (d > 12) { differing++; worst = Math.max(worst, d); }
        }
      }
      return { size: c.width, bg, outside, differing, worst };
    }, BASE + '/icon-maskable-512.png');
    check('außerhalb der Safe Zone ist nur Hintergrund',
      safe.differing === 0,
      `${safe.differing} von ${safe.outside} Pixeln weichen ab (max. Abweichung ${safe.worst}) — würde beschnitten`);
    check('Safe-Zone-Prüfung hat wirklich Pixel gesehen', safe.outside > 1000, JSON.stringify(safe));

    // Counter-check: the old full-bleed icon must fail the same test.
    const old = await p.evaluate(async (src) => {
      const img = new Image(); img.src = src; await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      const at = (x, y) => { const i = (y * c.width + x) * 4; return [data[i], data[i+1], data[i+2]]; };
      const bg = at(2, 2);
      const cx = c.width / 2, cy = c.height / 2, safeR = c.width * 0.4;
      let differing = 0;
      for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) {
        if (Math.hypot(x - cx, y - cy) <= safeR) continue;
        const px = at(x, y);
        if (Math.max(...px.map((v, i) => Math.abs(v - bg[i]))) > 12) differing++;
      }
      return differing;
    }, BASE + '/icon-512.jpg');
    check('Gegenprobe: das randlose Icon fällt durch dieselbe Prüfung', old > 100,
      `nur ${old} abweichende Pixel — die Prüfung misst nichts`);
    await p.context().close();
  }

  // ══ Web Push ══
  console.log('\n=== Web Push ===');
  const relay = await startStubRelay();
  try {
    const ctx = await browser.newContext({ timezoneId: 'Europe/Berlin' });
    await ctx.grantPermissions(['notifications'], { origin: BASE });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.addInitScript(seed => {
      const f = new Date('2026-09-12T10:00:00Z').getTime(); const D = Date;
      Date = class extends D { constructor(...a) { if (!a.length) super(f); else super(...a); } static now() { return f; } };
      localStorage.setItem('crimson-tide-tracker', JSON.stringify(seed));

      // Stand in for the browser<->push-service handshake ONLY. Subscribing for
      // real needs a reachable push service, and Chrome disables the Push API
      // in incognito contexts outright — neither is available to a test runner.
      // Everything after this point (what gets sent, the local cache, the
      // service worker's push handler, teardown) runs unmodified.
      const fake = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-test-endpoint',
        expirationTime: null,
        options: {},
        getKey() { return null; },
        toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'p256dh-e2e', auth: 'auth-e2e' } }; },
        unsubscribe() { window.__pushUnsubscribed = true; window.__pushSub = null; return Promise.resolve(true); },
        keys: { p256dh: 'p256dh-e2e', auth: 'auth-e2e' },
      };
      window.__pushSub = null;
      PushManager.prototype.subscribe = function () { window.__pushSub = fake; return Promise.resolve(fake); };
      PushManager.prototype.getSubscription = function () { return Promise.resolve(window.__pushSub); };
    }, SEED);
    await page.goto(U);
    await page.waitForTimeout(2500);

    check('Push ist standardmäßig aus', await page.evaluate(() => !state.settings.pushUrl));
    check('Status sagt, dass nichts das Gerät verlässt', await page.evaluate(() => {
      document.querySelector('[data-tab="data"]').click();
      return /bleiben auf diesem Gerät/.test(document.getElementById('push-status').textContent);
    }));
    check('ohne Konfiguration erreicht den Relay nichts',
      relay.received.vapid === 0 && relay.received.subscribe.length === 0,
      JSON.stringify(relay.received));

    // Turn it on
    await page.evaluate(url => {
      document.querySelector('[data-tab="data"]').click();
      document.getElementById('settings-push-url').value = url;
    }, relay.url);
    await page.click('[data-action="enable-push"]');
    await page.waitForTimeout(2000);

    check('Relay wurde nach dem VAPID-Schlüssel gefragt', relay.received.vapid > 0);
    check('genau eine Anmeldung gesendet', relay.received.subscribe.length === 1,
      JSON.stringify(relay.received.subscribe.length));

    const sent = relay.received.subscribe[0] || {};
    check('Anmeldung enthält Subscription und Zeitstempel',
      !!sent.subscription && !!sent.subscription.endpoint && Number.isFinite(sent.fireAt),
      JSON.stringify(Object.keys(sent)));
    check('Anmeldung enthält NICHTS ausser diesen beiden Feldern',
      JSON.stringify(Object.keys(sent).sort()) === '["fireAt","subscription"]',
      JSON.stringify(Object.keys(sent)));

    // The privacy claim, checked literally against the wire payload.
    const wire = JSON.stringify(sent);
    const leaks = ['2026-09-25', '2026-08-28', 'Periode', 'Crimson Tide', 'warnDays', 'cycles']
      .filter(t => wire.includes(t));
    check('keine Zyklusdaten im gesendeten Körper',
      relay.received.subscribe.length > 0 && leaks.length === 0,
      relay.received.subscribe.length === 0 ? 'nichts gesendet — die Pruefung waere wertlos'
                                            : 'gefunden: ' + leaks.join(', '));

    // fireAt must be the warning moment: 3 days before 2026-09-25, at local
    // noon. Read it back in the browser's zone — comparing against a timestamp
    // built in the test runner's zone would just measure where CI happens to run.
    const inBerlin = new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short',
    }).format(new Date(sent.fireAt));
    check('Zeitstempel ist Warntag 12:00 Uhr Ortszeit',
      inBerlin === '22.09.26, 12:00', inBerlin + ' (erwartet 22.09.26, 12:00)');

    check('Status zeigt Push als aktiv', await page.evaluate(() => {
      renderSettings();
      return /Push aktiv/.test(document.getElementById('push-status').textContent);
    }));

    // The wording must be sitting in the local cache, not on the server.
    const cached = await page.evaluate(async () => {
      const res = await (await caches.open('ctt-push')).match('./__push-message');
      return res ? await res.json() : null;
    });
    check('Warntext liegt lokal im Cache', !!cached && /Crimson Tide/.test(cached.body || ''),
      JSON.stringify(cached));
    check('Cache kennt die zugehörige Periode', cached && cached.periodStart === '2026-09-25',
      JSON.stringify(cached));

    // ── Deliver a real push through CDP ──
    const cdp = await ctx.newCDPSession(page);
    // Attach before enable(): the first workerRegistrationUpdated arrives as a
    // direct result of enabling, and a listener added afterwards misses it.
    const registrationId = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no service worker registration via CDP')), 10000);
      cdp.on('ServiceWorker.workerRegistrationUpdated', e => {
        const r = (e.registrations || []).find(x => x.scopeURL.startsWith(BASE));
        if (r) { clearTimeout(t); resolve(r.registrationId); }
      });
      cdp.send('ServiceWorker.enable').catch(reject);
    });
    await cdp.send('ServiceWorker.deliverPushMessage', {
      origin: BASE,
      registrationId,
      data: '',   // empty, exactly as the relay sends it
    });
    await page.waitForTimeout(1500);

    const shown = await page.evaluate(async () => {
      const r = await navigator.serviceWorker.ready;
      const ns = await r.getNotifications();
      return ns.map(n => ({ title: n.title, body: n.body, tag: n.tag }));
    });
    check('leerer Push erzeugt eine Benachrichtigung', shown.length >= 1, JSON.stringify(shown));
    check('Text stammt aus dem lokalen Cache, nicht aus dem Push',
      shown.some(n => /Crimson Tide kommt in/.test(n.body || '')), JSON.stringify(shown));

    // The worker records what it announced so the app does not repeat it.
    const after = await page.evaluate(async () => {
      const res = await (await caches.open('ctt-push')).match('./__push-message');
      return res ? await res.json() : null;
    });
    check('Worker vermerkt die angekündigte Periode', after && after.notifiedFor === '2026-09-25',
      JSON.stringify(after));

    const adopted = await page.evaluate(async () => {
      await syncPushNotified();
      return state.settings.lastNotifiedFor;
    });
    check('App übernimmt den Vermerk und meldet nicht doppelt', adopted === '2026-09-25', String(adopted));

    // ── Turn it off again ──
    await page.click('[data-action="disable-push"]');
    await page.waitForTimeout(1200);
    check('Abmeldung wurde gesendet', relay.received.unsubscribe.length >= 1,
      JSON.stringify(relay.received.unsubscribe.length));
    check('Push-URL ist wieder leer', await page.evaluate(() => !state.settings.pushUrl));
    check('Subscription im Browser aufgelöst',
      await page.evaluate(() => window.__pushUnsubscribed === true && window.__pushSub === null));
    check('keine Skriptfehler im gesamten Ablauf', errs.length === 0, errs.join(' | '));
    await ctx.close();
  } finally {
    relay.server.close();
  }

  // ══ Fallback stays intact ══
  console.log('\n=== Lokale Warnung bleibt unabhängig ===');
  {
    const ctx = await browser.newContext({ timezoneId: 'Europe/Berlin' });
    await ctx.grantPermissions(['notifications'], { origin: BASE });
    const page = await ctx.newPage();
    await page.addInitScript(seed => {
      const f = new Date('2026-09-23T10:00:00Z').getTime(); const D = Date;
      Date = class extends D { constructor(...a) { if (!a.length) super(f); else super(...a); } static now() { return f; } };
      localStorage.setItem('crimson-tide-tracker', JSON.stringify(seed));
    }, SEED);
    await page.goto(U);
    await page.waitForTimeout(2500);
    const n = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length);
    check('ohne Push-Server warnt die App weiterhin beim Öffnen', n === 1, 'n=' + n);
    await ctx.close();
  }

  console.log('\n' + (fails === 0 ? '✔ Alle Pruefungen bestanden' : `✘ ${fails} Pruefung(en) fehlgeschlagen`));
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})();
