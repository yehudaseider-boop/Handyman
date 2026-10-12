import { resolve } from 'node:path';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
const app = createApp({ serveDir: resolve('dist') });
const server = app.listen(port, process.env.HOST ?? '127.0.0.1', (error?: Error) => {
  if (error) {
    console.error('Unable to start Handyman:', (error as NodeJS.ErrnoException).code ?? error.name);
    app.locals.close();
    process.exit(1);
  }
  console.log(`Handyman is listening on port ${port} (${process.env.APP_MODE === 'live' ? 'live' : 'demo'} mode).`);
});
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (closing) return;
  closing = true;
  server.close(() => { app.locals.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
});
