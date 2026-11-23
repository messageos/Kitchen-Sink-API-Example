// @ts-check
import * as content from './content.js';
import { isKeyword } from './keywords.js';
import { tourStop, tourStopNamed } from './tour.js';

/**
 * The conversation: what this app answers to each message a person sends. `routeReply` decides, and
 * `answerReply` sends.
 *
 * @typedef {import('./types.js').ReplyData} ReplyData
 * @typedef {import('./types.js').MessageContent} MessageContent
 * @typedef {import('./types.js').WebhookEvent} WebhookEvent
 */

/** Up to three sends can answer one message as replies, so no answer here is longer than that. */
export const MAX_REPLIES = 3;

/**
 * The wait between two messages of one answer. A card or a file can take longer to appear on the phone than
 * text sent right behind it, and the buttons show only under the newest message, so the last message is given
 * a head start to land last.
 */
export const SEND_GAP_MS = 1500;

/** How long the typing demo waits between the typing indicator and its message. */
export const TYPING_PAUSE_MS = 2000;

const GREETINGS = new Set(['hi', 'hello', 'hey']);

/**
 * @typedef {{ name: 'silent', why: 'keyword' | 'action' | 'empty' }
 *   | { name: 'menu' }
 *   | { name: 'demo', id: string }
 *   | { name: 'picked', label: string, value: string }
 *   | { name: 'file', kind: string }
 *   | { name: 'location', latitude: number, longitude: number, words: string }
 *   | { name: 'attachment', caption: string }
 *   | { name: 'echo', text: string }} Route
 */

/**
 * Decides what one `reply.received` event gets, in this order: a keyword gets silence, a file gets the file
 * answer, a place gets the location answer, a tap runs its button, and typed words are a command or are echoed.
 * A tap on a button this app does not know gets the menu. It reads only the event, so the same event always
 * gets the same answer, on any server.
 *
 * @param {ReplyData} data
 * @returns {Route}
 */
export function routeReply(data) {
  const text = typeof data.text === 'string' ? data.text : '';

  // STOP, START, HELP, and the other keywords are answered by MessageOS. Typed, tapped, or written under a
  // photo, this app stays silent.
  if (isKeyword(text)) return { name: 'silent', why: 'keyword' };

  // The answer follows what arrived, not `kind`. `kind` names one thing, and a message can hold two: a photo
  // sent with a caption has kind `text`, and so does a place sent with words. Only a file with no words has
  // kind `file`, and only a place with no words has kind `location`. So a message with attachments is a file,
  // and a message with coordinates is a location, whatever else came with it.
  if (Array.isArray(data.attachments) && data.attachments.length > 0) return { name: 'attachment', caption: text.trim() };

  const { latitude, longitude } = data.location ?? {};
  if (typeof latitude === 'number' && typeof longitude === 'number' && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
    return { name: 'location', latitude, longitude, words: text.trim() };
  }

  if (data.kind === 'chip') {
    const postback = data.postbackData ?? '';
    if (postback === 'ks:menu') return { name: 'menu' };
    if (postback.startsWith('ks:picked:')) return { name: 'picked', label: text, value: postback.slice('ks:picked:'.length) };
    if (postback.startsWith('ks:file:')) return { name: 'file', kind: postback.slice('ks:file:'.length) };
    // A tap on an action already did its work on the phone: it opened a page, the dialer, or a map.
    if (postback.startsWith('ks:action:')) return { name: 'silent', why: 'action' };
    if (postback.startsWith('ks:') && tourStop(postback.slice(3))) return { name: 'demo', id: postback.slice(3) };
    // A button this app does not know: one from an older version of it, or one sent before this app answered.
    // Buttons on a card stay in the conversation for good, so a person can tap one long after. Their tap is now
    // the newest message, and the buttons under the last answer are gone, so silence would leave them with
    // nothing to tap. The menu gives them every button back.
    return { name: 'menu' };
  }

  // Typed words.
  const words = text.trim().toLowerCase().replace(/[.!?]+$/, '');
  if (words === '') return { name: 'silent', why: 'empty' };
  if (words === 'menu' || GREETINGS.has(words)) return { name: 'menu' };
  const named = tourStopNamed(words);
  if (named) return { name: 'demo', id: named.id };
  return { name: 'echo', text: text.trim() };
}

