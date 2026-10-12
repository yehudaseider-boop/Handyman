import assert from 'node:assert/strict';
import {createHmac, randomUUID} from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import {createApp} from '../server/app.js';
import type {AppOptions} from '../server/types.js';

const origin = 'https://handyman.test';
const credentials = {email: 'owner@example.test', password: 'Testing-only-password-2026!'};
const secret = 'test-app-secret';
const configured: AppOptions = {mode:'live', appOrigin:origin, secureCookies:true, whatsappToken:'private-test-token', whatsappPhoneId:'phone-test', whatsappAppSecret:secret, whatsappVerifyToken:'private-test-verify'};

async function fixture(run: (app:ReturnType<typeof createApp>, agent:ReturnType<typeof request.agent>) => Promise<void>, options:AppOptions = configured) {
  const app = createApp({dbPath:':memory:',adminEmail:credentials.email,adminPassword:credentials.password,whatsappToken:'',whatsappPhoneId:'',whatsappAppSecret:'',whatsappVerifyToken:'',aiApiKey:'',...options});
  try {
    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').set('Origin',options.appOrigin ?? origin).send(credentials);
    assert.equal(login.status,200);
    agent.set('Cookie',String(login.headers['set-cookie'][0]).split(';')[0]!);
    await run(app,agent);
  } finally {app.locals.close();}
}

function incoming(id = randomUUID(), text = 'Please repair my kitchen tap') {
  return {object:'whatsapp_business_account',entry:[{changes:[{value:{metadata:{phone_number_id:'phone-test'},messages:[{id,from:'27820000123',timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:text}}]}}]}]};
}

function webhook(app:ReturnType<typeof createApp>, payload:object) {
  const raw=JSON.stringify(payload);
  return request(app).post('/webhooks/whatsapp').set('Content-Type','application/json').set('X-Hub-Signature-256',`sha256=${createHmac('sha256',secret).update(raw).digest('hex')}`).send(raw);
}

test('unsupported media requests human follow-up without fabricating intake from a system notice', async () => {
  await fixture(async (app, agent) => {
    const event = {object:'whatsapp_business_account',entry:[{changes:[{value:{metadata:{phone_number_id:'phone-test'},messages:[{id:randomUUID(),from:'27820000123',timestamp:String(Math.floor(Date.now()/1000)),type:'image',image:{id:'test-image-id',mime_type:'image/jpeg'}}]}}]}]};
    assert.equal((await webhook(app,event)).status,200);
    const id = String((await agent.get('/api/conversations')).body.conversations[0].id);
    const detail = (await agent.get(`/api/conversations/${id}`)).body;
    assert.equal(detail.conversation.status,'waiting');
    assert.equal(detail.conversation.automationPaused,true);
    assert.match(detail.messages[0].text,/media cannot be opened here/);
    assert.match(detail.messages[0].text,/written description/);
    const extracted = await agent.post(`/api/conversations/${id}/intake/analyze`).set('Origin',origin).send({expectedVersion:0});
    assert.equal(extracted.status,200);
    assert.equal(extracted.body.intake.summary,'');
    assert.ok(extracted.body.intake.missingFields.includes('summary'));
    assert.deepEqual(extracted.body.intake.evidence,[]);
    const converted = await agent.post(`/api/conversations/${id}/intake/job`).set('Origin',origin).send({expectedVersion:extracted.body.intake.version});
    assert.equal(converted.status,409);
    assert.equal(converted.body.error.code,'intake_incomplete');
  });
});

async function customer(app:ReturnType<typeof createApp>, agent:ReturnType<typeof request.agent>) {
  assert.equal((await webhook(app,incoming())).status,200);
  return String((await agent.get('/api/conversations')).body.conversations[0].id);
}

