// @ts-check
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { routeReply, SEND_GAP_MS, TYPING_PAUSE_MS } from '../src/conversation.js';
import { isKeyword } from '../src/keywords.js';
import { TOUR } from '../src/tour.js';
import { assertSendable } from '../test-support/api-rules.js';
import { PUBLIC_URL, replyEvent, startApp, startFakeApi, tapped, typed } from '../test-support/harness.js';

const MENU = { type: 'reply', text: 'Menu', postbackData: 'ks:menu' };

/** The tour buttons a demo ends with. @param {string} id */
function navOf(id) {
  const stop = TOUR.find((entry) => entry.id === id);
  const next = TOUR.find((entry) => entry.id === stop?.next);
  return next ? [{ type: 'reply', text: `Next: ${next.name}`, postbackData: `ks:${next.id}` }, MENU] : [MENU];
}

/**
 * Delivers one event and returns the messages the app sent for it, after checking what holds for every answer:
 * the webhook said 200, there are at most three sends, each is a reply to the person's message with the
 * Idempotency-Key made from that message's id, and the real API would accept each body.
 *
 * @param {import('node:test').TestContext} t
 * @param {ReturnType<typeof replyEvent>} event
 * @param {Record<string, unknown>} [whoami]
 * @param {import('../test-support/harness.js').FakeApi['respond']} [respond] Answers some calls another way.
 */
async function answerTo(t, event, whoami = {}, respond = null) {
  const api = await startFakeApi({ whoami });
  api.respond = respond;
  const app = await startApp({ api });
  t.after(() => Promise.all([api.close(), app.close()]));

  assert.deepEqual(await app.deliver(event), { status: 200, body: { ok: true } });
  const sent = api.messages();
  assert.ok(sent.length <= 3, 'an answer is at most three messages');
  sent.forEach((call, index) => {
    assert.equal(call.idempotencyKey, `ks-reply-${event.data.inboundMessageId}-${index + 1}`);
    assert.deepEqual(call.body.to, { contactId: event.data.contactId });
    if (whoami.replyWindowSeconds !== null) assert.equal(call.body.inReplyTo, event.data.inboundMessageId);
    assert.match(call.body.reference, /^kitchen-sink:[a-z-]+$/);
    assertSendable(call.body);
    // The file each picture or file link points at is really in public/media.
    for (const url of JSON.stringify(call.body).match(/https:\/\/kitchen-sink\.example\.test\/media\/[^"]+/g) ?? []) {
      assert.ok(existsSync(new URL(`../public/media/${url.split('/media/')[1]}`, import.meta.url)), url);
    }
  });
  return { api, app, messages: sent.map((call) => call.body), calls: api.calls };
}

test('the menu is a carousel with one card for each demo, and every button names its demo', async (t) => {
  for (const event of [typed('menu'), typed('MENU'), typed('Hello!'), typed(' hi '), tapped('Menu', 'ks:menu')]) {
    const { messages } = await answerTo(t, event);
    assert.equal(messages.length, 1);
    const { cards } = messages[0].carousel;
    assert.deepEqual(cards.map((/** @type {any} */ card) => card.title), TOUR.map((stop) => stop.name));
    assert.deepEqual(cards.map((/** @type {any} */ card) => card.suggestions), TOUR.map((stop) => [{ type: 'reply', text: stop.button, postbackData: `ks:${stop.id}` }]));
    cards.forEach((/** @type {any} */ card, /** @type {number} */ index) => {
      assert.equal(card.media.url, `${PUBLIC_URL}/media/menu-${TOUR[index].id}.jpg`);
      assert.ok(card.description.length > 0);
    });
    // The carousel rule: each button names its item, differs from the rest, fits 25 characters, is no keyword.
    const labels = cards.map((/** @type {any} */ card) => card.suggestions[0].text);
    assert.equal(new Set(labels.map((/** @type {string} */ label) => label.toLowerCase())).size, labels.length);
    assert.ok(labels.every((/** @type {string} */ label) => label.length <= 25 && !isKeyword(label)));
    // No picture is used twice in one carousel.
    assert.equal(new Set(cards.map((/** @type {any} */ card) => card.media.url)).size, cards.length);
    assert.equal(messages[0].reference, 'kitchen-sink:menu');
  }
});

test('text: a plain text, then a text with the tour buttons', async (t) => {
  const { messages, app } = await answerTo(t, tapped('Show text', 'ks:text'));
  assert.equal(messages.length, 2);
  assert.deepEqual(Object.keys(messages[0]).sort(), ['inReplyTo', 'reference', 'text', 'to']);
  assert.deepEqual(messages[1].suggestions, navOf('text'));
  assert.deepEqual(app.sleeps, [SEND_GAP_MS], 'the second message waits for the first to land');
});

test('replies: suggested replies with their own postbackData, then the tour buttons', async (t) => {
  const { messages } = await answerTo(t, tapped('Show replies', 'ks:replies'));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].suggestions, [
    { type: 'reply', text: 'Small', postbackData: 'ks:picked:small' },
    { type: 'reply', text: 'Medium', postbackData: 'ks:picked:medium' },
    { type: 'reply', text: 'Large', postbackData: 'ks:picked:large' },
    ...navOf('replies'),
  ]);
});

