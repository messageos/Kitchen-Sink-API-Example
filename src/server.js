// @ts-check
import { createServer } from 'node:http';
import { handler } from './app.js';
import { loadEnvFile, readConfig, settingsPresent, WEBHOOK_PATH } from './config.js';
import { log } from './log.js';

// Runs the app as an ordinary server: `npm start`, or `npm run dev` to restart on every change.
loadEnvFile();
const config = readConfig();

createServer(handler).listen(config.port, () => {
  log('info', 'kitchen sink listening', { port: config.port, webhookPath: WEBHOOK_PATH, apiUrl: config.apiUrl, settings: settingsPresent(config) });
});
