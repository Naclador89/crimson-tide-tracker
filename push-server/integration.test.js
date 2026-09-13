// End-to-end against the REAL relay process.
//
// The browser suite (tests/e2e/push.js) drives the app against a stub relay so
// it can assert on what the app sends. This does the opposite: it starts
// server.js as a real child process, with real VAPID keys and a real data file,
// and drives it the way the app does — subscribe, reschedule, fire, unsubscribe
// — including a restart in the middle.
//
// Still not covered, and not coverable here: the push service itself. Reaching
// FCM needs the open internet, so web-push is intercepted at the HTTPS layer;
// everything up to the outbound request is the real code path.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { generateVAPIDKeys } = require('web-push');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-relay-'));
const DATA = path.join(DIR, 'subscriptions.json');
const KEYS = generateVAPIDKeys();
const PORT = 8300 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;

// Stands in for the push service: server.js posts here instead of FCM, so the
// request it builds — VAPID headers included — is the real one. It has to be
// HTTPS, because the relay rejects plaintext endpoints on purpose.
let pushService, pushed = [], pushPort;

function selfSignedCert() {
  const key = path.join(DIR, 'k.pem'), cert = path.join(DIR, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
    { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function env(extra = {}) {
  return {
    ...process.env,
    PORT: String(PORT),
    DATA_FILE: DATA,
    VAPID_PUBLIC: KEYS.publicKey,
    VAPID_PRIVATE: KEYS.privateKey,
    VAPID_SUBJECT: 'mailto:relay@example.com',
    ALLOWED_ORIGIN: 'https://crimson-tide-tracker.leiding.net',
    TICK_SECONDS: '1',
    // Only so the child accepts the throwaway certificate of the stand-in push
    // service. Nothing in server.js depends on it.
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    ...extra,
  };
}

let child;
let childLog = [];
async function startRelay(extra) {
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: env(extra), stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Both pipes must be drained. The relay logs a line per request, and an
  // unread pipe fills up and blocks the child mid-write — which looks exactly
  // like a hung scheduler.
  const keep = d => {
    childLog.push(String(d).trimEnd());
    if (childLog.length > 200) childLog.shift();
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', d => { keep(d); if (!/ALLOWED_ORIGIN/.test(String(d))) process.stderr.write(d); });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/health')).ok) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('relay did not come up');
}
async function stopRelay() {
  if (!child || child.exitCode !== null) return;
  // Capture the process and clear the timer: Promise.race does not cancel the
  // loser, so a surviving timeout would fire later and SIGKILL whatever `child`
  // points at by then — which, after a restart, is the new process.
  const victim = child;
  const done = new Promise(r => victim.once('exit', r));
  victim.kill('SIGTERM');
  let hardKill;
  await Promise.race([
    done,
    new Promise(r => { hardKill = setTimeout(() => { victim.kill('SIGKILL'); r(); }, 3000); }),
  ]);
  clearTimeout(hardKill);
}

const sub = (id, port) => ({
  endpoint: `https://127.0.0.1:${port}/push/${id}`,
  keys: {
    // A real subscription's keys; web-push needs a valid P-256 point and a
    // 16-byte auth secret or it refuses to encrypt.
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
});

before(async () => {
  await new Promise(r => {
    pushService = https.createServer(selfSignedCert(), (req, res) => {
      let body = [];
      req.on('data', c => body.push(c));
      req.on('end', () => {
        pushed.push({
          url: req.url,
          hasVapid: /vapid/i.test(req.headers.authorization || ''),
          ttl: req.headers.ttl,
          length: Buffer.concat(body).length,
        });
        res.writeHead(201).end();
      });
    });
    pushService.listen(0, '127.0.0.1', r);
  });
  pushPort = pushService.address().port;
  await startRelay();
});

after(async () => {
  await stopRelay();
  pushService.close();
  fs.rmSync(DIR, { recursive: true, force: true });
});

const post = (p, body) => fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const soon = ms => Date.now() + ms;

describe('the real relay process', () => {
  test('comes up and reports health', async () => {
    const r = await fetch(BASE + '/health');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, scheduled: 0 });
  });

  test('serves the VAPID public key it was configured with', async () => {
    assert.equal((await fetch(BASE + '/vapid')).status, 200);
    assert.equal((await (await fetch(BASE + '/vapid')).json()).publicKey, KEYS.publicKey);
  });

  test('accepts a subscription and writes it to the data file', async () => {
    const r = await post('/subscribe', { subscription: sub('a', pushPort), fireAt: soon(60_000) });
    assert.equal(r.status, 200);
    const onDisk = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    assert.equal(onDisk.length, 1);
    assert.deepEqual(Object.keys(onDisk[0]).sort(), ['fireAt', 'subscription']);
  });

  test('keeps its reminders across a restart', async () => {
    await stopRelay();
    await startRelay();
    const health = await (await fetch(BASE + '/health')).json();
    assert.equal(health.scheduled, 1, 'the reminder must survive the process');
  });

  test('actually sends a push once the moment arrives', async () => {
    pushed.length = 0;
    // Two seconds out, with a one second tick.
    await post('/subscribe', { subscription: sub('a', pushPort), fireAt: soon(2000) });
    for (let i = 0; i < 60 && pushed.length === 0; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(pushed.length, 1,
      'no push arrived within 6s. Relay said:\n' + childLog.slice(-15).join('\n'));
    assert.match(pushed[0].url, /\/push\/a$/);
  });

  test('the outbound request is a signed, empty Web Push', async () => {
    assert.ok(pushed[0].hasVapid, 'no VAPID authorization header');
    assert.equal(pushed[0].length, 0, 'a body would be the one place data could leak');
    assert.equal(pushed[0].ttl, String(6 * 3600));
  });

  test('a fired reminder is cleared, on disk too', async () => {
    const health = await (await fetch(BASE + '/health')).json();
    assert.equal(health.scheduled, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(DATA, 'utf8')), []);
  });

  test('rescheduling replaces rather than accumulates', async () => {
    await post('/subscribe', { subscription: sub('b', pushPort), fireAt: soon(60_000) });
    await post('/subscribe', { subscription: sub('b', pushPort), fireAt: soon(90_000) });
    assert.equal((await (await fetch(BASE + '/health')).json()).scheduled, 1);
  });

  test('unsubscribing removes it again', async () => {
    const r = await post('/unsubscribe', { endpoint: sub('b', pushPort).endpoint });
    assert.equal((await r.json()).removed, true);
    assert.equal((await (await fetch(BASE + '/health')).json()).scheduled, 0);
  });

  test('CORS answers the origin it was configured for', async () => {
    const r = await fetch(BASE + '/vapid');
    assert.equal(r.headers.get('access-control-allow-origin'),
      'https://crimson-tide-tracker.leiding.net');
  });

  test('a dead subscription is dropped instead of retried forever', async () => {
    // Answer 410 Gone, the way a push service reports an expired subscription.
    const gone = https.createServer(selfSignedCert(), (req, res) => res.writeHead(410).end());
    await new Promise(r => gone.listen(0, '127.0.0.1', r));
    const gonePort = gone.address().port;

    await post('/subscribe', { subscription: sub('dead', gonePort), fireAt: soon(1500) });
    for (let i = 0; i < 60; i++) {
      if ((await (await fetch(BASE + '/health')).json()).scheduled === 0) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal((await (await fetch(BASE + '/health')).json()).scheduled, 0,
      'a 410 must remove the subscription');
    gone.close();
  });

  test('shuts down cleanly on SIGTERM', async () => {
    const code = await new Promise(resolve => {
      child.once('exit', (c, sig) => resolve(c === 0 || sig === 'SIGTERM'));
      child.kill('SIGTERM');
      setTimeout(() => resolve(false), 5000);
    });
    assert.ok(code, 'did not exit within 5s of SIGTERM');
  });
});