/** The API cannot take the work right now. The webhook answers with an error so MessageOS delivers the event again. */
export class RetryLater extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'RetryLater';
  }
}

/**
 * What one send came to.
 *
 * @typedef {{ ok: true, replayed: boolean } | { ok: false, why: string }} SendResult
 */

/**
 * Reads the answer to `POST /messages`.
 *
 * @param {import('./messageos.js').ApiAnswer} answer
 * @returns {SendResult}
 */
export function sendResult(answer) {
  const code = answer.body?.error?.code;
  const reason = answer.body?.error?.reason;
  // 201 is sent. 202 is deferred: accepted, and held by a rule this app did not ask for.
  if (answer.ok) return { ok: true, replayed: answer.replayed };
  // This key was used before with another body. The event was already answered, so there is nothing left to send.
  if (answer.status === 422 && code === 'idempotency_key_reuse') return { ok: true, replayed: true };
  // Worth another delivery: the same send is still running, the API or the network is busy, or the key is wrong.
  if (answer.status >= 500 || answer.status === 429 || answer.status === 401 || answer.status === 403) throw new RetryLater(`POST /messages answered ${answer.status}.`);
  if (answer.status === 409 && (code === 'conflict' || reason === 'provider_busy')) throw new RetryLater(`POST /messages answered 409 ${reason ?? code}.`);
  // Not sent, and sending again would not change it: the person opted out, the body is not valid, and so on.
  if (code === 'blocked') return { ok: false, why: `MessageOS blocked it with the reason ${reason}.` };
  return { ok: false, why: `POST /messages answered ${answer.status}${code ? ` ${code}` : ''}.` };
}

/**
 * Answers one `reply.received` event. Every message goes out through `POST /messages` with:
 *
 * - `inReplyTo`, the id of the person's message, which makes the send a reply. A reply to a message from the
 *   last hour needs no consent record, and quiet hours do not hold it.
 * - an `Idempotency-Key` built from the id of the person's message and the position of the send
 *   (`ks-reply-<inboundMessageId>-1`, `-2`, `-3`). Not from the event id: each webhook endpoint gets its own copy
 *   of an event with its own id, so two endpoints that both take `reply.received` would each answer. The message
 *   id is the same on every copy and every redelivery, so the same keys go out, MessageOS returns the stored
 *   answers, and the person gets nothing twice.
 *
 * @param {WebhookEvent} event
 * @param {object} deps
 * @param {import('./messageos.js').Client} deps.api
 * @param {import('./types.js').Features} deps.features
 * @param {string} deps.publicUrl
 * @param {import('./types.js').Log} deps.log
 * @param {(ms: number) => Promise<unknown>} deps.sleep
 * @returns {Promise<{ route: string, sends: number }>}
 */
