// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isKeyword } from '../src/keywords.js';
import { TOUR } from '../src/tour.js';

// tour.json is read by this app and by anything outside it that walks the tour, so its shape is pinned here.
const tour = JSON.parse(readFileSync(new URL('../tour.json', import.meta.url), 'utf8'));

test('tour.json lists the ten demos in tour order', () => {
  assert.deepEqual(tour, [
    { id: 'text', name: 'Text', button: 'Show text', next: 'replies' },
    { id: 'replies', name: 'Replies', button: 'Show replies', next: 'actions' },
    { id: 'actions', name: 'Actions', button: 'Show actions', next: 'card' },
    { id: 'card', name: 'Card', button: 'Show a card', next: 'carousel' },
    { id: 'carousel', name: 'Carousel', button: 'Show a carousel', next: 'files' },
    { id: 'files', name: 'Files', button: 'Show files', next: 'location' },
    { id: 'location', name: 'Location', button: 'Show location', next: 'typing' },
    { id: 'typing', name: 'Typing', button: 'Show typing', next: 'expiry' },
    { id: 'expiry', name: 'Expiry', button: 'Show expiry', next: 'device' },
    { id: 'device', name: 'Device check', button: 'Show device check', next: 'menu' },
  ]);
  assert.deepEqual(TOUR, tour);
});

test('every stop has exactly id, name, button, and next, and each next is the stop after it', () => {
  tour.forEach((/** @type {Record<string, string>} */ stop, /** @type {number} */ index) => {
    assert.deepEqual(Object.keys(stop), ['id', 'name', 'button', 'next']);
    assert.equal(stop.next, tour[index + 1]?.id ?? 'menu');
  });
});

test('every button names its demo, differs from the others, fits 25 characters, and is not a keyword', () => {
  const buttons = tour.map((/** @type {{ button: string }} */ stop) => stop.button);
  assert.equal(new Set(buttons.map((/** @type {string} */ button) => button.toLowerCase())).size, buttons.length);
  for (const stop of tour) {
    assert.ok(stop.button.length <= 25, stop.button);
    assert.ok(`Next: ${stop.name}`.length <= 25, stop.name);
    assert.ok(!isKeyword(stop.button) && !isKeyword(stop.name), stop.button);
  }
});
