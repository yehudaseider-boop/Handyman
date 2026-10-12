import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import request from 'supertest';
import {createApp} from '../server/app.js';

const origin='http://localhost:5173';
const credentials={email:'recovery@example.test',password:'Recovery-test-password-2026!'};
async function login(app:ReturnType<typeof createApp>) {
  const agent=request.agent(app);
  assert.equal((await agent.post('/api/auth/login').set('Origin',origin).send(credentials)).status,200);
  return agent;
}

test('operator stop is idempotent and independent of stale versions without changing other limits',async()=>{
  const app=createApp({mode:'demo',dbPath:':memory:',appOrigin:origin,adminEmail:credentials.email,adminPassword:credentials.password});
  try {
    assert.equal((await request(app).post('/api/automation/stop').set('Origin',origin).send({})).status,401);
    const agent=await login(app);
    assert.equal((await agent.post('/api/automation/stop').set('Origin','https://untrusted.test').send({})).status,403);
    assert.equal((await agent.post('/api/automation/stop').set('Origin',origin).send({enabled:true})).status,400);
    const {knowledge}=(await agent.get('/api/knowledge')).body;const {version,...facts}=knowledge;
    await agent.patch('/api/knowledge').set('Origin',origin).send({...facts,approved:true,expectedVersion:version}).expect(200);
    const {policy}=(await agent.get('/api/automation')).body;
    await agent.patch('/api/automation').set('Origin',origin).send({enabled:true,maxRepliesPerMinute:2,expectedVersion:policy.version}).expect(200);
    const stopped=await agent.post('/api/automation/stop').set('Origin',origin).send({});
    assert.equal(stopped.status,200);assert.equal(stopped.body.policy.enabled,false);assert.equal(stopped.body.policy.maxRepliesPerMinute,2);
    const again=await agent.post('/api/automation/stop').set('Origin',origin).send({});
    assert.equal(again.status,200);assert.equal(again.body.policy.version,stopped.body.policy.version);
  } finally {await app.locals.automationDrain();app.locals.close();}
});

test('restart discards queued work, retains uncertain sends, pauses the customer and never retries a provider',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'handyman-recovery-'));
  let calls=0;
  const options={mode:'demo' as const,dbPath:join(directory,'reception.sqlite'),appOrigin:origin,adminEmail:credentials.email,adminPassword:credentials.password,fetchImpl:(async()=>{calls++;throw new Error('No provider should be contacted');}) as typeof fetch};
  let app=createApp(options);
  const inbound=randomUUID(),queued=randomUUID(),outbound=randomUUID(),now=new Date().toISOString();
  try {
    app.locals.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(inbound,'demo-conv-1','inbound','Hello',now,'received',null);
    app.locals.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(queued,'demo-conv-2','inbound','Hello',now,'received',null);
    app.locals.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(outbound,'demo-conv-1','outbound','A previously submitted reply',now,'pending',null);
    const claim=app.locals.db.prepare('INSERT INTO automation_claims (inbound_id,conversation_id,status,knowledge_version,policy_version,outbound_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)');
    claim.run(inbound,'demo-conv-1','sending',1,1,outbound,now,now);
    claim.run(queued,'demo-conv-2','queued',1,1,null,now,now);
    app.locals.close();app=createApp(options);
    await app.locals.automationDrain();
    assert.equal(calls,0);
    assert.equal(app.locals.db.prepare('SELECT status FROM messages WHERE id=?').get(outbound).status,'unconfirmed');
    assert.equal(app.locals.db.prepare('SELECT status FROM automation_claims WHERE inbound_id=?').get(inbound).status,'unconfirmed');
    assert.equal(app.locals.db.prepare('SELECT status FROM automation_claims WHERE inbound_id=?').get(queued).status,'skipped');
    const conversation=app.locals.db.prepare('SELECT automation_paused,status FROM conversations WHERE id=?').get('demo-conv-1');
    assert.equal(conversation.automation_paused,1);assert.equal(conversation.status,'waiting');
    const agent=await login(app);
    assert.equal((await agent.get('/api/conversations/demo-conv-1')).status,200);
    assert.equal(calls,0);
  } finally {await app.locals.automationDrain();app.locals.close();await rm(directory,{recursive:true,force:true});}
});

test('a human request received while reception is off stays paused after approval and activation',async()=>{
  const app=createApp({mode:'demo',dbPath:':memory:',appOrigin:origin,adminEmail:credentials.email,adminPassword:credentials.password});
  try {
    const agent=await login(app);
    const first=await agent.post('/api/demo/inbound').set('Origin',origin).send({conversationId:'demo-conv-1',text:'Please let me speak to a human.'});
    assert.equal(first.status,201);assert.equal(first.body.conversation.automationPaused,true);
    const {knowledge}= (await agent.get('/api/knowledge')).body;
    const {version,...facts}=knowledge;
    assert.equal((await agent.patch('/api/knowledge').set('Origin',origin).send({...facts,approved:true,expectedVersion:version})).status,200);
    const {policy}=(await agent.get('/api/automation')).body;
    assert.equal((await agent.patch('/api/automation').set('Origin',origin).send({enabled:true,businessHoursOnly:false,expectedVersion:policy.version})).status,200);
    const before=(await agent.get('/api/conversations/demo-conv-1')).body.messages.length;
    const next=await agent.post('/api/demo/inbound').set('Origin',origin).send({conversationId:'demo-conv-1',text:'Hi'});
    assert.equal(next.status,201);assert.equal(next.body.conversation.automationPaused,true);
    assert.equal((await agent.get('/api/conversations/demo-conv-1')).body.messages.length,before+1);
    assert.ok(!next.body.automation?.outboundMessage);
  } finally {await app.locals.automationDrain();app.locals.close();}
});
