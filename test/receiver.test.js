// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { API_KEY, SECRET, replyEvent, startApp, startFakeApi, tapped, typed } from '../test-support/harness.js';

/** @param {import('node:test').TestContext} t @param {Parameters<typeof startApp>[0]} [appOptions] */
async function setup(t, appOptions = {}) {
  const api = await startFakeApi();
  const app = await startApp({ api, ...appOptions });
  t.after(() => Promise.all([api.close(), app.close()]));
  return { api, app };
}

test('a signed event is accepted and answered through the API', async (t) => {
  const { api, app } = await setup(t);
  const answer = await app.deliver(typed('menu'));
  assert.deepEqual(answer, { status: 200, body: { ok: true } });
  assert.equal(api.delivered.length, 1);
  assert.ok(api.calls.every((call) => call.authorization === `Bearer ${API_KEY}`));
});

test('a bad signature is refused with 401 and nothing is sent', async (t) => {
  const { api, app } = await setup(t);
  const event = typed('menu');
  assert.deepEqual(await app.deliver(event, { secret: 'not-the-secret' }), { status: 401, body: { ok: false, error: 'bad_signature' } });
  assert.deepEqual(await app.deliver(event, { signature: 'sha256=nope' }), { status: 401, body: { ok: false, error: 'bad_signature' } });
  assert.deepEqual(await app.deliver(event, { signature: '' }), { status: 401, body: { ok: false, error: 'missing_headers' } });
  assert.equal(api.calls.length, 0);
});

test('a body changed after it was signed is refused', async (t) => {
  const { api, app } = await setup(t);
  const event = typed('menu');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { signatureFor } = await import('../src/signature.js');
  const signature = signatureFor(JSON.stringify(event), SECRET, timestamp);
  const changed = JSON.stringify({ ...event, data: { ...event.data, contactId: 43 } });
  assert.equal((await app.deliver(event, { body: changed, timestamp, signature })).status, 401);
  assert.equal(api.calls.length, 0);
});

/**
 * Reads the whole body before the handler runs, the way a host that offers a parsed `req.body` does.
 *
 * @param {import('node:http').IncomingMessage} req
 */
