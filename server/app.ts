import express, { type Request, type Response, type NextFunction } from 'express';
import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { audit, conversation, intake, job, message, openDatabase } from './db.js';
import type { AppOptions, Message, Job, Intake } from './types.js';
import { generateAiDraft } from './ai.js';
import { analyzeIntake } from './intake.js';
import { isMediaNotice } from './message-content.js';
import { readBoundedJson, discardProviderBody } from './ai-response.js';
import { knowledgeSchema, automationPolicySchema, emptyKnowledge, demoKnowledge, defaultAutomationPolicy, decideReception, evaluateReceptionSafety, type Knowledge, type AutomationPolicy, type ReceptionDecision } from './reception.js';

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Record<string, unknown>) { super(message); }
}
const text = (limit = 2000) => z.string().trim().min(1).max(limit);
const phone = z.string().trim().regex(/^\+[1-9]\d{7,14}$/, 'Use an international phone number, for example +27821234567');
const timestamp = z.union([z.literal(''), z.string().datetime({ offset: true })]);
const jobSchema = z.object({ title: text(160), customerName: text(120), phone, category: text(80).default('General'), address: z.string().trim().max(500).default(''), scheduledAt: timestamp.default(''), status: z.enum(['new', 'scheduled', 'in_progress', 'completed']).default('new'), notes: z.string().trim().max(5000).default(''), conversationId: z.string().min(1).max(80).nullable().optional(), assignedTo: text(100).default('Team'), durationMinutes: z.number().int().min(15).max(480).default(60) }).strict();
const jobPatchSchema = z.object({title: text(160).optional(), customerName: text(120).optional(), phone: phone.optional(), category:text(80).optional(), address:z.string().trim().max(500).optional(), scheduledAt:timestamp.optional(), status:z.enum(['new','scheduled','in_progress','completed']).optional(), notes:z.string().trim().max(5000).optional(), conversationId:z.string().min(1).max(80).nullable().optional(), assignedTo:text(100).optional(), durationMinutes:z.number().int().min(15).max(480).optional(), expectedVersion:z.number().int().min(1).optional()}).strict().refine(value => Object.keys(value).some(key => key !== 'expectedVersion'), 'Provide a field to update');
const settingsSchema = z.object({ businessName: text(120), businessHours: text(500), welcomeMessage: text(2000), awayMessage: text(2000), automationEnabled: z.boolean() }).strict();
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export function createApp(options: AppOptions = {}) {
  if (process.env.APP_MODE && !['demo', 'live'].includes(process.env.APP_MODE)) throw new Error('APP_MODE must be demo or live.');
  const mode = options.mode ?? (process.env.APP_MODE === 'live' ? 'live' : 'demo');
  const email = (options.adminEmail ?? process.env.ADMIN_EMAIL ?? (mode === 'demo' ? 'admin@handyman.local' : '')).trim().toLowerCase();
  const password = options.adminPassword ?? process.env.ADMIN_PASSWORD ?? (mode === 'demo' ? 'DemoPass!2026' : '');
  if (!email || !password || password.length > 256 || (mode === 'live' && (password.length < 16 || password === 'DemoPass!2026'))) throw new Error('Live mode requires ADMIN_EMAIL and a unique ADMIN_PASSWORD between 16 and 256 characters.');
  if (!z.string().email().safeParse(email).success) throw new Error('ADMIN_EMAIL must be a valid email address.');
  const origin = new URL(options.appOrigin ?? process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173').origin;
  const secureCookies = options.secureCookies ?? (mode === 'live');
  if (mode === 'live' && !origin.startsWith('https://')) throw new Error('Live mode requires an HTTPS APP_ORIGIN.');
  if (mode === 'live' && !secureCookies) throw new Error('Live mode requires secure session cookies.');
  const whatsappToken = options.whatsappToken ?? process.env.WHATSAPP_ACCESS_TOKEN;
  const whatsappPhoneId = options.whatsappPhoneId ?? process.env.WHATSAPP_PHONE_NUMBER_ID;
  const appSecret = options.whatsappAppSecret ?? process.env.WHATSAPP_APP_SECRET;
  const verifyToken = options.whatsappVerifyToken ?? process.env.WHATSAPP_VERIFY_TOKEN;
  const aiApiKey = options.aiApiKey ?? process.env.AI_API_KEY;
  const aiModel = options.aiModel ?? process.env.AI_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const allowLiveAutomation = options.allowLiveAutomation ?? process.env.ALLOW_LIVE_AUTOMATION === '1';
  const db = openDatabase(options.dbPath ?? process.env.DB_PATH ?? process.env.DATABASE_PATH ?? resolve(`data/handyman-${mode}.sqlite`), mode, email, password);
  const app = express();
  app.disable('x-powered-by');
  app.locals.db = db;
  let databaseClosed = false;
  app.locals.close = () => { if (!databaseClosed) { databaseClosed = true; db.close(); } };
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  const requestAttempts = new Map<string, { count: number; resetAt: number }>();
  const intakeAttempts = new Map<string, { count: number; resetAt: number }>();
  const draftAttempts = new Map<string, { count: number; resetAt: number }>();
  let passwordVerifications = 0;
  const SESSION_DURATION = 8 * 60 * 60 * 1000;
  const getConversation = (id: string) => {
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'not_found', 'Conversation not found.');
    return conversation(row);
  };
  const getJob = (id: string) => {
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'not_found', 'Job not found.');
    return job(row);
  };
  const getIntake = (id: string): Intake | null => {
    const row = db.prepare('SELECT * FROM intakes WHERE conversation_id=?').get(id);
    return row ? intake(row) : null;
  };
  const checkVersion = (current: number, expected: number) => { if (current !== expected) throw new HttpError(409, 'version_conflict', 'This record changed. Reload it before saving.', {currentVersion: current}); };
  const checkSchedule = (selected: Pick<Job, 'id'|'status'|'scheduledAt'|'assignedTo'|'durationMinutes'>) => {
    if (!['scheduled', 'in_progress'].includes(selected.status)) return;
    if (!selected.scheduledAt || !Number.isFinite(Date.parse(selected.scheduledAt)) || !selected.assignedTo.trim()) throw new HttpError(400, 'schedule_required', 'Scheduled jobs require a valid date, time, and assigned team member.');
    const start = Date.parse(selected.scheduledAt), end = start + selected.durationMinutes * 60_000;
    const conflict = db.prepare("SELECT * FROM jobs WHERE id!=? AND status IN ('scheduled','in_progress') AND lower(trim(assigned_to))=lower(trim(?)) AND scheduled_at!=''").all(selected.id, selected.assignedTo).find(row => { const otherStart=Date.parse(String(row.scheduled_at)); return Number.isFinite(otherStart) && start < otherStart + Number(row.duration_minutes) * 60_000 && end > otherStart; });
    if (conflict) throw new HttpError(409, 'schedule_conflict', 'This team member already has a job during that time. Choose a different time or assignee.', {jobId: String(conflict.id), scheduledAt: String(conflict.scheduled_at), durationMinutes: Number(conflict.duration_minutes), assignedTo: String(conflict.assigned_to)});
  };
  const insertJob = (selected: Omit<Job, 'createdAt'|'updatedAt'|'version'>) => {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO jobs (id,title,customer_name,phone,category,address,scheduled_at,status,notes,created_at,updated_at,conversation_id,assigned_to,duration_minutes,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(selected.id, selected.title, selected.customerName, selected.phone, selected.category, selected.address, selected.scheduledAt, selected.status, selected.notes, now, now, selected.conversationId, selected.assignedTo, selected.durationMinutes, 1);
    return getJob(selected.id);
  };
  const transaction = <T,>(operation: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try { const result=operation(); db.exec('COMMIT'); return result; }
    catch(error) { db.exec('ROLLBACK'); throw error; }
  };
  const getSettings = () => {
    const row = db.prepare('SELECT * FROM settings WHERE id = 1').get()!;
    return { businessName: String(row.business_name), businessHours: String(row.business_hours), welcomeMessage: String(row.welcome_message), awayMessage: String(row.away_message), automationEnabled: Boolean(row.automation_enabled) };
  };
  type StoredKnowledge = Knowledge;
  type StoredPolicy = AutomationPolicy;
  const createdConfigAt = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO reception_config VALUES (?,?,?,?)').run('knowledge', JSON.stringify(mode === 'demo' ? demoKnowledge : emptyKnowledge), 1, createdConfigAt);
  db.prepare('INSERT OR IGNORE INTO reception_config VALUES (?,?,?,?)').run('automation', JSON.stringify(defaultAutomationPolicy), 1, createdConfigAt);
  let automationRunning = false;
  let automationScheduled = false;
  const drainWaiters: Array<() => void> = [];
  app.locals.automationDrain = () => new Promise<void>(resolve => {
    if (!automationRunning && !automationScheduled) resolve(); else drainWaiters.push(resolve);
  });

  function getKnowledge(): StoredKnowledge {
    const row = db.prepare("SELECT * FROM reception_config WHERE kind='knowledge'").get()!;
    return knowledgeSchema.parse({...JSON.parse(String(row.payload)), version: Number(row.version)});
  }
  function getPolicy(): StoredPolicy {
    const row = db.prepare("SELECT * FROM reception_config WHERE kind='automation'").get()!;
    return automationPolicySchema.parse({...JSON.parse(String(row.payload)), version: Number(row.version)});
  }
  function liveSendingAllowed() { return mode === 'live' && allowLiveAutomation && Boolean(whatsappToken && whatsappPhoneId && appSecret && verifyToken); }
  function liveAutomaticReplies() { return liveSendingAllowed() && getPolicy().enabled && getKnowledge().approved; }
  function policyResponse() { return {policy: getPolicy(), liveSendingAllowed: liveSendingAllowed(), mode}; }
  function storeConfig(kind: 'knowledge'|'automation', value: StoredKnowledge|StoredPolicy) {
    db.prepare('UPDATE reception_config SET payload=?,version=?,updated_at=? WHERE kind=?').run(JSON.stringify(value), value.version, new Date().toISOString(), kind);
  }
  function pauseForAutomation(id: string, reason: string) {
    db.prepare("UPDATE conversations SET status='waiting',automation_paused=1 WHERE id=?").run(id);
    audit(db, 'automation.handoff', reason);
  }
  function automationMessages(conversationId: string) {
    return db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY substr(created_at,1,19) DESC,rowid DESC LIMIT 12').all(conversationId).reverse().map(message);
  }
  function setClaim(inboundId: string, status: string, reasonCode: string) {
    if (databaseClosed) return;
    db.prepare('UPDATE automation_claims SET status=?,reason_code=?,updated_at=? WHERE inbound_id=?').run(status, reasonCode, new Date().toISOString(), inboundId);
  }
  function enforceInboundSafety(incoming: Message) {
    const knowledge=getKnowledge(),policy=getPolicy(),selected=getConversation(incoming.conversationId);
    if (selected.automationPaused) return null;
    // Safety and requests for a person remain pending across global off/on changes.
    // The temporary classifier flags below authorize no replies or provider calls.
    const decision=decideReception({knowledge:{...knowledge,approved:true},policy:{...policy,enabled:true,businessHoursOnly:false},messages:[incoming],paused:false});
    const safetyReasons=['dangerous_request','human_requested','sensitive_payment','prompt_injection','unsupported_media'];
    if (decision.action!=='handoff'||!safetyReasons.includes(decision.reasonCode)) return null;
    pauseForAutomation(selected.id,decision.reason);
    const now=new Date().toISOString();
    db.prepare('INSERT OR IGNORE INTO automation_claims (inbound_id,conversation_id,status,reason_code,knowledge_version,policy_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(incoming.id,selected.id,'handoff',decision.reasonCode,knowledge.version,policy.version,now,now);
    return decision;
  }
  function claimAutomation(inboundId: string): boolean {
    if (databaseClosed) return false;
    const inbound = db.prepare("SELECT * FROM messages WHERE id=? AND direction='inbound'").get(inboundId);
    if (!inbound || !getPolicy().enabled) return false;
    const knowledge = getKnowledge(), policy = getPolicy();
    if (!knowledge.approved) return false;
    const now = new Date().toISOString();
    const existing = db.prepare('SELECT inbound_id FROM automation_claims WHERE inbound_id=?').get(inboundId);
    if (existing) return false;
    db.prepare('INSERT INTO automation_claims (inbound_id,conversation_id,status,knowledge_version,policy_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(inboundId, String(inbound.conversation_id), 'queued', knowledge.version, policy.version, now, now);
    return true;
  }
  async function processAutomation(inboundId: string, alreadyClaimed = false): Promise<{decision: ReceptionDecision|null; status: string; outboundMessage?: Message}|null> {
    if (databaseClosed || (!alreadyClaimed && !claimAutomation(inboundId))) return null;
    const claim = db.prepare('SELECT * FROM automation_claims WHERE inbound_id=?').get(inboundId);
    if (!claim || claim.status !== 'queued') return null;
    const selected = getConversation(String(claim.conversation_id));
    const knowledge = getKnowledge(), policy = getPolicy();
    const messages = automationMessages(selected.id);
    const latest = messages.at(-1);
    if (!policy.enabled || !knowledge.approved || knowledge.version !== Number(claim.knowledge_version) || policy.version !== Number(claim.policy_version) || !latest || latest.id !== inboundId) {
      setClaim(inboundId, 'skipped', 'state_changed');
      return {decision: null, status: 'skipped'};
    }
    const decision = decideReception({knowledge, policy, messages, paused: selected.automationPaused});
    if (decision.action !== 'reply' || !decision.reply) {
      setClaim(inboundId, decision.action === 'handoff' ? 'handoff' : 'skipped', decision.reasonCode);
      if (decision.action === 'handoff') pauseForAutomation(selected.id, decision.reason);
      return {decision, status: decision.action === 'handoff' ? 'handoff' : 'skipped'};
    }
    if (mode === 'live' && !liveSendingAllowed()) {
      setClaim(inboundId, 'skipped', 'live_gate_closed');
      return {decision, status: 'skipped'};
    }
    const nowMs = Date.now(), dayStart = new Date(nowMs - 86_400_000).toISOString();
    const replies = db.prepare("SELECT COALESCE(dispatched_at,created_at) AS dispatched_at FROM automation_claims WHERE conversation_id=? AND outbound_id IS NOT NULL AND COALESCE(dispatched_at,created_at)>? ORDER BY COALESCE(dispatched_at,created_at) DESC").all(selected.id, dayStart);
    const globalCount = Number(db.prepare("SELECT count(*) AS n FROM automation_claims WHERE outbound_id IS NOT NULL AND COALESCE(dispatched_at,created_at)>?").get(new Date(nowMs - 60_000).toISOString())!.n);
    const tooFast = replies[0] && nowMs - Date.parse(String(replies[0].dispatched_at)) < policy.cooldownSeconds * 1000;
    if (replies.length >= policy.maxRepliesPerConversation || globalCount >= policy.maxRepliesPerMinute || tooFast) {
      setClaim(inboundId, 'handoff', 'reply_limit');
      pauseForAutomation(selected.id, 'Automatic reply budget reached. Human follow-up is required.');
      return {decision: {...decision, action:'handoff', reply:null, reasonCode:'reply_limit', reason:'Automatic reply budget reached. Human follow-up is required.'}, status:'handoff'};
    }
    if (mode === 'live') {
      const age = nowMs - Date.parse(latest.createdAt);
      if (!Number.isFinite(age) || age < 0 || age >= 86_400_000) {
        setClaim(inboundId, 'handoff', 'reply_window_closed'); pauseForAutomation(selected.id, 'The WhatsApp reply window is closed. Human follow-up is required.');
        return {decision:{...decision,action:'handoff',reply:null,reasonCode:'reply_window_closed',reason:'The WhatsApp reply window is closed.'},status:'handoff'};
      }
      if (db.prepare("SELECT id FROM messages WHERE conversation_id=? AND direction='outbound' AND status IN ('pending','unconfirmed') LIMIT 1").get(selected.id)) {
        setClaim(inboundId,'handoff','unconfirmed_send'); pauseForAutomation(selected.id,'An earlier reply is awaiting delivery confirmation. Human review is required.');
        return {decision:{...decision,action:'handoff',reply:null,reasonCode:'unconfirmed_send',reason:'An earlier reply is awaiting delivery confirmation.'},status:'handoff'};
      }
    }
    const outboundId = randomUUID(), now = new Date(nowMs).toISOString();
    // No await occurs between the final state checks and the persisted send claim.
    const reserved = transaction(() => {
      const reservedClaim = db.prepare("UPDATE automation_claims SET status='sending' WHERE inbound_id=? AND status='queued'").run(inboundId);
      if (Number(reservedClaim.changes)!==1) return false;
      db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(outboundId,selected.id,'outbound',decision.reply,now,mode==='demo'?'sent':'pending',null);
      db.prepare("UPDATE automation_claims SET status='sending',reason_code=?,reply=?,outbound_id=?,dispatched_at=?,updated_at=? WHERE inbound_id=?").run(decision.reasonCode,decision.reply,outboundId,now,now,inboundId);
      // Keep inbound unread alerts until an operator actually reviews them.
      db.prepare('UPDATE conversations SET preview=?,updated_at=? WHERE id=?').run(decision.reply,now,selected.id);
      return true;
    });
    if (!reserved) return {decision:null,status:'skipped'};
    if (mode === 'demo') {
      setClaim(inboundId,'sent',decision.reasonCode);
      audit(db,'automation.demo_reply','Approved rule-based demo reply recorded. No external message was sent.');
      return {decision,status:'sent',outboundMessage:message(db.prepare('SELECT * FROM messages WHERE id=?').get(outboundId)!)};
    }
    try {
      const outcome = await sendWhatsApp(fetchImpl,whatsappPhoneId!,whatsappToken!,selected.phone,decision.reply);
      if (databaseClosed) return {decision,status:'unconfirmed'};
      if (outcome.rejection) {
        db.prepare("UPDATE messages SET status='failed' WHERE id=?").run(outboundId);
        setClaim(inboundId,'failed',outcome.rejection.code);
        pauseForAutomation(selected.id,'WhatsApp rejected an automatic reply. Human review is required.');
        return {decision,status:'failed'};
      }
      const observed = db.prepare('SELECT status FROM provider_statuses WHERE provider_id=? AND received_at>?').get(outcome.providerId!,Date.now()-86_400_000);
      const deliveryStatus = observed ? advanceStatus('sent',String(observed.status)) : 'sent';
      db.prepare('UPDATE messages SET provider_id=?,status=? WHERE id=?').run(outcome.providerId!,deliveryStatus,outboundId);
      setClaim(inboundId,deliveryStatus==='failed'?'failed':'sent',decision.reasonCode);
      if (deliveryStatus==='failed') pauseForAutomation(selected.id,'WhatsApp reported an automatic reply delivery failure. Human review is required.');
      audit(db,'automation.reply','Approved rule-based automatic reply accepted by WhatsApp.');
      return {decision,status:deliveryStatus==='failed'?'failed':'sent',outboundMessage:message(db.prepare('SELECT * FROM messages WHERE id=?').get(outboundId)!)};
    } catch {
      if (!databaseClosed) {
        db.prepare("UPDATE messages SET status='unconfirmed' WHERE id=?").run(outboundId);
        setClaim(inboundId,'unconfirmed','send_unconfirmed');
        pauseForAutomation(selected.id,'An automatic WhatsApp reply could not be confirmed. Check WhatsApp before retrying.');
      }
      return {decision,status:'unconfirmed'};
    }
  }
  function queueAutomation(inboundId: string) {
    if (!claimAutomation(inboundId)) return;
    const queued = Number(db.prepare("SELECT count(*) AS n FROM automation_claims WHERE status='queued'").get()!.n);
    if (queued > 100) {
      const row = db.prepare('SELECT conversation_id FROM automation_claims WHERE inbound_id=?').get(inboundId)!;
      setClaim(inboundId,'handoff','queue_full'); pauseForAutomation(String(row.conversation_id),'Automatic reply queue is full. Human follow-up is required.'); return;
    }
    if (automationRunning || automationScheduled) return;
    automationScheduled = true;
    setImmediate(async () => {
      automationScheduled = false; automationRunning = true;
      try {
        while (!databaseClosed) {
          const queued = db.prepare("SELECT inbound_id FROM automation_claims WHERE status='queued' ORDER BY rowid LIMIT 1").get();
          if (!queued) break;
          try { await processAutomation(String(queued.inbound_id),true); }
          catch {
            const id=String(queued.inbound_id); setClaim(id,'failed','worker_failed');
            if (!databaseClosed) { const row=db.prepare('SELECT conversation_id FROM automation_claims WHERE inbound_id=?').get(id); if (row) pauseForAutomation(String(row.conversation_id),'Automatic reply processing failed. Human review is required.'); }
          }
        }
      } finally { automationRunning = false; for (const resolve of drainWaiters.splice(0)) resolve(); }
    });
  }

  const settingsResponse = () => ({ settings: getSettings(), integration: { mode, whatsappConfigured: Boolean(whatsappToken && whatsappPhoneId), webhookConfigured: mode === 'live' && Boolean(appSecret && verifyToken && whatsappPhoneId), aiConfigured: Boolean(aiApiKey), automaticReplies: liveAutomaticReplies() } });
  const readinessResponse = () => {
    const checks = { liveMode: mode === 'live', httpsOrigin: origin.startsWith('https://'), secureCookies, whatsappToken: Boolean(whatsappToken), whatsappPhoneId: Boolean(whatsappPhoneId), whatsappAppSecret: Boolean(appSecret), whatsappVerifyToken: Boolean(verifyToken) };
    const names = { liveMode: 'APP_MODE=live', httpsOrigin: 'APP_ORIGIN=https://…', secureCookies: 'secure session cookies', whatsappToken: 'WHATSAPP_ACCESS_TOKEN', whatsappPhoneId: 'WHATSAPP_PHONE_NUMBER_ID', whatsappAppSecret: 'WHATSAPP_APP_SECRET', whatsappVerifyToken: 'WHATSAPP_VERIFY_TOKEN' };
    return { mode, ready: Object.values(checks).every(Boolean), checks, missingNames: (Object.keys(checks) as Array<keyof typeof checks>).filter(key => !checks[key]).map(key => names[key]), webhookUrl: checks.liveMode && checks.httpsOrigin ? `${origin}/webhooks/whatsapp` : null, aiConfigured: Boolean(aiApiKey), automaticReplies: liveAutomaticReplies(), providerVerified: false };
  };
  const activity = (limit = 30) => db.prepare('SELECT id,action,detail,created_at AS createdAt FROM activity ORDER BY created_at DESC LIMIT ?').all(limit);
  const cookieToken = (req: Request) => {
    const match = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('handyman_session='));
    return match?.slice('handyman_session='.length);
  };
  const currentUser = (req: Request) => {
    const token = cookieToken(req);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    const row = db.prepare('SELECT u.id,u.email,u.name FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?').get(tokenHash(token), Date.now());
    return row ? { id: String(row.id), email: String(row.email), name: String(row.name) } : undefined;
  };
  const sessionCookieOptions = { httpOnly: true, sameSite: 'strict' as const, secure: secureCookies, path: '/' };

  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
    if (secureCookies) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.path.startsWith('/api/') || req.path.startsWith('/webhooks/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', (req, _res, next) => {
    const now = Date.now();
    if (requestAttempts.size > 10_000) for (const [key, value] of requestAttempts) if (value.resetAt <= now) requestAttempts.delete(key);
    const key = req.socket.remoteAddress ?? 'unknown';
    const previous = requestAttempts.get(key);
    const current = !previous || previous.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : previous;
    current.count += 1;
    requestAttempts.set(key, current);
    if (current.count > 240) return next(new HttpError(429, 'rate_limited', 'Too many requests. Please try again shortly.'));
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers.origin !== origin) return next(new HttpError(403, 'origin_rejected', 'Request origin is not allowed.'));
    next();
  });

  app.get('/webhooks/whatsapp', (req, res, next) => {
    if (mode !== 'live') return next(new HttpError(503, 'live_mode_required', 'Switch to a separately configured live workspace before registering WhatsApp webhooks.'));
    if (!verifyToken || !appSecret || !whatsappPhoneId) return next(new HttpError(503, 'integration_not_configured', 'Webhook verification is not configured.'));
    const candidate = req.query['hub.verify_token'];
    if (req.query['hub.mode'] !== 'subscribe' || typeof candidate !== 'string' || !safeEqual(candidate, verifyToken) || typeof req.query['hub.challenge'] !== 'string') return next(new HttpError(403, 'verification_failed', 'Webhook verification failed.'));
    res.type('text').send(req.query['hub.challenge']);
  });
  app.post('/webhooks/whatsapp', express.raw({ type: 'application/json', limit: '256kb' }), (req, res, next) => {
    if (mode !== 'live') return next(new HttpError(503, 'live_mode_required', 'Real WhatsApp messages cannot be ingested into a demo workspace.'));
    if (!appSecret || !whatsappPhoneId) return next(new HttpError(503, 'integration_not_configured', 'Webhook signature verification and a WhatsApp phone number ID are required.'));
    const raw = req.body as Buffer;
    const signature = req.headers['x-hub-signature-256'];
    if (!Buffer.isBuffer(raw) || typeof signature !== 'string' || !safeEqual(signature, `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`)) return next(new HttpError(401, 'invalid_signature', 'Invalid webhook signature.'));
    let body: ReturnType<typeof webhookSchema.parse>;
    try { body = webhookSchema.parse(JSON.parse(raw.toString('utf8'))); } catch { return next(new HttpError(400, 'invalid_webhook', 'Invalid WhatsApp webhook payload.')); }
    const automationInboundIds: string[] = [];
    try {
      db.exec('BEGIN');
      for (const entry of body.entry ?? []) for (const change of entry.changes ?? []) {
        const value = change.value;
        if (value.metadata?.phone_number_id !== whatsappPhoneId) continue;
        for (const incoming of value.messages ?? []) {
          if (db.prepare('SELECT id FROM messages WHERE provider_id=?').get(incoming.id)) continue;
          const incomingPhone = `+${incoming.from}`;
          if (!phone.safeParse(incomingPhone).success) continue;
          const contact = value.contacts?.find(contact => contact.wa_id === incoming.from);
          let row = db.prepare('SELECT id FROM conversations WHERE phone=?').get(incomingPhone);
          if (!row) {
            const id = randomUUID();
            db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, contact?.profile?.name?.slice(0, 120) || incomingPhone, incomingPhone, '', '1970-01-01T00:00:00.000Z', 0, 'open', '', 0, 'General');
            row = { id };
          }
          const providerTime = incoming.timestamp ? Number(incoming.timestamp) * 1000 : NaN;
          // Preserve Meta's message time for the 24-hour customer-service window.
          // Missing or future timestamps must never open a new live reply window.
          const createdAt = Number.isFinite(providerTime) && providerTime >= 0 && providerTime <= Date.now() ? new Date(providerTime).toISOString() : '1970-01-01T00:00:00.000Z';
          const supportedText = incoming.type === 'text' && incoming.text?.body;
          const received = addInbound(String(row.id), supportedText || `[${incoming.type.slice(0, 30)} message received — media cannot be opened here. Ask the customer for a written description.]`, incoming.id, createdAt);
          enforceInboundSafety(received);
          automationInboundIds.push(received.id);
          if (!supportedText) {
            db.prepare("UPDATE conversations SET status='waiting',automation_paused=1 WHERE id=?").run(String(row.id));
            audit(db, 'message.unsupported', 'Non-text WhatsApp content requires human follow-up for a written description.');
          }
        }
        for (const status of value.statuses ?? []) {
          // Delivery callbacks may arrive before the send HTTP response gives
          // us its provider ID. Keep a small, short-lived signed status ledger.
          const prior = db.prepare('SELECT status FROM provider_statuses WHERE provider_id=?').get(status.id);
          const ledgerStatus = advanceStatus(prior ? String(prior.status) : undefined, status.status);
          db.prepare('INSERT INTO provider_statuses VALUES (?,?,?) ON CONFLICT(provider_id) DO UPDATE SET status=excluded.status,received_at=excluded.received_at').run(status.id, ledgerStatus, Date.now());
          const current = db.prepare("SELECT status FROM messages WHERE provider_id=? AND direction='outbound'").get(status.id);
          if (current) {
            const updatedStatus = advanceStatus(String(current.status), ledgerStatus);
            db.prepare("UPDATE messages SET status=? WHERE provider_id=? AND direction='outbound'").run(updatedStatus, status.id);
            if (updatedStatus === 'failed' && current.status !== 'failed') {
              db.prepare("UPDATE conversations SET status='waiting',automation_paused=1 WHERE id IN (SELECT conversation_id FROM messages WHERE provider_id=? AND direction='outbound')").run(status.id);
              audit(db, 'message.failed', 'WhatsApp reported a delivery failure. Human review is required before retrying.');
            }
          }
        }
      }
      db.prepare('DELETE FROM provider_statuses WHERE received_at<?').run(Date.now() - 86_400_000);
      db.exec('DELETE FROM provider_statuses WHERE provider_id IN (SELECT provider_id FROM provider_statuses ORDER BY received_at DESC,provider_id DESC LIMIT -1 OFFSET 1000)');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); return next(error); }
    res.json({ received: true });
    for (const id of automationInboundIds) {
      try { queueAutomation(id); }
      catch { console.error('Automatic reply queue failed; human review is required.'); }
    }
  });
  app.use(express.json({ limit: '32kb', strict: true }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', mode }));
  app.post('/api/auth/login', async (req, res, next) => {
    const input = z.object({ email: z.string().trim().email().max(254).transform(value => value.toLowerCase()), password: z.string().min(1).max(256) }).strict().parse(req.body);
    const now = Date.now();
    if (loginAttempts.size > 10_000) for (const [key, value] of loginAttempts) if (value.resetAt <= now) loginAttempts.delete(key);
    const key = req.socket.remoteAddress ?? 'unknown';
    let attempts = loginAttempts.get(key);
    if (!attempts || attempts.resetAt <= now) { attempts = { count: 0, resetAt: now + 15 * 60_000 }; loginAttempts.set(key, attempts); }
    if (attempts.count >= 8) { res.set('Retry-After', String(Math.ceil((attempts.resetAt - now) / 1000))); return next(new HttpError(429, 'login_rate_limited', 'Too many sign-in attempts. Try again in 15 minutes.')); }
    if (passwordVerifications >= 4) { res.set('Retry-After', '2'); return next(new HttpError(429, 'login_busy', 'Sign-in is busy. Please try again shortly.')); }
    // Reserve the attempt before awaiting scrypt so parallel requests cannot
    // bypass the limit. Keep expensive password work off the webhook event loop.
    attempts.count++;
    const row = db.prepare('SELECT * FROM users WHERE email=?').get(input.email);
    const dummySalt = '00000000000000000000000000000000';
    const [salt, expected] = row ? String(row.password_hash).split(':') : [dummySalt, '00'.repeat(64)];
    passwordVerifications++;
    let actual: Buffer;
    try { actual = await new Promise<Buffer>((resolve, reject) => scrypt(input.password, salt!, 64, (error, result) => error ? reject(error) : resolve(result))); }
    finally { passwordVerifications--; }
    const expectedBytes = Buffer.from(expected!, 'hex');
    if (!row || actual.length !== expectedBytes.length || !timingSafeEqual(actual, expectedBytes)) return next(new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.'));
    const currentAccount = db.prepare('SELECT email,password_hash FROM users WHERE id=?').get(String(row.id));
    if (!currentAccount || currentAccount.email !== row.email || currentAccount.password_hash !== row.password_hash) return next(new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.'));
    attempts.count = 0;
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now);
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(tokenHash(token), String(row.id), now + SESSION_DURATION);
    res.cookie('handyman_session', token, { ...sessionCookieOptions, maxAge: SESSION_DURATION });
    audit(db, 'auth.signed_in', 'Workspace admin signed in.');
    res.json({ user: { id: row.id, email: row.email, name: row.name }, mode });
  });
  app.use('/api', (req, _res, next) => { if (!currentUser(req)) return next(new HttpError(401, 'unauthorized', 'Sign in to continue.')); next(); });
  app.get('/api/auth/me', (req, res) => res.json({ user: currentUser(req), mode }));
  app.get('/api/integration/readiness', (_req, res) => res.json(readinessResponse()));
  app.post('/api/auth/logout', (req, res) => {
    const token = cookieToken(req);
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
    res.clearCookie('handyman_session', sessionCookieOptions);
    res.json({ ok: true });
  });
  app.get('/api/dashboard', (_req, res) => {
    const stats = {
      openConversations: Number(db.prepare("SELECT count(*) AS n FROM conversations WHERE status='open'").get()!.n),
      unreadMessages: Number(db.prepare('SELECT COALESCE(sum(unread_count),0) AS n FROM conversations').get()!.n),
      activeJobs: Number(db.prepare("SELECT count(*) AS n FROM jobs WHERE status!='completed'").get()!.n),
      completedJobs: Number(db.prepare("SELECT count(*) AS n FROM jobs WHERE status='completed'").get()!.n),
    };
    const dailyMessages = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(Date.now() - (6 - index) * 86_400_000).toISOString().slice(0, 10);
      const nextDate = new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
      const rows = db.prepare('SELECT direction,count(*) AS n FROM messages WHERE created_at>=? AND created_at<? GROUP BY direction').all(date, nextDate);
      return { date, inbound: Number(rows.find(row => row.direction === 'inbound')?.n ?? 0), outbound: Number(rows.find(row => row.direction === 'outbound')?.n ?? 0) };
    });
    res.json({ stats, recentActivity: activity(6), dailyMessages });
  });
  app.get('/api/conversations', (_req, res) => res.json({ conversations: db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all().map(conversation) }));
  app.get('/api/conversations/:id', (req, res) => {
    const selected = getConversation(req.params.id as string);
    const query = z.object({ before: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(req.query);
    let rows;
    if (query.before) {
      const cursor = db.prepare('SELECT rowid,created_at FROM messages WHERE id=? AND conversation_id=?').get(query.before, selected.id);
      if (!cursor) throw new HttpError(400, 'invalid_cursor', 'The message cursor does not belong to this conversation.');
      rows = db.prepare('SELECT * FROM messages WHERE conversation_id=? AND (substr(created_at,1,19)<? OR (substr(created_at,1,19)=? AND rowid<?)) ORDER BY substr(created_at,1,19) DESC,rowid DESC LIMIT ?').all(selected.id, String(cursor.created_at).slice(0,19), String(cursor.created_at).slice(0,19), cursor.rowid as number, query.limit+1);
    } else rows = db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY substr(created_at,1,19) DESC,rowid DESC LIMIT ?').all(selected.id, query.limit+1);
    const hasMore = rows.length > query.limit;
    const messages = rows.slice(0,query.limit).reverse().map(message);
    res.json({ conversation: selected, messages, suggestion: getSuggestion(messages, selected.automationPaused), pagination: {hasMore, before: hasMore ? messages[0]!.id : null} });
  });
  app.get('/api/conversations/:id/intake', (req, res) => {
    const selected = getConversation(req.params.id as string);
    res.json({intake: getIntake(selected.id)});
  });
  app.post('/api/conversations/:id/intake/analyze', async (req, res) => {
    const input = z.object({useAi: z.boolean().default(false), expectedVersion: z.number().int().min(0).optional()}).strict().parse(req.body ?? {});
    const selected = getConversation(req.params.id as string), before = getIntake(selected.id);
    if (before?.jobId) return res.json({intake: before, conversation: selected});
    const version = before?.version ?? 0;
    if (input.expectedVersion !== undefined) checkVersion(version, input.expectedVersion);
    if (input.useAi) {
      if (!aiApiKey) throw new HttpError(503, 'integration_not_configured', 'Configure AI credentials before requesting AI intake analysis.');
      const user = currentUser(req)!, now = Date.now();
      for (const [key,value] of intakeAttempts) if (value.resetAt <= now) intakeAttempts.delete(key);
      const current = intakeAttempts.get(user.id) ?? {count: 0, resetAt: now + 60_000};
      if (current.count >= 10) throw new HttpError(429, 'intake_rate_limited', 'Too many AI intake requests. Try again in a minute.');
      current.count++; intakeAttempts.set(user.id, current);
    }
    const inbound = db.prepare("SELECT * FROM messages WHERE conversation_id=? AND direction='inbound' ORDER BY substr(created_at,1,19) DESC,rowid DESC LIMIT 20").all(selected.id).reverse().map(message);
    if (!inbound.length) throw new HttpError(409, 'no_customer_message', 'Receive a customer message before analyzing intake.');
    let analysis;
    try { analysis = await analyzeIntake(inbound, {useAi: input.useAi, apiKey: aiApiKey, model: aiModel, fetchImpl}); }
    catch { throw new HttpError(502, 'intake_failed', 'The AI service could not analyze intake. Try local extraction or edit the details manually.'); }
    // Compare after the awaited provider call, so concurrent manual edits are never overwritten.
    const analyzed = transaction(() => {
      checkVersion(getIntake(selected.id)?.version ?? 0, version);
      const currentInbound = db.prepare("SELECT id FROM messages WHERE conversation_id=? AND direction='inbound' ORDER BY substr(created_at,1,19) DESC,rowid DESC LIMIT 20").all(selected.id).reverse().map(row => String(row.id));
      if (JSON.stringify(currentInbound) !== JSON.stringify(inbound.map(item => item.id))) throw new HttpError(409, 'conversation_changed', 'New customer messages arrived during analysis. Analyze the updated conversation again.');
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO intakes (conversation_id,summary,category,address,preferred_time,urgency,wants_human,source,evidence,version,updated_at,job_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)
        ON CONFLICT(conversation_id) DO UPDATE SET summary=excluded.summary,category=excluded.category,address=excluded.address,preferred_time=excluded.preferred_time,urgency=excluded.urgency,wants_human=excluded.wants_human,source=excluded.source,evidence=excluded.evidence,version=excluded.version,updated_at=excluded.updated_at`).run(selected.id, analysis.summary, analysis.category, analysis.address, analysis.preferredTime, analysis.urgency, Number(analysis.wantsHuman), analysis.source, JSON.stringify(analysis.evidence), version + 1, now);
      if (analysis.urgency === 'urgent' || analysis.wantsHuman) db.prepare("UPDATE conversations SET automation_paused=1,status='waiting' WHERE id=?").run(selected.id);
      audit(db, 'intake.analyzed', input.useAi ? 'AI intake prepared for human review.' : 'Local intake prepared for human review.');
      return getIntake(selected.id);
    });
    res.json({intake: analyzed, conversation: getConversation(selected.id)});
  });
  app.patch('/api/conversations/:id/intake', (req, res) => {
    const input = z.object({summary: z.string().trim().max(2000).optional(), category: text(80).optional(), address: z.string().trim().max(500).optional(), preferredTime: z.string().trim().max(300).optional(), urgency: z.enum(['routine','urgent']).optional(), expectedVersion: z.number().int().min(0)}).strict().refine(value => Object.keys(value).length > 1, 'Provide a field to update').parse(req.body);
    const selected = getConversation(req.params.id as string);
    const editedIntake = transaction(() => {
      const existing = getIntake(selected.id);
      if (existing?.jobId) throw new HttpError(409, 'intake_converted', 'This intake has already been converted. Edit the linked job instead.');
      checkVersion(existing?.version ?? 0, input.expectedVersion);
      const updated = {...{summary:'',category:selected.category,address:'',preferredTime:'',urgency:'routine',wantsHuman:false,evidence:[]}, ...existing, ...input};
      const edited = new Set(Object.keys(input).filter(field => field !== 'expectedVersion'));
      const evidence = updated.evidence.filter(item => !edited.has(item.field));
      db.prepare(`INSERT INTO intakes (conversation_id,summary,category,address,preferred_time,urgency,wants_human,source,evidence,version,updated_at,job_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)
        ON CONFLICT(conversation_id) DO UPDATE SET summary=excluded.summary,category=excluded.category,address=excluded.address,preferred_time=excluded.preferred_time,urgency=excluded.urgency,source=excluded.source,evidence=excluded.evidence,version=excluded.version,updated_at=excluded.updated_at`).run(selected.id, updated.summary, updated.category, updated.address, updated.preferredTime, updated.urgency, Number(updated.wantsHuman), 'manual', JSON.stringify(evidence), (existing?.version ?? 0)+1, new Date().toISOString());
      if (updated.urgency === 'urgent' || updated.wantsHuman) db.prepare("UPDATE conversations SET automation_paused=1,status='waiting' WHERE id=?").run(selected.id);
      audit(db, 'intake.updated', 'Intake details reviewed and edited by an operator.');
      return getIntake(selected.id);
    });
    res.json({intake:editedIntake, conversation:getConversation(selected.id)});
  });
  app.post('/api/conversations/:id/intake/job', (req, res) => {
    const input=z.object({expectedVersion:z.number().int().min(1)}).strict().parse(req.body);
    const selected=getConversation(req.params.id as string), existing=getIntake(selected.id);
    if (!existing) throw new HttpError(409,'intake_required','Analyze or complete the customer intake first.');
    if (existing.jobId) return res.json({intake:existing,job:getJob(existing.jobId),conversation:selected});
    checkVersion(existing.version,input.expectedVersion);
    if (existing.missingFields.length) throw new HttpError(409,'intake_incomplete','Complete the job summary, address, and preferred time before creating a draft job.', {missingFields:existing.missingFields});
    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-read under the write lock; another worker may have converted it already.
      const locked = getIntake(selected.id)!;
      if (locked.jobId) {
        const linked = getJob(locked.jobId);
        db.exec('COMMIT');
        return res.json({intake:locked,job:linked,conversation:getConversation(selected.id)});
      }
      checkVersion(locked.version,input.expectedVersion);
      const created = insertJob({id:randomUUID(), title:existing.summary.slice(0,160), customerName:selected.customerName, phone:selected.phone, category:existing.category, address:existing.address, scheduledAt:'', status:'new', notes:`Preferred time: ${existing.preferredTime}\n${existing.urgency === 'urgent' ? 'Urgent: human review required.\n' : ''}${existing.summary}`, conversationId:selected.id,assignedTo:selected.assignedTo.trim() || 'Team',durationMinutes:60});
      db.prepare('UPDATE intakes SET job_id=?,version=version+1,updated_at=? WHERE conversation_id=?').run(created.id,new Date().toISOString(),selected.id);
      audit(db,'intake.converted','Reviewed intake converted into a draft job; availability still requires confirmation.');
      db.exec('COMMIT');
      res.status(201).json({intake:getIntake(selected.id),job:created,conversation:getConversation(selected.id)});
    } catch(error) {db.exec('ROLLBACK'); throw error;}
  });
  app.post('/api/conversations/:id/draft', async (req, res) => {
    z.object({}).strict().parse(req.body ?? {});
    const selected = getConversation(req.params.id as string);
    const settings = getSettings();
    if (selected.automationPaused || !settings.automationEnabled) throw new HttpError(409, 'drafts_paused', 'Enable draft assistance in settings and resume this conversation before generating a draft.');
    const user = currentUser(req)!;
    const now = Date.now();
    for (const [key, value] of draftAttempts) if (value.resetAt <= now) draftAttempts.delete(key);
    const current = draftAttempts.get(user.id) ?? { count: 0, resetAt: now + 60_000 };
    if (current.count >= 10) throw new HttpError(429, 'draft_rate_limited', 'Too many draft requests. Try again in a minute.');
    current.count++;
    draftAttempts.set(user.id, current);
    const messages = db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY substr(created_at,1,19) DESC,rowid DESC LIMIT 12').all(selected.id).reverse().map(message);
    if (!aiApiKey) {
      const suggestion = getSuggestion(messages, false);
      if (!suggestion) throw new HttpError(409, 'no_customer_message', 'Receive a customer message before generating a draft.');
      return res.json({ draft: { ...suggestion, source: 'template' } });
    }
    let draft;
    const knowledgeSnapshot = getKnowledge();
    try {
      draft = await generateAiDraft({ ...settings, messages, ...(knowledgeSnapshot.approved ? {businessKnowledge: JSON.stringify(knowledgeSnapshot).slice(0,8000)} : {}) }, { apiKey: aiApiKey, model: aiModel, fetchImpl });
    } catch {
      throw new HttpError(502, 'draft_failed', 'The AI service could not generate a draft. You can still write a reply manually.');
    }
    const currentConversation = getConversation(selected.id);
    if (currentConversation.automationPaused || !getSettings().automationEnabled) throw new HttpError(409, 'drafts_paused', 'Draft assistance was paused while the draft was being generated.');
    const latestIds = db.prepare('SELECT id FROM messages WHERE conversation_id=? ORDER BY substr(created_at,1,19) DESC,rowid DESC LIMIT 12').all(selected.id).reverse().map(row => String(row.id));
    if (JSON.stringify(latestIds) !== JSON.stringify(messages.map(item => item.id))) throw new HttpError(409, 'conversation_changed', 'The conversation changed while the draft was being generated. Generate a new draft from the latest messages.');
    if (JSON.stringify(getSettings()) !== JSON.stringify(settings)) throw new HttpError(409, 'settings_changed', 'Business settings changed while the draft was being generated. Generate a new draft with the current settings.');
    if (getKnowledge().version !== knowledgeSnapshot.version) throw new HttpError(409, 'knowledge_changed', 'Business knowledge changed while the draft was generated. Generate a new draft with the current knowledge.');
    audit(db, 'draft.generated', 'AI reply draft generated for human review.');
    res.json({ draft: { ...draft, source: 'ai' } });
  });
  app.patch('/api/conversations/:id', (req, res) => {
    const input = z.object({ status: z.enum(['open', 'waiting', 'resolved']).optional(), assignedTo: z.string().trim().max(100).optional(), automationPaused: z.boolean().optional(), unreadCount: z.literal(0).optional() }).strict().refine(value => Object.keys(value).length > 0, 'Provide a field to update').parse(req.body);
    const existing = getConversation(req.params.id as string);
    db.prepare('UPDATE conversations SET status=?,assigned_to=?,automation_paused=?,unread_count=? WHERE id=?').run(input.status ?? existing.status, input.assignedTo ?? existing.assignedTo, Number(input.automationPaused ?? existing.automationPaused), input.unreadCount ?? existing.unreadCount, existing.id);
    audit(db, 'conversation.updated', 'Conversation status or ownership updated.');
    res.json({ conversation: getConversation(existing.id) });
  });
  app.post('/api/conversations/:id/messages', async (req, res) => {
    const input = z.object({ text: text(4096), idempotencyKey: z.string().uuid().optional() }).strict().parse(req.body);
    const selected = getConversation(req.params.id as string);
    const id = input.idempotencyKey ?? randomUUID();
    const existingMessage = db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    if (existingMessage) {
      if (existingMessage.conversation_id !== selected.id || existingMessage.text !== input.text || existingMessage.direction !== 'outbound') throw new HttpError(409, 'idempotency_conflict', 'The send identifier has already been used for another message.');
      return res.json({ message: message(existingMessage), conversation: selected });
    }
    if (mode === 'live' && (!whatsappToken || !whatsappPhoneId)) throw new HttpError(503, 'integration_not_configured', 'Configure WhatsApp credentials before sending messages.');
    if (mode === 'live') {
      const lastInbound = db.prepare("SELECT created_at FROM messages WHERE conversation_id=? AND direction='inbound' ORDER BY created_at DESC LIMIT 1").get(selected.id);
      const age = lastInbound ? Date.now() - Date.parse(String(lastInbound.created_at)) : NaN;
      if (!Number.isFinite(age) || age < 0 || age >= 24 * 60 * 60_000) throw new HttpError(409, 'template_required', 'The 24-hour reply window has closed. Send an approved WhatsApp template using your provider before replying here.');
    }
    const unconfirmed = db.prepare("SELECT id FROM messages WHERE conversation_id=? AND direction='outbound' AND text=? AND status IN ('pending','unconfirmed') LIMIT 1").get(selected.id, input.text);
    if (mode === 'live' && unconfirmed) throw new HttpError(409, 'send_unconfirmed', 'A matching reply is awaiting confirmation. Check WhatsApp before sending it again to avoid duplicates.');
    const now = new Date().toISOString();
    db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(id, selected.id, 'outbound', input.text, now, mode === 'demo' ? 'sent' : 'pending', null);
    // Record the operator's reply before awaiting the provider. New inbound
    // messages arriving during the send retain their preview and unread alert.
    db.prepare('UPDATE conversations SET preview=?,updated_at=?,unread_count=0 WHERE id=?').run(input.text, now, selected.id);
    if (mode === 'live') {
      let rejection: HttpError | undefined;
      try {
        const outcome = await sendWhatsApp(fetchImpl, whatsappPhoneId!, whatsappToken!, selected.phone, input.text);
        if (outcome.rejection) {
          rejection = outcome.rejection;
          db.prepare("UPDATE messages SET status='failed' WHERE id=?").run(id);
          db.prepare("UPDATE conversations SET status='waiting',automation_paused=1 WHERE id=?").run(selected.id);
          audit(db, 'message.failed', 'WhatsApp rejected the reply. Human review is required before retrying.');
        } else {
          const observed = db.prepare('SELECT status FROM provider_statuses WHERE provider_id=? AND received_at>?').get(outcome.providerId!, Date.now() - 86_400_000);
          const deliveryStatus = observed ? advanceStatus('sent', String(observed.status)) : 'sent';
          db.prepare('UPDATE messages SET provider_id=?,status=? WHERE id=?').run(outcome.providerId!, deliveryStatus, id);
          if (deliveryStatus === 'failed') {
            db.prepare("UPDATE conversations SET status='waiting',automation_paused=1 WHERE id=?").run(selected.id);
            audit(db, 'message.failed', 'WhatsApp reported a delivery failure. Human review is required before retrying.');
          }
        }
      } catch {
        db.prepare('UPDATE messages SET status=? WHERE id=?').run('unconfirmed', id);
        audit(db, 'message.unconfirmed', 'WhatsApp send could not be confirmed. Check WhatsApp before retrying.');
        throw new HttpError(502, 'send_unconfirmed', 'WhatsApp could not confirm delivery. Check WhatsApp before retrying to avoid duplicates.');
      }
      if (rejection) throw rejection;
    }
    audit(db, 'message.sent', mode === 'demo' ? 'Demo reply recorded; no external message was sent.' : 'Reply accepted by WhatsApp.');
    res.status(201).json({ message: message(db.prepare('SELECT * FROM messages WHERE id=?').get(id)!), conversation: getConversation(selected.id) });
  });
  app.get('/api/jobs', (_req, res) => res.json({ jobs: db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all().map(job) }));
  app.get('/api/jobs/:id', (req,res) => res.json({job:getJob(req.params.id as string)}));
  app.post('/api/jobs', (req, res) => {
    const input = jobSchema.parse(req.body);
    if (input.conversationId) getConversation(input.conversationId);
    const selected = {...input,id:randomUUID(),conversationId:input.conversationId ?? null};
    const created=transaction(() => { checkSchedule(selected); return insertJob(selected); });
    audit(db, 'job.created', 'New job added to the board.');
    res.status(201).json({ job: created });
  });
  app.patch('/api/jobs/:id', (req, res) => {
    const input = jobPatchSchema.parse(req.body);
    const updatedJob = transaction(() => {
      const existing = getJob(req.params.id as string), updated = { ...existing, ...input };
      if(input.expectedVersion!==undefined) checkVersion(existing.version,input.expectedVersion);
      if (input.conversationId) getConversation(input.conversationId);
      checkSchedule(updated);
      db.prepare('UPDATE jobs SET title=?,customer_name=?,phone=?,category=?,address=?,scheduled_at=?,status=?,notes=?,conversation_id=?,assigned_to=?,duration_minutes=?,version=version+1,updated_at=? WHERE id=?').run(updated.title, updated.customerName, updated.phone, updated.category, updated.address, updated.scheduledAt, updated.status, updated.notes, updated.conversationId, updated.assignedTo, updated.durationMinutes, new Date().toISOString(), existing.id);
      audit(db, 'job.updated', 'Job details updated.');
      return getJob(existing.id);
    });
    res.json({ job: updatedJob });
  });
  app.get('/api/settings', (_req, res) => res.json(settingsResponse()));
  app.patch('/api/settings', (req, res) => {
    const input = settingsSchema.partial().refine(value => Object.keys(value).length > 0, 'Provide a field to update').parse(req.body);
    const updated = { ...getSettings(), ...input };
    db.prepare('UPDATE settings SET business_name=?,business_hours=?,welcome_message=?,away_message=?,automation_enabled=? WHERE id=1').run(updated.businessName, updated.businessHours, updated.welcomeMessage, updated.awayMessage, Number(updated.automationEnabled));
    audit(db, 'settings.updated', 'Business settings updated.');
    res.json(settingsResponse());
  });
  app.get('/api/knowledge', (_req,res) => res.json({knowledge:getKnowledge()}));
  app.patch('/api/knowledge', (req,res) => {
    const {version: _version, ...knowledgeFields} = knowledgeSchema.shape;
    const input = z.object({...knowledgeFields,approved:z.boolean().optional().default(false),expectedVersion:z.number().int().min(1)}).strict().parse(req.body);
    const {expectedVersion,...fields} = input;
    const updated = transaction(() => {
      const existing=getKnowledge(); checkVersion(existing.version,expectedVersion);
      const knowledge = knowledgeSchema.parse({...fields,version:existing.version+1});
      if (knowledge.approved && (!knowledge.services.length || !knowledge.serviceAreas.length)) throw new HttpError(409,'knowledge_not_ready','Add services and service areas before approving the business knowledge.');
      storeConfig('knowledge',knowledge);
      if (!knowledge.approved) {
        const policy=getPolicy();
        if (policy.enabled) storeConfig('automation',{...policy,enabled:false,version:policy.version+1});
      }
      // A queued decision is valid only for the exact approved configuration.
      db.prepare("UPDATE automation_claims SET status='skipped',reason_code='knowledge_changed',updated_at=? WHERE status='queued'").run(new Date().toISOString());
      audit(db,'knowledge.updated',knowledge.approved?'Business knowledge saved and explicitly approved.':'Business knowledge saved for review; automatic replies disabled.');
      return knowledge;
    });
    res.json({knowledge:updated});
  });
  app.get('/api/automation', (_req,res) => res.json(policyResponse()));
  app.post('/api/automation/stop', (req,res) => {
    z.object({}).strict().parse(req.body ?? {});
    transaction(() => {
      const existing=getPolicy();
      if (existing.enabled) storeConfig('automation',{...existing,enabled:false,version:existing.version+1});
      db.prepare("UPDATE automation_claims SET status='skipped',reason_code='operator_stop',updated_at=? WHERE status='queued'").run(new Date().toISOString());
      audit(db,'automation.stopped','Automatic reception stopped by an operator. Replies already submitted cannot be recalled.');
    });
    res.json(policyResponse());
  });
  app.patch('/api/automation', (req,res) => {
    const input=automationPolicySchema.omit({version:true}).partial().extend({expectedVersion:z.number().int().min(1)}).strict().refine(value=>Object.keys(value).some(key=>key!=='expectedVersion'),'Provide a policy field to update').parse(req.body);
    transaction(() => {
      const existing=getPolicy(); checkVersion(existing.version,input.expectedVersion);
      const {expectedVersion:_,...fields}=input;
      const policy=automationPolicySchema.parse({...existing,...fields,version:existing.version+1});
      if (policy.enabled) {
        const knowledge=getKnowledge();
        if (!knowledge.approved || !knowledge.services.length || !knowledge.serviceAreas.length) throw new HttpError(409,'knowledge_not_ready','Approve business knowledge containing services and service areas before enabling automatic replies.');
        if (mode==='live'&&!liveSendingAllowed()) throw new HttpError(409,'live_gate_closed','Live automatic replies require ALLOW_LIVE_AUTOMATION=1 and a complete WhatsApp connection.');
      }
      storeConfig('automation',policy);
      db.prepare("UPDATE automation_claims SET status='skipped',reason_code='policy_changed',updated_at=? WHERE status='queued'").run(new Date().toISOString());
      audit(db,'automation.updated',policy.enabled?'Controlled rule-based automatic replies enabled.':'Automatic replies switched off. Replies already submitted to WhatsApp cannot be recalled.');
    });
    res.json(policyResponse());
  });
  app.post('/api/reception/simulate', (req,res) => {
    const input=z.object({messages:z.array(z.object({direction:z.enum(['inbound','outbound']),text:text(4096)}).strict()).min(1).max(12),now:z.string().datetime({offset:true}).optional()}).strict().refine(value=>value.messages.reduce((total,item)=>total+item.text.length,0)<=12000,'Conversation exceeds the 12,000-character simulation limit').parse(req.body);
    const started=performance.now();
    const decision=decideReception({knowledge:getKnowledge(),policy:{...getPolicy(),enabled:true},messages:input.messages.map((item,index)=>({...item,id:`simulation-${index}`})),paused:false,now:input.now?new Date(input.now):new Date()});
    res.json({decision,elapsedMs:Math.round((performance.now()-started)*100)/100,mode:'simulation',sent:false});
  });
  app.post('/api/reception/ai-draft', async (req,res) => {
    const input=z.object({messages:z.array(z.object({direction:z.enum(['inbound','outbound']),text:text(4096)}).strict()).min(1).max(12),useAi:z.literal(true)}).strict().refine(value=>value.messages.reduce((total,item)=>total+item.text.length,0)<=12000,'Conversation exceeds the 12,000-character simulation limit').parse(req.body);
    if (!aiApiKey) throw new HttpError(503,'ai_not_configured','Configure AI credentials before testing an AI preview.');
    const knowledge=getKnowledge(), settings=getSettings();
    if (!knowledge.approved) throw new HttpError(409,'knowledge_not_ready','Approve the business knowledge before testing an AI preview.');
    const user=currentUser(req)!,now=Date.now();
    for (const [key,value] of draftAttempts) if (value.resetAt<=now) draftAttempts.delete(key);
    const attempts=draftAttempts.get(user.id)??{count:0,resetAt:now+60_000};
    if (attempts.count>=10) throw new HttpError(429,'draft_rate_limited','Too many AI preview requests. Try again in a minute.');
    attempts.count++; draftAttempts.set(user.id,attempts);
    let draft;
    try { draft=await generateAiDraft({...settings,businessKnowledge:JSON.stringify(knowledge).slice(0,8000),messages:input.messages.map((item,index)=>({...item,id:`simulation-${index}`}))},{apiKey:aiApiKey,model:aiModel,fetchImpl}); }
    catch { throw new HttpError(502,'draft_failed','The AI service could not generate a preview. You can still test the rule-based receptionist.'); }
    if (getKnowledge().version!==knowledge.version||JSON.stringify(getSettings())!==JSON.stringify(settings)) throw new HttpError(409,'knowledge_changed','Business knowledge or settings changed during generation. Generate a new preview.');
    res.json({draft:{...draft,source:'ai'},sent:false,mode:'simulation'});
  });
  app.post('/api/reception/evaluate', (req,res) => {
    z.object({}).strict().parse(req.body ?? {});
    res.json(evaluateReceptionSafety());
  });

  app.get('/api/activity', (_req, res) => res.json({ activity: activity() }));
  app.post('/api/demo/inbound', async (req, res) => {
    if (mode !== 'demo') throw new HttpError(404, 'not_found', 'Endpoint not found.');
    const input = z.object({ conversationId: z.string().max(80).optional(), text: text(4096) }).strict().parse(req.body);
    const id = input.conversationId ?? 'demo-conv-1';
    getConversation(id);
    const incoming = addInbound(id, input.text);
    const safetyDecision = enforceInboundSafety(incoming);
    const automation = safetyDecision ? {decision:safetyDecision,status:'handoff'} : await processAutomation(incoming.id);
    res.status(201).json({ message: incoming, conversation: getConversation(id), automation });
  });
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not_found', 'Endpoint not found.')));
  const serveDir = options.serveDir;
  if (serveDir && existsSync(resolve(serveDir, 'index.html'))) {
    app.use(express.static(serveDir, { index: false }));
    app.get('/{*path}', (req, res, next) => req.path.startsWith('/webhooks/') ? next() : res.sendFile(resolve(serveDir, 'index.html')));
  }
  app.use((_req, _res, next) => next(new HttpError(404, 'not_found', 'Endpoint not found.')));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: { code: 'validation_failed', message: error.issues.map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ') } });
    if (error instanceof HttpError) return res.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details ? {details:error.details} : {}) } });
    if (error instanceof SyntaxError && 'status' in error) return res.status(400).json({ error: { code: 'invalid_json', message: 'Request body must be valid JSON.' } });
    if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') return res.status(413).json({ error: { code: 'body_too_large', message: 'Request body is too large.' } });
    console.error('Request failed:', error instanceof Error ? error.name : 'UnknownError');
    res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong. Please try again.' } });
  });

  function addInbound(conversationId: string, incomingText: string, providerId: string | null = null, createdAt?: string): Message {
    const id = randomUUID(), now = createdAt ?? new Date().toISOString();
    db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(id, conversationId, 'inbound', incomingText, now, 'received', providerId);
    const last = db.prepare('SELECT preview,updated_at FROM conversations WHERE id=?').get(conversationId)!;
    // Meta timestamps have second precision. Within a second, arrival order
    // decides the preview; the timestamp itself must never move backwards.
    const latest = now.slice(0, 19) >= String(last.updated_at).slice(0, 19);
    const updatedAt = now > String(last.updated_at) ? now : String(last.updated_at);
    db.prepare("UPDATE conversations SET preview=?,updated_at=?,unread_count=unread_count+1,status=CASE WHEN automation_paused=1 THEN 'waiting' ELSE 'open' END WHERE id=?").run(latest ? incomingText : String(last.preview), updatedAt, conversationId);
    audit(db, 'message.received', providerId ? 'New WhatsApp message received.' : 'Simulated customer message received.');
    return message(db.prepare('SELECT * FROM messages WHERE id=?').get(id)!);
  }

  function getSuggestion(messages: Message[], paused: boolean) {
    const settings = getSettings();
    if (!settings.automationEnabled || paused) return null;
    const latest = [...messages].reverse().find(item => item.direction === 'inbound' && !isMediaNotice(item.text));
    if (!latest) return null;
    const content = latest.text.toLowerCase();
    if (/\b(gas|sparking|smoke|fire|electrocut|emergency)\b/.test(content)) return { text: 'Your safety comes first. If there is immediate danger, leave the area and contact local emergency services. Do not touch exposed wiring or attempt repairs. Once you are safe, our team can follow up about your request.', reason: 'Potential safety concern · human review required' };
    if (/\b(quote|cost|price|pricing|repaint|painting)\b/.test(content)) return { text: `Thanks for contacting ${settings.businessName}. Could you send a written description of the work and your area? Our team will review the scope and discuss pricing before any work starts.`, reason: 'Quote request · collect scope before pricing' };
    if (/\b(book|tomorrow|appointment|available|morning|schedule|thursday)\b/.test(content)) return { text: 'We would be happy to help arrange a visit. Please share your address, the work needed, and your preferred date and time. Our team will confirm availability with you before the booking is final.', reason: 'Booking request · availability needs confirmation' };
    if (/^(hi|hello|hey|good morning|good afternoon)\b/.test(content)) return { text: settings.welcomeMessage, reason: 'Greeting · your saved welcome message' };
    return { text: `Thanks for your message. A member of the ${settings.businessName} team will review your request. Could you share any extra details about the work and your location?`, reason: 'Needs team review · no promises made automatically' };
  }
  return app;
}

function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

async function sendWhatsApp(fetchImpl: typeof fetch, phoneId: string, token: string, recipient: string, content: string): Promise<{providerId?: string; rejection?: HttpError}> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('provider_timeout')); }, 15_000);
  });
  const operation = (async () => {
    const response = await fetchImpl(`https://graph.facebook.com/v23.0/${encodeURIComponent(phoneId)}/messages`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: recipient.replace(/^\+/, ''), type: 'text', text: { body: content } }), signal: controller.signal });
    if (controller.signal.aborted) { discardProviderBody(response); throw new Error('provider_timeout'); }
    if ([401,403,429].includes(response.status)) {
      discardProviderBody(response);
      return {rejection: providerRejection(response.status)};
    }
    let body: unknown;
    try { body = await readBoundedJson(response, {signal: controller.signal}); }
    catch (error) {
      // A definite client rejection cannot have accepted this request. The
      // detailed error body is optional and is never shown to an operator.
      if (response.status >= 400 && response.status < 500) return {rejection: providerRejection(response.status)};
      throw error;
    }
    const parsedError = z.object({error: z.object({code: z.number().int().optional()})}).safeParse(body);
    if (response.status >= 400 && response.status < 500) return {rejection: providerRejection(response.status, parsedError.success ? parsedError.data.error.code : undefined)};
    if (!response.ok) throw new Error('provider_unconfirmed');
    if (parsedError.success) return {rejection: providerRejection(response.status, parsedError.data.error.code)};
    const accepted = z.object({messages: z.array(z.object({id: z.string().min(1).max(256).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value))})).min(1).max(10)}).safeParse(body);
    if (!accepted.success) throw new Error('provider_invalid_response');
    return {providerId: accepted.data.messages[0]!.id};
  })();
  try { return await Promise.race([operation, deadline]); }
  finally { clearTimeout(timer); controller.abort(); }
}

function providerRejection(status: number, code?: number): HttpError {
  if (code === 190 || status === 401 || status === 403) return new HttpError(503, 'integration_auth_failed', 'WhatsApp rejected the connection credentials. Ask the workspace administrator to update the access token and permissions.');
  if (code === 131047) return new HttpError(409, 'template_required', 'WhatsApp reports that the 24-hour reply window has closed. Use an approved template before replying here.');
  if (status === 429 || [4, 80007, 130429, 131048, 131056].includes(code ?? -1)) return new HttpError(429, 'provider_rate_limited', 'WhatsApp temporarily limited this request. Wait before trying again.');
  return new HttpError(502, 'send_rejected', 'WhatsApp rejected this reply. Check the recipient and connection before trying again.');
}

function advanceStatus(current: string | undefined, incoming: string): string {
  if (!current) return incoming;
  if (incoming === 'failed') return ['delivered', 'read'].includes(current) ? current : 'failed';
  const rank: Record<string, number> = { pending: 0, unconfirmed: 0, failed: 1, sent: 1, delivered: 2, read: 3 };
  return (rank[incoming] ?? 0) > (rank[current] ?? 0) ? incoming : current;
}

const webhookSchema = z.object({ object: z.literal('whatsapp_business_account'), entry: z.array(z.object({ changes: z.array(z.object({ value: z.object({ metadata: z.object({ phone_number_id: z.string() }).optional(), contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string() }).optional() })).optional(), messages: z.array(z.object({ id: text(256), from: z.string().regex(/^\d{8,15}$/), type: z.string().max(80), timestamp: z.string().regex(/^\d{1,12}$/).optional(), text: z.object({ body: text(4096) }).optional() })).max(100).optional(), statuses: z.array(z.object({ id: text(256), status: z.enum(['sent', 'delivered', 'read', 'failed']) })).max(100).optional() }) })).max(100).optional() })).max(100).optional() });
