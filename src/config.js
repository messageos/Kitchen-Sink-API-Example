// @ts-check

/**
 * @typedef {object} Config
 * @property {string} apiUrl The MessageOS API address, with no slash at the end.
 * @property {string} apiKey Your client key. Never log it.
 * @property {string} webhookSecret The signing secret of your webhook. Never log it.
 * @property {string} publicUrl This app's own public https address, with no slash at the end.
 * @property {number} port
 */

const DEFAULT_API_URL = 'https://api.messageos.ai/v1';

/** @param {string | undefined} value */
function clean(value) {
  return (value ?? '').trim().replace(/\/+$/, '');
}

/**
 * Reads the settings from the environment. See `.env.example` for what each one is.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Config}
 */
export function readConfig(env = process.env) {
  return {
    apiUrl: clean(env.MESSAGEOS_API_URL) || DEFAULT_API_URL,
    apiKey: (env.MESSAGEOS_API_KEY ?? '').trim(),
    webhookSecret: (env.MESSAGEOS_WEBHOOK_SECRET ?? '').trim(),
    publicUrl: clean(env.PUBLIC_URL),
    port: Number(env.PORT) || 3000,
  };
}

/**
 * Which settings are present, as true or false. Safe to show: it never holds a value.
 *
 * @param {Config} config
 */
export function settingsPresent(config) {
  return {
    apiUrl: config.apiUrl !== '',
    apiKey: config.apiKey !== '',
    webhookSecret: config.webhookSecret !== '',
    publicUrl: config.publicUrl.startsWith('https://'),
  };
}

/**
 * Loads a local `.env` file into the environment when there is one. The server and the scripts call it. A host
 * that sets the environment itself needs no file.
 */
export function loadEnvFile() {
  try {
    process.loadEnvFile?.('.env');
  } catch {
    // No .env file here. The settings come from the environment.
  }
}

/** The address MessageOS posts events to. */
export const WEBHOOK_PATH = '/webhooks/messageos';

/** The events this app listens for. `npm run setup:webhook` registers exactly these. */
export const WEBHOOK_EVENTS = [
  'reply.received',
  'message.delivered',
  'message.read',
  'message.failed',
  'contact.opted_out',
  'contact.opted_in',
];