test('a tapped reply is answered with its label and value, and the tour goes on from its demo', async (t) => {
  const cases = [
    { label: 'Medium', value: 'medium', demo: 'replies' },
    { label: 'Tap this button', value: 'card-button', demo: 'card' },
    { label: 'Pick Teal', value: 'teal', demo: 'carousel' },
  ];
  for (const { label, value, demo } of cases) {
    const { messages } = await answerTo(t, tapped(label, `ks:picked:${value}`));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, `You tapped ${label}. Your system received postbackData ${value}.`);
    assert.deepEqual(messages[0].suggestions, navOf(demo));
  }
  const { messages } = await answerTo(t, tapped('Something else', 'ks:picked:unknown-value'));
  assert.equal(messages[0].text, 'You tapped Something else. Your system received postbackData unknown-value.');
  assert.deepEqual(messages[0].suggestions, [MENU]);
});

test('actions: one message with every kind of action', async (t) => {
  const { messages } = await answerTo(t, tapped('Show actions', 'ks:actions'));
  assert.equal(messages.length, 1);
  const suggestions = messages[0].suggestions;
  assert.deepEqual(suggestions.map((/** @type {any} */ suggestion) => suggestion.type), ['openUrl', 'openUrl', 'dial', 'viewLocation', 'shareLocation', 'createCalendarEvent', 'reply', 'reply']);
  assert.deepEqual(suggestions.slice(-2), navOf('actions'));
  assert.equal(suggestions[0].openIn, 'webview');
  assert.equal(suggestions[0].url, `${PUBLIC_URL}/`);
  assert.equal(suggestions[1].openIn, 'browser');
  assert.match(suggestions[2].phoneNumber, /^\+1555555\d{4}$/, 'a fictional number');
  // The calendar event is the day after the person's message, worked out from its receivedAt and not from the clock.
  assert.equal(suggestions[5].startTime, '2026-11-24T17:00:00Z');
  assert.equal(suggestions[5].endTime, '2026-11-24T18:00:00Z');
  assert.ok(suggestions.every((/** @type {any} */ suggestion) => suggestion.postbackData.startsWith('ks:')));
});

test('card: a vertical card, then a horizontal card that carries the tour buttons', async (t) => {
  const { messages, app } = await answerTo(t, tapped('Show a card', 'ks:card'));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].card.orientation, 'VERTICAL');
  assert.ok(messages[0].card.title && messages[0].card.description && messages[0].card.media.url);
  assert.deepEqual(messages[0].card.suggestions.map((/** @type {any} */ button) => button.type), ['reply', 'openUrl']);
  assert.equal(messages[0].suggestions, undefined);
  assert.equal(messages[1].card.orientation, 'HORIZONTAL');
  assert.equal(messages[1].card.thumbnailAlignment, 'LEFT');
  assert.deepEqual(messages[1].suggestions, navOf('card'));
  assert.deepEqual(app.sleeps, [SEND_GAP_MS]);
});

test('carousel: cards whose buttons name their items', async (t) => {
  const { messages } = await answerTo(t, tapped('Show a carousel', 'ks:carousel'));
  assert.equal(messages.length, 1);
  const { cards } = messages[0].carousel;
  assert.deepEqual(cards.map((/** @type {any} */ card) => card.suggestions[0].text), ['Pick Violet', 'Pick Blue', 'Pick Teal']);
  assert.deepEqual(cards.map((/** @type {any} */ card) => card.suggestions[0].postbackData), ['ks:picked:violet', 'ks:picked:blue', 'ks:picked:teal']);
  assert.equal(new Set(cards.map((/** @type {any} */ card) => card.media.url)).size, 3);
  assert.deepEqual(messages[0].suggestions, navOf('carousel'));
});

const FILE_CHIPS = [
  { type: 'reply', text: 'Image', postbackData: 'ks:file:image' },
  { type: 'reply', text: 'Video', postbackData: 'ks:file:video' },
  { type: 'reply', text: 'Audio', postbackData: 'ks:file:audio' },
  { type: 'reply', text: 'PDF', postbackData: 'ks:file:pdf' },
];

test('files: buttons to pick a kind of file', async (t) => {
  const { messages } = await answerTo(t, tapped('Show files', 'ks:files'));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].suggestions, [...FILE_CHIPS, ...navOf('files')]);
});

test('each kind of file is sent by its address, words first and the file last with the buttons', async (t) => {
  const expected = { image: 'sample-waves.jpg', video: 'sample.mp4', audio: 'sample.mp3', pdf: 'sample.pdf' };
  for (const [kind, file] of Object.entries(expected)) {
    const { messages } = await answerTo(t, tapped(kind, `ks:file:${kind}`));
    assert.equal(messages.length, 2, kind);
    assert.ok(messages[0].text.length > 0 && messages[0].suggestions === undefined);
    assert.equal(messages[1].file.url, `${PUBLIC_URL}/media/${file}`);
    assert.equal(messages[1].file.thumbnailUrl, kind === 'video' ? `${PUBLIC_URL}/media/sample-video-thumb.jpg` : undefined);
    assert.deepEqual(messages[1].suggestions, [...FILE_CHIPS, ...navOf('files')]);
    assert.equal(messages[1].reference, `kitchen-sink:file-${kind}`);
  }
});

