// @ts-check
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readConfig, settingsPresent, WEBHOOK_PATH } from './config.js';
import { answerReply } from './conversation.js';
import { log as writeLog } from './log.js';
import { createClient, featuresFrom } from './messageos.js';
import { verifySignature } from './signature.js';

/**
 * The whole app is one Node handler, `(req, res)`. `server.js` runs it with `http.createServer`, and
 * `api/index.js` exports it for a host that runs functions.
 *
 * @typedef {import('node:http').IncomingMessage} Req
 * @typedef {import('node:http').ServerResponse} Res
 * @typedef {import('./types.js').WebhookEvent} WebhookEvent
 */

const MEDIA_DIR = fileURLToPath(new URL('../public/media/', import.meta.url));
// A Map, so a name such as `constructor` in an address finds nothing. A plain object would answer with a
// value it inherits.
const MEDIA_TYPES = new Map([
  ['jpg', 'image/jpeg'],
  ['png', 'image/png'],
  ['gif', 'image/gif'],
  ['mp4', 'video/mp4'],
  ['mp3', 'audio/mpeg'],
  ['pdf', 'application/pdf'],
]);

const MAX_BODY_BYTES = 1_000_000;
const WHOAMI_TTL_MS = 5 * 60 * 1000;
const REMEMBERED_EVENTS = 1000;

const STATUS_EVENTS = new Set(['message.delivered', 'message.read', 'message.failed', 'contact.opted_out', 'contact.opted_in']);

class BodyTooLarge extends Error {}

/**
 * The request body exactly as it arrived. The signature covers these bytes, so they are read before anything
 * parses them.
 *
 * The bytes are collected with `data` and `end` listeners, not with `for await (const chunk of req)`. A host
 * that runs functions can read the body before it calls the handler, to offer a parsed `req.body`, and then
 * hand the same bytes back through those two events only. A loop over the request sees an empty body there,
 * and every signature fails.
 *
 * @param {Req} req
 * @returns {Promise<Buffer>}
 */
async function readRawBody(req) {
  // Some hosts read the body first and keep the exact bytes on the request. Those are the bytes to check.
  const kept = /** @type {{ rawBody?: unknown }} */ (req).rawBody;
  if (Buffer.isBuffer(kept)) {
    if (kept.length > MAX_BODY_BYTES) throw new BodyTooLarge();
    return kept;
  }

  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (/** @type {Buffer} */ chunk) => {
      size += chunk.length;
      // Refuse now. What is left of the body is still read, and dropped.
      if (size > MAX_BODY_BYTES) return reject(new BodyTooLarge());
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    // The body was read before the handler ran. A host that hands it back does so at once. When nothing has
    // come by the next turn of the event loop, nothing kept the bytes: answer as an empty body, which fails the
    // signature check, and do not wait for an `end` that will never come.
    if (req.readableEnded) setImmediate(() => chunks.length === 0 && resolve(Buffer.alloc(0)));
  });
}

/** @param {Res} res @param {number} status @param {unknown} body */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

/** @param {string | string[] | undefined} value */
function header(value) {
  return Array.isArray(value) ? value[0] : value;
}

