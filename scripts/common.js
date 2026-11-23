// @ts-check
import { loadEnvFile, readConfig } from '../src/config.js';
import { ApiUnreachable, createClient } from '../src/messageos.js';

/** Prints why a script cannot go on, and stops. @param {string} message @returns {never} */
export function fail(message) {
  console.error(message);
  process.exit(1);
}

/** The settings and an API client for a script. Stops when there is no key. */
export function setup() {
  loadEnvFile();
  const config = readConfig();
  if (!config.apiKey) fail('MESSAGEOS_API_KEY is not set. Copy .env.example to .env and put your key in it.');
  return { config, api: createClient({ apiUrl: config.apiUrl, apiKey: config.apiKey }) };
}

/**
 * Runs a script, and turns a failure into one plain line.
 *
 * @param {() => Promise<void>} main
 */
export function run(main) {
  main().catch((err) => {
    if (err instanceof ApiUnreachable) fail(`${err.message} Check MESSAGEOS_API_URL and your connection.`);
    fail(err instanceof Error ? err.message : String(err));
  });
}

/** One line for an answer that is not 2xx. @param {import('../src/messageos.js').ApiAnswer} answer */
export function describeError(answer) {
  const error = answer.body?.error;
  const parts = [`status ${answer.status}`, error?.code, error?.reason].filter(Boolean).join(', ');
  return `${error?.message ?? 'The request was not accepted.'} (${parts}${answer.requestId ? `, request ${answer.requestId}` : ''})`;
}
