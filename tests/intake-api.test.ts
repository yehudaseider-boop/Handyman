import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { openDatabase, passwordHash } from '../server/db.js';
import type { AppOptions, Intake, Job } from '../server/types.js';

const origin = 'http://localhost:5173';
const credentials = { email: 'intake-owner@example.test', password: 'Test-only-password-942!' };
type App = ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;

async function fixture(run: (app: App, options: AppOptions) => Promise<void>, overrides: AppOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'handyman-intake-'));
  const options: AppOptions = { dbPath: join(directory, 'workspace.sqlite'), mode: 'demo', adminEmail: credentials.email, adminPassword: credentials.password, appOrigin: origin, secureCookies: false, whatsappToken:'',whatsappPhoneId:'',whatsappAppSecret:'',whatsappVerifyToken:'',aiApiKey:'',allowLiveAutomation:false,...overrides };
  let app: App | undefined;
  try { app = createApp(options); await run(app, options); }
  finally { app?.locals.close(); await rm(directory, { recursive: true, force: true }); }
}

async function authenticated(app: App) {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/login').set('Origin', origin).send(credentials);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return agent;
}

function freshConversation(app: App) {
  const id = randomUUID();
  app.locals.db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, 'Intake customer', `+2782${Math.floor(Math.random() * 10_000_000).toString().padStart(7, '0')}`, '', new Date().toISOString(), 0, 'open', '', 0, 'General');
  return id;
}

async function intake(agent: Agent, id: string): Promise<Intake> {
  const result = await agent.get(`/api/conversations/${id}/intake`);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.intake;
}

async function inbound(agent: Agent, id: string, text: string) {
  const result = await agent.post('/api/demo/inbound').set('Origin', origin).send({ conversationId: id, text });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.message;
}

async function analyze(agent: Agent, id: string, expectedVersion = 0): Promise<Intake> {
  const result = await agent.post(`/api/conversations/${id}/intake/analyze`).set('Origin', origin).send({ expectedVersion });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.intake;
}

test('local intake collects multiple customer replies with grounded evidence and excludes operator messages', async () => {
  await fixture(async app => {
    const agent = await authenticated(app);
    const id = freshConversation(app);
    assert.equal((await agent.get(`/api/conversations/${id}/intake`)).body.intake, null);
    const problem = await inbound(agent, id, 'My kitchen tap is leaking.');
    const first = await analyze(agent, id);
    assert.equal(first.summary, problem.text);
    assert.equal(first.category, 'Plumbing');
    assert.equal(first.status, 'collecting');
    assert.deepEqual(first.missingFields.sort(), ['address', 'preferredTime']);
    const details = await inbound(agent, id, 'I am at 14 Oak Road. Tomorrow morning please.');
    const outgoing = await agent.post(`/api/conversations/${id}/messages`).set('Origin', origin).send({ text: 'Unconfirmed suggestion: 99 Invented Street on Friday afternoon.' });
    assert.equal(outgoing.status, 201);
    const ready = await analyze(agent, id, first.version);
    assert.equal(ready.summary, problem.text, 'A follow-up address must retain the original job description');
    assert.equal(ready.address, '14 Oak Road');
    assert.equal(ready.preferredTime, 'Tomorrow morning');
    assert.equal(ready.source, 'template');
    assert.equal(ready.status, 'ready');
    assert.deepEqual(ready.missingFields, []);
    assert.equal(ready.jobId, null);
    assert.equal(ready.version, first.version + 1);
    const inboundMessages = new Map([[problem.id, problem.text], [details.id, details.text]]);
    for (const evidence of ready.evidence) {
      assert.ok(inboundMessages.get(evidence.messageId)?.includes(evidence.quote), JSON.stringify(evidence));
    }
    for (const field of ['summary', 'address', 'preferredTime'] as const) {
      assert.ok(ready.evidence.some(evidence => evidence.field === field && evidence.quote === ready[field]), field);
    }
    assert.equal((await agent.get('/api/jobs')).body.jobs.filter((job: Job) => job.conversationId === id).length, 0, 'Analysis must never silently book a job');
  });
});