test('integration readiness requires a session and reports local checks without exposing credentials or claiming provider verification', async () => {
  await fixture(async(app,agent) => {
    assert.equal((await request(app).get('/api/integration/readiness')).status,401);
    const response=await agent.get('/api/integration/readiness');
    assert.equal(response.status,200);
    assert.equal(response.body.ready,true);
    assert.equal(response.body.providerVerified,false);
    assert.equal(response.body.automaticReplies,false);
    assert.equal(response.body.webhookUrl,`${origin}/webhooks/whatsapp`);
    assert.deepEqual(response.body.missingNames,[]);
    for(const value of ['private-test-token',secret,'private-test-verify']) assert.ok(!JSON.stringify(response.body).includes(value));
  });
  await fixture(async(_app,agent) => {
    const result=(await agent.get('/api/integration/readiness')).body;
    assert.equal(result.ready,false);
    assert.equal(result.webhookUrl,null);
    assert.ok(result.missingNames.includes('APP_MODE=live'));
    assert.ok(result.missingNames.includes('WHATSAPP_ACCESS_TOKEN'));
  },{mode:'demo',appOrigin:'http://localhost:5173',secureCookies:false});
});

for(const rejection of [
  {http:401,code:190,status:503,error:'integration_auth_failed'},
  {http:400,code:131047,status:409,error:'template_required'},
  {http:429,code:130429,status:429,error:'provider_rate_limited'},
  {http:400,code:131026,status:502,error:'send_rejected'},
]) test(`definite WhatsApp rejection ${rejection.code} is failed, sanitized, idempotent, and routed to human review`,async() => {
  let calls=0;
  await fixture(async(app,agent) => {
    const id=await customer(app,agent);
    const payload={text:'Our team will check availability.',idempotencyKey:randomUUID()};
    const sent=await agent.post(`/api/conversations/${id}/messages`).set('Origin',origin).send(payload);
    assert.equal(sent.status,rejection.status);
    assert.equal(sent.body.error.code,rejection.error);
    assert.ok(!JSON.stringify(sent.body).includes('private-provider-diagnostic'));
    const detail=(await agent.get(`/api/conversations/${id}`)).body;
    assert.equal(detail.messages.at(-1).status,'failed');
    assert.equal(detail.conversation.status,'waiting');
    assert.equal(detail.conversation.automationPaused,true);
    const replay=await agent.post(`/api/conversations/${id}/messages`).set('Origin',origin).send(payload);
    assert.equal(replay.status,200);
    assert.equal(replay.body.message.status,'failed');
    assert.equal(calls,1);
    assert.equal((await webhook(app,incoming(randomUUID(),'Here is another detail'))).status,200);
    assert.equal((await agent.get(`/api/conversations/${id}`)).body.conversation.status,'waiting');
  },{...configured,fetchImpl:async() => {calls++;return new Response(JSON.stringify({error:{code:rejection.code,message:'private-provider-diagnostic private-test-token'}}),{status:rejection.http});}});
});

test('provider server errors and oversized or malformed acceptance bodies remain unconfirmed and cannot cause duplicate sends',async() => {
  for(const response of [
    () => new Response(JSON.stringify({error:{code:2}}),{status:503}),
    () => new Response('{not valid JSON'),
    () => new Response(JSON.stringify({messages:[{id:123}]})),
    () => new Response('x'.repeat(65_537)),
  ]) {
    let calls=0;
    await fixture(async(app,agent) => {
      const id=await customer(app,agent);
      const sent=await agent.post(`/api/conversations/${id}/messages`).set('Origin',origin).send({text:'We are reviewing your request.'});
      assert.equal(sent.status,502);
      assert.equal(sent.body.error.code,'send_unconfirmed');
      const repeated=await agent.post(`/api/conversations/${id}/messages`).set('Origin',origin).send({text:'We are reviewing your request.'});
      assert.equal(repeated.status,409);
      assert.equal(calls,1);
    },{...configured,fetchImpl:async() => {calls++;return response();}});
  }
});

test('an explicit token rejection does not wait for a stalled diagnostic body',async() => {
  let cancelled=false;
  await fixture(async(app,agent) => {
    const id=await customer(app,agent);
    const result=await agent.post(`/api/conversations/${id}/messages`).set('Origin',origin).send({text:'Our team will review this.'});
    assert.equal(result.status,503);
    assert.equal(result.body.error.code,'integration_auth_failed');
    assert.equal(cancelled,true);
    assert.equal((await agent.get(`/api/conversations/${id}`)).body.messages.at(-1).status,'failed');
  },{...configured,fetchImpl:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:401})});
});

