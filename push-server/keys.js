#!/usr/bin/env node
// Prints a fresh VAPID key pair. The public key is handed to browsers by the
// server itself (GET /vapid); the private key stays here and nowhere else.
const { generateVAPIDKeys } = require('web-push');
const { publicKey, privateKey } = generateVAPIDKeys();
console.log(`VAPID_PUBLIC=${publicKey}`);
console.log(`VAPID_PRIVATE=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:du@example.com   # anpassen');