test('manual intake review uses optimistic versions and removes unsupported extraction evidence', async () => {
  await fixture(async app => {
    const agent = await authenticated(app);
    const id = freshConversation(app);
    await inbound(agent, id, 'My kitchen tap is leaking. I am at 14 Oak Road. Tomorrow morning please.');
    const extracted = await analyze(agent, id);
    const reviewed = await agent.patch(`/api/conversations/${id}/intake`).set('Origin', origin).send({ expectedVersion: extracted.version, address: '24 Reviewed Road', preferredTime: 'Customer called: Tuesday afternoon' });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    assert.equal(reviewed.body.intake.version, extracted.version + 1);
    assert.equal(reviewed.body.intake.source, 'manual');
    assert.ok(!reviewed.body.intake.evidence.some((entry: { field: string }) => ['address', 'preferredTime'].includes(entry.field)), 'Manual corrections must not retain quotes asserting different values');
    const stale = await agent.patch(`/api/conversations/${id}/intake`).set('Origin', origin).send({ expectedVersion: extracted.version, address: 'Accidental stale overwrite' });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.deepEqual(await intake(agent, id), reviewed.body.intake);
  });
});

test('hazardous requests and requests for a person pause assistance and route the conversation to human review', async () => {
  await fixture(async app => {
    const agent = await authenticated(app);
    for (const [text, expectedUrgency, expectedHuman] of [
      ['There are sparks from exposed wiring.', 'urgent', false],
      ['Please speak to a human about my kitchen tap.', 'routine', true],
    ] as const) {
      const id = freshConversation(app);
      await inbound(agent, id, text);
      const analyzed = await analyze(agent, id);
      assert.equal(analyzed.urgency, expectedUrgency);
      assert.equal(analyzed.wantsHuman, expectedHuman);
      const detail = await agent.get(`/api/conversations/${id}`);
      assert.equal(detail.body.conversation.status, 'waiting');
      assert.equal(detail.body.conversation.automationPaused, true);
      assert.equal(detail.body.suggestion, null);
      const draft = await agent.post(`/api/conversations/${id}/draft`).set('Origin', origin).send({});
      assert.equal(draft.status, 409, 'A paused conversation must not offer a normal AI reply draft');
    }
  });
});

test('incomplete intake blocks conversion and reviewed intake creates exactly one linked draft job across restarts', async () => {
  await fixture(async (app, options) => {
    const agent = await authenticated(app);
    const id = freshConversation(app);
    const noIntake = await agent.post(`/api/conversations/${id}/intake/job`).set('Origin', origin).send({ expectedVersion: 1 });
    assert.equal(noIntake.status, 409);
    await inbound(agent, id, 'My kitchen tap is leaking.');
    const partial = await analyze(agent, id);
    const incomplete = await agent.post(`/api/conversations/${id}/intake/job`).set('Origin', origin).send({ expectedVersion: partial.version });
    assert.equal(incomplete.status, 409);
    assert.equal(incomplete.body.error.code, 'intake_incomplete');
    assert.equal((await agent.get('/api/jobs')).body.jobs.filter((job: Job) => job.conversationId === id).length, 0);
    const review = await agent.patch(`/api/conversations/${id}/intake`).set('Origin', origin).send({ expectedVersion: partial.version, address: '14 Oak Road', preferredTime: 'Tomorrow morning' });
    assert.equal(review.status, 200);
    const version = review.body.intake.version;
    const created = await agent.post(`/api/conversations/${id}/intake/job`).set('Origin', origin).send({ expectedVersion: version });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const linked: Job = created.body.job;
    assert.equal(linked.conversationId, id);
    assert.equal(linked.status, 'new');
    assert.equal(linked.scheduledAt, '', 'A preferred time must not become a confirmed appointment');
    assert.equal(linked.address, '14 Oak Road');
    assert.match(linked.notes, /Tomorrow morning/);
    assert.equal(created.body.intake.status, 'converted');
    assert.equal(created.body.intake.jobId, linked.id);
    const repeated = await agent.post(`/api/conversations/${id}/intake/job`).set('Origin', origin).send({ expectedVersion: version });
    assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
    assert.equal(repeated.body.job.id, linked.id);
    assert.equal((await agent.get('/api/jobs')).body.jobs.filter((job: Job) => job.conversationId === id).length, 1);
    const locked = await agent.patch(`/api/conversations/${id}/intake`).set('Origin', origin).send({ expectedVersion: created.body.intake.version, address: 'Unexpected overwrite' });
    assert.equal(locked.status, 409);
    const reanalysis = await agent.post(`/api/conversations/${id}/intake/analyze`).set('Origin', origin).send({});
    assert.equal(reanalysis.status, 200);
    assert.deepEqual(reanalysis.body.intake, created.body.intake);
    app.locals.close();
    const reopened = createApp(options);
    try {
      const reopenedAgent = await authenticated(reopened);
      assert.deepEqual(await intake(reopenedAgent, id), created.body.intake);
      const persisted = await reopenedAgent.get(`/api/jobs/${linked.id}`);
      assert.equal(persisted.status, 200);
      assert.deepEqual(persisted.body.job, linked);
    } finally { reopened.locals.close(); }
  });
});

