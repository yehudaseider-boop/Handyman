import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { passwordHash } from './db.js';

// Explicit reset avoids silently changing administrator credentials during server restarts.
const path = process.env.DB_PATH ?? process.env.DATABASE_PATH;
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
if (!path || !existsSync(path)) throw new Error('DB_PATH must identify an existing workspace database.');
if (!email || !password || password.length < 16 || password.length > 256 || password === 'DemoPass!2026') {
  throw new Error('Set ADMIN_EMAIL and a unique ADMIN_PASSWORD of 16–256 characters using your secret manager.');
}
const db = new DatabaseSync(path);
try {
  const user = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (!user) throw new Error('No existing administrator matches ADMIN_EMAIL.');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash(password), String(user.id));
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(String(user.id));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  console.log('Administrator password reset. Existing sessions were revoked.');
} finally { db.close(); }