test('a file button with a kind this app does not have shows the picker again, in one message', async (t) => {
  // postbackData comes back from a phone, so it can be anything, including a name every object answers to.
  for (const kind of ['spreadsheet', 'constructor', 'toString', '__proto__', 'hasOwnProperty', '']) {
    const { messages } = await answerTo(t, tapped('Other', `ks:file:${kind}`));
    assert.equal(messages.length, 1, kind);
    assert.match(messages[0].text, /Pick one\.$/, kind);
    assert.equal(messages[0].file, undefined, kind);
    assert.deepEqual(messages[0].suggestions, [...FILE_CHIPS, ...navOf('files')], kind);
    assert.equal(messages[0].reference, 'kitchen-sink:files', kind);
  }
});

test('a tapped value or a feature name that every object answers to is treated as unknown', async (t) => {
  const picked = await answerTo(t, tapped('Odd', 'ks:picked:constructor'));
  assert.equal(picked.messages.length, 1);
  assert.equal(picked.messages[0].text, 'You tapped Odd. Your system received postbackData constructor.');
  assert.deepEqual(picked.messages[0].suggestions, [MENU]);

  const api = await startFakeApi();
  const app = await startApp({ api });
  t.after(() => Promise.all([api.close(), app.close()]));
  api.respond = (call) => (call.path === '/capabilities' ? { status: 200, body: { phoneNumber: call.query.phoneNumber, rcs: true, features: ['card', 'constructor', '__proto__'] } } : undefined);
  assert.equal((await app.deliver(tapped('Show device check', 'ks:device'))).status, 200);
  assert.match(api.messages()[0].body.text, /- rich cards \(card\)\n- constructor \(constructor\)\n- __proto__ \(__proto__\)$/);
  assertSendable(api.messages()[0].body);
});

test('the sample files are small enough to ship and to send', () => {
  const size = (/** @type {string} */ name) => statSync(new URL(`../public/media/${name}`, import.meta.url)).size;
  for (const stop of TOUR) assert.ok(size(`menu-${stop.id}.jpg`) < 300_000, stop.id);
  for (const name of ['sample-waves.jpg', 'sample-rings.jpg', 'color-violet.jpg', 'color-blue.jpg', 'color-teal.jpg', 'sample-video-thumb.jpg']) assert.ok(size(name) < 300_000, name);
  assert.ok(size('sample.mp4') < 2_000_000);
  assert.ok(size('sample.mp3') < 300_000 && size('sample.pdf') < 300_000);
});

test('location: asks with a share location button', async (t) => {
  const { messages } = await answerTo(t, tapped('Show location', 'ks:location'));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].suggestions, [{ type: 'shareLocation', text: 'Share location', postbackData: 'ks:action:share' }, ...navOf('location')]);
});

test('a shared location is answered with its coordinates and a map button for the same point', async (t) => {
  const { messages } = await answerTo(t, replyEvent({ kind: 'location', text: '', location: { latitude: 37.4219983, longitude: -122.084, label: null } }));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, 'You shared a location: 37.422, -122.084. Your system received it in reply.received as location.latitude and location.longitude.');
  assert.deepEqual(messages[0].suggestions, [
    { type: 'viewLocation', text: 'View on map', latitude: 37.422, longitude: -122.084, label: 'The place you shared', postbackData: 'ks:action:map' },
    ...navOf('location'),
  ]);
  assert.equal(messages[0].reference, 'kitchen-sink:location-received');
});

test('a place sent with words has kind text, and still gets the location answer, with the words', async (t) => {
  const { messages } = await answerTo(t, replyEvent({ kind: 'text', text: ' Meet me here ', location: { latitude: 51.5072, longitude: -0.1276, label: null } }));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, 'You shared a location: 51.5072, -0.1276, with the words "Meet me here". Your system received it in reply.received as location.latitude and location.longitude, and the words as text.');
  assert.deepEqual(messages[0].suggestions[0], { type: 'viewLocation', text: 'View on map', latitude: 51.5072, longitude: -0.1276, label: 'The place you shared', postbackData: 'ks:action:map' });
  assert.deepEqual(messages[0].suggestions.slice(1), navOf('location'));
  assert.equal(messages[0].reference, 'kitchen-sink:location-received');
});

test('a file from the person is described from the event, and never downloaded', async (t) => {
  const attachment = { url: 'https://files.example.test/abc', mediaType: 'image/jpeg', kind: 'image', fileName: 'photo.jpg' };
  const { messages, calls } = await answerTo(t, replyEvent({ kind: 'file', text: '', attachments: [attachment] }));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, 'You sent a file: image/jpeg, named photo.jpg. Your system received its address, media type, and name in reply.received as attachments. This app did not download it.');
  assert.deepEqual(messages[0].suggestions, [MENU]);
  assert.equal(messages[0].reference, 'kitchen-sink:file-received');
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ['GET /whoami', 'POST /messages']);

  const unnamed = await answerTo(t, replyEvent({ kind: 'file', text: '', attachments: [{ ...attachment, mediaType: 'application/pdf', fileName: null }] }));
  assert.match(unnamed.messages[0].text, /^You sent a file: application\/pdf\. /);
  const two = await answerTo(t, replyEvent({ kind: 'file', text: '', attachments: [attachment, { ...attachment, mediaType: 'video/mp4', fileName: 'clip.mp4' }] }));
  assert.equal(two.messages[0].text, 'You sent 2 files: image/jpeg, named photo.jpg; video/mp4, named clip.mp4. Your system received the address, media type, and name of each in reply.received as attachments. This app did not download them.');
  assert.deepEqual(two.messages[0].suggestions, [MENU]);
});