test('intake routes require a session, exact browser origin and strictly typed bounded inputs', async () => {
  await fixture(async app => {
    const id = freshConversation(app);
    const path = `/api/conversations/${id}/intake`;
    assert.equal((await request(app).get(path)).status, 401);
    for (const [method, url, body] of [
      ['post', `${path}/analyze`, {}], ['patch', path, { expectedVersion: 0, summary: 'Tap' }], ['post', `${path}/job`, { expectedVersion: 1 }],
    ] as const) {
      assert.equal((await request(app)[method](url).set('Origin', origin).send(body)).status, 401);
      const agent = await authenticated(app);
      assert.equal((await agent[method](url).send(body)).status, 403);
      assert.equal((await agent[method](url).set('Origin', `${origin}.attacker.example`).send(body)).status, 403);
    }
    const agent = await authenticated(app);
    for (const patch of [{ summary: 12 }, { address: {} }, { preferredTime: true }, { urgency: 'critical' }, { category: '' }, { source: 'ai' }, { evidence: [] }, { jobId: 'forged' }, { expectedVersion: '0', summary: 'Tap' }, { summary: 'x'.repeat(2001) }]) {
      const result = await agent.patch(path).set('Origin', origin).send({ expectedVersion: 0, ...patch });
      assert.equal(result.status, 400, `${JSON.stringify(patch)}: ${JSON.stringify(result.body)}`);
    }
    for (const payload of [{ useAi: 'yes' }, { expectedVersion: -1 }, { model: 'untrusted-model' }]) {
      assert.equal((await agent.post(`${path}/analyze`).set('Origin', origin).send(payload)).status, 400);
    }
    assert.equal((await agent.get(path)).body.intake, null, 'Rejected requests must not create an intake');
    assert.equal((await agent.get('/api/conversations/missing/intake')).status, 404);
    assert.equal((await agent.post('/api/conversations/missing/intake/analyze').set('Origin', origin).send({})).status, 404);
  });
});

test('an AI completion cannot overwrite intake manually reviewed while the provider was responding', { timeout: 5000 }, async () => {
  let entered!: () => void;
  const providerEntered = new Promise<void>(resolve => { entered = resolve; });
  let release!: (response: Response) => void;
  const providerResponse = new Promise<Response>(resolve => { release = resolve; });
  const fetchImpl: typeof fetch = async () => { entered(); return providerResponse; };
  await fixture(async app => {
    const agent = await authenticated(app);
    const id = freshConversation(app);
    const message = await inbound(agent, id, 'My kitchen tap is leaking. I am at 14 Oak Road. Tomorrow morning please.');
    const initial = await analyze(agent, id);
    const pending = agent.post(`/api/conversations/${id}/intake/analyze`).set('Origin', origin).send({ useAi: true, expectedVersion: initial.version }).then(response => response);
    await providerEntered;
    const manual = await agent.patch(`/api/conversations/${id}/intake`).set('Origin', origin).send({ expectedVersion: initial.version, address: '23 Verified Road', preferredTime: 'Confirmed customer preference: Friday afternoon' });
    assert.equal(manual.status, 200);
    const candidate = { summary: 'My kitchen tap is leaking.', category: 'Plumbing', address: '14 Oak Road', preferredTime: 'Tomorrow morning', urgency: 'routine', wantsHuman: false, evidence: [
      { field: 'summary', messageId: message.id, quote: 'My kitchen tap is leaking.' },
      { field: 'category', messageId: message.id, quote: 'tap' },
      { field: 'address', messageId: message.id, quote: '14 Oak Road' },
      { field: 'preferredTime', messageId: message.id, quote: 'Tomorrow morning' },
    ] };
    release(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(candidate) }, finish_reason: 'stop' }] })));
    const stale = await pending;
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.error.code, 'version_conflict');
    assert.deepEqual(await intake(agent, id), manual.body.intake);
  }, { aiApiKey: 'test-only-ai-key', fetchImpl });
});

