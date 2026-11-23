// @ts-check

/**
 * Writes one JSON line. Pass facts as fields, never the API key, the webhook secret, or what a person wrote.
 *
 * @type {import('./types.js').Log}
 */
export function log(level, message, fields = {}) {
  const line = JSON.stringify({ level, time: new Date().toISOString(), message, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}
