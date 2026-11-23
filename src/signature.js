// @ts-check
import { createHmac, timingSafeEqual } from 'node:crypto';

/** A timestamp further than this from our clock is refused, so a captured request cannot be played back later. */
export const TOLERANCE_SECONDS = 300;

/**
 * The signature MessageOS sends: `sha256=` and the lowercase hex HMAC-SHA256 of `<timestamp>.<raw body>`, keyed
 * with the webhook's signing secret.
 *
 * @param {Buffer | string} rawBody The request body exactly as it arrived, before any JSON parsing.
 * @param {string} secret
 * @param {string} timestamp The `x-messageos-timestamp` header: unix seconds.
 */
export function signatureFor(rawBody, secret, timestamp) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex')}`;
}

/**
 * Checks one webhook request. Call it with the raw body: a parsed and re-encoded body can differ in spacing or
 * key order, and the signature then fails.
 *
 * @param {object} input
 * @param {Buffer | string} input.rawBody
 * @param {string | undefined} input.timestamp The `x-messageos-timestamp` header.
 * @param {string | undefined} input.signature The `x-messageos-signature` header.
 * @param {string} input.secret
 * @param {number} [input.now] Milliseconds, as `Date.now()` gives.
 * @returns {{ ok: true } | { ok: false, reason: 'missing_headers' | 'bad_signature' | 'stale_timestamp' }}
 */
export function verifySignature({ rawBody, timestamp, signature, secret, now = Date.now() }) {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return { ok: false, reason: 'missing_headers' };

  // Compare in constant time, so the time the check takes says nothing about how much of a guess was right.
  const expected = Buffer.from(signatureFor(rawBody, secret, timestamp));
  const received = Buffer.from(signature);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return { ok: false, reason: 'bad_signature' };

  // Each delivery attempt is signed again with a new timestamp, so a real retry always passes this.
  if (Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return { ok: false, reason: 'stale_timestamp' };

  return { ok: true };
}