test('a photo sent with a caption has kind text, and still gets the file answer, with the caption', async (t) => {
  const photo = { url: 'https://files.example.test/abc', mediaType: 'image/jpeg', kind: 'image', fileName: 'photo.jpg' };
  const { messages, calls } = await answerTo(t, replyEvent({ kind: 'text', text: ' Is this the right part? ', attachments: [photo] }));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, 'You sent a file: image/jpeg, named photo.jpg, with the words "Is this the right part?". Your system received its address, media type, and name in reply.received as attachments, and the words as text. This app did not download it.');
  assert.deepEqual(messages[0].suggestions, [MENU]);
  assert.equal(messages[0].reference, 'kitchen-sink:file-received');
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ['GET /whoami', 'POST /messages']);

  // The caption is not read as a command: a photo captioned "menu" or "card" is still a photo.
  for (const caption of ['menu', 'hi', 'card', 'Files']) {
    const answer = await answerTo(t, replyEvent({ kind: 'text', text: caption, attachments: [photo] }));
    assert.equal(answer.messages.length, 1, caption);
    assert.ok(answer.messages[0].text.startsWith(`You sent a file: image/jpeg, named photo.jpg, with the words "${caption}".`), caption);
  }

  // The longest answer still fits one text: five files with long names, and a caption as long as a message can be.
  const long = { ...photo, mediaType: `application/${'x'.repeat(200)}`, fileName: `${'n'.repeat(300)}.bin` };
  const most = await answerTo(t, replyEvent({ kind: 'text', text: 'c'.repeat(3000), attachments: Array.from({ length: 7 }, () => long) }));
  assert.ok(most.messages[0].text.startsWith('You sent 7 files: '));
  assert.ok(most.messages[0].text.length <= 2000);
  assert.ok(most.messages[0].text.endsWith('This app did not download them.'));
});

test('a keyword written under a photo or beside a place gets no answer, like any keyword', async (t) => {
  const photo = { url: 'https://files.example.test/abc', mediaType: 'image/jpeg', kind: 'image', fileName: 'photo.jpg' };
  for (const event of [
    replyEvent({ kind: 'text', text: 'STOP', attachments: [photo] }),
    replyEvent({ kind: 'text', text: 'Help!', attachments: [photo] }),
    replyEvent({ kind: 'text', text: 'stop', location: { latitude: 1, longitude: 2, label: null } }),
  ]) {
    const { calls } = await answerTo(t, event);
    assert.equal(calls.filter((call) => call.path !== '/whoami').length, 0, event.data.text);
  }
});

test('typing: POST /typing, a two second pause, then the message', async (t) => {
  const { messages, calls, app } = await answerTo(t, tapped('Show typing', 'ks:typing'));
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ['GET /whoami', 'POST /typing', 'POST /messages']);
  assert.deepEqual(calls[1].body, { to: { contactId: 42 } });
  assert.deepEqual(app.sleeps, [TYPING_PAUSE_MS]);
  assert.equal(TYPING_PAUSE_MS, 2000);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].suggestions, navOf('typing'));
});

test('typing: when the indicator is refused, the message says so and nothing waits', async (t) => {
  const api = await startFakeApi();
  const app = await startApp({ api });
  t.after(() => Promise.all([api.close(), app.close()]));
  api.respond = (call) => (call.path === '/typing' ? { status: 409, body: { error: { code: 'blocked', reason: 'message_rejected', message: 'The phone cannot be reached.' } } } : undefined);
  assert.equal((await app.deliver(tapped('Show typing', 'ks:typing'))).status, 200);
  assert.match(api.messages()[0].body.text, /POST \/typing answered 409 with the reason message_rejected/);
  assert.deepEqual(app.sleeps, []);
});

test('expiry: one text with ttlSeconds and a trafficType', async (t) => {
  const { messages } = await answerTo(t, tapped('Show expiry', 'ks:expiry'));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ttlSeconds, 600);
  assert.equal(messages[0].trafficType, 'serviceRequest');
  assert.equal(messages[0].expiresAt, undefined);
  assert.deepEqual(messages[0].suggestions, navOf('expiry'));
});

test('expiry: when the network refuses that message, a plain one follows so the tour can go on', async (t) => {
  const api = await startFakeApi();
  const app = await startApp({ api });
  t.after(() => Promise.all([api.close(), app.close()]));
  api.respond = (call) => (call.path === '/messages' && call.body.ttlSeconds ? { status: 409, body: { error: { code: 'blocked', reason: 'message_rejected', message: 'Not accepted.' } } } : undefined);
  assert.equal((await app.deliver(tapped('Show expiry', 'ks:expiry'))).status, 200);
  const sent = api.messages();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body.ttlSeconds, undefined);
  assert.match(sent[1].body.text, /message_rejected/);
  assert.deepEqual(sent[1].body.suggestions, navOf('expiry'));
  assertSendable(sent[1].body);
});

