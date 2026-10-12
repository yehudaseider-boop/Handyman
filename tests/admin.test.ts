import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import request from 'supertest';
import { createApp } from '../server/app.js';

test('explicit administrator rotation revokes sessions and invalidates the old password', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'handyman-admin-'));
  const dbPath = join(directory, 'workspace.sqlite');
  const email = 'rotate@example.test';
  const oldPassword = 'Old-test-password-2026!';
  const newPassword = 'New-test-password-2026!';
  const origin = 'http://127.0.0.1:5173';
  const options = { dbPath, mode: 'demo' as const, adminEmail: email, adminPassword: oldPassword, appOrigin: origin };
  let app = createApp(options);
  try {
    const login = await request(app).post('/api/auth/login').set('Origin', origin).send({ email, password: oldPassword });
    assert.equal(login.status, 200);
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    app.locals.close();
    const reset = spawnSync(process.execPath, ['--import', 'tsx', resolve('server/admin.ts')], {
      env: { ...process.env, DB_PATH: dbPath, ADMIN_EMAIL: email, ADMIN_PASSWORD: newPassword },
      encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(reset.status, 0, reset.stderr);
    assert.ok(!reset.stdout.includes(newPassword));
    app = createApp(options);
    assert.equal((await request(app).get('/api/auth/me').set('Cookie', cookie)).status, 401);
    assert.equal((await request(app).post('/api/auth/login').set('Origin', origin).send({ email, password: oldPassword })).status, 401);
    assert.equal((await request(app).post('/api/auth/login').set('Origin', origin).send({ email, password: newPassword })).status, 200);
    app.locals.close();
    const rejected = spawnSync(process.execPath, ['--import', 'tsx', resolve('server/admin.ts')], {
      env: { ...process.env, DB_PATH: dbPath, ADMIN_EMAIL: email, ADMIN_PASSWORD: 'short' },
      encoding: 'utf8', timeout: 15_000,
    });
    assert.notEqual(rejected.status, 0);
    app = createApp(options);
    assert.equal((await request(app).post('/api/auth/login').set('Origin', origin).send({ email, password: newPassword })).status, 200);
  } finally { app.locals.close(); rmSync(directory, { recursive: true, force: true }); }
});
