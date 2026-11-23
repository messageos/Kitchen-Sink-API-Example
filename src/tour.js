// @ts-check
import { readFileSync } from 'node:fs';

/**
 * The tour: the demos in the order a person walks them. `tour.json` is the one place that lists them, so the
 * menu, the "Next" buttons, and anything outside this app that walks the tour all read the same file.
 *
 * @type {ReadonlyArray<import('./types.js').TourStop>}
 */
export const TOUR = Object.freeze(JSON.parse(readFileSync(new URL('../tour.json', import.meta.url), 'utf8')));

/** @param {string} id */
export function tourStop(id) {
  return TOUR.find((stop) => stop.id === id) ?? null;
}

/**
 * The demo a typed word names, by id or by name in any case, or null.
 *
 * @param {string} words
 */
export function tourStopNamed(words) {
  const wanted = words.trim().toLowerCase();
  return TOUR.find((stop) => stop.id === wanted || stop.name.toLowerCase() === wanted) ?? null;
}