async function readAhead(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * A host that runs functions: it reads the body first, then hands the same bytes back to `data` and `end`
 * listeners only. Anything else that reads the request finds it already ended.
 *
 * @param {import('../test-support/harness.js').Handler} handler
 * @returns {import('../test-support/harness.js').Handler}
 */
function hostThatHandsTheBodyBack(handler) {
  return async (req, res) => {
    const body = await readAhead(req);
    const replay = new PassThrough();
    const on = req.on.bind(req);
    const patched = /** @type {any} */ (req);
    patched.on = patched.addListener = (/** @type {string} */ name, /** @type {(...args: any[]) => void} */ listener) =>
      name === 'data' || name === 'end' ? replay.on(name, listener) : on(name, listener);
    replay.write(body);
    replay.end();
    return handler(req, res);
  };
}

test('on a host that reads the body first and hands it back, a signed event is still accepted', async (t) => {
  const { api, app } = await setup(t, { host: hostThatHandsTheBodyBack });
  const event = tapped('Show a card', 'ks:card');
  assert.deepEqual(await app.deliver(event), { status: 200, body: { ok: true } });
  assert.equal(api.delivered.length, 2);
  assert.deepEqual(await app.deliver(event), { status: 200, body: { ok: true, duplicate: true } });

  // The signature is still checked against the bytes that arrived.
  assert.equal((await app.deliver(typed('menu'), { secret: 'not-the-secret' })).status, 401);
  const signedFor = typed('menu');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { signatureFor } = await import('../src/signature.js');
  const changed = JSON.stringify({ ...signedFor, data: { ...signedFor.data, contactId: 43 } });
  assert.equal((await app.deliver(signedFor, { body: changed, timestamp, signature: signatureFor(JSON.stringify(signedFor), SECRET, timestamp) })).status, 401);
  assert.equal(api.delivered.length, 2);

  // An event with no body at all ends at once, with no bytes.
  const empty = await fetch(`${app.url}/webhooks/messageos`, { method: 'POST', headers: { 'x-messageos-timestamp': timestamp, 'x-messageos-signature': signatureFor('', SECRET, timestamp) } });
  assert.equal(empty.status, 400);
});

test('on a host that reads the body first and keeps the bytes as rawBody, a signed event is still accepted', async (t) => {
  const { api, app } = await setup(t, {
    host: (handler) => async (req, res) => {
      /** @type {any} */ (req).rawBody = await readAhead(req);
      return handler(req, res);
    },
  });
  assert.deepEqual(await app.deliver(typed('menu')), { status: 200, body: { ok: true } });
  assert.equal(api.delivered.length, 1);
  assert.equal((await app.deliver(typed('menu'), { secret: 'not-the-secret' })).status, 401);
  assert.equal((await app.deliver(null, { body: JSON.stringify({ id: 'evt_big', type: 'webhook.test', pad: 'x'.repeat(1_100_000) }) })).status, 413);
});

test('when something read the body and kept nothing, the event is refused at once, not left waiting', async (t) => {
  const { api, app } = await setup(t, {
    host: (handler) => async (req, res) => {
      await readAhead(req);
      return handler(req, res);
    },
  });
  const answer = await Promise.race([app.deliver(typed('menu')), new Promise((resolve) => setTimeout(() => resolve('no answer'), 2000).unref())]);
  assert.deepEqual(answer, { status: 401, body: { ok: false, error: 'bad_signature' } });
  assert.equal(api.calls.length, 0);
});

test('a body over the size limit is refused with 413 and nothing is done with it', async (t) => {
  const { api, app } = await setup(t);
  const big = JSON.stringify({ id: 'evt_big', type: 'reply.received', data: { text: 'x'.repeat(1_500_000) } });
  assert.deepEqual(await app.deliver(null, { body: big }), { status: 413, body: { ok: false, error: 'payload_too_large' } });
  assert.equal(api.calls.length, 0);
  // The server is still there for the next event.
  assert.equal((await app.deliver(typed('menu'))).status, 200);
});

test('a timestamp more than 300 seconds off is refused, and one inside the window passes', async (t) => {
  // A fixed clock. With the real one, a request made late in a second would be a few milliseconds inside the limit.
  const seconds = 1_795_000_000;
  const { api, app } = await setup(t, { now: () => seconds * 1000 });
  assert.deepEqual(await app.deliver(typed('menu'), { timestamp: String(seconds - 301) }), { status: 401, body: { ok: false, error: 'stale_timestamp' } });
  assert.deepEqual(await app.deliver(typed('menu'), { timestamp: String(seconds + 301) }), { status: 401, body: { ok: false, error: 'stale_timestamp' } });
  assert.equal(api.calls.length, 0);
  assert.equal((await app.deliver(typed('menu'), { timestamp: String(seconds - 290) })).status, 200);
});

test('a signed body that is not an event is refused with 400', async (t) => {
  const { app } = await setup(t);
  assert.deepEqual(await app.deliver(null, { body: 'not json' }), { status: 400, body: { ok: false, error: 'not_json' } });
  assert.deepEqual(await app.deliver(null, { body: '{"hello":"there"}' }), { status: 400, body: { ok: false, error: 'not_an_event' } });
});

test('the same event delivered again to the same server is answered 200 and sends nothing more', async (t) => {
  const { api, app } = await setup(t);
  const event = tapped('Show text', 'ks:text');
  assert.equal((await app.deliver(event)).status, 200);
  const callsAfterFirst = api.calls.length;
  assert.deepEqual(await app.deliver(event), { status: 200, body: { ok: true, duplicate: true } });
  assert.equal(api.calls.length, callsAfterFirst);
  assert.equal(api.delivered.length, 2);
});

test('the same event delivered to another server repeats the same Idempotency-Keys, so nothing is sent twice', async (t) => {
  const { api, app } = await setup(t);
  const other = await startApp({ api });
  t.after(() => other.close());
  const event = tapped('Show a card', 'ks:card');

  assert.equal((await app.deliver(event)).status, 200);
  const first = api.messages().map((call) => ({ key: call.idempotencyKey, body: call.body }));
  const key = `ks-reply-${event.data.inboundMessageId}`;
  assert.deepEqual(first.map((call) => call.key), [`${key}-1`, `${key}-2`]);
  assert.equal(api.delivered.length, 2);

  // A server with no memory of the event: a new process, or another instance on a functions host.
  assert.deepEqual(await other.deliver(event), { status: 200, body: { ok: true } });
  const second = api.messages().slice(first.length).map((call) => ({ key: call.idempotencyKey, body: call.body }));
  assert.deepEqual(second, first);
  assert.equal(api.delivered.length, 2, 'the API replayed its stored answers');
  assert.deepEqual(other.sleeps, [], 'a replayed send needs no head start');
});

test('two webhook endpoints each get a copy of one message with its own event id, and the person is answered once', async (t) => {
  const { api, app } = await setup(t);
  // The Actions demo, because its calendar event has a date, which must not come from the copy's own time.
  const copy = tapped('Show actions', 'ks:actions');
  // The second endpoint's copy: the same message, a new event id, made a moment later, past midnight UTC.
  const otherCopy = { ...copy, id: 'evt_11111111-1111-4111-8111-111111111111', createdAt: '2026-11-24T00:00:00.004Z' };
  assert.notEqual(otherCopy.id, copy.id);

  assert.deepEqual(await app.deliver(copy), { status: 200, body: { ok: true } });
  const first = api.messages().map((call) => ({ key: call.idempotencyKey, body: call.body }));
  assert.deepEqual(first.map((call) => call.key), [`ks-reply-${copy.data.inboundMessageId}-1`]);
  assert.equal(api.delivered.length, 1);

  // The app has not seen this event id, so it does the work again. The keys and the bodies are the same.
  assert.deepEqual(await app.deliver(otherCopy), { status: 200, body: { ok: true } });
  assert.deepEqual(api.messages().slice(first.length).map((call) => ({ key: call.idempotencyKey, body: call.body })), first);
  assert.equal(api.delivered.length, 1, 'the API replayed its stored answer');
});

test('when the API cannot take a send, the webhook answers 500, and the redelivery finishes the work once', async (t) => {
  const { api, app } = await setup(t);
  const event = tapped('Show text', 'ks:text');
  let failures = 0;
  api.respond = (call) => {
    // The second message of the answer fails once.
    if (call.method === 'POST' && call.path === '/messages' && call.idempotencyKey === `ks-reply-${event.data.inboundMessageId}-2` && failures === 0) {
      failures += 1;
      return { status: 503, body: { error: { code: 'service_unavailable', message: 'Try again.' } } };
    }
  };
  assert.deepEqual(await app.deliver(event), { status: 500, body: { ok: false, error: 'try_again' } });
  assert.equal(api.delivered.length, 1);

  assert.deepEqual(await app.deliver(event), { status: 200, body: { ok: true } });
  assert.equal(api.delivered.length, 2, 'the first message was replayed and the second was sent');
  const key = `ks-reply-${event.data.inboundMessageId}`;
  assert.deepEqual(api.messages().map((call) => call.idempotencyKey), [`${key}-1`, `${key}-2`, `${key}-1`, `${key}-2`]);
});

test('a send that is still running, a busy network, and a refused key all ask for another delivery', async (t) => {
  const { api, app } = await setup(t);
  const answers = [
    { status: 409, body: { error: { code: 'conflict', message: 'A request with the same Idempotency-Key is still in progress.' } } },
    { status: 409, body: { error: { code: 'blocked', reason: 'provider_busy', message: 'Busy.' } } },
    { status: 429, body: { error: { code: 'rate_limited', message: 'Slow down.' } } },
    { status: 401, body: { error: { code: 'unauthorized', message: 'The key is not valid.' } } },
  ];
  for (const answer of answers) {
    api.respond = (call) => (call.path === '/messages' ? answer : undefined);
    assert.equal((await app.deliver(typed('menu'))).status, 500, JSON.stringify(answer));
  }
});

test('a blocked send is not retried: the event is accepted and the reason is logged', async (t) => {
  const { api, app } = await setup(t);
  api.respond = (call) => (call.path === '/messages' ? { status: 409, body: { error: { code: 'blocked', reason: 'opted_out', message: 'This person opted out.' } } } : undefined);
  assert.equal((await app.deliver(typed('hello there'))).status, 200);
  const line = app.logs.find((entry) => entry.message === 'message not sent');
  assert.match(String(line?.why), /opted_out/);
});

test('an event is not acted on while the app has no key', async (t) => {
  const { api, app } = await setup(t, { env: { MESSAGEOS_API_KEY: '' } });
  assert.equal((await app.deliver(typed('menu'))).status, 500);
  assert.equal(api.calls.length, 0);
});

test('with no webhook secret set, every delivery is refused', async (t) => {
  const { api, app } = await setup(t, { env: { MESSAGEOS_WEBHOOK_SECRET: '' } });
  assert.deepEqual(await app.deliver(typed('menu')), { status: 500, body: { ok: false, error: 'not_configured' } });
  assert.equal(api.calls.length, 0);
});

test('webhook.test and unknown event types are accepted and call nothing', async (t) => {
  const { api, app } = await setup(t);
  const base = { createdAt: '2026-11-23T18:00:00.000Z', clientId: 'messageos-kitchen-sink' };
  assert.equal((await app.deliver({ ...base, id: 'evt_test_1', type: 'webhook.test', data: {} })).status, 200);
  assert.equal((await app.deliver({ ...base, id: 'evt_new_1', type: 'something.new', data: { a: 1 } })).status, 200);
  assert.equal((await app.deliver({ ...base, id: 'evt_wf_1', type: 'workflow.completed', data: {} })).status, 200);
  assert.equal(api.calls.length, 0);
});

test('delivery reports and consent changes write one log line each and call nothing', async (t) => {
  const { api, app } = await setup(t);
  const base = { createdAt: '2026-11-23T18:00:00.000Z', clientId: 'messageos-kitchen-sink' };
  const report = { id: 'msg_7', messageId: 7, auditId: 7, contactId: 42, externalId: null, channel: 'rcs', reference: 'kitchen-sink:menu', origin: 'api' };
  const events = [
    { ...base, id: 'evt_d', type: 'message.delivered', data: { ...report, deliveredAt: '2026-11-23T18:00:01.000Z' } },
    { ...base, id: 'evt_r', type: 'message.read', data: { ...report, readAt: '2026-11-23T18:00:02.000Z' } },
    { ...base, id: 'evt_f', type: 'message.failed', data: { ...report, failedAt: '2026-11-23T18:00:03.000Z', reason: 'The file could not be fetched.', providerCode: '404' } },
    { ...base, id: 'evt_o', type: 'contact.opted_out', data: { contactId: 42, externalId: null, optedIn: false, changedAt: '2026-11-23T18:00:04.000Z' } },
    { ...base, id: 'evt_i', type: 'contact.opted_in', data: { contactId: 42, externalId: null, optedIn: true, changedAt: '2026-11-23T18:00:05.000Z' } },
  ];
  for (const event of events) {
    assert.equal((await app.deliver(event)).status, 200, event.type);
    const lines = app.logs.filter((entry) => entry.eventId === event.id);
    assert.equal(lines.length, 1, event.type);
    assert.equal(lines[0].message, event.type);
    assert.equal(lines[0].contactId, 42);
  }
  assert.equal(app.logs.find((entry) => entry.eventId === 'evt_d')?.reference, 'kitchen-sink:menu');
  assert.equal(app.logs.find((entry) => entry.eventId === 'evt_f')?.level, 'warn');
  assert.equal(api.calls.length, 0);
});

test('no log line holds the key, the secret, or what a person wrote', async (t) => {
  const { app } = await setup(t);
  await app.deliver(typed('my card number is 4111 1111 1111 1111'));
  await app.deliver(replyEvent({ kind: 'text', text: 'menu' }), { secret: 'wrong' });
  const output = JSON.stringify(app.logs);
  assert.ok(app.logs.length > 0);
  assert.ok(!output.includes(API_KEY) && !output.includes(SECRET) && !output.includes('4111'));
});

test('only POST reaches the webhook', async (t) => {
  const { app } = await setup(t);
  const response = await fetch(`${app.url}/webhooks/messageos`);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
});

test('GET /health says which settings are present, never their values', async (t) => {
  const { app } = await setup(t);
  const response = await fetch(`${app.url}/health`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { ok: true, settings: { apiUrl: true, apiKey: true, webhookSecret: true, publicUrl: true } });
  assert.ok(!text.includes(API_KEY) && !text.includes(SECRET));

  const bare = await startApp({ env: { MESSAGEOS_API_KEY: '', MESSAGEOS_WEBHOOK_SECRET: undefined, PUBLIC_URL: 'http://localhost:3000' } });
  t.after(() => bare.close());
  assert.deepEqual(await (await fetch(`${bare.url}/health`)).json(), { ok: true, settings: { apiUrl: true, apiKey: false, webhookSecret: false, publicUrl: false } });
});

test('GET / is a short page that says what this is', async (t) => {
  const { app } = await setup(t);
  const response = await fetch(`${app.url}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
  assert.match(await response.text(), /MessageOS Kitchen Sink/);
});

test('GET /media serves the sample files with their types, and nothing outside the folder', async (t) => {
  const { app } = await setup(t);
  const expected = { 'menu-text.jpg': 'image/jpeg', 'sample.mp4': 'video/mp4', 'sample.mp3': 'audio/mpeg', 'sample.pdf': 'application/pdf' };
  for (const [name, type] of Object.entries(expected)) {
    const response = await fetch(`${app.url}/media/${name}`);
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get('content-type'), type);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, readFileSync(new URL(`../public/media/${name}`, import.meta.url)));
  }
  const head = await fetch(`${app.url}/media/sample.pdf`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.text()).length, 0);

  for (const path of ['/media/missing.jpg', '/media/..%2Fsrc%2Fapp.js', '/media/%2e%2e/package.json', '/media/.env', '/media/sub/dir.jpg', '/media/sample.constructor', '/media/constructor', '/nothing-here']) {
    assert.equal((await fetch(`${app.url}${path}`)).status, 404, path);
  }
});