test('an AI completion based on older inbound messages cannot overwrite a new customer correction', { timeout: 5000 }, async () => {
  let entered!: () => void;
  const providerEntered = new Promise<void>(resolve => { entered = resolve; });
  let release!: (response: Response) => void;
  const providerResponse = new Promise<Response>(resolve => { release = resolve; });
  await fixture(async app => {
    const agent = await authenticated(app);
    const id = freshConversation(app);
    const message = await inbound(agent, id, 'My kitchen tap is leaking.');
    const initial = await analyze(agent, id);
    const pending = agent.post(`/api/conversations/${id}/intake/analyze`).set('Origin', origin).send({ useAi: true, expectedVersion: initial.version }).then(response => response);
    await providerEntered;
    await inbound(agent, id, 'Correction: I am at 29 New Street. Friday morning please.');
    const candidate = { summary: message.text, category: 'Plumbing', address: '', preferredTime: '', urgency: 'routine', wantsHuman: false, evidence: [{ field: 'summary', messageId: message.id, quote: message.text }, { field: 'category', messageId: message.id, quote: 'tap' }] };
    release(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(candidate) }, finish_reason: 'stop' }] })));
    const stale = await pending;
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.error.code, 'conversation_changed');
    assert.deepEqual(await intake(agent, id), initial);
    const refreshed = await analyze(agent, id, initial.version);
    assert.equal(refreshed.address, '29 New Street');
    assert.equal(refreshed.preferredTime, 'Friday morning');
  }, { aiApiKey: 'test-only-ai-key', fetchImpl: async () => { entered(); return providerResponse; } });
});

const scheduledJob = (overrides: Record<string, unknown> = {}) => ({ title: 'Fix kitchen tap', customerName: 'Schedule customer', phone: '+27821234567', category: 'Plumbing', address: '17 Test Street, Johannesburg', scheduledAt: '2030-03-15T08:00:00.000Z', status: 'scheduled', assignedTo: 'Team A', durationMinutes: 60, notes: '', ...overrides });

async function createJob(agent: Agent, payload = scheduledJob()): Promise<Job> {
  const response = await agent.post('/api/jobs').set('Origin', origin).send(payload);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.job;
}

test('scheduling rejects an overlapping team appointment and permits exact boundaries and other teams', async () => {
  await fixture(async app => {
    const agent = await authenticated(app);
    const first = await createJob(agent);
    for (const scheduledAt of ['2030-03-15T07:30:00.000Z', '2030-03-15T08:00:00.000Z', '2030-03-15T08:59:59.000Z']) {
      const conflict = await agent.post('/api/jobs').set('Origin', origin).send(scheduledJob({ scheduledAt }));
      assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    }
    const equivalentAppointment = await agent.post('/api/jobs').set('Origin', origin).send(scheduledJob({ scheduledAt: '2030-03-15T10:00:00.000+02:00', assignedTo: '  team a  ' }));
    assert.equal(equivalentAppointment.status, 409, 'Equivalent timezone offsets and assignee casing must not bypass overlap detection');
    await createJob(agent, scheduledJob({ scheduledAt: '2030-03-15T07:00:00.000Z' }));
    await createJob(agent, scheduledJob({ scheduledAt: '2030-03-15T09:00:00.000Z' }));
    await createJob(agent, scheduledJob({ assignedTo: 'Team B' }));
    await createJob(agent, scheduledJob({ status: 'completed' }));
    await createJob(agent, scheduledJob({ status: 'new' }));
    const existing = (await agent.get('/api/jobs')).body.jobs.find((job: Job) => job.id === first.id);
    assert.deepEqual(existing, first, 'A rejected conflict must not change the existing appointment');
  });
});