test('device: GET /capabilities for this phone, answered as a short list, with only Menu after it', async (t) => {
  const { messages, calls } = await answerTo(t, tapped('Show device check', 'ks:device'));
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ['GET /whoami', 'GET /capabilities', 'POST /messages']);
  assert.deepEqual(calls[1].query, { phoneNumber: '+15555550123' });
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /can receive RCS/);
  for (const feature of ['card', 'carousel', 'openUrl', 'dial', 'viewLocation', 'shareLocation', 'createCalendarEvent']) assert.ok(messages[0].text.includes(`(${feature})`), feature);
  assert.deepEqual(messages[0].suggestions, [MENU], 'the last demo offers only the menu');
});

test('device: a phone that cannot get RCS, and a check that does not answer', async (t) => {
  const api = await startFakeApi();
  const app = await startApp({ api });
  t.after(() => Promise.all([api.close(), app.close()]));
  api.respond = (call) => (call.path === '/capabilities' ? { status: 200, body: { phoneNumber: '+15555550123', rcs: false, features: [] } } : undefined);
  await app.deliver(tapped('Show device check', 'ks:device'));
  assert.match(api.messages()[0].body.text, /cannot receive RCS/);
  api.respond = (call) => (call.path === '/capabilities' ? { status: 503, body: { error: { code: 'provider_unavailable', message: 'Try again.' } } } : undefined);
  await app.deliver(tapped('Show device check', 'ks:device'));
  assert.match(api.messages()[1].body.text, /GET \/capabilities answered 503/);
});

test('the tour can be walked from the menu to the last demo by its Next buttons', async (t) => {
  const api = await startFakeApi();
  const app = await startApp({ api });
  t.after(() => Promise.all([api.close(), app.close()]));

  await app.deliver(typed('menu'));
  let button = api.messages().at(-1)?.body.carousel.cards[0].suggestions[0];
  const visited = [];
  while (button && button.postbackData !== 'ks:menu') {
    visited.push(button.postbackData.slice(3));
    assert.equal((await app.deliver(tapped(button.text, button.postbackData))).status, 200);
    const last = api.messages().at(-1)?.body;
    button = last.suggestions.find((/** @type {any} */ suggestion) => suggestion.text.startsWith('Next: ')) ?? last.suggestions.at(-1);
    assert.deepEqual(last.suggestions.at(-1), MENU, 'Menu is always the last button');
  }
  assert.deepEqual(visited, TOUR.map((stop) => stop.id));
  for (const call of api.messages()) assertSendable(call.body);
});