test('the provider deadline covers a fetch implementation that ignores abort and a stalled response body',async context => {
  context.mock.timers.enable({apis:['setTimeout']});
  for(const stalledBody of [false,true]) {
    let started!:()=>void;
    const providerStarted=new Promise<void>(resolve => {started=resolve;});
    let cancelled=false;
    const fetchImpl:typeof fetch=async() => {
      started();
      if(!stalledBody) return new Promise<Response>(() => {});
      return new Response(new ReadableStream({cancel(){cancelled=true;}}));
    };
    await fixture(async(app,agent) => {
      const id=await customer(app,agent);
      const sending=agent.post(`/api/conversations/${id}/messages`).set('Origin',origin).send({text:'Checking a visit for you.'}).then(response=>response);
      await providerStarted;
      // The request deadline was registered before invoking the provider.
      context.mock.timers.tick(15_000);
      const result=await sending;
      assert.equal(result.status,502);
      assert.equal(result.body.error.code,'send_unconfirmed');
      if(stalledBody) assert.equal(cancelled,true);
    },{...configured,fetchImpl});
  }
});

test('delivery failure callbacks preserve a human handoff and never regress delivered or read messages',async() => {
  await fixture(async(app,agent) => {
    const id=await customer(app,agent);
    const send=await agent.post(`/api/conversations/${id}/messages`).set('Origin',origin).send({text:'The request is with our team.'});
    assert.equal(send.status,201);
    const statuses=(status:string) => ({object:'whatsapp_business_account',entry:[{changes:[{value:{metadata:{phone_number_id:'phone-test'},statuses:[{id:'wamid.delivery-test',status}]}}]}]});
    assert.equal((await webhook(app,statuses('failed'))).status,200);
    let detail=(await agent.get(`/api/conversations/${id}`)).body;
    assert.equal(detail.messages.at(-1).status,'failed');
    assert.equal(detail.conversation.status,'waiting');
    assert.equal(detail.conversation.automationPaused,true);
    for(const state of ['delivered','read','failed']) assert.equal((await webhook(app,statuses(state))).status,200);
    detail=(await agent.get(`/api/conversations/${id}`)).body;
    assert.equal(detail.messages.at(-1).status,'read');
    assert.equal((await webhook(app,incoming(randomUUID(),'Please let the operator know'))).status,200);
    assert.equal((await agent.get(`/api/conversations/${id}`)).body.conversation.status,'waiting');
  },{...configured,fetchImpl:async()=>new Response(JSON.stringify({messages:[{id:'wamid.delivery-test'}]}))});
});

test('the live reply window fails closed for future, invalid, and exactly 24-hour-old stored timestamps',async context => {
  context.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-12T12:00:00.000Z')});
  let calls=0;
  await fixture(async(app,agent) => {
    const id=await customer(app,agent);
    for(const value of ['2026-10-13T12:00:00.000Z','not-a-date','2026-10-11T12:00:00.000Z']) {
      app.locals.db.prepare("UPDATE messages SET created_at=? WHERE conversation_id=? AND direction='inbound'").run(value,id);
      const denied=await agent.post(`/api/conversations/${id}/messages`).set('Origin',origin).send({text:'This must never send.'});
      assert.equal(denied.status,409);
      assert.equal(denied.body.error.code,'template_required');
    }
    assert.equal(calls,0);
  },{...configured,fetchImpl:async()=>{calls++;throw new Error('Unexpected provider call');}});
});

test('conversation history is bounded, stable within the same second, and cursors cannot cross customer boundaries',async() => {
  await fixture(async(app,agent) => {
    const id=await customer(app,agent);
    const createdAt=new Date().toISOString();
    const expected:string[]=[];
    for(let index=0;index<125;index++) {
      const messageId=randomUUID();
      expected.push(messageId);
      app.locals.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(messageId,id,'inbound',`Message ${index}`,createdAt,'received',null);
    }
    const latest=(await agent.get(`/api/conversations/${id}`)).body;
    assert.equal(latest.messages.length,50);
    assert.deepEqual(latest.messages.map((item:{id:string})=>item.id),expected.slice(-50));
    assert.equal(latest.pagination.hasMore,true);
    const older=(await agent.get(`/api/conversations/${id}`).query({before:latest.pagination.before,limit:50})).body;
    assert.deepEqual(older.messages.map((item:{id:string})=>item.id),expected.slice(25,75));
    const first=(await agent.get(`/api/conversations/${id}`).query({before:older.pagination.before,limit:50})).body;
    assert.equal(first.messages.length,26);
    assert.equal(first.pagination.hasMore,false);
    const seen=[...first.messages,...older.messages,...latest.messages].map(item=>item.id);
    assert.equal(new Set(seen).size,126);
    app.locals.db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?)').run('different-customer','Other customer','+27820000999','',createdAt,0,'open','',0,'General');
    assert.equal((await agent.get('/api/conversations/different-customer').query({before:latest.pagination.before})).status,400);
    assert.equal((await agent.get(`/api/conversations/${id}`).query({limit:101})).status,400);
  });
});

