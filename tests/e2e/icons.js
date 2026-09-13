// Regression tests for the app icons.
//
// The interesting one is the maskable icon: Android may crop anything outside
// the central 80%, so the check samples every pixel beyond that circle and
// requires background only. A counter-check against the full-bleed icon proves
// the test can actually fail.
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
const BASE = process.env.BASE_URL || 'http://localhost:8790';
const ROOT = path.join(__dirname, '..', '..');


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

  console.log('\n' + (fails === 0 ? '✔ Alle Pruefungen bestanden' : `✘ ${fails} Pruefung(en) fehlgeschlagen`));
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})();
