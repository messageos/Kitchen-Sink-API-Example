// @ts-check
// The shapes this app reads and writes, as JSDoc types. There is no code in this file.

/**
 * One button under a message or on a card. `text` is the label, 25 characters or fewer. `postbackData` is your own
 * value: it comes back in `reply.received` when the person taps the button.
 *
 * @typedef {{ type: 'reply', text: string, postbackData?: string }} ReplySuggestion
 * @typedef {{ type: 'openUrl', text: string, url: string, openIn?: 'webview' | 'browser', webviewViewMode?: 'FULL' | 'HALF' | 'TALL', postbackData?: string }} OpenUrlSuggestion
 * @typedef {{ type: 'dial', text: string, phoneNumber: string, postbackData?: string }} DialSuggestion
 * @typedef {{ type: 'viewLocation', text: string, latitude?: number, longitude?: number, query?: string, label?: string, postbackData?: string }} ViewLocationSuggestion
 * @typedef {{ type: 'shareLocation', text: string, postbackData?: string }} ShareLocationSuggestion
 * @typedef {{ type: 'createCalendarEvent', text: string, title: string, description?: string, startTime: string, endTime: string, postbackData?: string }} CalendarSuggestion
 * @typedef {ReplySuggestion | OpenUrlSuggestion | DialSuggestion | ViewLocationSuggestion | ShareLocationSuggestion | CalendarSuggestion} Suggestion
 */

/**
 * @typedef {{ url: string, thumbnailUrl?: string, height?: 'SHORT' | 'MEDIUM' | 'TALL' }} CardMedia
 * @typedef {{ title?: string, description?: string, media?: CardMedia, suggestions?: Suggestion[] }} CarouselCard
 * @typedef {CarouselCard & { orientation?: 'VERTICAL' | 'HORIZONTAL', thumbnailAlignment?: 'LEFT' | 'RIGHT' }} Card
 * @typedef {{ cardWidth?: 'SMALL' | 'MEDIUM', cards: CarouselCard[] }} Carousel
 * @typedef {{ url: string, thumbnailUrl?: string }} FileContent
 */

/**
 * What one message carries: exactly one of `text`, `card`, `carousel`, or `file`, with optional buttons under it.
 * The sender adds `to`, `inReplyTo`, and `reference` before it posts the body to `POST /messages`.
 *
 * @typedef {object} MessageContent
 * @property {string} [text]
 * @property {Card} [card]
 * @property {Carousel} [carousel]
 * @property {FileContent} [file]
 * @property {Suggestion[]} [suggestions]
 * @property {number} [ttlSeconds]
 * @property {'authentication' | 'transaction' | 'promotion' | 'serviceRequest' | 'acknowledgement'} [trafficType]
 */

/**
 * The `data` of a `reply.received` event.
 *
 * @typedef {object} ReplyData
 * @property {number} inboundMessageId The id of the person's message. A send that names it in `inReplyTo` is a reply.
 * @property {number} contactId
 * @property {string | null} externalId
 * @property {string} phoneNumber
 * @property {number} [conversationId]
 * @property {string} text What the person typed, the label of the button they tapped, or the words they sent with a
 *   file or a place. Empty when there were no words.
 * @property {string} receivedAt
 * @property {'text' | 'chip' | 'file' | 'location'} kind `chip` for a tap. Otherwise `text` when there are words,
 *   `file` when there are none and a file came, and `location` when there are none and a place came. A photo with a
 *   caption has kind `text`, so read `attachments` and `location` themselves to know what arrived.
 * @property {string | null} postbackData Your own value for the button they tapped, or null.
 * @property {Array<{ url: string, mediaType: string, kind: string, fileName: string | null }>} attachments The files
 *   the person sent, with or without words. Empty when there are none.
 * @property {{ latitude: number, longitude: number, label: string | null } | null} location The place the person
 *   shared, with or without words, or null.
 */

/**
 * Every event has this envelope. `data` depends on `type`.
 *
 * @typedef {object} WebhookEvent
 * @property {string} id
 * @property {string} type
 * @property {string} createdAt
 * @property {string} clientId
 * @property {Record<string, any>} data
 */

/**
 * What this key can use on this API address, read from `GET /whoami`.
 *
 * @typedef {object} Features
 * @property {boolean} rich Buttons, cards, carousels, and files (`richMessages`).
 * @property {boolean} extras Typing, the capability check, expiry, and traffic type (`rcsExtras`).
 * @property {boolean} replies Whether `inReplyTo` is accepted (`replyWindowSeconds` is a number).
 */

/**
 * One stop of the tour, as `tour.json` lists it.
 *
 * @typedef {{ id: string, name: string, button: string, next: string }} TourStop
 */

/**
 * One line of structured log output.
 *
 * @typedef {(level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void} Log
 */

export {};
