// @ts-check
// npm run check
// Calls GET /whoami and prints what this key and this API address offer, and which demos will run.
import { featuresFrom } from '../src/messageos.js';
import { TOUR } from '../src/tour.js';
import { describeError, fail, run, setup } from './common.js';

const NEEDED_SCOPES = ['messages:write', 'contacts:read', 'contacts:write', 'conversations:read', 'webhooks:manage', 'usage:read'];
const NEEDS_RICH = ['replies', 'actions', 'card', 'carousel', 'files', 'location'];
const NEEDS_EXTRAS = ['typing', 'expiry', 'device'];

run(async () => {
  const { config, api } = setup();
  const answer = await api.whoami();
  if (!answer.ok) fail(`GET /whoami failed: ${describeError(answer)}`);

  const who = answer.body ?? {};
  const scopes = Array.isArray(who.scopes) ? who.scopes : [];
  const missing = NEEDED_SCOPES.filter((scope) => !scopes.includes(scope));
  const features = featuresFrom(who);

  console.log(`API address:         ${config.apiUrl}`);
  console.log(`Agent:               ${who.name} (${who.clientId})`);
  console.log(`Environment:         ${who.environment}`);
  console.log(`Key:                 ${who.keyPrefix}...`);
  console.log(`Permissions:         ${scopes.join(', ') || 'none'}`);
  console.log(`Missing permissions: ${missing.join(', ') || 'none'}`);
  console.log(`richMessages:        ${who.richMessages}   (buttons, cards, carousels, files)`);
  console.log(`rcsExtras:           ${who.rcsExtras}   (typing, device check, expiry, traffic type)`);
  console.log(`replyWindowSeconds:  ${who.replyWindowSeconds}   (${features.replies ? 'inReplyTo is accepted' : 'inReplyTo is not accepted, so answers are sent as ordinary messages'})`);
  console.log(`quietHoursEnforced:  ${who.quietHoursEnforced}`);
  console.log(`allowedClasses:      ${Array.isArray(who.allowedClasses) ? who.allowedClasses.join(', ') : who.allowedClasses}`);
  console.log('');
  console.log('Demos:');
  for (const stop of TOUR) {
    let state = 'runs';
    if (NEEDS_RICH.includes(stop.id) && !features.rich) state = 'skipped, needs richMessages';
    if (NEEDS_EXTRAS.includes(stop.id) && !features.extras) state = 'softened, needs rcsExtras';
    console.log(`  ${stop.id.padEnd(9)} ${state}`);
  }
  console.log('');
  console.log(`Webhook secret set:  ${config.webhookSecret ? 'yes' : 'no'}`);
  console.log(`PUBLIC_URL set:      ${config.publicUrl.startsWith('https://') ? 'yes' : 'no, it must be an https address'}`);

  if (!scopes.includes('messages:write')) fail('\nThis key cannot send messages. Make a key with messages:write.');
});
