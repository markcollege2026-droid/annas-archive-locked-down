/**
 * Process entry point: starts the gateway on CONFIG.HOST/PORT.
 *
 * The server binds 0.0.0.0 by default so it works in containers, on PaaS hosts
 * and behind a platform reverse proxy / preview URL.
 */

import { CONFIG } from './config.js';
import { createApp } from './server.js';

let app;
try {
  app = createApp(CONFIG);
} catch (error) {
  console.error(`refusing to start: ${error.message}`);
  process.exit(1);
}
const port = Number(process.env.PORT) || CONFIG.PORT;

const server = app.listen(port, CONFIG.HOST, () => {
  const target = new URL(CONFIG.TARGET_ORIGIN);
  console.log(`gateway listening on http://${CONFIG.HOST}:${port}`);
  console.log(`target: ${target.origin}`);
  console.log(`required sequence: ${CONFIG.ACCESS_SEQUENCE.length} characters, max span ${CONFIG.MAX_SEQUENCE_SPAN}`);
  console.log(`case sensitive: ${CONFIG.CASE_SENSITIVE}`);
  console.log(`link rewriting: ${CONFIG.REWRITE_LINKS}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

export { app };