test('a webhook transaction rolls back all newly created customers and messages when one insertion fails',async() => {
  await fixture(async(app,agent) => {
    app.locals.db.exec("CREATE TRIGGER reject_test_message BEFORE INSERT ON messages WHEN NEW.text='reject this message' BEGIN SELECT RAISE(ABORT,'test insertion failure'); END");
    const payload=incoming();
    payload.entry[0]!.changes[0]!.value.messages.push({...payload.entry[0]!.changes[0]!.value.messages[0]!,id:randomUUID(),text:{body:'reject this message'}});
    assert.equal((await webhook(app,payload)).status,500);
    assert.deepEqual((await agent.get('/api/conversations')).body.conversations,[]);
    assert.equal(Number(app.locals.db.prepare('SELECT count(*) AS n FROM messages').get()!.n),0);
  });
});

test('password rotation during async verification prevents an old credential from creating a new session',async() => {
  await fixture(async(app,_agent) => {
    const db=app.locals.db;
    const prepare=db.prepare.bind(db);
    let changed=false;
    db.prepare=(sql:string) => {
      const statement=prepare(sql);
      if(sql !== 'SELECT * FROM users WHERE email=?') return statement;
      return new Proxy(statement,{get(target,key){
        if(key === 'get') return (...args:unknown[]) => {
          const row=Reflect.apply(target.get,target,args);
          queueMicrotask(() => {prepare('UPDATE users SET password_hash=?').run('different-password-hash');prepare('DELETE FROM sessions').run();changed=true;});
          return row;
        };
        const value=Reflect.get(target,key);
        return typeof value === 'function' ? value.bind(target) : value;
      }});
    };
    const response=await request(app).post('/api/auth/login').set('Origin',origin).send(credentials);
    assert.equal(changed,true);
    assert.equal(response.status,401);
    assert.equal(Number(prepare('SELECT count(*) AS n FROM sessions').get()!.n),0);
  });
});

for(const change of ['pause','settings','inbound']) test(`an AI draft cannot bypass a ${change} change made while its provider request is running`,async() => {
  let started!:()=>void,complete!:(response:Response)=>void;
  const providerStarted=new Promise<void>(resolve=>{started=resolve;});
  const providerResult=new Promise<Response>(resolve=>{complete=resolve;});
  await fixture(async(app,agent) => {
    const id=await customer(app,agent);
    assert.equal((await agent.patch('/api/settings').set('Origin',origin).send({automationEnabled:true})).status,200);
    const pending=agent.post(`/api/conversations/${id}/draft`).set('Origin',origin).send({}).then(response=>response);
    try {
      await providerStarted;
      if(change==='pause') await agent.patch(`/api/conversations/${id}`).set('Origin',origin).send({automationPaused:true});
      if(change==='settings') await agent.patch('/api/settings').set('Origin',origin).send({businessName:'Updated business'});
      if(change==='inbound') await webhook(app,incoming(randomUUID(),'Actually I need a different day'));
      complete(new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'Could you share your address?'}}]})));
      const result=await pending;
      assert.equal(result.status,409);
      assert.equal(result.body.error.code,change==='pause'?'drafts_paused':change==='settings'?'settings_changed':'conversation_changed');
      assert.ok(!result.body.draft);
    } finally {complete(new Response('{}'));await pending;}
  },{...configured,aiApiKey:'private-ai-test-key',fetchImpl:async()=>{started();return providerResult;}});
});
