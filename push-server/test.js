// Tests for the push relay. No real push service is contacted: web-push's
// sendNotification is stubbed so the scheduler can be driven deterministically.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = path.join(os.tmpdir(), 'ctt-push-test-' + process.pid + '.json');
// Real keys: setVapidDetails validates them, so placeholders will not do.
const { generateVAPIDKeys } = require('web-push');
const keys = generateVAPIDKeys();
process.env.VAPID_PUBLIC = keys.publicKey;
process.env.VAPID_PRIVATE = keys.privateKey;
process.env.VAPID_SUBJECT = 'mailto:test@example.com';
process.env.DATA_FILE = DATA;
process.env.ALLOWED_ORIGIN = 'https://crimson-tide-tracker.leiding.net';

const webpush = require('web-push');
const sent = [];
let nextError = null;
webpush.sendNotification = async (subscription, payload) => {
  if (nextError) { const e = nextError; nextError = null; throw e; }
  sent.push({ endpoint: subscription.endpoint, payload });
  return { statusCode: 201 };
};

const relay = require('./server.js');

let base;
before(async () => {
  await new Promise(r => relay.server.listen(0, r));
  base = 'http://localhost:' + relay.server.address().port;
});
after(() => {
  relay.server.close();
  fs.rmSync(DATA, { force: true });
  fs.rmSync(DATA + '.tmp', { force: true });
});
beforeEach(() => { relay.store.clear(); sent.length = 0; nextError = null; });