test('every answer ends with something to tap: its last message carries the Menu button, or is the menu', async (t) => {
  const photo = { url: 'https://files.example.test/abc', mediaType: 'image/jpeg', kind: 'image', fileName: 'photo.jpg' };
  const place = { latitude: 40.7128, longitude: -74.006, label: null };
  const refused = { status: 409, body: { error: { code: 'blocked', reason: 'message_rejected', message: 'Not accepted.' } } };

  /** Every message a person can send that this app answers. @type {Array<{ event: () => ReturnType<typeof replyEvent>, respond?: import('../test-support/harness.js').FakeApi['respond'] }>} */
  const cases = [
    // The menu, typed and tapped.
    { event: () => typed('menu') },
    { event: () => typed('Hello') },
    { event: () => tapped('Menu', 'ks:menu') },
    // A button this app no longer knows, and one it never made. Both get the menu.
    { event: () => tapped('Old button', 'ks:retired-demo') },
    { event: () => tapped('On my way', 'not-ours') },
    // Every demo, tapped from the menu and typed by name.
    ...TOUR.flatMap((stop) => [{ event: () => tapped(stop.button, `ks:${stop.id}`) }, { event: () => typed(stop.name) }]),
    // A tapped reply from each demo that has one, and one this app does not know.
    ...['small', 'medium', 'large', 'card-button', 'violet', 'blue', 'teal', 'unknown-value'].map((value) => ({ event: () => tapped('A label', `ks:picked:${value}`) })),
    // Each kind of file, and a kind this app does not have.
    ...['image', 'video', 'audio', 'pdf', 'spreadsheet'].map((kind) => ({ event: () => tapped(kind, `ks:file:${kind}`) })),
    // What a person sends on their own: a place, a file, each with and without words, and plain words.
    { event: () => replyEvent({ kind: 'location', text: '', location: place }) },
    { event: () => replyEvent({ kind: 'text', text: 'I am here', location: place }) },
    { event: () => replyEvent({ kind: 'file', text: '', attachments: [photo] }) },
    { event: () => replyEvent({ kind: 'file', text: '', attachments: [photo, photo] }) },
    { event: () => replyEvent({ kind: 'text', text: 'Is this the right part?', attachments: [photo] }) },
    { event: () => typed('What time do you open?') },
    // The lines sent when something is refused or cannot be read.
    { event: () => tapped('Show typing', 'ks:typing'), respond: (call) => (call.path === '/typing' ? refused : undefined) },
    { event: () => tapped('Show expiry', 'ks:expiry'), respond: (call) => (call.path === '/messages' && call.body.ttlSeconds ? refused : undefined) },
    { event: () => tapped('Show device check', 'ks:device'), respond: (call) => (call.path === '/capabilities' ? { status: 503, body: { error: { code: 'provider_unavailable', message: 'Try again.' } } } : undefined) },
    { event: () => tapped('Show device check', 'ks:device'), respond: (call) => (call.path === '/capabilities' ? { status: 200, body: { phoneNumber: '+15555550123', rcs: false, features: [] } } : undefined) },
  ];

  // The list above reaches every kind of answer the router has, and every demo.
  const routes = cases.map(({ event }) => routeReply(event().data));
  assert.deepEqual([...new Set(routes.map((route) => route.name))].sort(), ['attachment', 'demo', 'echo', 'file', 'location', 'menu', 'picked']);
  assert.deepEqual([...new Set(routes.flatMap((route) => (route.name === 'demo' ? [route.id] : [])))].sort(), TOUR.map((stop) => stop.id).sort());

  // With buttons: the default, and each way a key can lack the other features.
  for (const whoami of [{}, { rcsExtras: false }, { replyWindowSeconds: null }, { rcsExtras: false, replyWindowSeconds: null }]) {
    for (const { event, respond } of cases) {
      const sent = event();
      const where = `${JSON.stringify(whoami)} ${sent.data.text} ${sent.data.postbackData ?? ''}`;
      // What reached the phone. A message the API refused is not in this list.
      const { delivered } = (await answerTo(t, sent, whoami, respond)).api;
      assert.ok(delivered.length >= 1, where);
      const last = delivered[delivered.length - 1];
      if (last.reference === 'kitchen-sink:menu') {
        // The menu itself: a button for every demo.
        assert.deepEqual(last.carousel.cards.map((/** @type {any} */ card) => card.suggestions[0].postbackData), TOUR.map((stop) => `ks:${stop.id}`), where);
      } else {
        assert.deepEqual(last.suggestions?.at(-1), MENU, `${where}: the last button is Menu`);
      }
      // Buttons show only under the newest message, so no earlier message of the answer carries any.
      for (const earlier of delivered.slice(0, -1)) assert.equal(earlier.suggestions, undefined, where);
    }
  }

  // Without buttons there is nothing to tap, so the last message says what to type instead.
  for (const whoami of [{ richMessages: false }, { richMessages: false, rcsExtras: false }]) {
    for (const { event, respond } of cases) {
      const sent = event();
      const where = `${JSON.stringify(whoami)} ${sent.data.text} ${sent.data.postbackData ?? ''}`;
      const { delivered } = (await answerTo(t, sent, whoami, respond)).api;
      assert.ok(delivered.length >= 1, where);
      const last = delivered[delivered.length - 1];
      if (last.reference === 'kitchen-sink:menu') assert.match(last.text, /Type one of these to run a demo: /, where);
      else assert.match(last.text, /\n\n(Type [a-z]+ for the next demo, or menu for the list\.|Type menu for the list of demos\.)$/, where);
      for (const message of delivered) assert.equal(message.suggestions ?? message.card ?? message.carousel ?? message.file, undefined, where);
    }
  }
});

test('STOP, START, HELP, and the other keywords get no answer from this app, typed or tapped', async (t) => {
  for (const word of ['STOP', 'stop', 'Stop.', 'STOP ALL', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout', 'opt out', 'START', 'unstop', 'join', 'subscribe', 'HELP', 'info']) {
    const typedAnswer = await answerTo(t, typed(word));
    assert.equal(typedAnswer.calls.filter((call) => call.path !== '/whoami').length, 0, word);
    const tappedAnswer = await answerTo(t, tapped(word, word));
    assert.equal(tappedAnswer.calls.filter((call) => call.path !== '/whoami').length, 0, word);
  }
});

test('typed words that are not a command come back as "You said: <text>" with a Menu button', async (t) => {
  for (const words of ['ks-test-7f3a9c', 'What time do you open?', 'please stop by tomorrow', 'yes']) {
    const { messages } = await answerTo(t, typed(words));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, `You said: ${words}`);
    assert.deepEqual(messages[0].suggestions, [MENU]);
    assert.equal(messages[0].reference, 'kitchen-sink:echo');
  }
  const long = await answerTo(t, typed('x'.repeat(2000)));
  assert.equal(long.messages[0].text.length, 2000);
});

test('a typed demo name runs that demo', async (t) => {
  assert.equal((await answerTo(t, typed('Replies'))).messages[0].suggestions[0].postbackData, 'ks:picked:small');
  assert.match((await answerTo(t, typed('device check'))).messages[0].text, /GET \/capabilities/);
});