export async function answerReply(event, { api, features, publicUrl, log, sleep }) {
  const data = /** @type {ReplyData} */ (event.data);
  const route = routeReply(data);
  const ctx = { features, publicUrl };
  let sends = 0;
  let lastWasNew = false;

  /**
   * @param {string} label What this answer is, for `reference` and the log.
   * @param {MessageContent} message
   */
  async function send(label, message) {
    if (sends >= MAX_REPLIES) throw new Error(`An answer is at most ${MAX_REPLIES} messages.`);
    if (lastWasNew) await sleep(SEND_GAP_MS);
    sends += 1;
    const body = {
      to: { contactId: data.contactId },
      ...message,
      // Your own id for the message. It comes back in message.delivered, message.read, and message.failed.
      reference: `kitchen-sink:${label}`,
      ...(features.replies && Number.isInteger(data.inboundMessageId) ? { inReplyTo: data.inboundMessageId } : {}),
    };
    const answer = await api.sendMessage(body, `ks-reply-${data.inboundMessageId}-${sends}`);
    const result = sendResult(answer);
    lastWasNew = result.ok && !result.replayed;
    log(result.ok ? 'info' : 'warn', !result.ok ? 'message not sent' : answer.status === 202 ? 'message deferred' : 'message sent', {
      eventId: event.id,
      answer: label,
      position: sends,
      status: answer.status,
      replayed: answer.replayed,
      messageId: answer.body?.id ?? null,
      requestId: answer.requestId,
      ...(result.ok ? {} : { why: result.why }),
    });
    return result;
  }

  /** @param {string} label @param {MessageContent[]} messages */
  async function sendAll(label, messages) {
    for (const message of messages) await send(label, message);
  }

  /** @param {string} id */
  async function runDemo(id) {
    if (content.needsRichMessages(ctx, id)) return sendAll(id, content.skipped(ctx, id));
    switch (id) {
      case 'text':
        return sendAll(id, content.textDemo(ctx));
      case 'replies':
        return sendAll(id, content.repliesDemo(ctx));
      case 'actions':
        return sendAll(id, content.actionsDemo(ctx, data.receivedAt));
      case 'card':
        return sendAll(id, content.cardDemo(ctx));
      case 'carousel':
        return sendAll(id, content.carouselDemo(ctx));
      case 'files':
        return sendAll(id, content.filesDemo(ctx));
      case 'location':
        return sendAll(id, content.locationDemo(ctx));
      case 'typing':
        return sendAll(id, content.typingDemo(ctx, await showTyping()));
      case 'expiry': {
        const [message] = content.expiryDemo(ctx);
        const first = await send(id, message);
        // The network can refuse an expiry or a traffic type. Say so, so the tour still moves on.
        if (!first.ok && features.extras) await sendAll(id, content.expiryFallback(ctx, first.why));
        return;
      }
      case 'device':
        return sendAll(id, content.deviceDemo(ctx, await checkDevice()));
    }
  }

  /** @returns {Promise<{ shown: true } | { shown: false, why: string }>} */
  async function showTyping() {
    if (!features.extras) return { shown: false, why: 'GET /whoami shows rcsExtras false for this key, so POST /typing is not turned on.' };
    // A signal, not a message: it needs no Idempotency-Key, and sending it again on a redelivery does no harm.
    const answer = await api.typing({ contactId: data.contactId });
    log('info', 'typing indicator requested', { eventId: event.id, status: answer.status, requestId: answer.requestId });
    if (answer.status !== 202) return { shown: false, why: `POST /typing answered ${answer.status}${answer.body?.error?.reason ? ` with the reason ${answer.body.error.reason}` : ''}.` };
    await sleep(TYPING_PAUSE_MS);
    return { shown: true };
  }

  /** @returns {Promise<{ checked: true, rcs: boolean, features: string[] } | { checked: false, why: string }>} */
  async function checkDevice() {
    if (!features.extras) return { checked: false, why: 'GET /whoami shows rcsExtras false for this key, so GET /capabilities is not turned on.' };
    const answer = await api.capabilities(data.phoneNumber);
    log('info', 'capabilities read', { eventId: event.id, status: answer.status, requestId: answer.requestId });
    if (answer.status !== 200) return { checked: false, why: `GET /capabilities answered ${answer.status}. Try again in a moment.` };
    const listed = Array.isArray(answer.body?.features) ? answer.body.features.filter((/** @type {unknown} */ feature) => typeof feature === 'string') : [];
    return { checked: true, rcs: answer.body?.rcs === true, features: listed };
  }

  switch (route.name) {
    case 'silent':
      log('info', 'reply not answered', { eventId: event.id, why: route.why });
      break;
    case 'menu':
      await sendAll('menu', content.menu(ctx));
      break;
    case 'picked':
      await sendAll('picked', content.picked(ctx, route.label, route.value));
      break;
    case 'file':
      await sendAll(content.isFileKind(route.kind) ? `file-${route.kind}` : 'files', content.needsRichMessages(ctx, 'files') ? content.skipped(ctx, 'files') : content.fileDemo(ctx, route.kind));
      break;
    case 'location':
      await sendAll('location-received', content.locationReceived(ctx, route, route.words));
      break;
    case 'attachment':
      await sendAll('file-received', content.fileReceived(ctx, data.attachments, route.caption));
      break;
    case 'echo':
      await sendAll('echo', content.echo(ctx, route.text));
      break;
    case 'demo':
      await runDemo(route.id);
      break;
  }
  return { route: route.name === 'demo' ? route.id : route.name, sends };
}