test('job edits validate every supplied field, require valid scheduling prerequisites and preserve optimistic updates', async () => {
  await fixture(async app => {
    const agent = await authenticated(app);
    const original = await createJob(agent);
    const invalid = [
      { title: 2 }, { title: '' }, { customerName: false }, { phone: '0821234567' }, { category: {} },
      { address: 4 }, { scheduledAt: 'tomorrow' }, { status: 'cancelled' }, { notes: [] },
      { assignedTo: 8 }, { durationMinutes: 0 }, { durationMinutes: 1.5 }, { durationMinutes: '60' },
      { expectedVersion: -1 }, { expectedVersion: '1' }, { conversationId: 123 }, { unknown: 'not supported' },
      { scheduledAt: '' }, { assignedTo: '' },
    ];
    for (const patch of invalid) {
      const rejected = await agent.patch(`/api/jobs/${original.id}`).set('Origin', origin).send({ expectedVersion: original.version, ...patch });
      assert.equal(rejected.status, 400, `${JSON.stringify(patch)}: ${JSON.stringify(rejected.body)}`);
    }
    const update = await agent.patch(`/api/jobs/${original.id}`).set('Origin', origin).send({ expectedVersion: original.version, notes: 'Operator reviewed the appointment', durationMinutes: 90 });
    assert.equal(update.status, 200, JSON.stringify(update.body));
    assert.equal(update.body.job.version, original.version + 1);
    const stale = await agent.patch(`/api/jobs/${original.id}`).set('Origin', origin).send({ expectedVersion: original.version, title: 'Overwrite newer appointment', notes: 'Lost update' });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    const saved = (await agent.get('/api/jobs')).body.jobs.find((job: Job) => job.id === original.id);
    assert.equal(saved.notes, 'Operator reviewed the appointment');
    assert.equal(saved.durationMinutes, 90);
    assert.equal(saved.title, original.title);
    assert.equal(saved.version, original.version + 1);
    for (const payload of [scheduledJob({ scheduledAt: '' }), scheduledJob({ assignedTo: '' }), scheduledJob({ status: 'in_progress', scheduledAt: '' })]) {
      const rejected = await agent.post('/api/jobs').set('Origin', origin).send(payload);
      assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    }
  });
});

test('moving or lengthening an appointment checks overlap without applying a partial update', async () => {
  await fixture(async app => {
    const agent = await authenticated(app);
    const first = await createJob(agent);
    const second = await createJob(agent, scheduledJob({ scheduledAt: '2030-03-15T09:00:00.000Z' }));
    for (const patch of [{ scheduledAt: '2030-03-15T08:30:00.000Z' }, { durationMinutes: 61 }]) {
      const target = 'durationMinutes' in patch ? first : second;
      const response = await agent.patch(`/api/jobs/${target.id}`).set('Origin', origin).send({ ...patch, notes: 'Must not be saved', expectedVersion: target.version });
      assert.equal(response.status, 409, JSON.stringify(response.body));
      const saved = (await agent.get('/api/jobs')).body.jobs.find((job: Job) => job.id === target.id);
      assert.deepEqual(saved, target);
    }
    const completed = await agent.patch(`/api/jobs/${first.id}`).set('Origin', origin).send({ expectedVersion: first.version, status: 'completed' });
    assert.equal(completed.status, 200);
    const move = await agent.patch(`/api/jobs/${second.id}`).set('Origin', origin).send({ expectedVersion: second.version, scheduledAt: first.scheduledAt });
    assert.equal(move.status, 200, 'Completed work must release its appointment interval');
  });
});