const HOME_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MessageOS Kitchen Sink</title>
<style>
  body { margin: 0; padding: 32px 20px; font: 16px/1.5 system-ui, sans-serif; background: #0b0d22; color: #ecebff; }
  main { max-width: 560px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 12px; }
  code { background: #1b1f45; padding: 2px 6px; border-radius: 6px; }
  a { color: #a5b4fc; }
</style>
</head>
<body>
<main>
<h1>MessageOS Kitchen Sink</h1>
<p>This is an example app. It answers people through the MessageOS API and shows every kind of message: text, suggested replies and actions, rich cards, carousels, files, locations, the typing indicator, expiry, and the device check.</p>
<p>MessageOS posts events to <code>${WEBHOOK_PATH}</code> on this address, and the app answers each one with <code>POST /v1/messages</code>.</p>
<p>If you opened this page from a button in a conversation, that button was a suggested action that opens a link.</p>
</main>
</body>
</html>
`;

/**
 * Builds the handler. The options exist for the tests. A real server needs none of them.
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env] Where the settings are read from.
 * @param {typeof fetch} [options.fetch]
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<unknown>} [options.sleep]
 * @param {import('./types.js').Log} [options.log]
 * @returns {(req: Req, res: Res) => Promise<void>}
 */
export function createApp(options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? writeLog;

  // A best effort guard against handling one event twice. It lives in this process only: another server, or this
  // one after a restart, has not seen the event. The Idempotency-Key on every send is what makes a repeat safe.
  /** @type {Set<string>} */
  const handled = new Set();
  /** @type {Map<string, Promise<void>>} */
  const inProgress = new Map();

  /** @type {{ key: string, at: number, features: import('./types.js').Features } | null} */
  let whoamiCache = null;

  /** @param {import('./messageos.js').Client} api @param {string} cacheKey */
  async function readFeatures(api, cacheKey) {
    if (whoamiCache && whoamiCache.key === cacheKey && now() - whoamiCache.at < WHOAMI_TTL_MS) return whoamiCache.features;
    const answer = await api.whoami();
    if (!answer.ok) throw new Error(`GET /whoami answered ${answer.status}. Check MESSAGEOS_API_KEY and MESSAGEOS_API_URL.`);
    const features = featuresFrom(answer.body);
    whoamiCache = { key: cacheKey, at: now(), features };
    log('info', 'features read', { ...features, environment: answer.body?.environment ?? null });
    return features;
  }

  /**
   * The work for one event. It throws when the event should be delivered again.
   *
   * @param {WebhookEvent} event
   * @param {import('./config.js').Config} config
   */
  async function handleEvent(event, config) {
    if (event.type === 'reply.received') {
      if (!config.apiKey || !config.publicUrl.startsWith('https://')) {
        throw new Error('MESSAGEOS_API_KEY and an https PUBLIC_URL must be set before this app can answer.');
      }
      const api = createClient({ apiUrl: config.apiUrl, apiKey: config.apiKey, fetch: options.fetch });
      const features = await readFeatures(api, `${config.apiUrl} ${config.apiKey}`);
      const outcome = await answerReply(event, { api, features, publicUrl: config.publicUrl, log, sleep });
      log('info', 'reply handled', { eventId: event.id, contactId: event.data?.contactId ?? null, kind: event.data?.kind ?? null, ...outcome });
      return;
    }
    if (STATUS_EVENTS.has(event.type)) {
      // One line for each report. A real system would update its own record of the message or the contact here.
      const { id, reference, contactId, channel, reason, optedIn } = event.data ?? {};
      log(event.type === 'message.failed' ? 'warn' : 'info', event.type, { eventId: event.id, messageId: id, reference, contactId, channel, reason, optedIn });
      return;
    }
    if (event.type === 'webhook.test') {
      log('info', 'webhook.test', { eventId: event.id });
      return;
    }
    // A type this app does not know. Accept it, so it is not sent again.
    log('info', 'event ignored', { eventId: event.id, type: event.type });
  }

  /** @param {Req} req @param {Res} res */
  async function receiveWebhook(req, res) {
    const config = readConfig(env);
    if (!config.webhookSecret) {
      log('error', 'webhook refused: MESSAGEOS_WEBHOOK_SECRET is not set');
      return sendJson(res, 500, { ok: false, error: 'not_configured' });
    }

    // 1. Read the raw body, before any JSON parsing.
    let rawBody;
    try {
      rawBody = await readRawBody(req);
    } catch (err) {
      if (err instanceof BodyTooLarge) return sendJson(res, 413, { ok: false, error: 'payload_too_large' });
      throw err;
    }

    // 2. Check the signature in constant time, and 3. refuse a timestamp more than 300 seconds off.
    const checked = verifySignature({
      rawBody,
      timestamp: header(req.headers['x-messageos-timestamp']),
      signature: header(req.headers['x-messageos-signature']),
      secret: config.webhookSecret,
      now: now(),
    });
    if (!checked.ok) {
      log('warn', 'webhook refused', { reason: checked.reason });
      return sendJson(res, 401, { ok: false, error: checked.reason });
    }

    /** @type {WebhookEvent} */
    let event;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return sendJson(res, 400, { ok: false, error: 'not_json' });
    }
    if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') return sendJson(res, 400, { ok: false, error: 'not_an_event' });

    // 4. Never act twice on one event. A delivery can arrive more than once.
    if (handled.has(event.id)) {
      log('info', 'event already handled', { eventId: event.id });
      return sendJson(res, 200, { ok: true, duplicate: true });
    }

    // 5. Do the work, and answer 2xx only once it is done. Any other answer makes MessageOS deliver the event
    //    again later, which is safe: every send repeats with the same Idempotency-Key.
    let work = inProgress.get(event.id);
    if (!work) {
      work = handleEvent(event, config).finally(() => inProgress.delete(event.id));
      inProgress.set(event.id, work);
    }
    try {
      await work;
    } catch (err) {
      log('error', 'event failed, it will be delivered again', { eventId: event.id, type: event.type, error: err instanceof Error ? err.message : String(err) });
      return sendJson(res, 500, { ok: false, error: 'try_again' });
    }
    handled.add(event.id);
    if (handled.size > REMEMBERED_EVENTS) handled.delete(handled.values().next().value ?? '');
    sendJson(res, 200, { ok: true });
  }

  /** @param {Req} req @param {Res} res @param {string} name */
  async function serveMedia(req, res, name) {
    const type = MEDIA_TYPES.get(name.split('.').pop() ?? '');
    // Only a plain file name from the media folder: no folders, no dots at the start.
    if (!type || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return sendJson(res, 404, { error: 'not_found' });
    const info = await stat(MEDIA_DIR + name).catch(() => null);
    if (!info?.isFile()) return sendJson(res, 404, { error: 'not_found' });
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size, 'Cache-Control': 'public, max-age=3600' });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(MEDIA_DIR + name).on('error', () => res.destroy()).pipe(res);
  }

  return async function handler(req, res) {
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      const reading = req.method === 'GET' || req.method === 'HEAD';

      if (path === WEBHOOK_PATH) {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          return sendJson(res, 405, { error: 'method_not_allowed' });
        }
        return await receiveWebhook(req, res);
      }
      if (reading && path === '/health') return sendJson(res, 200, { ok: true, settings: settingsPresent(readConfig(env)) });
      if (reading && path.startsWith('/media/')) return await serveMedia(req, res, path.slice('/media/'.length));
      if (reading && path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(HOME_PAGE) });
        return void res.end(req.method === 'HEAD' ? undefined : HOME_PAGE);
      }
      sendJson(res, 404, { error: 'not_found' });
    } catch (err) {
      log('error', 'request failed', { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.destroy();
    }
  };
}

/** The handler, with settings from the environment. */
export const handler = createApp();
