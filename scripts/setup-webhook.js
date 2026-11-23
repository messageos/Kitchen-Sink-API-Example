// @ts-check
// npm run setup:webhook
// Registers this app's webhook at <PUBLIC_URL>/webhooks/messageos and prints its signing secret once.
import { WEBHOOK_EVENTS, WEBHOOK_PATH } from '../src/config.js';
import { describeError, fail, run, setup } from './common.js';

run(async () => {
  const { config, api } = setup();
  if (!config.publicUrl.startsWith('https://')) fail('PUBLIC_URL must be this app\'s public https address. MessageOS does not deliver to a private or local address.');
  const url = `${config.publicUrl}${WEBHOOK_PATH}`;

  const listed = await api.listWebhooks();
  if (!listed.ok) fail(`GET /webhooks failed: ${describeError(listed)}`);
  /** @type {Array<{ id: number, url: string, status: string, eventTypes: string[] }>} */
  const endpoints = Array.isArray(listed.body?.data) ? listed.body.data : [];
  const existing = endpoints.find((endpoint) => endpoint.url === url && endpoint.status !== 'disabled');
  if (existing) {
    const lacking = WEBHOOK_EVENTS.filter((type) => !existing.eventTypes.includes(type));
    console.log(`A webhook for ${url} already exists: id ${existing.id}, status ${existing.status}.`);
    if (lacking.length > 0) console.log(`It does not receive: ${lacking.join(', ')}. Add them with PATCH /webhooks/${existing.id}, or in the dashboard under Developers.`);
    if (existing.status === 'paused') {
      // MessageOS pauses a webhook when its 8 newest deliveries all ran out of attempts. It is sent nothing until it is resumed.
      console.log('It is paused, so no event is delivered to it. Fix what made the deliveries fail, then resume it:');
      console.log(`PATCH /webhooks/${existing.id} with the body {"status":"active"}, or in the dashboard under Developers.`);
    }
    console.log('Its signing secret was shown once, when it was made, and cannot be read again.');
    console.log(`If you no longer have it, remove the webhook (DELETE /webhooks/${existing.id}, or in the dashboard) and run this again.`);
    return;
  }

  const made = await api.createWebhook(url, WEBHOOK_EVENTS);
  if (!made.ok) fail(`POST /webhooks failed: ${describeError(made)}`);
  console.log(`Webhook ${made.body.id} registered for ${url}`);
  console.log(`Events: ${made.body.eventTypes.join(', ')}`);
  console.log('');
  console.log('This is the signing secret. It is shown only now. Put it in .env, or in your host\'s settings:');
  console.log('');
  console.log(`MESSAGEOS_WEBHOOK_SECRET=${made.body.secret}`);
});
