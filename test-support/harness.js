// @ts-check
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { signatureFor } from '../src/signature.js';

/**
 * What the tests run against: the real handler on a free port, and a stand-in for the MessageOS API on another.
 * Nothing here reaches the network.
 */

export const SECRET = 'test-webhook-secret';
export const API_KEY = 'mosc_test_key_for_the_fake_api';
export const PUBLIC_URL = 'https://kitchen-sink.example.test';

/** @param {import('node:http').Server} server */
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The server has no port.');
  return `http://127.0.0.1:${address.port}`;
}

/** @param {import('node:http').Server} server */
async function stop(server) {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
}

/** @param {import('node:http').IncomingMessage} req */
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @typedef {object} ApiCall
 * @property {string} method
 * @property {string} path The path after /v1, without the query.
 * @property {Record<string, string>} query
 * @property {string | undefined} idempotencyKey
 * @property {string | undefined} authorization
 * @property {any} body
 */

/**
 * A stand-in for the MessageOS API. It keeps every call, and it treats an Idempotency-Key the way the real API
 * does: the same key with the same body replays the stored answer, and the same key with another body is 422.
 *
 * @param {{ whoami?: Record<string, unknown> }} [options]
 */
export async function startFakeApi(options = {}) {
  /** @type {ApiCall[]} */
  const calls = [];
  /** @type {Map<string, { text: string, status: number, body: unknown }>} */
  const stored = new Map();
  /** @type {any[]} */
  const delivered = [];
  /** @type {any[]} */
  const webhooks = [];

  const state = {
    calls,
    /** The bodies of the messages that were really sent. A replayed answer adds nothing here. */
    delivered,
    webhooks,
    whoami: {
      clientId: 'messageos-kitchen-sink',
      name: 'MessageOS Kitchen Sink',
      keyPrefix: 'mosc_test_k',
      scopes: ['messages:write', 'contacts:read', 'contacts:write', 'conversations:read', 'webhooks:manage', 'usage:read'],
      environment: 'development',
      timezone: null,
      quietHours: { start: '21:00', end: '08:00' },
      allowedClasses: ['service', 'transactional'],
      workflowsEnabled: false,
      replyWindowSeconds: 3600,
      quietHoursEnforced: false,
      richMessages: true,
      rcsExtras: true,
      limits: { requestsPerMinute: null, sendsPerAgent: null, sendsPerAgentWindowSeconds: 3600, sendsPerContact: null, sendsPerContactWindowSeconds: 3600 },
      ...options.whoami,
    },
    /**
     * Set this to answer a call another way: return `{ status, body }`, or nothing to answer as usual.
     *
     * @type {((call: ApiCall) => { status: number, body?: unknown } | undefined | void) | null}
     */
    respond: null,
    /** The message bodies posted to /messages, in order, replays included. */
    messages: () => calls.filter((call) => call.method === 'POST' && call.path === '/messages'),
    url: '',
    close: async () => {},
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const text = await readBody(req);
    /** @type {ApiCall} */
    const call = {
      method: req.method ?? 'GET',
      path: url.pathname.replace(/^\/v1/, ''),
      query: Object.fromEntries(url.searchParams),
      idempotencyKey: /** @type {string | undefined} */ (req.headers['idempotency-key']),
      authorization: req.headers.authorization,
      body: text ? JSON.parse(text) : undefined,
    };
    calls.push(call);

    /** @param {number} status @param {unknown} [body] @param {Record<string, string>} [headers] */
    const answer = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'X-Request-Id': `req_${calls.length}`, ...headers });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };

    if (call.authorization !== `Bearer ${API_KEY}`) return answer(401, { error: { code: 'unauthorized', message: 'The key is not valid.' } });
    const override = state.respond?.(call);
    if (override) return answer(override.status, override.body);

    const route = `${call.method} ${call.path}`;
    if (route === 'GET /whoami') return answer(200, state.whoami);
    if (route === 'POST /messages') {
      const key = call.idempotencyKey;
      if (!key || key.length < 8 || key.length > 128) return answer(422, { error: { code: 'validation_error', message: 'Idempotency-Key is required.' } });
      const before = stored.get(key);
      if (before) {
        if (before.text !== text) return answer(422, { error: { code: 'idempotency_key_reuse', message: 'This Idempotency-Key was used with another body.' } });
        return answer(before.status, before.body, { 'Idempotent-Replay': 'true' });
      }
      delivered.push(call.body);
      const id = delivered.length;
      const type = call.body.card ? 'card' : call.body.carousel ? 'carousel' : call.body.file ? 'file' : 'text';
      const body = { id: `msg_${id}`, status: 'sent', type, channel: 'rcs', contactId: call.body.to?.contactId ?? 42, reference: call.body.reference ?? null, auditId: id };
      stored.set(key, { text, status: 201, body });
      return answer(201, body);
    }
    if (route === 'POST /typing') return answer(202, { status: 'accepted', contactId: call.body?.to?.contactId ?? 42 });
    if (route === 'GET /capabilities') {
      return answer(200, { phoneNumber: call.query.phoneNumber, rcs: true, features: ['card', 'carousel', 'openUrl', 'dial', 'viewLocation', 'shareLocation', 'createCalendarEvent'] });
    }
    if (route === 'GET /webhooks') return answer(200, { data: webhooks.map(({ secret, ...rest }) => rest) });
    if (route === 'POST /webhooks') {
      const endpoint = { id: webhooks.length + 1, url: call.body.url, eventTypes: call.body.eventTypes, status: 'active', secret: 'a'.repeat(48), createdAt: '2026-11-23T18:00:00.000Z' };
      webhooks.push(endpoint);
      return answer(201, endpoint);
    }
    answer(404, { error: { code: 'not_found', message: 'Not found.' } });
  });

  state.url = `${await listen(server)}/v1`;
  state.close = () => stop(server);
  return state;
}

