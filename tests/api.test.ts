import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../server/app.js';
import type { AppOptions } from '../server/types.js';

const origin = 'http://localhost:5173';
const credentials = { email: 'owner@example.test', password: 'Test-only-password-942!' };
const appSecret = 'test-only-whatsapp-app-secret';
const verifyToken = 'test-only-whatsapp-verify-token';

async function fixture(run: (app: ReturnType<typeof createApp>, options: AppOptions) => Promise<void>, overrides: AppOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'handyman-api-'));
  const options: AppOptions = {
    dbPath: join(directory, 'workspace.sqlite'),
    mode: 'demo',
    adminEmail: credentials.email,
    adminPassword: credentials.password,
    appOrigin: origin,
    secureCookies: false,
    whatsappToken: '', whatsappPhoneId: '', whatsappAppSecret: '', whatsappVerifyToken: '', aiApiKey: '', allowLiveAutomation: false,
    ...overrides,
  };
  let app: ReturnType<typeof createApp> | undefined;
  try {
    app = createApp(options);
    await run(app, options);
  } finally {
    app?.locals.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function authenticated(app: ReturnType<typeof createApp>, requestOrigin = origin) {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/login').set('Origin', requestOrigin).send(credentials);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  if (requestOrigin.startsWith('https://')) {
    const cookies = response.headers['set-cookie'] as unknown as string[];
    agent.set('Cookie', cookies.find(cookie => cookie.startsWith('handyman_session='))!.split(';')[0]);
  }
  return agent;
}

function signed(payload: object) {
  const body = JSON.stringify(payload);
  return { body, signature: `sha256=${createHmac('sha256', appSecret).update(body).digest('hex')}` };
}

function inboundWebhook(id: string, text = 'Please help with a leaking tap') {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'business-1', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '27110000000', phone_number_id: 'phone-test' },
      contacts: [{ wa_id: '27820000123', profile: { name: 'Webhook customer' } }],
      messages: [{ from: '27820000123', id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
    } }] }],
  };
}

test('private routes require authentication and signed-in sessions are revoked at logout', async () => {
  await fixture(async app => {
    for (const path of ['/api/auth/me', '/api/dashboard', '/api/conversations', '/api/jobs', '/api/settings', '/api/activity']) {
      assert.equal((await request(app).get(path)).status, 401, path);
    }
    const denied = await request(app).post('/api/auth/login').set('Origin', origin).send({ ...credentials, password: 'incorrect' });
    assert.equal(denied.status, 401);
    assert.ok(!JSON.stringify(denied.body).includes(credentials.password));

    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').set('Origin', origin).send(credentials);
    assert.equal(login.status, 200);
    assert.equal(login.body.user.email, credentials.email);
    const cookies = login.headers['set-cookie'] as unknown as string[];
    assert.ok(cookies.some(cookie => /handyman_session=/.test(cookie) && /HttpOnly/i.test(cookie) && /SameSite=Strict/i.test(cookie)));
    const sessionCookie = cookies.find(cookie => cookie.startsWith('handyman_session='))!.split(';')[0];
    assert.equal((await agent.get('/api/auth/me')).status, 200);
    assert.equal((await agent.post('/api/auth/logout').set('Origin', origin)).status, 200);
    assert.equal((await agent.get('/api/auth/me')).status, 401);
    assert.equal((await request(app).get('/api/auth/me').set('Cookie', sessionCookie)).status, 401, 'A captured cookie must be invalid after logout');
  });
});

test('browser mutations enforce exact origin, including login, and reject missing origin', async () => {
  await fixture(async app => {
    assert.equal((await request(app).post('/api/auth/login').send(credentials)).status, 403);
    assert.equal((await request(app).post('/api/auth/login').set('Origin', 'https://attacker.example').send(credentials)).status, 403);
    assert.equal((await request(app).post('/api/auth/login').set('Origin', `${origin}.attacker.example`).send(credentials)).status, 403);
    const agent = await authenticated(app);
    const before = (await agent.get('/api/settings')).body.settings;
    const changed = { ...before, businessName: 'Cross-origin overwrite' };
    assert.equal((await agent.patch('/api/settings').set('Origin', 'https://attacker.example').send(changed)).status, 403);
    assert.equal((await agent.patch('/api/settings').send(changed)).status, 403);
    assert.deepEqual((await agent.get('/api/settings')).body.settings, before);
  });
});

