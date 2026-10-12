import { DatabaseSync } from 'node:sqlite';
import { randomUUID, scryptSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Conversation, Job, Message, Mode, Intake } from './types.js';

export function passwordHash(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function openDatabase(path: string, mode: Mode, email: string, password: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  // Inspect the existing mode before schema or data migrations modify a checkout.
  const hasMetadata = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'").get();
  const existingMode = hasMetadata ? db.prepare('SELECT value FROM metadata WHERE key = ?').get('mode') : undefined;
  if (existingMode && existingMode.value !== mode) {
    db.close();
    throw new Error('Database mode differs from APP_MODE. Use a separate database path for demo and live data.');
  }
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, customer_name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, preview TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, unread_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', assigned_to TEXT NOT NULL DEFAULT '', automation_paused INTEGER NOT NULL DEFAULT 0, category TEXT NOT NULL DEFAULT 'General');
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), direction TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, provider_id TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS provider_statuses (provider_id TEXT PRIMARY KEY, status TEXT NOT NULL, received_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, title TEXT NOT NULL, customer_name TEXT NOT NULL, phone TEXT NOT NULL, category TEXT NOT NULL, address TEXT NOT NULL, scheduled_at TEXT NOT NULL, status TEXT NOT NULL, notes TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), business_name TEXT NOT NULL, business_hours TEXT NOT NULL, welcome_message TEXT NOT NULL, away_message TEXT NOT NULL, automation_enabled INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS reception_config (kind TEXT PRIMARY KEY CHECK(kind IN ('knowledge','automation')), payload TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS automation_claims (inbound_id TEXT PRIMARY KEY REFERENCES messages(id), conversation_id TEXT NOT NULL REFERENCES conversations(id), status TEXT NOT NULL, reason_code TEXT NOT NULL DEFAULT '', reply TEXT, outbound_id TEXT UNIQUE REFERENCES messages(id), dispatched_at TEXT, knowledge_version INTEGER NOT NULL, policy_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS automation_claims_conversation_idx ON automation_claims(conversation_id,created_at);
    CREATE INDEX IF NOT EXISTS automation_claims_status_idx ON automation_claims(status,created_at);
    CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS messages_conversation_order_idx ON messages(conversation_id, substr(created_at,1,19));
    CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages(created_at);
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  `);
  const automationColumns = new Set(db.prepare('PRAGMA table_info(automation_claims)').all().map(column => String(column.name)));
  if (!automationColumns.has('dispatched_at')) db.exec('ALTER TABLE automation_claims ADD COLUMN dispatched_at TEXT');
  // Additive, idempotent migration preserves previously created user databases.
  const jobColumns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map(column => String(column.name)));
  for (const [name, definition] of [['conversation_id', 'TEXT REFERENCES conversations(id)'], ['assigned_to', "TEXT NOT NULL DEFAULT 'Team'"], ['duration_minutes', 'INTEGER NOT NULL DEFAULT 60'], ['version', 'INTEGER NOT NULL DEFAULT 1']]) {
    if (!jobColumns.has(name!)) db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS jobs_conversation_idx ON jobs(conversation_id);
    CREATE TABLE IF NOT EXISTS intakes (conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), summary TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'General', address TEXT NOT NULL DEFAULT '', preferred_time TEXT NOT NULL DEFAULT '', urgency TEXT NOT NULL DEFAULT 'routine', wants_human INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'template', evidence TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, job_id TEXT UNIQUE REFERENCES jobs(id));`);
  db.prepare('INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)').run('mode', mode);
  db.prepare("UPDATE messages SET status='unconfirmed' WHERE direction='outbound' AND status='pending'").run();
  // Provider sends interrupted by a restart are deliberately never retried.
  db.prepare("UPDATE conversations SET status='waiting',automation_paused=1 WHERE id IN (SELECT conversation_id FROM automation_claims WHERE status='sending')").run();
  db.prepare("UPDATE automation_claims SET status='unconfirmed',reason_code='server_restarted',updated_at=? WHERE status='sending'").run(new Date().toISOString());
  db.prepare("UPDATE automation_claims SET status='skipped',reason_code='server_restarted',updated_at=? WHERE status='queued'").run(new Date().toISOString());
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) db.prepare('INSERT INTO users (id,email,name,password_hash) VALUES (?,?,?,?)').run(randomUUID(), email, 'Workspace admin', passwordHash(password));
  db.prepare('INSERT OR IGNORE INTO settings VALUES (1, ?, ?, ?, ?, ?)').run('Handyman', 'Mon–Fri, 08:00–17:00', 'Thanks for contacting Handyman. Tell us what you need help with and our team will get back to you.', 'Thanks for your message. Our team will reply during business hours.', 0);
  const seeded = db.prepare('SELECT value FROM metadata WHERE key = ?').get('seeded');
  if (mode === 'demo' && !seeded) seedDemo(db);
  return db;
}

