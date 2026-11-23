// @ts-check
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { WEBHOOK_EVENTS } from '../src/config.js';
import { assertSendable } from '../test-support/api-rules.js';
import { API_KEY, PUBLIC_URL, startFakeApi } from '../test-support/harness.js';

/**
 * Runs one of the scripts the way `npm run` does, against the fake API. It runs from a folder with no `.env`
 * file, so only the settings given here count.
 *
 * @param {string} name
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runScript(name, args, env) {
  const file = fileURLToPath(new URL(`../scripts/${name}.js`, import.meta.url));
  return new Promise((resolve) => {
    execFile(process.execPath, [file, ...args], { cwd: tmpdir(), env: { PATH: process.env.PATH, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

/** @param {import('node:test').TestContext} t @param {Record<string, unknown>} [whoami] */
async function setup(t, whoami) {
  const api = await startFakeApi({ whoami });
  t.after(() => api.close());
  return { api, env: { MESSAGEOS_API_URL: api.url, MESSAGEOS_API_KEY: API_KEY, PUBLIC_URL } };
}

test('check prints what the key and the API address offer, and never the key', async (t) => {
  const { api, env } = await setup(t, { rcsExtras: false, scopes: ['messages:write', 'contacts:read'] });
  const result = await runScript('check', [], env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Agent: +MessageOS Kitchen Sink \(messageos-kitchen-sink\)/);
  assert.match(result.stdout, /Missing permissions: contacts:write, conversations:read, webhooks:manage, usage:read/);
  assert.match(result.stdout, /richMessages: +true/);
  assert.match(result.stdout, /typing +softened, needs rcsExtras/);
  assert.match(result.stdout, /replies +runs/);
  assert.ok(!result.stdout.includes(API_KEY));
  assert.deepEqual(api.calls.map((call) => `${call.method} ${call.path}`), ['GET /whoami']);
});

test('check stops with a plain line when there is no key, or the key is refused', async (t) => {
  const { env } = await setup(t);
  const none = await runScript('check', [], { ...env, MESSAGEOS_API_KEY: '' });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /MESSAGEOS_API_KEY is not set/);
  const wrong = await runScript('check', [], { ...env, MESSAGEOS_API_KEY: 'mosc_wrong' });
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /GET \/whoami failed: The key is not valid\. \(status 401, unauthorized/);
});

test('setup:webhook registers the webhook once, prints the secret once, then says it exists', async (t) => {
  const { api, env } = await setup(t);
  const first = await runScript('setup-webhook', [], env);
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(api.calls.at(-1)?.body, { url: `${PUBLIC_URL}/webhooks/messageos`, eventTypes: WEBHOOK_EVENTS });
  assert.deepEqual(WEBHOOK_EVENTS, ['reply.received', 'message.delivered', 'message.read', 'message.failed', 'contact.opted_out', 'contact.opted_in']);
  assert.match(first.stdout, new RegExp(`MESSAGEOS_WEBHOOK_SECRET=${'a'.repeat(48)}`));

  const second = await runScript('setup-webhook', [], env);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /already exists: id 1, status active/);
  assert.ok(!second.stdout.includes('a'.repeat(48)));
  assert.equal(api.webhooks.length, 1);
});

test('setup:webhook says when the webhook it finds is paused, and how to resume it', async (t) => {
  const { api, env } = await setup(t);
  api.webhooks.push({ id: 7, url: `${PUBLIC_URL}/webhooks/messageos`, eventTypes: WEBHOOK_EVENTS, status: 'paused', secret: 'b'.repeat(48), createdAt: '2026-11-23T18:00:00.000Z' });
  const result = await runScript('setup-webhook', [], env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /already exists: id 7, status paused/);
  assert.match(result.stdout, /It is paused, so no event is delivered to it\./);
  assert.match(result.stdout, /PATCH \/webhooks\/7 with the body \{"status":"active"\}/);
  assert.ok(!result.stdout.includes('b'.repeat(48)));
  assert.equal(api.webhooks.length, 1, 'no second webhook is made');
});

test('setup:webhook refuses an address that is not https', async (t) => {
  const { api, env } = await setup(t);
  const result = await runScript('setup-webhook', [], { ...env, PUBLIC_URL: 'http://localhost:3000' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /PUBLIC_URL must be/);
  assert.equal(api.calls.length, 0);
});

test('send:menu starts a conversation: the menu with a consent record, to one phone number', async (t) => {
  const { api, env } = await setup(t);
  const result = await runScript('send-menu', ['+15555550123'], env);
  assert.equal(result.code, 0, result.stderr);
  const [call] = api.messages();
  assert.deepEqual(call.body.to, { phoneNumber: '+15555550123' });
  assert.equal(call.body.carousel.cards.length, 10);
  assert.equal(call.body.consent.source, 'kitchen-sink-example');
  assert.ok(!Number.isNaN(Date.parse(call.body.consent.capturedAt)));
  assert.equal('inReplyTo' in call.body, false, 'a message that starts a conversation is not a reply');
  assert.match(String(call.idempotencyKey), /^ks-menu-[0-9a-f-]{36}$/);
  assertSendable(call.body);
  assert.match(result.stdout, /Sent: msg_1, status sent, type carousel/);
});

test('send:menu wants one E.164 number, and reports a blocked send in plain words', async (t) => {
  const { api, env } = await setup(t);
  for (const args of [[], ['5555550123'], ['+1 555 555 0123']]) {
    const result = await runScript('send-menu', args, env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /E\.164/);
  }
  assert.equal(api.calls.length, 0);

  api.respond = (call) => (call.path === '/messages' ? { status: 409, body: { error: { code: 'blocked', reason: 'agent_not_available', message: 'This agent cannot reach that phone yet.' } } } : undefined);
  const blocked = await runScript('send-menu', ['+15555550123'], env);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /The menu was not sent: This agent cannot reach that phone yet\. \(status 409, blocked, agent_not_available/);
});
