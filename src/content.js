// @ts-check
import { TOUR, tourStop } from './tour.js';

/**
 * Every message this app sends is built here, as plain data. Nothing in this file calls the API: each function
 * returns the content of one or more messages, and `conversation.js` sends them.
 *
 * @typedef {import('./types.js').MessageContent} MessageContent
 * @typedef {import('./types.js').Suggestion} Suggestion
 * @typedef {import('./types.js').Features} Features
 *
 * @typedef {object} ContentContext
 * @property {Features} features What this key can use, from `GET /whoami`.
 * @property {string} publicUrl This app's public https address. Picture and file links start with it.
 */

/** @type {Suggestion} */
const MENU_CHIP = { type: 'reply', text: 'Menu', postbackData: 'ks:menu' };

/** The longest text one message takes. */
const MAX_TEXT = 2000;

/** The demos that are made of buttons, cards, or files, so they need `richMessages`. */
const NEEDS_RICH = new Set(['replies', 'actions', 'card', 'carousel', 'files', 'location']);

/**
 * The tables in this file that are looked up with a value from outside the app, such as the end of a
 * `postbackData` or a feature name from the API, are Maps. A Map holds only the keys put in it. A plain object
 * also answers to `constructor`, `toString`, and `__proto__`, and a button's `postbackData` comes back from a
 * phone, so it is never trusted to be one of the app's own values.
 */

/** One line for each demo, shown on its menu card. Looked up only with the ids in `tour.json`. */
const DESCRIPTIONS = /** @type {Record<string, string>} */ ({
  text: 'A plain text message, the smallest thing you can send.',
  replies: 'Buttons a person taps to answer. Each one carries your own value.',
  actions: 'Buttons that open a link, call, show a map, share a location, or add an event.',
  card: 'A rich card with a picture, a title, words, and buttons.',
  carousel: 'A row of cards to swipe through, each with its own button.',
  files: 'An image, a video, an audio file, or a PDF, sent by its address.',
  location: 'Ask for a location and read the coordinates that come back.',
  typing: 'Show the typing indicator while your system works on an answer.',
  expiry: 'A message with a time to live and a declared traffic type.',
  device: 'Ask what this phone supports before you send.',
});

/** @param {ContentContext} ctx @param {string} file A file name in `public/media/`. */
function media(ctx, file) {
  return `${ctx.publicUrl}/media/${file}`;
}

/**
 * The buttons that end a demo: the next demo, then the menu. The last demo offers only the menu. Buttons show
 * only under the newest message in a conversation, so they always go on the last message of an answer.
 *
 * @param {string} demoId
 * @returns {Suggestion[]}
 */
export function navChips(demoId) {
  const next = tourStop(tourStop(demoId)?.next ?? '');
  return next ? [{ type: 'reply', text: `Next: ${next.name}`, postbackData: `ks:${next.id}` }, MENU_CHIP] : [MENU_CHIP];
}

/** The same directions in words, for a key that cannot send buttons. @param {string} demoId */
function navHint(demoId) {
  const next = tourStop(tourStop(demoId)?.next ?? '');
  return next ? `Type ${next.id} for the next demo, or menu for the list.` : 'Type menu for the list of demos.';
}

/**
 * Ends the last message of an answer, so a person is never left with nothing to tap: the answer's own buttons,
 * then the tour buttons, which always end with Menu. Without rich messages the same directions are added to the
 * text instead. An answer that belongs to no demo passes `''` and gets Menu alone.
 *
 * @param {ContentContext} ctx
 * @param {string} demoId
 * @param {MessageContent} content
 * @param {Suggestion[]} [own]
 * @returns {MessageContent}
 */
function withNav(ctx, demoId, content, own = []) {
  if (ctx.features.rich) return { ...content, suggestions: [...own, ...navChips(demoId)] };
  if (content.text === undefined) return content;
  const hint = `\n\n${navHint(demoId)}`;
  return { ...content, text: `${content.text.slice(0, MAX_TEXT - hint.length)}${hint}` };
}

/** True when this key cannot run the demo as built. @param {ContentContext} ctx @param {string} demoId */
export function needsRichMessages(ctx, demoId) {
  return !ctx.features.rich && NEEDS_RICH.has(demoId);
}

