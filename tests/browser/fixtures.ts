import { test as base, expect } from '@playwright/test';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createApp } from '../../server/app.js';

// Each browser scenario has fresh data and rate-limit buckets. Production
// protection stays enabled, and credentials from a developer's shell are excluded.
export const test = base.extend<{ workspace: void }>({
  workspace: [async ({}, use) => {
    const app = createApp({
      mode: 'demo', dbPath: ':memory:', appOrigin: 'http://127.0.0.1:4179',
      adminEmail: 'admin@handyman.local', adminPassword: 'DemoPass!2026',
      secureCookies: false, serveDir: resolve('dist'),
      whatsappToken: '', whatsappPhoneId: '', whatsappAppSecret: '', whatsappVerifyToken: '', aiApiKey: '',
    });
    const server = app.listen(4179, '127.0.0.1');
    await once(server, 'listening');
    try { await use(); }
    finally {
      await new Promise<void>(resolveClose => {
        server.close(() => { app.locals.close(); resolveClose(); });
        server.closeAllConnections();
      });
    }
  }, { auto: true }],
});
export { expect };