const sub = (id = 'a') => ({
  endpoint: 'https://fcm.googleapis.com/fcm/send/' + id,
  keys: { p256dh: 'p256dh-' + id, auth: 'auth-' + id },
});
const post = (p, body) => fetch(base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const inHours = h => Date.now() + h * 3600_000;

describe('endpoints', () => {
  test('GET /vapid hands out the public key', async () => {
    const r = await fetch(base + '/vapid');
    assert.equal(r.status, 200);
    assert.equal((await r.json()).publicKey, process.env.VAPID_PUBLIC);
  });

  test('GET /health reports how many reminders are pending', async () => {
    await post('/subscribe', { subscription: sub(), fireAt: inHours(3) });
    const r = await fetch(base + '/health');
    assert.deepEqual(await r.json(), { ok: true, scheduled: 1 });
  });

  test('CORS headers are present, including on preflight', async () => {
    const r = await fetch(base + '/vapid');
    assert.equal(r.headers.get('access-control-allow-origin'), process.env.ALLOWED_ORIGIN);
    const pre = await fetch(base + '/subscribe', { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
  });

  test('unknown routes 404', async () => {
    assert.equal((await fetch(base + '/nope')).status, 404);
  });
});

describe('subscribe', () => {
  test('stores a valid subscription', async () => {
    const r = await post('/subscribe', { subscription: sub(), fireAt: inHours(2) });
    assert.equal(r.status, 200);
    assert.equal(relay.store.size, 1);
  });

  test('stores only the subscription and the timestamp', async () => {
    // Anything else the client might send must not be retained.
    await post('/subscribe', {
      subscription: sub(), fireAt: inHours(2),
      periodStart: '2026-09-25', message: 'Periode in 3 Tagen', cycles: [{ start: '2026-08-28' }],
    });
    const stored = [...relay.store.values()][0];
    assert.deepEqual(Object.keys(stored).sort(), ['fireAt', 'subscription']);
    const blob = JSON.stringify(stored);
    for (const leak of ['2026-09-25', 'Periode', '2026-08-28']) {
      assert.ok(!blob.includes(leak), `leaked ${leak} into storage`);
    }
  });

  test('re-subscribing replaces the pending reminder', async () => {
    await post('/subscribe', { subscription: sub(), fireAt: inHours(2) });
    await post('/subscribe', { subscription: sub(), fireAt: inHours(5) });
    assert.equal(relay.store.size, 1);
    assert.ok([...relay.store.values()][0].fireAt > inHours(4));
  });

  test('rejects malformed input', async () => {
    const bad = [
      {},
      { subscription: sub() },                                     // no fireAt
      { fireAt: inHours(2) },                                      // no subscription
      { subscription: { endpoint: 'https://x' }, fireAt: inHours(2) },  // no keys
      { subscription: { ...sub(), endpoint: 'http://insecure' }, fireAt: inHours(2) },
      { subscription: sub(), fireAt: 'bald' },
      { subscription: sub(), fireAt: Date.now() - 86400_000 },      // long past
      { subscription: sub(), fireAt: Date.now() + 400 * 86400_000 },// absurdly far out
    ];
    for (const body of bad) {
      const r = await post('/subscribe', body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal(relay.store.size, 0);
  });

  test('rejects a body that is not JSON, and an oversized one', async () => {
    const r1 = await fetch(base + '/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope',
    });
    assert.equal(r1.status, 400);
    const r2 = await post('/subscribe', {
      subscription: { ...sub(), keys: { p256dh: 'x'.repeat(20000), auth: 'a' } }, fireAt: inHours(2),
    });
    assert.equal(r2.status, 413, 'oversized body must be refused, not reset');
  });
});

describe('unsubscribe', () => {
  test('removes a stored reminder', async () => {
    await post('/subscribe', { subscription: sub(), fireAt: inHours(2) });
    const r = await post('/unsubscribe', { endpoint: sub().endpoint });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).removed, true);
    assert.equal(relay.store.size, 0);
  });

  test('is harmless for an endpoint that is not stored', async () => {
    const r = await post('/unsubscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/ghost' });
    assert.equal((await r.json()).removed, false);
  });

  test('requires an endpoint', async () => {
    assert.equal((await post('/unsubscribe', {})).status, 400);
  });
});

describe('scheduler', () => {
  test('sends nothing before the reminder is due', async () => {
    await post('/subscribe', { subscription: sub(), fireAt: inHours(3) });
    assert.deepEqual(await relay.tick(), { sent: 0, dropped: 0 });
    assert.equal(sent.length, 0);
    assert.equal(relay.store.size, 1, 'must stay scheduled');
  });

  test('sends when due and clears the entry', async () => {
    await post('/subscribe', { subscription: sub(), fireAt: inHours(1) });
    const res = await relay.tick(inHours(1.1));
    assert.deepEqual(res, { sent: 1, dropped: 0 });
    assert.equal(sent.length, 1);
    assert.equal(relay.store.size, 0, 'a fired reminder must not repeat');
  });

  test('the push carries no payload', async () => {
    await post('/subscribe', { subscription: sub(), fireAt: inHours(1) });
    await relay.tick(inHours(2));
    assert.equal(sent[0].payload, null, 'payload would be the one place data could leak');
  });

  test('a dead subscription (410) is dropped', async () => {
    await post('/subscribe', { subscription: sub(), fireAt: inHours(1) });
    nextError = Object.assign(new Error('gone'), { statusCode: 410 });
    const res = await relay.tick(inHours(2));
    assert.deepEqual(res, { sent: 0, dropped: 1 });
    assert.equal(relay.store.size, 0);
  });

  test('a transient failure keeps the reminder for the next tick', async () => {
    await post('/subscribe', { subscription: sub(), fireAt: inHours(1) });
    nextError = Object.assign(new Error('service unavailable'), { statusCode: 503 });
    await relay.tick(inHours(2));
    assert.equal(relay.store.size, 1, 'must be retried');
    const res = await relay.tick(inHours(2));
    assert.equal(res.sent, 1);
  });

  test('handles several devices independently', async () => {
    await post('/subscribe', { subscription: sub('a'), fireAt: inHours(1) });
    await post('/subscribe', { subscription: sub('b'), fireAt: inHours(9) });
    await relay.tick(inHours(2));
    assert.equal(sent.length, 1);
    assert.ok(sent[0].endpoint.endsWith('/a'));
    assert.equal(relay.store.size, 1, 'the later one stays');
  });
});

describe('persistence', () => {
  test('survives a restart', async () => {
    await post('/subscribe', { subscription: sub('keep'), fireAt: inHours(4) });
    relay.store.clear();
    relay.load();
    assert.equal(relay.store.size, 1);
    assert.ok([...relay.store.values()][0].subscription.endpoint.endsWith('/keep'));
  });

  test('a missing data file is not an error', () => {
    fs.rmSync(DATA, { force: true });
    relay.store.clear();
    assert.doesNotThrow(() => relay.load());
    assert.equal(relay.store.size, 0);
  });
});