/**
 * The one plain line sent in place of a demo this key cannot run.
 *
 * @param {ContentContext} ctx
 * @param {string} demoId
 * @returns {MessageContent[]}
 */
export function skipped(ctx, demoId) {
  const name = tourStop(demoId)?.name ?? demoId;
  return [withNav(ctx, demoId, { text: `The ${name} demo is skipped: it needs buttons, cards, or files, and GET /whoami shows richMessages false for this key.` })];
}

/**
 * The menu: a carousel with one card for each demo. Every card's button names that card's demo, so no two
 * buttons read the same. Some phones show a card's button apart from its title, and "Show" on every card would
 * not say which demo a tap opens.
 *
 * @param {ContentContext} ctx
 * @returns {MessageContent[]}
 */
export function menu(ctx) {
  if (!ctx.features.rich) {
    const runnable = TOUR.filter((stop) => !NEEDS_RICH.has(stop.id)).map((stop) => stop.id);
    const held = TOUR.filter((stop) => NEEDS_RICH.has(stop.id)).map((stop) => stop.id);
    return [{
      text: [
        'This is the MessageOS Kitchen Sink. GET /whoami shows richMessages false for this key, so the menu is plain text.',
        `Type one of these to run a demo: ${runnable.join(', ')}.`,
        `These need rich messages: ${held.join(', ')}.`,
      ].join('\n\n'),
    }];
  }
  return [{
    carousel: {
      cardWidth: 'MEDIUM',
      cards: TOUR.map((stop) => ({
        title: stop.name,
        description: DESCRIPTIONS[stop.id] ?? '',
        media: { url: media(ctx, `menu-${stop.id}.jpg`), height: 'MEDIUM' },
        suggestions: [{ type: 'reply', text: stop.button, postbackData: `ks:${stop.id}` }],
      })),
    },
  }];
}

/** @param {ContentContext} ctx @returns {MessageContent[]} */
export function textDemo(ctx) {
  return [
    { text: `This is a plain text message. A text can be up to ${MAX_TEXT} characters.` },
    withNav(ctx, 'text', {
      text: ctx.features.rich
        ? 'The body of that message was a recipient and text, nothing else. This message adds suggestions: the buttons under it.'
        : 'The body of that message was a recipient and text, nothing else.',
    }),
  ];
}

/** @param {ContentContext} ctx @returns {MessageContent[]} */
export function repliesDemo(ctx) {
  return [withNav(ctx, 'replies', {
    text: 'Suggested replies are buttons a person taps to answer. Each one carries postbackData, your own value for it. Which size would you pick?',
  }, [
    { type: 'reply', text: 'Small', postbackData: 'ks:picked:small' },
    { type: 'reply', text: 'Medium', postbackData: 'ks:picked:medium' },
    { type: 'reply', text: 'Large', postbackData: 'ks:picked:large' },
  ])];
}

/** The demo each tapped value belongs to, so the answer to a tap can offer that demo's next step. */
const PICK_SOURCES = new Map([
  ['small', 'replies'],
  ['medium', 'replies'],
  ['large', 'replies'],
  ['card-button', 'card'],
  ['violet', 'carousel'],
  ['blue', 'carousel'],
  ['teal', 'carousel'],
]);

/**
 * The answer to a tap on a suggested reply or a card button.
 *
 * @param {ContentContext} ctx
 * @param {string} label The label the person tapped. It arrives as `text`.
 * @param {string} value The part of `postbackData` after `ks:picked:`.
 * @returns {MessageContent[]}
 */
export function picked(ctx, label, value) {
  return [withNav(ctx, PICK_SOURCES.get(value) ?? '', { text: `You tapped ${label}. Your system received postbackData ${value}.` })];
}

/**
 * A calendar event the day after the person's message. It is worked out from the time the message was received,
 * not from the clock, so every copy and every redelivery of the event builds the same body and the
 * Idempotency-Key still matches.
 *
 * @param {string} receivedAt
 */
