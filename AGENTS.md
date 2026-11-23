# Rules for a coding assistant working in this example

This is a public example of answering people through the MessageOS API. Keep it small enough to read in one sitting.

1. Plain JavaScript, ES modules, `// @ts-check` with JSDoc types. No build step and no runtime dependencies: only `node:` modules and the built-in `fetch`.
2. Run `npm run typecheck` and `npm test` before you finish. Tests use no network: they post signed events at the real handler and read the calls it makes to the stand-in API in `test-support/harness.js`.
3. The receiver in `src/app.js` keeps its order: raw body, signature in constant time, timestamp within 300 seconds, duplicate check, work, then 2xx. Never parse the body before the signature is checked. Read the body with `data` and `end` listeners, not a loop over the request, because a host that runs functions hands a body it already read back through those events only.
4. Every answer to a person is `POST /messages` with `inReplyTo` and the header `Idempotency-Key: ks-reply-<inboundMessageId>-<n>`. Build the key from the person's message, never from the event id: each webhook endpoint gets its own copy of an event with its own id, so two endpoints would answer twice. An answer is at most three messages.
5. A message body must come out the same every time for one message. Nothing from the clock, a random value, or the event's `id` or `createdAt` goes into a body, or the same message handled again is refused as a reused key.
6. Never answer STOP, START, HELP, or another word in `src/keywords.js`. MessageOS answers them.
7. Decide what a message is from what arrived, in this order: a keyword, `attachments` that are not empty, a `location`, a tap (`kind` is `chip`), then typed words. Never from `kind` alone: a photo with a caption and a place with words both have kind `text`.
8. Buttons route by `postbackData` that starts with `ks:`, never by label. That value comes back from a phone, so look it up in a `Map`, never in a plain object, which also answers to names such as `constructor`. A tap on an action (`ks:action:`) gets no answer, and a tap with any other value the app does not have gets the menu. A label is 25 characters or fewer and is never a keyword.
9. In a carousel, each card's button names that card's item and differs from every other card's button.
10. Buttons go on the last message of an answer. They show only under the newest message.
11. Every answer's last message ends with the `Menu` button, so a person always has something to tap. The menu itself is the one exception. Build the rest with `withNav` in `src/content.js`, which writes the same directions as words where buttons are off. The test that walks every route fails without it.
12. `tour.json` is the one list of demos. Add a demo there, in `src/content.js`, and in `src/conversation.js`, and keep the shape `{ id, name, button, next }`.
13. Read `GET /whoami` before using a feature. Where `richMessages`, `rcsExtras`, or `replyWindowSeconds` is off, say so in one plain line and do not fail.
14. Never log or print the API key, the webhook secret, or what a person wrote. The one exception is `npm run setup:webhook`, which prints a new secret once.
15. A new message body needs a test that passes it through `assertSendable` in `test-support/api-rules.js`, the request rules of the real API written out by hand.
16. Media in `public/media/` stays small: pictures under 300 KB with no words in them, video under 2 MB.
17. Prose in this folder uses plain words and no em or en dashes.