function seedDemo(db: DatabaseSync) {
  db.exec('BEGIN');
  try {
    const now = Date.now();
    const customers = [
      ['demo-conv-1', 'Emma Wilson', '+27820000101', 'Plumbing', 'Hi! Our kitchen tap is leaking. Could someone come tomorrow morning?', 'open', 2, 12],
      ['demo-conv-2', 'James Mokoena', '+27820000102', 'Electrical', 'Thanks, 10am on Thursday works for the installation.', 'waiting', 0, 39],
      ['demo-conv-3', 'Olivia Jacobs', '+27820000103', 'Painting', 'Can you send me a quote for repainting two bedrooms?', 'open', 1, 74],
      ['demo-conv-4', 'Daniel Smith', '+27820000104', 'Repairs', 'The door is working perfectly now. Thank you!', 'resolved', 0, 151],
      ['demo-conv-5', 'Aisha Patel', '+27820000105', 'General', 'Are you available for a few small jobs around the house?', 'open', 1, 224],
    ] as const;
    for (const [id, name, phone, category, text, status, unread, minutes] of customers) {
      const timestamp = new Date(now - minutes * 60_000).toISOString();
      db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, name, phone, text, timestamp, unread, status, status === 'waiting' ? 'Alex' : '', 0, category);
      db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(randomUUID(), id, 'inbound', `Hello, is this Handyman? I need help with ${category.toLowerCase()}.`, new Date(now - (minutes + 25) * 60_000).toISOString(), 'received', null);
      db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(randomUUID(), id, 'outbound', 'Hi! You’re in the right place. Tell us a little more about the job and we’ll help you get it sorted.', new Date(now - (minutes + 20) * 60_000).toISOString(), 'sent', null);
      db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(randomUUID(), id, 'inbound', text, timestamp, 'received', null);
    }
    const jobs = [
      ['Fix leaking kitchen tap', 'Emma Wilson', '+27820000101', 'Plumbing', '14 Oak Lane, Johannesburg', 'scheduled', 'Check washer and cartridge; customer prefers morning.'],
      ['Install pendant lights', 'James Mokoena', '+27820000102', 'Electrical', '27 Willow Road, Sandton', 'scheduled', 'Two pendant lights supplied by customer.'],
      ['Bedroom painting quote', 'Olivia Jacobs', '+27820000103', 'Painting', '8 Garden Street, Rosebank', 'new', 'Two bedrooms; confirm wall condition and colour.'],
      ['Repair sticking front door', 'Daniel Smith', '+27820000104', 'Repairs', '42 Park Avenue, Randburg', 'completed', 'Door alignment completed and checked with customer.'],
    ];
    jobs.forEach((job, index) => {
      const created = new Date(now - 86_400_000).toISOString();
      const [title, name, phone, category, address, status, notes] = job;
      db.prepare('INSERT INTO jobs (id,title,customer_name,phone,category,address,scheduled_at,status,notes,created_at,updated_at,conversation_id,assigned_to,duration_minutes,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(`demo-job-${index + 1}`, title!, name!, phone!, category!, address!, new Date(now + (index + 1) * 86_400_000).toISOString(), status!, notes!, created, created, `demo-conv-${index + 1}`, 'Team', 60, 1);
    });
    audit(db, 'workspace.created', 'Demo workspace prepared with fictional customer data.');
    db.prepare('INSERT INTO metadata VALUES (?, ?)').run('seeded', '1');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function audit(db: DatabaseSync, action: string, detail: string) {
  db.prepare('INSERT INTO activity VALUES (?,?,?,?)').run(randomUUID(), action, detail, new Date().toISOString());
}

export function conversation(row: Record<string, unknown>): Conversation {
  return { id: String(row.id), customerName: String(row.customer_name), phone: String(row.phone), preview: String(row.preview), updatedAt: String(row.updated_at), unreadCount: Number(row.unread_count), status: String(row.status), assignedTo: String(row.assigned_to), automationPaused: Boolean(row.automation_paused), category: String(row.category) };
}

export function message(row: Record<string, unknown>): Message {
  return { id: String(row.id), conversationId: String(row.conversation_id), direction: row.direction as Message['direction'], text: String(row.text), createdAt: String(row.created_at), status: String(row.status), providerId: row.provider_id ? String(row.provider_id) : null };
}

export function job(row: Record<string, unknown>): Job {
  return { conversationId: row.conversation_id ? String(row.conversation_id) : null, assignedTo: String(row.assigned_to), durationMinutes: Number(row.duration_minutes), version: Number(row.version), id: String(row.id), title: String(row.title), customerName: String(row.customer_name), phone: String(row.phone), category: String(row.category), address: String(row.address), scheduledAt: String(row.scheduled_at), status: String(row.status), notes: String(row.notes), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

export function intake(row: Record<string, unknown>): Intake {
  const summary = String(row.summary), address = String(row.address), preferredTime = String(row.preferred_time);
  const missingFields = Object.entries({summary, address, preferredTime}).filter(([, value]) => !value.trim()).map(([field]) => field);
  return {conversationId: String(row.conversation_id), summary, category: String(row.category), address, preferredTime, urgency: row.urgency as Intake['urgency'], wantsHuman: Boolean(row.wants_human), source: row.source as Intake['source'], evidence: JSON.parse(String(row.evidence)), version: Number(row.version), updatedAt: String(row.updated_at), jobId: row.job_id ? String(row.job_id) : null, missingFields, status: row.job_id ? 'converted' : missingFields.length ? 'collecting' : 'ready'};
}