function sampleEventTimes(receivedAt) {
  const parsed = Date.parse(receivedAt);
  const from = Number.isFinite(parsed) ? parsed : Date.UTC(2030, 0, 1);
  const date = new Date(from + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { startTime: `${date}T17:00:00Z`, endTime: `${date}T18:00:00Z` };
}

/**
 * One message with every kind of suggested action.
 *
 * @param {ContentContext} ctx
 * @param {string} receivedAt When the person's message was received, as RFC 3339: `receivedAt` in the event's data.
 * @returns {MessageContent[]}
 */
export function actionsDemo(ctx, receivedAt) {
  return [withNav(ctx, 'actions', {
    text: 'Suggested actions are buttons that do something on the phone: open a link inside the conversation, open the browser, start a call, show a place, share a location, or add a calendar event. The phone number is a fictional 555 number.',
  }, [
    { type: 'openUrl', text: 'Open in webview', url: `${ctx.publicUrl}/`, openIn: 'webview', webviewViewMode: 'TALL', postbackData: 'ks:action:webview' },
    { type: 'openUrl', text: 'Open in browser', url: 'https://messageos.ai', openIn: 'browser', postbackData: 'ks:action:browser' },
    { type: 'dial', text: 'Call a number', phoneNumber: '+15555550100', postbackData: 'ks:action:dial' },
    { type: 'viewLocation', text: 'View on map', latitude: 37.8199, longitude: -122.4783, label: 'Golden Gate Bridge', postbackData: 'ks:action:map' },
    { type: 'shareLocation', text: 'Share location', postbackData: 'ks:action:share' },
    { type: 'createCalendarEvent', text: 'Add to calendar', title: 'Kitchen Sink sample event', description: 'Made by the MessageOS Kitchen Sink example.', ...sampleEventTimes(receivedAt), postbackData: 'ks:action:calendar' },
  ])];
}

/**
 * A vertical card, then a horizontal one. Buttons on a card belong to the card. The tour buttons go under the
 * second message, in `suggestions` beside `card`.
 *
 * @param {ContentContext} ctx
 * @returns {MessageContent[]}
 */
export function cardDemo(ctx) {
  return [
    {
      card: {
        orientation: 'VERTICAL',
        title: 'A vertical rich card',
        description: 'The picture sits above the words. A card takes a title, a description, media, and up to four buttons.',
        media: { url: media(ctx, 'sample-waves.jpg'), height: 'TALL' },
        suggestions: [
          { type: 'reply', text: 'Tap this button', postbackData: 'ks:picked:card-button' },
          { type: 'openUrl', text: 'Open the example page', url: `${ctx.publicUrl}/`, openIn: 'webview', postbackData: 'ks:action:webview' },
        ],
      },
    },
    withNav(ctx, 'card', {
      card: {
        orientation: 'HORIZONTAL',
        thumbnailAlignment: 'LEFT',
        title: 'A horizontal rich card',
        description: 'The picture sits beside the words. thumbnailAlignment puts it on the left or the right.',
        media: { url: media(ctx, 'sample-rings.jpg'), height: 'MEDIUM' },
      },
    }),
  ];
}

const COLORS = [
  { id: 'violet', name: 'Violet', description: 'The first card. Swipe to see the next one.' },
  { id: 'blue', name: 'Blue', description: 'Each card has its own picture, words, and button.' },
  { id: 'teal', name: 'Teal', description: 'A carousel takes 2 to 10 cards.' },
];

/** @param {ContentContext} ctx @returns {MessageContent[]} */
export function carouselDemo(ctx) {
  return [withNav(ctx, 'carousel', {
    carousel: {
      cardWidth: 'MEDIUM',
      cards: COLORS.map((color) => ({
        title: color.name,
        description: color.description,
        media: { url: media(ctx, `color-${color.id}.jpg`), height: 'MEDIUM' },
        // Named for the item, so the three buttons differ: Pick Violet, Pick Blue, Pick Teal.
        suggestions: [{ type: 'reply', text: `Pick ${color.name}`, postbackData: `ks:picked:${color.id}` }],
      })),
    },
  })];
}

/**
 * The sample files in `public/media/`, by the kind a person picks.
 *
 * @type {Map<string, { label: string, file: string, thumbnail?: string, line: string }>}
 */
const FILES = new Map([
  ['image', { label: 'Image', file: 'sample-waves.jpg', line: 'An image, sent as a file. The body was file.url: the public address of the picture.' }],
  ['video', { label: 'Video', file: 'sample.mp4', thumbnail: 'sample-video-thumb.jpg', line: 'A short video, sent as a file. The body also set file.thumbnailUrl, a small preview picture.' }],
  ['audio', { label: 'Audio', file: 'sample.mp3', line: 'A short audio file, sent as a file by its address.' }],
  ['pdf', { label: 'PDF', file: 'sample.pdf', line: 'A one page PDF, sent as a file by its address.' }],
]);

/** True for a kind of sample file this app has: image, video, audio, or pdf. @param {string} kind */
export function isFileKind(kind) {
  return FILES.has(kind);
}

/** @returns {Suggestion[]} */
function fileChips() {
  return [...FILES].map(([kind, entry]) => ({ type: 'reply', text: entry.label, postbackData: `ks:file:${kind}` }));
}

/** @param {ContentContext} ctx @returns {MessageContent[]} */
export function filesDemo(ctx) {
  return [withNav(ctx, 'files', {
    text: 'A file is sent by its address: an image, a video, an audio file, or a PDF. MessageOS does not download it. The phone network fetches it from this app. Pick one.',
  }, fileChips())];
}

/**
 * One sample file. The words go first and the file last, because the buttons show only under the newest
 * message and a file can take a moment longer to appear than text sent right behind it.
 *
 * @param {ContentContext} ctx
 * @param {string} kind image, video, audio, or pdf.
 * @returns {MessageContent[]}
 */
export function fileDemo(ctx, kind) {
  const entry = FILES.get(kind);
  // A kind this app does not have, whatever the button said: show the picker again.
  if (!entry) return filesDemo(ctx);
  return [
    { text: entry.line },
    withNav(ctx, 'files', {
      file: { url: media(ctx, entry.file), ...(entry.thumbnail ? { thumbnailUrl: media(ctx, entry.thumbnail) } : {}) },
    }, fileChips()),
  ];
}

/** @param {ContentContext} ctx @returns {MessageContent[]} */
export function locationDemo(ctx) {
  return [withNav(ctx, 'location', {
    text: 'Tap Share location and pick a place to send. It reaches your system as reply.received with kind location and the coordinates.',
  }, [{ type: 'shareLocation', text: 'Share location', postbackData: 'ks:action:share' }])];
}

/** The longest run of a person's own words this app quotes back beside a file or a place. */
const MAX_QUOTED = 500;

/**
 * The words a person sent together with a file or a place, as the end of a sentence. Empty when there were none.
 *
 * @param {string} words
 */
function withTheWords(words) {
  const trimmed = words.trim();
  return trimmed === '' ? '' : `, with the words "${trimmed.slice(0, MAX_QUOTED)}"`;
}

/**
 * The answer to a location a person shared: the coordinates, and a button that shows the same point on a map.
 *
 * @param {ContentContext} ctx
 * @param {{ latitude: number, longitude: number }} location
 * @param {string} [words] What the person wrote with the place, if anything.
 * @returns {MessageContent[]}
 */
export function locationReceived(ctx, location, words = '') {
  const latitude = Number(location.latitude.toFixed(5));
  const longitude = Number(location.longitude.toFixed(5));
  const said = withTheWords(words);
  return [withNav(ctx, 'location', {
    text: `You shared a location: ${latitude}, ${longitude}${said}. Your system received it in reply.received as location.latitude and location.longitude${said ? ', and the words as text' : ''}.`,
  }, [{ type: 'viewLocation', text: 'View on map', latitude, longitude, label: 'The place you shared', postbackData: 'ks:action:map' }])];
}

/**
 * The answer to a file a person sent, with or without a caption. It says what arrived from the event alone.
 * The app does not download the file.
 *
 * @param {ContentContext} ctx
 * @param {Array<{ mediaType?: string | null, fileName?: string | null }>} attachments At least one.
 * @param {string} [caption] What the person wrote with the file, if anything.
 * @returns {MessageContent[]}
 */
export function fileReceived(ctx, attachments, caption = '') {
  const described = attachments.slice(0, 5).map((attachment) => {
    const type = String(attachment.mediaType || 'unknown type').slice(0, 100);
    return attachment.fileName ? `${type}, named ${String(attachment.fileName).slice(0, 100)}` : type;
  });
  const one = attachments.length === 1;
  const said = withTheWords(caption);
  const what = one ? `You sent a file: ${described[0]}` : `You sent ${attachments.length} files: ${described.join('; ')}`;
  const where = `Your system received ${one ? 'its address, media type, and name' : 'the address, media type, and name of each'} in reply.received as attachments${said ? ', and the words as text' : ''}.`;
  return [withNav(ctx, '', { text: `${what}${said}. ${where} This app did not download ${one ? 'it' : 'them'}.` })];
}

/**
 * Typed words that are not a command come straight back.
 *
 * @param {ContentContext} ctx
 * @param {string} text
 * @returns {MessageContent[]}
 */
export function echo(ctx, text) {
  return [withNav(ctx, '', { text: `You said: ${text}`.slice(0, MAX_TEXT) })];
}

/**
 * The message that follows the typing indicator.
 *
 * @param {ContentContext} ctx
 * @param {{ shown: true } | { shown: false, why: string }} result
 * @returns {MessageContent[]}
 */
export function typingDemo(ctx, result) {
  const text = result.shown
    ? 'This app called POST /typing, waited two seconds, and then sent this message. The typing indicator shows in between.'
    : `No typing indicator this time: ${result.why}`;
  return [withNav(ctx, 'typing', { text })];
}

/** How long the expiry demo's message lives, and the kind of traffic it declares. */
export const EXPIRY = /** @type {const} */ ({ ttlSeconds: 600, trafficType: 'serviceRequest' });

/**
 * A text with an expiry and a traffic type, where this key can send them.
 *
 * @param {ContentContext} ctx
 * @returns {MessageContent[]}
 */
export function expiryDemo(ctx) {
  if (!ctx.features.extras) {
    return [withNav(ctx, 'expiry', { text: 'GET /whoami shows rcsExtras false for this key, so this message was sent without an expiry or a traffic type. Where it is true, a message can carry ttlSeconds or expiresAt, and trafficType.' })];
  }
  return [withNav(ctx, 'expiry', {
    text: `This message was sent with ttlSeconds ${EXPIRY.ttlSeconds} and trafficType ${EXPIRY.trafficType}. ttlSeconds is how long the message lives before the messaging network takes it back automatically. trafficType declares what kind of traffic the message is.`,
    ...EXPIRY,
  })];
}

/** Sent when the message with an expiry did not go out. @param {ContentContext} ctx @param {string} why @returns {MessageContent[]} */
export function expiryFallback(ctx, why) {
  return [withNav(ctx, 'expiry', { text: `The message with an expiry and a traffic type was not sent: ${why} This one was sent without them.` })];
}

/** This API's name for each feature, in words. */
const FEATURE_WORDS = new Map([
  ['card', 'rich cards'],
  ['carousel', 'carousels'],
  ['openUrl', 'buttons that open a link'],
  ['dial', 'buttons that start a call'],
  ['viewLocation', 'buttons that show a place'],
  ['shareLocation', 'buttons that ask for a location'],
  ['createCalendarEvent', 'buttons that add a calendar event'],
  ['revoke', 'taking a message back'],
]);

/**
 * The capability check, as a short list.
 *
 * @param {ContentContext} ctx
 * @param {{ checked: true, rcs: boolean, features: string[] } | { checked: false, why: string }} result
 * @returns {MessageContent[]}
 */
export function deviceDemo(ctx, result) {
  let text;
  if (!result.checked) {
    text = `No device check this time: ${result.why}`;
  } else if (!result.rcs) {
    text = 'GET /capabilities says this phone cannot receive RCS from this agent.';
  } else {
    const lines = result.features.slice(0, 20).map((feature) => `- ${FEATURE_WORDS.get(feature) ?? feature} (${feature})`);
    text = ['GET /capabilities says this phone can receive RCS from this agent. It supports:', ...lines].join('\n');
  }
  return [withNav(ctx, 'device', { text })];
}
