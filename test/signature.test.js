// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isKeyword } from '../src/keywords.js';
import { signatureFor, verifySignature } from '../src/signature.js';

// The sample from the MessageOS webhooks guide: this body, secret, and timestamp give this signature.
const BODY = '{"id":"evt_1","type":"reply.received","createdAt":"2026-10-23T23:00:00.000Z","clientId":"example","data":{"contactId":1,"text":"Hello"}}';
const SECRET = 'test-secret';
const TIMESTAMP = '1700000000';
const SIGNATURE = 'sha256=8f33db04011ef79a464e40a4f1d7438c399844a8636acb15ebe824f4fa46e4fc';
const NOW = 1700000000 * 1000;

test('the signature matches the sample in the webhooks guide', () => {
  assert.equal(signatureFor(BODY, SECRET, TIMESTAMP), SIGNATURE);
  assert.equal(signatureFor(Buffer.from(BODY), SECRET, TIMESTAMP), SIGNATURE);
});

test('a good signature passes, within 300 seconds either way', () => {
  for (const drift of [0, 300, -300]) {
    assert.deepEqual(verifySignature({ rawBody: BODY, timestamp: TIMESTAMP, signature: SIGNATURE, secret: SECRET, now: NOW + drift * 1000 }), { ok: true });
  }
});

test('a wrong signature, secret, or body is refused', () => {
  const bad = { ok: false, reason: 'bad_signature' };
  assert.deepEqual(verifySignature({ rawBody: BODY, timestamp: TIMESTAMP, signature: `sha256=${'0'.repeat(64)}`, secret: SECRET, now: NOW }), bad);
  assert.deepEqual(verifySignature({ rawBody: BODY, timestamp: TIMESTAMP, signature: SIGNATURE, secret: 'another-secret', now: NOW }), bad);
  assert.deepEqual(verifySignature({ rawBody: `${BODY} `, timestamp: TIMESTAMP, signature: SIGNATURE, secret: SECRET, now: NOW }), bad);
  assert.deepEqual(verifySignature({ rawBody: BODY, timestamp: TIMESTAMP, signature: 'sha256=short', secret: SECRET, now: NOW }), bad);
  // The timestamp is part of what is signed, so changing it breaks the signature.
  assert.deepEqual(verifySignature({ rawBody: BODY, timestamp: '1700000001', signature: SIGNATURE, secret: SECRET, now: NOW }), bad);
});

test('a timestamp more than 300 seconds off is refused, even with a good signature', () => {
  for (const drift of [301, -301, 86400]) {
    assert.deepEqual(verifySignature({ rawBody: BODY, timestamp: TIMESTAMP, signature: SIGNATURE, secret: SECRET, now: NOW + drift * 1000 }), { ok: false, reason: 'stale_timestamp' });
  }
});

test('missing or malformed headers are refused', () => {
  const missing = { ok: false, reason: 'missing_headers' };
  assert.deepEqual(verifySignature({ rawBody: BODY, timestamp: undefined, signature: SIGNATURE, secret: SECRET, now: NOW }), missing);
  assert.deepEqual(verifySignature({ rawBody: BODY, timestamp: TIMESTAMP, signature: undefined, secret: SECRET, now: NOW }), missing);
  assert.deepEqual(verifySignature({ rawBody: BODY, timestamp: 'yesterday', signature: SIGNATURE, secret: SECRET, now: NOW }), missing);
});

test('the keyword list is the one MessageOS answers itself', () => {
  for (const word of ['STOP', 'stop', ' Stop. ', 'STOPALL', 'stop all', 'Stop  All', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout', 'opt out', 'START', 'unstop', 'join', 'subscribe', 'HELP', 'help!', 'info']) {
    assert.equal(isKeyword(word), true, word);
  }
  for (const word of ['please stop by tomorrow', 'stopping', 'menu', 'yes', 'helpful', '', 'start the tour']) {
    assert.equal(isKeyword(word), false, word);
  }
  assert.equal(isKeyword(null), false);
});
