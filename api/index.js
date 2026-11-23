// @ts-check
// For a host that runs functions: the same handler, exported as the function. `vercel.json` sends every path
// here, and the host serves the files in `public/` itself. Such a host can read the request body before it
// calls the handler. `readRawBody` in `src/app.js` still gets the exact bytes, so nothing is turned off here.
export { handler as default } from '../src/app.js';
