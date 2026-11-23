// @ts-check
import assert from 'node:assert/strict';
import { isKeyword } from '../src/keywords.js';

/**
 * The rules `POST /messages` applies to a body, written out by hand from the MessageOS API reference, so the
 * tests can check every body this app sends without calling the API. An unknown field fails, as it does there.
 */

const TOP_FIELDS = new Set(['to', 'text', 'suggestions', 'card', 'carousel', 'file', 'class', 'reference', 'consent', 'onQuiet', 'inReplyTo', 'expiresAt', 'ttlSeconds', 'trafficType']);
const SUGGESTION_FIELDS = /** @type {Record<string, string[]>} */ ({
  reply: ['type', 'text', 'postbackData'],
  openUrl: ['type', 'text', 'url', 'openIn', 'webviewViewMode', 'postbackData', 'fallbackUrl'],
  dial: ['type', 'text', 'phoneNumber', 'postbackData', 'fallbackUrl'],
  viewLocation: ['type', 'text', 'latitude', 'longitude', 'query', 'label', 'postbackData', 'fallbackUrl'],
  shareLocation: ['type', 'text', 'postbackData'],
  createCalendarEvent: ['type', 'text', 'startTime', 'endTime', 'title', 'description', 'postbackData', 'fallbackUrl'],
});
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** @param {Record<string, unknown>} object @param {Iterable<string>} allowed @param {string} where */
function onlyFields(object, allowed, where) {
  const known = new Set(allowed);
  for (const field of Object.keys(object)) assert.ok(known.has(field), `${where} has a field the API does not take: ${field}`);
}

/** @param {unknown} value @param {string[]} protocols @param {string} where */
function assertAddress(value, protocols, where) {
  assert.equal(typeof value, 'string', `${where} must be a string`);
  const text = /** @type {string} */ (value);
  assert.ok(text.length <= 2048 && !/[\s\u0000-\u001f\u007f-\u009f]/.test(text), `${where} must be a clean address`);
  const url = new URL(text);
  assert.ok(protocols.includes(url.protocol) && url.username === '' && url.password === '', `${where} must use ${protocols.join(' or ')}`);
}

/** @param {any} suggestion @param {string} where */
function assertSuggestion(suggestion, where) {
  const fields = SUGGESTION_FIELDS[suggestion.type];
  assert.ok(fields, `${where} has an unknown type: ${suggestion.type}`);
  onlyFields(suggestion, fields, where);
  assert.ok(typeof suggestion.text === 'string' && suggestion.text.trim().length > 0 && suggestion.text.length <= 25, `${where} needs a label of 1 to 25 characters: ${suggestion.text}`);
  if (suggestion.postbackData !== undefined) {
    assert.ok(typeof suggestion.postbackData === 'string' && suggestion.postbackData.length >= 1 && suggestion.postbackData.length <= 2048, `${where} postbackData must be 1 to 2048 characters`);
    assert.ok(!suggestion.postbackData.trim().toLowerCase().startsWith('wf:'), `${where} postbackData cannot start with wf:`);
    assert.ok(!isKeyword(suggestion.postbackData) && suggestion.postbackData.trim().toLowerCase() !== 'yes', `${where} postbackData cannot be a consent or help keyword`);
  }
  if (suggestion.type === 'openUrl') {
    const webview = (suggestion.openIn ?? 'webview') === 'webview';
    assertAddress(suggestion.url, webview ? ['https:'] : ['https:', 'http:'], `${where}.url`);
  }
  if (suggestion.type === 'dial') assert.match(suggestion.phoneNumber, /^\+[1-9]\d{7,14}$/, `${where}.phoneNumber must be E.164`);
  if (suggestion.type === 'viewLocation') {
    const hasPoint = typeof suggestion.latitude === 'number' && typeof suggestion.longitude === 'number';
    assert.ok(hasPoint || Boolean(suggestion.query?.trim()), `${where} needs latitude and longitude, or a query`);
    if (hasPoint) assert.ok(Math.abs(suggestion.latitude) <= 90 && Math.abs(suggestion.longitude) <= 180, `${where} coordinates are out of range`);
    if (suggestion.label !== undefined) assert.ok(suggestion.label.length >= 1 && suggestion.label.length <= 100, `${where}.label must be 1 to 100 characters`);
  }
  if (suggestion.type === 'createCalendarEvent') {
    assert.match(suggestion.startTime, RFC3339, `${where}.startTime must be RFC 3339`);
    assert.match(suggestion.endTime, RFC3339, `${where}.endTime must be RFC 3339`);
    assert.ok(Date.parse(suggestion.endTime) > Date.parse(suggestion.startTime), `${where}.endTime must be after startTime`);
    assert.ok(suggestion.title.length >= 1 && suggestion.title.length <= 100, `${where}.title must be 1 to 100 characters`);
    if (suggestion.description !== undefined) assert.ok(suggestion.description.length <= 500, `${where}.description is too long`);
  }
}