test('a tap on an action gets no answer, and neither do blank words', async (t) => {
  for (const event of [tapped('Open in browser', 'ks:action:browser'), tapped('Share location', 'ks:action:share'), tapped('Old action', 'ks:action:retired'), typed('   ')]) {
    const { calls } = await answerTo(t, event);
    assert.equal(calls.filter((call) => call.path !== '/whoami').length, 0, event.data.postbackData ?? 'blank');
  }
});

test('a tap on a button this app no longer knows gets the menu, so the person has something to tap', async (t) => {
  // A demo that was taken out, a button another system made, a name every plain object answers to, and a tap
  // that carries no value at all.
  const unknown = [tapped('Old button', 'ks:retired-demo'), tapped('On my way', 'not-ours'), tapped('Old button', 'ks:constructor'), tapped('Old button', 'ks:'), tapped('Old button', ''), replyEvent({ kind: 'chip', text: 'Old button', postbackData: null })];
  for (const event of unknown) {
    assert.deepEqual(routeReply(event.data), { name: 'menu' }, String(event.data.postbackData));
    const { messages } = await answerTo(t, event);
    assert.equal(messages.length, 1, String(event.data.postbackData));
    assert.equal(messages[0].reference, 'kitchen-sink:menu');
    assert.deepEqual(messages[0].carousel.cards.map((/** @type {any} */ card) => card.suggestions[0].postbackData), TOUR.map((stop) => `ks:${stop.id}`));
  }
  // Where buttons are off, the same tap gets the menu as text.
  const plain = await answerTo(t, tapped('Old button', 'ks:retired-demo'), { richMessages: false });
  assert.equal(plain.messages.length, 1);
  assert.match(plain.messages[0].text, /Type one of these to run a demo: /);
  // A keyword on the label still comes first: MessageOS answers it, and this app stays silent.
  const stop = await answerTo(t, tapped('Stop', 'ks:retired-demo'));
  assert.equal(stop.calls.filter((call) => call.path !== '/whoami').length, 0);
});

test('an event with nothing in it gets no answer, whatever its kind says', async (t) => {
  for (const event of [
    replyEvent({ kind: 'file', text: '', attachments: [] }),
    replyEvent({ kind: 'location', text: '', location: null }),
    replyEvent({ kind: 'location', text: '', location: { latitude: 200, longitude: 0, label: null } }),
  ]) {
    const { calls } = await answerTo(t, event);
    assert.equal(calls.filter((call) => call.path !== '/whoami').length, 0, event.data.kind);
  }
});

test('routeReply reads only the event', () => {
  const data = replyEvent().data;
  assert.deepEqual(routeReply({ ...data, kind: 'chip', text: 'Show text', postbackData: 'ks:text' }), { name: 'demo', id: 'text' });
  assert.deepEqual(routeReply({ ...data, kind: 'chip', text: 'Large', postbackData: 'ks:picked:a:b' }), { name: 'picked', label: 'Large', value: 'a:b' });
  assert.deepEqual(routeReply({ ...data, kind: 'location', location: { latitude: 200, longitude: 0, label: null } }), { name: 'silent', why: 'empty' });
  assert.deepEqual(routeReply({ ...data, kind: 'text', text: ' Hey. ' }), { name: 'menu' });
  assert.deepEqual(routeReply({ ...data, kind: 'text', text: ' hey there ' }), { name: 'echo', text: 'hey there' });
});

test('routeReply goes by what arrived, not by kind: keyword, file, location, tap, then typed words', () => {
  const data = replyEvent().data;
  const photo = { url: 'https://files.example.test/abc', mediaType: 'image/jpeg', kind: 'image', fileName: null };
  const place = { latitude: 40.7128, longitude: -74.006, label: null };

  // The same answer whatever kind says, because kind is `text` as soon as there are words.
  for (const kind of /** @type {const} */ (['file', 'text'])) {
    assert.deepEqual(routeReply({ ...data, kind, text: '', attachments: [photo] }), { name: 'attachment', caption: '' });
    assert.deepEqual(routeReply({ ...data, kind, text: ' Look ', attachments: [photo] }), { name: 'attachment', caption: 'Look' });
  }
  for (const kind of /** @type {const} */ (['location', 'text'])) {
    assert.deepEqual(routeReply({ ...data, kind, text: '', location: place }), { name: 'location', latitude: 40.7128, longitude: -74.006, words: '' });
    assert.deepEqual(routeReply({ ...data, kind, text: 'Here', location: place }), { name: 'location', latitude: 40.7128, longitude: -74.006, words: 'Here' });
  }

  // A keyword comes first, and a file comes before a place.
  assert.deepEqual(routeReply({ ...data, kind: 'text', text: 'Stop.', attachments: [photo], location: place }), { name: 'silent', why: 'keyword' });
  assert.deepEqual(routeReply({ ...data, kind: 'text', text: 'Both', attachments: [photo], location: place }), { name: 'attachment', caption: 'Both' });

  // A place whose coordinates are not on the map is not a location. Any words with it are still words.
  const nowhere = { latitude: 0, longitude: 181, label: null };
  assert.deepEqual(routeReply({ ...data, kind: 'text', text: 'menu', location: nowhere }), { name: 'menu' });
  assert.deepEqual(routeReply({ ...data, kind: 'text', text: 'Where is this?', location: nowhere }), { name: 'echo', text: 'Where is this?' });

  // A tap has neither a file nor a place, so it reaches its button.
  assert.deepEqual(routeReply({ ...data, kind: 'chip', text: 'Menu', postbackData: 'ks:menu' }), { name: 'menu' });
  // An action did its work on the phone and gets silence. Any other value the app does not have gets the menu.
  assert.deepEqual(routeReply({ ...data, kind: 'chip', text: 'Call a number', postbackData: 'ks:action:dial' }), { name: 'silent', why: 'action' });
  assert.deepEqual(routeReply({ ...data, kind: 'chip', text: 'Old button', postbackData: 'ks:retired-demo' }), { name: 'menu' });
});

