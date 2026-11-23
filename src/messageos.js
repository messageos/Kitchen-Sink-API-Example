// @ts-check

/**
 * @typedef {object} ApiAnswer
 * @property {number} status The HTTP status.
 * @property {boolean} ok True for a 2xx status.
 * @property {any} body The JSON body, or null when there was none.
 * @property {boolean} replayed True when this is the stored answer for an Idempotency-Key that was used before.
 * @property {string | null} requestId The `X-Request-Id` header, to quote when you ask MessageOS about a request.
 */

/** The API could not be reached at all: no connection, or no answer in time. The request is safe to make again. */
export class ApiUnreachable extends Error {
  /** @param {string} path @param {unknown} cause */
  constructor(path, cause) {
    super(`The MessageOS API did not answer ${path}.`, { cause });
    this.name = 'ApiUnreachable';
  }
}

/**
 * A small client for the MessageOS API. Every call sends the key as `Authorization: Bearer mosc_...`.
 *
 * @param {object} options
 * @param {string} options.apiUrl For example `https://api.messageos.ai/v1`.
 * @param {string} options.apiKey
 * @param {typeof fetch} [options.fetch]
 * @param {number} [options.timeoutMs]
 */
export function createClient({ apiUrl, apiKey, fetch = globalThis.fetch, timeoutMs = 8000 }) {
  /**
   * @param {'GET' | 'POST' | 'PATCH' | 'DELETE'} method
   * @param {string} path
   * @param {{ body?: unknown, idempotencyKey?: string }} [options]
   * @returns {Promise<ApiAnswer>}
   */
  async function request(method, path, { body, idempotencyKey } = {}) {
    /** @type {Record<string, string>} */
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    let response;
    let text;
    try {
      response = await fetch(`${apiUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (cause) {
      throw new ApiUnreachable(`${method} ${path.split('?')[0]}`, cause);
    }

    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON. The status still says what happened.
    }
    return {
      status: response.status,
      ok: response.ok,
      body: json,
      replayed: response.headers.get('idempotent-replay') === 'true',
      requestId: response.headers.get('x-request-id'),
    };
  }

  return {
    request,

    /** Who this key is, and what this API address has turned on. */
    whoami: () => request('GET', '/whoami'),

    /**
     * Sends one message. The key makes the send safe to repeat: the same key with the same body returns the
     * stored answer and sends nothing a second time.
     *
     * @param {Record<string, unknown>} body
     * @param {string} idempotencyKey 8 to 128 characters.
     */
    sendMessage: (body, idempotencyKey) => request('POST', '/messages', { body, idempotencyKey }),

    /** Shows the typing indicator to a contact. @param {{ contactId: number }} to */
    typing: (to) => request('POST', '/typing', { body: { to } }),

    /** Asks what one phone supports. @param {string} phoneNumber In E.164, such as +15555550123. */
    capabilities: (phoneNumber) => request('GET', `/capabilities?phoneNumber=${encodeURIComponent(phoneNumber)}`),

    listWebhooks: () => request('GET', '/webhooks'),

    /** @param {string} url @param {string[]} eventTypes */
    createWebhook: (url, eventTypes) => request('POST', '/webhooks', { body: { url, eventTypes } }),
  };
}

/** @typedef {ReturnType<typeof createClient>} Client */

/**
 * The three things this app adapts to, read from a `GET /whoami` answer.
 *
 * @param {any} whoami
 * @returns {import('./types.js').Features}
 */
export function featuresFrom(whoami) {
  return {
    rich: whoami?.richMessages === true,
    extras: whoami?.rcsExtras === true,
    replies: typeof whoami?.replyWindowSeconds === 'number',
  };
}