/** @param {any} card @param {string[]} fields @param {string} where */
function assertCard(card, fields, where) {
  onlyFields(card, fields, where);
  assert.ok(card.title?.trim() || card.description?.trim() || card.media, `${where} needs a title, a description, or media`);
  if (card.title !== undefined) assert.ok(card.title.length <= 200, `${where}.title is too long`);
  if (card.description !== undefined) assert.ok(card.description.length <= 500, `${where}.description is too long`);
  if (card.media) {
    onlyFields(card.media, ['url', 'thumbnailUrl', 'height'], `${where}.media`);
    assertAddress(card.media.url, ['https:'], `${where}.media.url`);
    if (card.media.thumbnailUrl !== undefined) assertAddress(card.media.thumbnailUrl, ['https:'], `${where}.media.thumbnailUrl`);
    if (card.media.height !== undefined) assert.ok(['SHORT', 'MEDIUM', 'TALL'].includes(card.media.height), `${where}.media.height is not valid`);
  }
  const buttons = card.suggestions ?? [];
  assert.ok(buttons.length <= 4, `${where} takes up to 4 buttons`);
  buttons.forEach((/** @type {any} */ button, /** @type {number} */ index) => assertSuggestion(button, `${where}.suggestions[${index}]`));
}

/**
 * Fails unless the real API would accept this body for `POST /messages`.
 *
 * @param {any} body
 */
export function assertSendable(body) {
  onlyFields(body, TOP_FIELDS, 'The body');
  onlyFields(body.to ?? {}, ['contactId', 'phoneNumber', 'externalId'], 'to');
  assert.ok(Number.isInteger(body.to?.contactId) || typeof body.to?.phoneNumber === 'string' || typeof body.to?.externalId === 'string', 'to needs a contactId, a phoneNumber, or an externalId');

  const kinds = ['text', 'card', 'carousel', 'file'].filter((field) => body[field] !== undefined);
  assert.equal(kinds.length, 1, `A message is exactly one of text, card, carousel, or file. This one has: ${kinds.join(', ') || 'none'}`);

  if (body.text !== undefined) assert.ok(typeof body.text === 'string' && body.text.length >= 1 && body.text.length <= 2000, 'text must be 1 to 2000 characters');
  if (body.card) {
    assertCard(body.card, ['title', 'description', 'media', 'suggestions', 'orientation', 'thumbnailAlignment'], 'card');
    if (body.card.orientation !== undefined) assert.ok(['VERTICAL', 'HORIZONTAL'].includes(body.card.orientation), 'card.orientation is not valid');
    if (body.card.thumbnailAlignment !== undefined) {
      assert.ok(['LEFT', 'RIGHT'].includes(body.card.thumbnailAlignment), 'card.thumbnailAlignment is not valid');
      assert.equal(body.card.orientation, 'HORIZONTAL', 'thumbnailAlignment is for a HORIZONTAL card');
    }
  }
  if (body.carousel) {
    onlyFields(body.carousel, ['cardWidth', 'cards'], 'carousel');
    if (body.carousel.cardWidth !== undefined) assert.ok(['SMALL', 'MEDIUM'].includes(body.carousel.cardWidth), 'carousel.cardWidth is not valid');
    assert.ok(Array.isArray(body.carousel.cards) && body.carousel.cards.length >= 2 && body.carousel.cards.length <= 10, 'A carousel takes 2 to 10 cards');
    body.carousel.cards.forEach((/** @type {any} */ card, /** @type {number} */ index) => {
      assertCard(card, ['title', 'description', 'media', 'suggestions'], `carousel.cards[${index}]`);
      if (body.carousel.cardWidth === 'SMALL') assert.notEqual(card.media?.height, 'TALL', 'A SMALL carousel takes no TALL media');
    });
  }
  if (body.file) {
    onlyFields(body.file, ['url', 'thumbnailUrl'], 'file');
    assertAddress(body.file.url, ['https:'], 'file.url');
    if (body.file.thumbnailUrl !== undefined) assertAddress(body.file.thumbnailUrl, ['https:'], 'file.thumbnailUrl');
  }

  const suggestions = body.suggestions ?? [];
  assert.ok(Array.isArray(suggestions) && suggestions.length <= 11, 'A message takes up to 11 suggestions');
  suggestions.forEach((/** @type {any} */ suggestion, /** @type {number} */ index) => assertSuggestion(suggestion, `suggestions[${index}]`));

  if (body.class !== undefined) assert.ok(['service', 'transactional', 'promotional'].includes(body.class), 'class is not valid');
  if (body.reference !== undefined) assert.ok(typeof body.reference === 'string' && body.reference.length >= 1 && body.reference.length <= 200, 'reference must be 1 to 200 characters');
  if (body.inReplyTo !== undefined) assert.ok(Number.isInteger(body.inReplyTo) && body.inReplyTo >= 1, 'inReplyTo must be a message id');
  if (body.consent !== undefined) {
    onlyFields(body.consent, ['source', 'capturedAt'], 'consent');
    assert.ok(typeof body.consent.source === 'string' && body.consent.source.length >= 1 && body.consent.source.length <= 200, 'consent.source must be 1 to 200 characters');
  }
  assert.ok(body.expiresAt === undefined || body.ttlSeconds === undefined, 'Send only one of expiresAt and ttlSeconds');
  if (body.ttlSeconds !== undefined) assert.ok(Number.isInteger(body.ttlSeconds) && body.ttlSeconds >= 1, 'ttlSeconds must be a whole number, 1 or more');
  if (body.expiresAt !== undefined) assert.match(body.expiresAt, RFC3339, 'expiresAt must be RFC 3339');
  if (body.trafficType !== undefined) assert.ok(['authentication', 'transaction', 'promotion', 'serviceRequest', 'acknowledgement'].includes(body.trafficType), 'trafficType is not valid');
}