test('with richMessages false: no buttons, cards, or files are sent, and each demo says so in one line', async (t) => {
  const off = { richMessages: false };
  const menu = await answerTo(t, typed('menu'), off);
  assert.equal(menu.messages.length, 1);
  assert.match(menu.messages[0].text, /richMessages false/);
  assert.match(menu.messages[0].text, /text, typing, expiry, device/);

  for (const id of ['replies', 'actions', 'card', 'carousel', 'files', 'location']) {
    const { messages } = await answerTo(t, typed(id), off);
    assert.equal(messages.length, 1, id);
    assert.match(messages[0].text, /is skipped/);
    assert.deepEqual(Object.keys(messages[0]).sort(), ['inReplyTo', 'reference', 'text', 'to'], id);
  }
  const file = await answerTo(t, tapped('Image', 'ks:file:image'), off);
  assert.match(file.messages[0].text, /is skipped/);

  for (const event of [typed('text'), typed('typing'), typed('expiry'), typed('device'), typed('anything else'), tapped('Small', 'ks:picked:small'), replyEvent({ kind: 'location', location: { latitude: 1, longitude: 2, label: null } })]) {
    const { messages } = await answerTo(t, event, off);
    assert.ok(messages.length >= 1);
    for (const message of messages) {
      assert.equal(typeof message.text, 'string');
      assert.equal(message.suggestions, undefined);
      assert.equal(message.card ?? message.carousel ?? message.file, undefined);
    }
  }
  const text = await answerTo(t, typed('text'), off);
  assert.match(text.messages[1].text, /Type replies for the next demo, or menu for the list\.$/);
  // With no buttons to tap, an answer outside the tour says how to get back to the menu.
  const echo = await answerTo(t, typed('ks-test-1'), off);
  assert.equal(echo.messages[0].text, 'You said: ks-test-1\n\nType menu for the list of demos.');
  const long = await answerTo(t, typed('x'.repeat(2000)), off);
  assert.equal(long.messages[0].text.length, 2000);
  assert.ok(long.messages[0].text.endsWith('x\n\nType menu for the list of demos.'));
  const photo = await answerTo(t, replyEvent({ kind: 'text', text: 'Look', attachments: [{ url: 'https://files.example.test/abc', mediaType: 'image/png', kind: 'image', fileName: null }] }), off);
  assert.equal(photo.messages[0].text, 'You sent a file: image/png, with the words "Look". Your system received its address, media type, and name in reply.received as attachments, and the words as text. This app did not download it.\n\nType menu for the list of demos.');
});

test('with rcsExtras false: no typing call, no capability call, no expiry fields, and each demo says so', async (t) => {
  const off = { rcsExtras: false };
  const typing = await answerTo(t, tapped('Show typing', 'ks:typing'), off);
  assert.deepEqual(typing.calls.map((call) => `${call.method} ${call.path}`), ['GET /whoami', 'POST /messages']);
  assert.match(typing.messages[0].text, /rcsExtras false/);
  assert.deepEqual(typing.app.sleeps, []);
  assert.deepEqual(typing.messages[0].suggestions, navOf('typing'));

  const expiry = await answerTo(t, tapped('Show expiry', 'ks:expiry'), off);
  assert.equal(expiry.messages.length, 1);
  assert.equal(expiry.messages[0].ttlSeconds, undefined);
  assert.equal(expiry.messages[0].trafficType, undefined);
  assert.match(expiry.messages[0].text, /rcsExtras false/);

  const device = await answerTo(t, tapped('Show device check', 'ks:device'), off);
  assert.deepEqual(device.calls.map((call) => `${call.method} ${call.path}`), ['GET /whoami', 'POST /messages']);
  assert.match(device.messages[0].text, /rcsExtras false/);
});

test('with replyWindowSeconds null: answers are sent without inReplyTo', async (t) => {
  for (const event of [typed('menu'), tapped('Show text', 'ks:text'), typed('hello there')]) {
    const { messages } = await answerTo(t, event, { replyWindowSeconds: null });
    assert.ok(messages.length >= 1);
    for (const message of messages) assert.equal('inReplyTo' in message, false);
  }
});

test('GET /whoami is read once and remembered for the next events', async (t) => {
  const api = await startFakeApi();
  const app = await startApp({ api });
  t.after(() => Promise.all([api.close(), app.close()]));
  await app.deliver(typed('one'));
  await app.deliver(typed('two'));
  await app.deliver(typed('three'));
  assert.equal(api.calls.filter((call) => call.path === '/whoami').length, 1);
});
