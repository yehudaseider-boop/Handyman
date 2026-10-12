/** Local API benchmark with fictional, in-memory data; never calls providers. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import request from 'supertest';
import { createApp } from '../server/app.js';

const origin = 'http://127.0.0.1:5173';
const app = createApp({ mode: 'demo', dbPath: ':memory:', appOrigin: origin,adminEmail:'admin@handyman.local',adminPassword:'DemoPass!2026',whatsappToken:'',whatsappPhoneId:'',whatsappAppSecret:'',whatsappVerifyToken:'',aiApiKey:'',allowLiveAutomation:false });
try {
  const db = app.locals.db;
  const insert = db.prepare('INSERT INTO messages (id,conversation_id,direction,text,created_at,status,provider_id) VALUES (?,?,?,?,?,?,?)');
  const historySize = 10_000;
  const now = Date.now();
  db.exec('BEGIN');
  try {
    for (let index = 0; index < historySize; index++) {
      insert.run(randomUUID(), 'demo-conv-1', 'inbound', `Fictional customer history ${index}: please review the tap repair and arrange a visit.`, new Date(now - (historySize - index) * 1000).toISOString(), 'received', null);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const agent = request.agent(app);
  const login = await agent.post('/api/auth/login').set('Origin', origin).send({ email: 'admin@handyman.local', password: 'DemoPass!2026' });
  assert.equal(login.status, 200, 'Demo benchmark sign-in must succeed');
  for (let index = 0; index < 10; index++) await agent.get('/api/conversations/demo-conv-1').expect(200);
  const elapsed: number[] = [];
  let responseBytes = 0;
  let pageMessages = 0;
  for (let index = 0; index < 100; index++) {
    const start = performance.now();
    const result = await agent.get('/api/conversations/demo-conv-1').expect(200);
    elapsed.push(performance.now() - start);
    assert.ok(result.body.messages.length <= 50, 'Inbox must page long histories');
    assert.equal(result.body.pagination.hasMore, true, 'Earlier messages must remain reachable');
    pageMessages = result.body.messages.length;
    responseBytes = Buffer.byteLength(result.text);
  }
  elapsed.sort((a, b) => a - b);
  const percentile = (value: number) => Number(elapsed[Math.ceil(elapsed.length * value) - 1]!.toFixed(2));
  console.log(JSON.stringify({
    environment: 'local in-memory API, fictional data, no external providers',
    historyMessages: historySize + 3,
    samples: elapsed.length,
    returnedMessages: pageMessages,
    responseBytes,
    p50Milliseconds: percentile(0.5),
    p95Milliseconds: percentile(0.95),
    note: 'Measures local API processing; excludes hosting, network, browser rendering and AI provider latency.',
  }, null, 2));
} finally { app.locals.close(); }
