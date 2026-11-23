// @ts-check
// npm run send:menu -- +15555550123
// Starts a conversation: sends the menu to one phone number. Use your own phone, or one whose owner asked for it.
import { randomUUID } from 'node:crypto';
import { menu } from '../src/content.js';
import { featuresFrom } from '../src/messageos.js';
import { describeError, fail, run, setup } from './common.js';

run(async () => {
  const phoneNumber = process.argv[2] ?? '';
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) fail('Give one phone number in E.164, such as: npm run send:menu -- +15555550123');

  const { config, api } = setup();
  if (!config.publicUrl.startsWith('https://')) fail('PUBLIC_URL must be this app\'s public https address. The menu\'s pictures are fetched from it.');

  const who = await api.whoami();
  if (!who.ok) fail(`GET /whoami failed: ${describeError(who)}`);

  // This message starts the conversation, so it is not a reply and cannot use inReplyTo. A message you start
  // needs a consent record: where and when the person agreed to get messages. Sending `consent` with a new
  // phone number creates the contact with that record in the same call. It needs contacts:write on the key.
  const [content] = menu({ features: featuresFrom(who.body), publicUrl: config.publicUrl });
  const body = {
    to: { phoneNumber },
    ...content,
    consent: { source: 'kitchen-sink-example', capturedAt: new Date().toISOString() },
    reference: 'kitchen-sink:menu',
  };
  const answer = await api.sendMessage(body, `ks-menu-${randomUUID()}`);
  if (!answer.ok) fail(`The menu was not sent: ${describeError(answer)}`);
  console.log(`Sent: ${answer.body.id}, status ${answer.body.status}, type ${answer.body.type}, contact ${answer.body.contactId}.`);
  console.log('Tap a card on the phone. Each tap arrives at this app\'s webhook as reply.received.');
});