/** @typedef {Awaited<ReturnType<typeof startFakeApi>>} FakeApi */

/**
 * The real handler on a free port, with its settings pointed at the fake API. Waits are recorded, not waited.
 *
 * `host` stands in for a host that does something to a request before the handler gets it.
 *
 * @typedef {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} Handler
 * @param {{ api?: FakeApi, env?: Record<string, string | undefined>, now?: () => number, host?: (handler: Handler) => Handler }} [options]
 */
export async function startApp(options = {}) {
  /** @type {Array<{ level: string, message: string } & Record<string, unknown>>} */
  const logs = [];
  /** @type {number[]} */
  const sleeps = [];
  const handler = createApp({
    env: {
      // With no fake API, point at a port nothing listens on, so a test can never reach the real one.
      MESSAGEOS_API_URL: options.api?.url ?? 'http://127.0.0.1:9/v1',
      MESSAGEOS_API_KEY: API_KEY,
      MESSAGEOS_WEBHOOK_SECRET: SECRET,
      PUBLIC_URL,
      ...options.env,
    },
    now: options.now,
    sleep: async (ms) => void sleeps.push(ms),
    log: (level, message, fields = {}) => void logs.push({ level, message, ...fields }),
  });
  const server = createServer(options.host ? options.host(handler) : handler);
  const url = await listen(server);

  /**
   * Posts one event the way MessageOS does: signed, with its headers. `overrides` breaks one thing on purpose.
   *
   * @param {unknown} event
   * @param {{ secret?: string, timestamp?: string, signature?: string, body?: string }} [overrides]
   */
  async function deliver(event, overrides = {}) {
    const body = overrides.body ?? JSON.stringify(event);
    const timestamp = overrides.timestamp ?? String(Math.floor((options.now?.() ?? Date.now()) / 1000));
    const response = await fetch(`${url}/webhooks/messageos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'MessageOS-Webhooks/1',
        'x-messageos-event-id': /** @type {any} */ (event)?.id ?? '',
        'x-messageos-timestamp': timestamp,
        'x-messageos-signature': overrides.signature ?? signatureFor(body, overrides.secret ?? SECRET, timestamp),
      },
      body,
    });
    return { status: response.status, body: await response.json() };
  }

  return { url, logs, sleeps, deliver, close: () => stop(server) };
}

let counter = 0;

/**
 * A `reply.received` event with every field the real one has.
 *
 * @param {Partial<import('../src/types.js').ReplyData>} [data]
 * @param {{ id?: string }} [overrides]
 */
export function replyEvent(data = {}, overrides = {}) {
  counter += 1;
  /** @type {import('../src/types.js').ReplyData} */
  const reply = {
    inboundMessageId: 900 + counter,
    contactId: 42,
    externalId: null,
    phoneNumber: '+15555550123',
    conversationId: 7,
    text: '',
    receivedAt: '2026-11-23T18:00:05.000Z',
    kind: 'text',
    postbackData: null,
    attachments: [],
    location: null,
    ...data,
  };
  return {
    id: overrides.id ?? `evt_00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    type: 'reply.received',
    createdAt: '2026-11-23T18:00:10.000Z',
    clientId: 'messageos-kitchen-sink',
    data: reply,
  };
}

/** A tap on a button. @param {string} label @param {string} postbackData */
export function tapped(label, postbackData) {
  return replyEvent({ kind: 'chip', text: label, postbackData });
}

/** Words a person typed. @param {string} text */
export function typed(text) {
  return replyEvent({ kind: 'text', text });
}