// Exact pre-intake schema, including its 11-column jobs table, to exercise real upgrades.
function legacyDatabase(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, customer_name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, preview TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, unread_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', assigned_to TEXT NOT NULL DEFAULT '', automation_paused INTEGER NOT NULL DEFAULT 0, category TEXT NOT NULL DEFAULT 'General');
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), direction TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, provider_id TEXT UNIQUE);
    CREATE TABLE provider_statuses (provider_id TEXT PRIMARY KEY, status TEXT NOT NULL, received_at INTEGER NOT NULL);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, title TEXT NOT NULL, customer_name TEXT NOT NULL, phone TEXT NOT NULL, category TEXT NOT NULL, address TEXT NOT NULL, scheduled_at TEXT NOT NULL, status TEXT NOT NULL, notes TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), business_name TEXT NOT NULL, business_hours TEXT NOT NULL, welcome_message TEXT NOT NULL, away_message TEXT NOT NULL, automation_enabled INTEGER NOT NULL);
    CREATE TABLE activity (id TEXT PRIMARY KEY, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  const timestamp = '2026-01-12T08:00:00.000Z';
  db.prepare('INSERT INTO metadata VALUES (?,?)').run('mode', 'demo');
  db.prepare('INSERT INTO metadata VALUES (?,?)').run('seeded', '1');
  db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('legacy-user', credentials.email, 'Existing owner', passwordHash(credentials.password));
  db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?)').run('legacy-conversation', 'Legacy customer', '+27820000444', 'My tap leaks', timestamp, 1, 'waiting', 'Existing team', 1, 'Plumbing');
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run('legacy-message', 'legacy-conversation', 'inbound', 'My tap leaks', timestamp, 'received', 'legacy-provider-message');
  db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('legacy-job', 'Legacy tap repair', 'Legacy customer', '+27820000444', 'Plumbing', '45 Saved Road', timestamp, 'new', 'Preserve this job', timestamp, timestamp);
  db.prepare('INSERT INTO settings VALUES (1,?,?,?,?,?)').run('Existing business', 'Existing hours', 'Existing welcome', 'Existing away', 1);
  db.prepare('INSERT INTO activity VALUES (?,?,?,?)').run('legacy-activity', 'legacy.created', 'Preserve existing history', timestamp);
  return db;
}

test('legacy database migration is additive and idempotent and preserves customers, jobs, credentials and settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'handyman-legacy-'));
  const path = join(directory, 'legacy.sqlite');
  try {
    const legacy = legacyDatabase(path);
    const snapshots = Object.fromEntries(['users', 'conversations', 'messages', 'settings', 'metadata', 'activity'].map(table => [table, legacy.prepare(`SELECT * FROM ${table}`).all()]));
    const originalJob = legacy.prepare('SELECT * FROM jobs').get()!;
    legacy.close();
    for (let run = 0; run < 2; run++) {
      const db = openDatabase(path, 'demo', credentials.email, 'Different password must not reset the owner');
      try {
        for (const [table, rows] of Object.entries(snapshots)) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), rows, table);
        const saved = db.prepare('SELECT * FROM jobs').get()!;
        for (const [column, value] of Object.entries(originalJob)) assert.equal(saved[column], value, column);
        assert.equal(saved.conversation_id, null);
        assert.equal(saved.duration_minutes, 60);
        assert.equal(saved.version, 1);
        assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get()!.n, 1);
        assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='intakes'").get()!.n, 1);
      } finally { db.close(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('opening legacy demo data in live mode refuses before schema or data migration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'handyman-wrong-mode-'));
  const path = join(directory, 'legacy.sqlite');
  try {
    const legacy = legacyDatabase(path);
    const schema = legacy.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
    const jobs = legacy.prepare('SELECT * FROM jobs').all();
    const metadata = legacy.prepare('SELECT * FROM metadata').all();
    legacy.close();
    assert.throws(() => openDatabase(path, 'live', credentials.email, credentials.password), /Database mode differs/);
    const unchanged = new DatabaseSync(path);
    try {
      assert.deepEqual(unchanged.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(), schema);
      assert.deepEqual(unchanged.prepare('SELECT * FROM jobs').all(), jobs);
      assert.deepEqual(unchanged.prepare('SELECT * FROM metadata').all(), metadata);
    } finally { unchanged.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