test('message creation persists and conversation handoff/status updates retain their state', async () => {
  await fixture(async (app, options) => {
    const agent = await authenticated(app);
    const list = await agent.get('/api/conversations');
    assert.equal(list.status, 200);
    assert.ok(list.body.conversations.length > 0, 'Demo workspace should have example conversations');
    const conversationId = list.body.conversations[0].id;
    const sentText = 'A technician can visit tomorrow at 10:00. <script>alert("x")</script>';
    const message = await agent.post(`/api/conversations/${conversationId}/messages`).set('Origin', origin).send({ text: sentText });
    assert.equal(message.status, 201, JSON.stringify(message.body));
    const handoff = await agent.patch(`/api/conversations/${conversationId}`).set('Origin', origin).send({ status: 'waiting', assignedTo: 'Alex', automationPaused: true });
    assert.equal(handoff.status, 200);
    const detail = await agent.get(`/api/conversations/${conversationId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.conversation.status, 'waiting');
    assert.equal(detail.body.conversation.assignedTo, 'Alex');
    assert.equal(detail.body.conversation.automationPaused, true);
    const saved = detail.body.messages.find((item: { text: string }) => item.text === sentText);
    assert.ok(saved);
    assert.equal(saved.direction, 'outbound');
    assert.equal(saved.status, 'sent');
    assert.equal(saved.providerId, null, 'Demo replies must not claim WhatsApp delivery');

    app.locals.close();
    const reopened = createApp(options);
    try {
      const reopenedAgent = await authenticated(reopened);
      const persisted = await reopenedAgent.get(`/api/conversations/${conversationId}`);
      assert.equal(persisted.body.conversation.automationPaused, true);
      assert.equal(persisted.body.conversation.status, 'waiting');
      assert.ok(persisted.body.messages.some((item: { text: string }) => item.text === sentText));
    } finally {
      reopened.locals.close();
    }
  });
});

test('invalid payloads and missing resources do not mutate workspace data', async () => {
  await fixture(async app => {
    const agent = await authenticated(app);
    const conversations = (await agent.get('/api/conversations')).body.conversations;
    const id = conversations[0].id;
    const before = (await agent.get(`/api/conversations/${id}`)).body;
    for (const payload of [{ text: '' }, { text: '   ' }, { text: 'x'.repeat(5000) }, { text: 5 }]) {
      assert.equal((await agent.post(`/api/conversations/${id}/messages`).set('Origin', origin).send(payload)).status, 400);
    }
    assert.equal((await agent.post(`/api/conversations/${id}/messages`).set('Origin', origin).send({ text: 'x'.repeat(50000) })).status, 413);
    assert.equal((await agent.patch(`/api/conversations/${id}`).set('Origin', origin).send({ status: 'untrusted-status' })).status, 400);
    assert.equal((await agent.get('/api/conversations/nonexistent-id')).status, 404);
    assert.equal((await agent.post('/api/conversations/nonexistent-id/messages').set('Origin', origin).send({ text: 'hello' })).status, 404);
    const after = (await agent.get(`/api/conversations/${id}`)).body;
    assert.equal(after.messages.length, before.messages.length);
    assert.equal(after.conversation.status, before.conversation.status);
    assert.equal((await agent.post('/api/jobs').set('Origin', origin).send({ title: 'Incomplete job' })).status, 400);
    assert.equal((await agent.patch('/api/settings').set('Origin', origin).send({ automationEnabled: 'yes' })).status, 400);
  });
});

test('jobs can be created, edited and read with dashboard totals reflecting their lifecycle', async () => {
  await fixture(async app => {
    const agent = await authenticated(app);
    const before = (await agent.get('/api/dashboard')).body.stats;
    const payload = {
      title: 'Repair garden tap', customerName: 'Jamie Test', phone: '+27820000456',
      category: 'Plumbing', address: '42 Example Street, Johannesburg',
      scheduledAt: '2027-01-12T08:00:00.000Z', status: 'scheduled', notes: 'Bring a replacement washer',
    };
    const created = await agent.post('/api/jobs').set('Origin', origin).send(payload);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.ok(created.body.job.id);
    const id = created.body.job.id;
    assert.equal((await agent.get('/api/dashboard')).body.stats.activeJobs, before.activeJobs + 1);
    const edited = await agent.patch(`/api/jobs/${id}`).set('Origin', origin).send({ status: 'completed', notes: 'Customer confirmed tap is fixed' });
    assert.equal(edited.status, 200);
    const jobs = (await agent.get('/api/jobs')).body.jobs;
    const persisted = jobs.find((job: { id: string }) => job.id === id);
    assert.equal(persisted.status, 'completed');
    assert.equal(persisted.notes, 'Customer confirmed tap is fixed');
    assert.equal(persisted.customerName, payload.customerName);
    const after = (await agent.get('/api/dashboard')).body.stats;
    assert.equal(after.activeJobs, before.activeJobs);
    assert.equal(after.completedJobs, before.completedJobs + 1);
    assert.equal((await agent.patch(`/api/jobs/${id}`).set('Origin', origin).send({ status: 'not-a-status' })).status, 400);
    assert.equal((await agent.patch('/api/jobs/nonexistent-id').set('Origin', origin).send({ notes: 'Missing' })).status, 404);
  });
});

test('settings expose only safe integration flags and retain valid updates', async () => {
  await fixture(async app => {
    const agent = await authenticated(app);
    const before = await agent.get('/api/settings');
    assert.equal(before.status, 200);
    assert.equal(before.body.integration.mode, 'demo');
    const body = JSON.stringify(before.body);
    for (const secret of [credentials.password, appSecret, verifyToken, 'test-private-access-token']) assert.ok(!body.includes(secret));
    for (const key of ['adminPassword', 'whatsappToken', 'whatsappAppSecret', 'whatsappVerifyToken']) assert.ok(!body.includes(key));
    const updated = await agent.patch('/api/settings').set('Origin', origin).send({ businessName: 'Test Handyman', automationEnabled: false });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const persisted = (await agent.get('/api/settings')).body.settings;
    assert.equal(persisted.businessName, 'Test Handyman');
    assert.equal(persisted.automationEnabled, false);
  }, { whatsappToken: 'test-private-access-token', whatsappPhoneId: 'phone-test', whatsappAppSecret: appSecret, whatsappVerifyToken: verifyToken });
});

test('demo incoming messages persist as inbound and appear in conversation unread totals', async () => {
  await fixture(async app => {
    const agent = await authenticated(app);
    const conversations = (await agent.get('/api/conversations')).body.conversations;
    const id = conversations[0].id;
    await agent.patch(`/api/conversations/${id}`).set('Origin', origin).send({ unreadCount: 0 });
    const text = 'Can someone fix our door handle today?';
    const result = await agent.post('/api/demo/inbound').set('Origin', origin).send({ conversationId: id, text });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const updated = (await agent.get('/api/conversations')).body.conversations.find((item: { id: string }) => item.id === id);
    assert.ok(updated.unreadCount >= 1);
    assert.equal(updated.preview, text);
    const detail = await agent.get(`/api/conversations/${id}`);
    assert.ok(detail.body.messages.some((message: { text: string; direction: string }) => message.text === text && message.direction === 'inbound'));
    assert.ok((await agent.get('/api/conversations')).body.conversations.find((item: { id: string }) => item.id === id).unreadCount >= 1, 'Reading a GET must not mutate unread state');
    await agent.patch(`/api/conversations/${id}`).set('Origin', origin).send({ unreadCount: 0 });
    assert.equal((await agent.get('/api/conversations')).body.conversations.find((item: { id: string }) => item.id === id).unreadCount, 0);
  });
});

test('webhook verification requires the configured token and rejects invalid signatures without writing messages', async () => {
  await fixture(async app => {
    const validChallenge = await request(app).get('/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': verifyToken, 'hub.challenge': 'challenge-123' });
    assert.equal(validChallenge.status, 200);
    assert.equal(validChallenge.text, 'challenge-123');
    assert.equal((await request(app).get('/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'x' })).status, 403);
    const agent = await authenticated(app, 'https://handyman.test');
    const before = (await agent.get('/api/dashboard')).body.dailyMessages;
    const payload = signed(inboundWebhook('wamid.rejected'));
    assert.equal((await request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json').send(payload.body)).status, 401);
    assert.equal((await request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', 'sha256=bad').send(payload.body)).status, 401);
    const tampered = payload.body.replace('leaking tap', 'broken roof');
    assert.equal((await request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', payload.signature).send(tampered)).status, 401);
    assert.deepEqual((await agent.get('/api/dashboard')).body.dailyMessages, before);
  }, { ...liveOptions, whatsappVerifyToken: verifyToken });
});

test('valid signed webhook writes a customer message exactly once when delivery is replayed', async () => {
  await fixture(async app => {
    const payload = signed(inboundWebhook('wamid.valid-unique'));
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', payload.signature).send(payload.body);
      assert.equal(response.status, 200, JSON.stringify(response.body));
    }
    const agent = await authenticated(app, 'https://handyman.test');
    const conversations = (await agent.get('/api/conversations')).body.conversations;
    const customer = conversations.find((item: { phone: string }) => item.phone.replace(/\D/g, '') === '27820000123');
    assert.ok(customer, 'Signed inbound WhatsApp creates the customer conversation');
    const detail = (await agent.get(`/api/conversations/${customer.id}`)).body;
    const delivered = detail.messages.filter((message: { providerId: string }) => message.providerId === 'wamid.valid-unique');
    assert.equal(delivered.length, 1, 'Provider retries must not create duplicate messages');
    assert.equal(delivered[0].direction, 'inbound');
    assert.equal(delivered[0].text, 'Please help with a leaking tap');
  }, { ...liveOptions, whatsappVerifyToken: verifyToken });
});

test('repeated failed sign-ins are throttled without exposing whether an account exists', async () => {
  await fixture(async app => {
    const first = await request(app).post('/api/auth/login').set('Origin', origin).send({ email: 'unknown@example.test', password: 'wrong' });
    const second = await request(app).post('/api/auth/login').set('Origin', origin).send({ email: credentials.email, password: 'wrong' });
    assert.equal(first.status, 401);
    assert.deepEqual(first.body, second.body);
    for (let attempt = 2; attempt < 8; attempt++) {
      assert.equal((await request(app).post('/api/auth/login').set('Origin', origin).send({ ...credentials, password: 'wrong' })).status, 401);
    }
    const throttled = await request(app).post('/api/auth/login').set('Origin', origin).send(credentials);
    assert.equal(throttled.status, 429);
    assert.ok(Number(throttled.headers['retry-after']) > 0);
    assert.ok(!throttled.headers['set-cookie']);
  });
});

test('signed webhook events for a different phone number are ignored', async () => {
  await fixture(async app => {
    const payload = inboundWebhook('wamid.foreign-number');
    payload.entry[0].changes[0].value.metadata.phone_number_id = 'different-phone';
    const signedPayload = signed(payload);
    const response = await request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signedPayload.signature).send(signedPayload.body);
    assert.equal(response.status, 200);
    const agent = await authenticated(app, 'https://handyman.test');
    const conversations = (await agent.get('/api/conversations')).body.conversations;
    assert.ok(!conversations.some((item: { phone: string }) => item.phone.replace(/\D/g, '') === '27820000123'));
  }, liveOptions);
});

test('live startup requires strong credentials, HTTPS and secure cookies, and refuses a demo database', async () => {
  await fixture(async (_app, options) => {
    const safeLive: AppOptions = { ...options, mode: 'live', appOrigin: 'https://handyman.test', secureCookies: true };
    assert.throws(() => createApp({ ...safeLive, adminPassword: '' }), /ADMIN_PASSWORD/);
    assert.throws(() => createApp({ ...safeLive, adminPassword: 'short' }), /ADMIN_PASSWORD/);
    assert.throws(() => createApp({ ...safeLive, adminPassword: 'x'.repeat(257) }), /ADMIN_PASSWORD/);
    assert.throws(() => createApp({ ...safeLive, adminPassword: 'DemoPass!2026' }), /ADMIN_PASSWORD/);
    assert.throws(() => createApp({ ...safeLive, appOrigin: origin }), /HTTPS/);
    assert.throws(() => createApp({ ...safeLive, secureCookies: false }), /secure session cookies/);
    assert.throws(() => createApp(safeLive), /separate database|mode differs/i);
  });
});

async function liveCookie(app: ReturnType<typeof createApp>) {
  const response = await request(app).post('/api/auth/login').set('Origin', 'https://handyman.test').send(credentials);
  assert.equal(response.status, 200);
  const cookies = response.headers['set-cookie'] as unknown as string[];
  const session = cookies.find(cookie => cookie.startsWith('handyman_session='))!;
  assert.match(session, /Secure/);
  return session.split(';')[0];
}

test('live workspace has no fictional customers and cannot simulate incoming messages or send without credentials', async () => {
  await fixture(async app => {
    const cookie = await liveCookie(app);
    assert.deepEqual((await request(app).get('/api/conversations').set('Cookie', cookie)).body.conversations, []);
    assert.deepEqual((await request(app).get('/api/jobs').set('Cookie', cookie)).body.jobs, []);
    const settings = (await request(app).get('/api/settings').set('Cookie', cookie)).body;
    assert.equal(settings.integration.mode, 'live');
    assert.equal(settings.integration.whatsappConfigured, false);
    assert.equal(settings.integration.automaticReplies, false);
    const demo = await request(app).post('/api/demo/inbound').set('Origin', 'https://handyman.test').set('Cookie', cookie).send({ text: 'Injected fake customer' });
    assert.equal(demo.status, 404);
    const payload = signed(inboundWebhook('wamid.live-inbound'));
    assert.equal((await request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', payload.signature).send(payload.body)).status, 200);
    const id = (await request(app).get('/api/conversations').set('Cookie', cookie)).body.conversations[0].id;
    const denied = await request(app).post(`/api/conversations/${id}/messages`).set('Origin', 'https://handyman.test').set('Cookie', cookie).send({ text: 'Do not transmit' });
    assert.equal(denied.status, 503);
    const detail = (await request(app).get(`/api/conversations/${id}`).set('Cookie', cookie)).body;
    assert.ok(!detail.messages.some((message: { direction: string }) => message.direction === 'outbound'));
  }, { mode: 'live', appOrigin: 'https://handyman.test', secureCookies: true, whatsappAppSecret: appSecret, whatsappPhoneId: 'phone-test' });
});

test('late webhook delivery preserves provider time and cannot reopen the WhatsApp 24-hour reply window', async () => {
  await fixture(async app => {
    const cookie = await liveCookie(app);
    const payload = inboundWebhook('wamid.stale-inbound');
    const timestamp = String(Math.floor((Date.now() - 25 * 60 * 60 * 1000) / 1000));
    payload.entry[0].changes[0].value.messages[0].timestamp = timestamp;
    const signedPayload = signed(payload);
    assert.equal((await request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signedPayload.signature).send(signedPayload.body)).status, 200);
    const id = (await request(app).get('/api/conversations').set('Cookie', cookie)).body.conversations[0].id;
    const before = (await request(app).get(`/api/conversations/${id}`).set('Cookie', cookie)).body.messages;
    assert.equal(before[0].createdAt, new Date(Number(timestamp) * 1000).toISOString());
    const reply = await request(app).post(`/api/conversations/${id}/messages`).set('Origin', 'https://handyman.test').set('Cookie', cookie).send({ text: 'Window has expired' });
    assert.equal(reply.status, 409);
    assert.equal(reply.body.error.code, 'template_required');
    assert.equal((await request(app).get(`/api/conversations/${id}`).set('Cookie', cookie)).body.messages.length, before.length);
  }, { mode: 'live', appOrigin: 'https://handyman.test', secureCookies: true, whatsappAppSecret: appSecret, whatsappPhoneId: 'phone-test', whatsappToken: 'test-private-access-token' });
});

async function liveCustomer(app: ReturnType<typeof createApp>, cookie: string) {
  const payload = signed(inboundWebhook(`wamid.${randomUUID()}`));
  assert.equal((await request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', payload.signature).send(payload.body)).status, 200);
  return (await request(app).get('/api/conversations').set('Cookie', cookie)).body.conversations[0].id as string;
}

const liveOptions: AppOptions = {
  mode: 'live', appOrigin: 'https://handyman.test', secureCookies: true,
  whatsappAppSecret: appSecret, whatsappPhoneId: 'phone-test', whatsappToken: 'test-private-access-token',
};

test('a confirmed live send is idempotent and delivery status cannot regress on late webhook events', async () => {
  let providerCalls = 0;
  const fetchImpl: typeof fetch = async (url, options) => {
    providerCalls++;
    assert.equal(String(url), 'https://graph.facebook.com/v23.0/phone-test/messages');
    assert.equal(options?.method, 'POST');
    assert.equal(options?.redirect, 'error', 'Provider redirects must not forward credentials');
    assert.ok(options?.signal);
    const body = JSON.parse(String(options?.body));
    assert.equal(body.to, '27820000123');
    assert.equal(body.text.body, 'Your technician is booked for tomorrow.');
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.confirmed-outbound' }] }), { status: 200 });
  };
  await fixture(async app => {
    const cookie = await liveCookie(app);
    const id = await liveCustomer(app, cookie);
    const message = { text: 'Your technician is booked for tomorrow.', idempotencyKey: randomUUID() };
    const first = await request(app).post(`/api/conversations/${id}/messages`).set('Origin', 'https://handyman.test').set('Cookie', cookie).send(message);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.message.providerId, 'wamid.confirmed-outbound');
    const retry = await request(app).post(`/api/conversations/${id}/messages`).set('Origin', 'https://handyman.test').set('Cookie', cookie).send(message);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.message.id, first.body.message.id);
    assert.equal(providerCalls, 1);
    const conflict = await request(app).post(`/api/conversations/${id}/messages`).set('Origin', 'https://handyman.test').set('Cookie', cookie).send({ ...message, text: 'Different text with same identifier' });
    assert.equal(conflict.status, 409);
    assert.equal(providerCalls, 1);
    let expectedStatus = 'sent';
    for (const status of ['delivered', 'failed', 'read', 'sent', 'failed']) {
      const event = signed({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'phone-test' }, statuses: [{ id: 'wamid.confirmed-outbound', status }] } }] }] });
      assert.equal((await request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', event.signature).send(event.body)).status, 200);
      if (status === 'delivered' || status === 'read') expectedStatus = status;
      const updated = (await request(app).get(`/api/conversations/${id}`).set('Cookie', cookie)).body.messages.find((message: { providerId: string }) => message.providerId === 'wamid.confirmed-outbound');
      assert.equal(updated.status, expectedStatus, `A late ${status} must not override confirmed delivery`);
    }
    const detail = (await request(app).get(`/api/conversations/${id}`).set('Cookie', cookie)).body;
    const outbound = detail.messages.filter((item: { direction: string }) => item.direction === 'outbound');
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].status, 'read');
  }, { ...liveOptions, fetchImpl });
});

test('transport failure retains an unconfirmed send, sanitizes errors and prevents duplicate retries after restart', async () => {
  let providerCalls = 0;
  const fetchImpl: typeof fetch = async () => {
    providerCalls++;
    throw new DOMException('private provider diagnostics test-private-access-token', 'TimeoutError');
  };
  await fixture(async (app, options) => {
    const cookie = await liveCookie(app);
    const id = await liveCustomer(app, cookie);
    const body = { text: 'Your booking request is being reviewed.', idempotencyKey: randomUUID() };
    const sent = await request(app).post(`/api/conversations/${id}/messages`).set('Origin', 'https://handyman.test').set('Cookie', cookie).send(body);
    assert.equal(sent.status, 502);
    assert.equal(sent.body.error.code, 'send_unconfirmed');
    assert.ok(!JSON.stringify(sent.body).includes('test-private-access-token'));
    assert.equal(providerCalls, 1);
    app.locals.close();
    const reopened = createApp(options);
    try {
      const newCookie = await liveCookie(reopened);
      const detail = (await request(reopened).get(`/api/conversations/${id}`).set('Cookie', newCookie)).body;
      const pending = detail.messages.filter((message: { direction: string }) => message.direction === 'outbound');
      assert.equal(pending.length, 1);
      assert.equal(pending[0].status, 'unconfirmed');
      assert.equal(pending[0].providerId, null);
      const replay = await request(reopened).post(`/api/conversations/${id}/messages`).set('Origin', 'https://handyman.test').set('Cookie', newCookie).send(body);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.message.status, 'unconfirmed');
      const duplicate = await request(reopened).post(`/api/conversations/${id}/messages`).set('Origin', 'https://handyman.test').set('Cookie', newCookie).send({ ...body, idempotencyKey: randomUUID() });
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.body.error.code, 'send_unconfirmed');
      assert.equal(providerCalls, 1);
    } finally {
      reopened.locals.close();
    }
  }, { ...liveOptions, fetchImpl });
});

test('draft assistance requires opt-in and respects handoff without sending or creating jobs', async () => {
  let networkCalls = 0;
  await fixture(async app => {
    const agent = await authenticated(app);
    const id = (await agent.get('/api/conversations')).body.conversations[0].id;
    const before = (await agent.get(`/api/conversations/${id}`)).body.messages;
    const jobsBefore = (await agent.get('/api/jobs')).body.jobs;
    const disabled = await agent.post(`/api/conversations/${id}/draft`).set('Origin', origin).send({});
    assert.equal(disabled.status, 409);
    assert.equal(disabled.body.error.code, 'drafts_paused');
    assert.equal((await agent.patch('/api/settings').set('Origin', origin).send({ automationEnabled: true })).status, 200);
    const template = await agent.post(`/api/conversations/${id}/draft`).set('Origin', origin).send({});
    assert.equal(template.status, 200);
    assert.equal(template.body.draft.source, 'template');
    assert.ok(template.body.draft.text.length > 0);
    await agent.patch(`/api/conversations/${id}`).set('Origin', origin).send({ automationPaused: true });
    const paused = await agent.post(`/api/conversations/${id}/draft`).set('Origin', origin).send({});
    assert.equal(paused.status, 409);
    assert.equal(paused.body.error.code, 'drafts_paused');
    assert.deepEqual((await agent.get(`/api/conversations/${id}`)).body.messages, before);
    assert.deepEqual((await agent.get('/api/jobs')).body.jobs, jobsBefore);
    assert.equal(networkCalls, 0);
  }, { aiApiKey: '', fetchImpl: async () => { networkCalls++; throw new Error('Unexpected external call'); } });
});

test('AI draft stays a human-reviewed proposal and provider errors do not expose credentials', async () => {
  let providerCalls = 0;
  let failProvider = false;
  const proposedText = 'Please share your address and preferred time so our team can check availability.';
  const fetchImpl: typeof fetch = async (url, options) => {
    providerCalls++;
    assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
    assert.equal(options?.redirect, 'error');
    if (failProvider) throw new Error('private-ai-key-should-not-leak');
    return new Response(JSON.stringify({ choices: [{ message: { content: proposedText }, finish_reason: 'stop' }] }), { status: 200 });
  };
  await fixture(async app => {
    const agent = await authenticated(app);
    const id = (await agent.get('/api/conversations')).body.conversations[0].id;
    const before = (await agent.get(`/api/conversations/${id}`)).body.messages;
    await agent.patch('/api/settings').set('Origin', origin).send({ automationEnabled: true });
    const draft = await agent.post(`/api/conversations/${id}/draft`).set('Origin', origin).send({});
    assert.equal(draft.status, 200);
    assert.equal(draft.body.draft.source, 'ai');
    assert.equal(draft.body.draft.text, proposedText);
    assert.match(draft.body.draft.reason, /review/i);
    assert.equal(providerCalls, 1);
    assert.deepEqual((await agent.get(`/api/conversations/${id}`)).body.messages, before);
    assert.ok(!JSON.stringify((await agent.get('/api/settings')).body).includes('private-ai-key-should-not-leak'));
    failProvider = true;
    const failure = await agent.post(`/api/conversations/${id}/draft`).set('Origin', origin).send({});
    assert.equal(failure.status, 502);
    assert.equal(failure.body.error.code, 'draft_failed');
    assert.ok(!JSON.stringify(failure.body).includes('private-ai-key-should-not-leak'));
    assert.equal(providerCalls, 2, 'Provider failures must not cause automatic retries');
    assert.deepEqual((await agent.get(`/api/conversations/${id}`)).body.messages, before);
  }, { aiApiKey: 'private-ai-key-should-not-leak', fetchImpl });
});

test('demo workspace rejects provider webhooks even when live secrets are accidentally configured', async () => {
  await fixture(async app => {
    const agent = await authenticated(app);
    const before = (await agent.get('/api/conversations')).body.conversations;
    const payload = signed(inboundWebhook('wamid.do-not-ingest-demo'));
    const delivery = await request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', payload.signature).send(payload.body);
    assert.equal(delivery.status, 503);
    const challenge = await request(app).get('/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': verifyToken, 'hub.challenge': 'do-not-register-demo' });
    assert.equal(challenge.status, 503);
    assert.deepEqual((await agent.get('/api/conversations')).body.conversations, before);
  }, { whatsappToken: 'test-private-access-token', whatsappPhoneId: 'phone-test', whatsappAppSecret: appSecret, whatsappVerifyToken: verifyToken });
});

for (const scenario of [{ name: 'a later second', delay: 1000, earlyStatus: false }, { name: 'the same second', delay: 500, earlyStatus: true }]) {
test(`a customer reply arriving during a provider send in ${scenario.name} retains its unread alert and preview`, async context => {
  context.mock.timers.enable({ apis: ['Date'], now: Math.floor(Date.now() / 1000) * 1000 + 100 });
  let providerStarted!: () => void;
  let resolveProvider!: (response: Response) => void;
  const started = new Promise<void>(resolve => { providerStarted = resolve; });
  const providerResponse = new Promise<Response>(resolve => { resolveProvider = resolve; });
  const fetchImpl: typeof fetch = async () => {
    providerStarted();
    return providerResponse;
  };
  await fixture(async app => {
    const cookie = await liveCookie(app);
    const id = await liveCustomer(app, cookie);
    const outboundText = 'Would tomorrow morning suit you?';
    const sendPromise = request(app).post(`/api/conversations/${id}/messages`).set('Origin', 'https://handyman.test').set('Cookie', cookie).send({ text: outboundText, idempotencyKey: randomUUID() }).then(response => response);
    try {
      await Promise.race([started, sendPromise.then(response => { throw new Error(`Send completed before provider was called: ${response.status}`); })]);
      const pending = (await request(app).get(`/api/conversations/${id}`).set('Cookie', cookie)).body;
      assert.equal(pending.conversation.preview, outboundText);
      assert.equal(pending.conversation.unreadCount, 0);
      assert.ok(pending.messages.some((message: { status: string }) => message.status === 'pending'));
      context.mock.timers.tick(scenario.delay);
      const customerText = 'Actually, please make it Friday afternoon.';
      const incoming = signed(inboundWebhook('wamid.arrived-during-send', customerText));
      assert.equal((await request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', incoming.signature).send(incoming.body)).status, 200);
      const receivedAt = new Date(Math.max(new Date(pending.conversation.updatedAt).getTime(), Math.floor(Date.now() / 1000) * 1000)).toISOString();
      if (scenario.earlyStatus) {
        for (const status of ['read', 'sent']) {
          const event = signed({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'phone-test' }, statuses: [{ id: 'wamid.send-completed-later', status }] } }] }] });
          assert.equal((await request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', event.signature).send(event.body)).status, 200);
        }
      }
      resolveProvider(new Response(JSON.stringify({ messages: [{ id: 'wamid.send-completed-later' }] }), { status: 200 }));
      const completed = await sendPromise;
      assert.equal(completed.status, 201);
      assert.equal(completed.body.conversation.preview, customerText);
      assert.equal(completed.body.conversation.unreadCount, 1);
      assert.equal(completed.body.conversation.updatedAt, receivedAt);
      assert.equal(completed.body.message.status, scenario.earlyStatus ? 'read' : 'sent', 'Status arriving before the provider response must be reconciled');
      const detail = (await request(app).get(`/api/conversations/${id}`).set('Cookie', cookie)).body;
      assert.equal(detail.conversation.preview, customerText);
      assert.equal(detail.conversation.unreadCount, 1);
      assert.ok(detail.messages.some((message: { text: string; direction: string }) => message.text === customerText && message.direction === 'inbound'));
      const outbound = detail.messages.find((message: { text: string }) => message.text === outboundText);
      assert.equal(outbound.status, scenario.earlyStatus ? 'read' : 'sent');
      assert.equal(outbound.providerId, 'wamid.send-completed-later');
    } finally {
      resolveProvider(new Response(JSON.stringify({ messages: [{ id: 'wamid.send-completed-later' }] }), { status: 200 }));
      await sendPromise;
    }
  }, { ...liveOptions, fetchImpl });
});
}
