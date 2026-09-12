#!/usr/bin/env node
//
// Crimson Tide Tracker — push relay
//
// The app is hosted statically (GitHub Pages), and a static host cannot wake a
// closed device. This is the smallest service that can: it holds a Web Push
// subscription plus one timestamp, and at that timestamp it sends an empty
// push. Run it wherever you like — the app asks for its URL.
//
// WHAT THIS SERVER LEARNS, deliberately kept to the minimum:
//   • a push endpoint (which push service, which anonymous device)
//   • one timestamp: when to ping that device
// It never receives cycle dates, period lengths, or the message text. The
// notification wording lives in the browser's own cache and is composed by the
// service worker when the empty push arrives. From this data the operator can
// tell that *a* reminder is due at time T — not what it is about.
//
// Setup:
//   npm install
//   npm run keys          → prints a VAPID key pair
//   VAPID_PUBLIC=… VAPID_PRIVATE=… VAPID_SUBJECT=mailto:you@example.com npm start
//
// Environment:
//   PORT            default 8080
//   VAPID_PUBLIC    required
//   VAPID_PRIVATE   required
//   VAPID_SUBJECT   required, a mailto: or https: URL identifying the operator
//   DATA_FILE       default ./subscriptions.json
//   ALLOWED_ORIGIN  default '*' — set it to the app's origin in production
//   TICK_SECONDS    default 30

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const webpush = require('web-push');

const PORT = Number(process.env.PORT || 8080);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'subscriptions.json');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const TICK_MS = Number(process.env.TICK_SECONDS || 30) * 1000;
const MAX_BODY = 8 * 1024;

const VAPID_PUBLIC = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT;

if (!VAPID_PUBLIC || !VAPID_PRIVATE || !VAPID_SUBJECT) {
  console.error('VAPID_PUBLIC, VAPID_PRIVATE and VAPID_SUBJECT must be set. Run: npm run keys');
  process.exit(1);
}
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

// ── Storage ────────────────────────────────────────────────
// A JSON file keyed by endpoint. Small enough that rewriting it wholesale is
// cheaper than any alternative; written to a temp file and renamed so a crash
// mid-write cannot truncate it.

const store = new Map();

// Fills the existing Map rather than replacing it: reassigning would strand
// every reference already handed out, the export among them.
function load() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('could not read %s: %s', DATA_FILE, e.message);
    return;
  }
  if (!Array.isArray(raw)) return;
  store.clear();
  for (const e of raw) {
    if (validSubscription(e && e.subscription) && Number.isFinite(e.fireAt)) {
      store.set(e.subscription.endpoint, { subscription: e.subscription, fireAt: e.fireAt });
    }
  }
}

// Serialised, not coalesced: returning an in-flight write to a later caller
// would acknowledge a state change that never reached the disk.
let saveChain = Promise.resolve();
function save() {
  saveChain = saveChain.then(async () => {
    const tmp = DATA_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify([...store.values()], null, 2));
    await fsp.rename(tmp, DATA_FILE);
  }).catch(e => { console.error('save failed:', e.message); });
  return saveChain;
}

// ── Validation ─────────────────────────────────────────────

function validSubscription(s) {
  return s && typeof s === 'object'
    && typeof s.endpoint === 'string'
    && /^https:\/\//.test(s.endpoint)
    && s.endpoint.length < 1024
    && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string';
}

// A year out is far past anything this app schedules; anything beyond that is
// a mistake or an attempt to park entries here forever.
const MAX_AHEAD_MS = 366 * 24 * 3600 * 1000;
function validFireAt(t) {
  return Number.isFinite(t) && t > Date.now() - 3600_000 && t < Date.now() + MAX_AHEAD_MS;
}

// ── HTTP ───────────────────────────────────────────────────

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function send(res, code, body) {
  cors(res);
  if (body === undefined) return res.writeHead(code).end();
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json' }).end(s);
}

class BodyTooLarge extends Error {}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, tooLarge = false;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      // Keep draining but stop buffering — destroying the request here would
      // tear down the socket before the error response could be written.
      if (size > MAX_BODY) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new BodyTooLarge('body too large'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') { cors(res); return res.writeHead(204).end(); }

  // The app fetches the public key so nothing has to be hardcoded in the client.
  if (req.method === 'GET' && url.pathname === '/vapid') {
    return send(res, 200, { publicKey: VAPID_PUBLIC });
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, scheduled: store.size });
  }

  if (req.method === 'POST' && url.pathname === '/subscribe') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return send(res, e instanceof BodyTooLarge ? 413 : 400, { error: e.message }); }

    if (!validSubscription(body.subscription)) return send(res, 400, { error: 'invalid subscription' });
    const fireAt = Number(body.fireAt);
    if (!validFireAt(fireAt)) return send(res, 400, { error: 'invalid fireAt' });

    // Re-subscribing replaces the pending reminder rather than adding one.
    store.set(body.subscription.endpoint, { subscription: body.subscription, fireAt });
    await save();
    return send(res, 200, { ok: true, fireAt });
  }

  if (req.method === 'POST' && url.pathname === '/unsubscribe') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return send(res, e instanceof BodyTooLarge ? 413 : 400, { error: e.message }); }
    if (typeof body.endpoint !== 'string') return send(res, 400, { error: 'endpoint required' });
    const had = store.delete(body.endpoint);
    if (had) await save();
    return send(res, 200, { ok: true, removed: had });
  }

  send(res, 404, { error: 'not found' });
});

// ── Scheduler ──────────────────────────────────────────────
// Empty pushes: the payload would be the one place cycle information could
// leak, so there isn't one. The service worker composes the text from what the
// browser already stored locally.

async function tick(now = Date.now()) {
  const due = [...store.values()].filter(e => e.fireAt <= now);
  if (!due.length) return { sent: 0, dropped: 0 };

  let sent = 0, dropped = 0;
  for (const entry of due) {
    try {
      await webpush.sendNotification(entry.subscription, null, { TTL: 6 * 3600 });
      sent++;
      store.delete(entry.subscription.endpoint);
    } catch (err) {
      const code = err.statusCode;
      if (code === 404 || code === 410) {
        // Subscription is gone for good — the browser dropped it.
        store.delete(entry.subscription.endpoint);
        dropped++;
      } else {
        // Transient: leave it in place and retry on the next tick.
        console.warn('push failed (%s), will retry: %s', code || '?', err.message);
      }
    }
  }
  await save();
  if (sent || dropped) console.log('tick: sent %d, dropped %d, pending %d', sent, dropped, store.size);
  return { sent, dropped };
}

// ── Boot ───────────────────────────────────────────────────

if (require.main === module) {
  load();
  const timer = setInterval(() => tick().catch(e => console.error('tick:', e)), TICK_MS);
  timer.unref?.();
  server.listen(PORT, () => {
    console.log('push relay on :%d — %d reminder(s) pending, origin %s',
      PORT, store.size, ALLOWED_ORIGIN);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { clearInterval(timer); server.close(() => process.exit(0)); });
  }
}

module.exports = { server, tick, store, load, save, validSubscription, validFireAt };
