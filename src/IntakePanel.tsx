import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, ClipboardCheck, LoaderCircle, ShieldCheck, Sparkles } from "lucide-react";
import { api, mutation, type Intake, type Job } from "./api";

export type ReviewedFields = Pick<Intake, "summary" | "category" | "address" | "preferredTime" | "urgency">;
export type IntakeDraft = { version: number; form: ReviewedFields };
const fieldsFrom = (intake: Intake): ReviewedFields => ({ summary: intake.summary, category: intake.category, address: intake.address, preferredTime: intake.preferredTime, urgency: intake.urgency });
const readable = (value: string) => value.replace(/([A-Z])/g, " $1").replace(/_/g, " ").toLowerCase();

export function IntakePanel({ conversationId, drafts, aiConfigured, onChanged, onOpenJob, notify }: {
  conversationId: string; drafts: Map<string, IntakeDraft>; aiConfigured: boolean; onChanged: () => void;
  onOpenJob: (job: Job) => void; notify: (message: string) => void;
}) {
  const [intake, setIntake] = useState<Intake | null>(null);
  const [form, setForm] = useState<ReviewedFields | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [consent, setConsent] = useState(false);
  const [dirty, setDirty] = useState(false);
  const active = useRef(true);
  const operating = useRef(false);
  const revision = useRef(0);
  function accept(value: Intake) { drafts.delete(conversationId); setIntake(value); setForm(fieldsFrom(value)); setDirty(false); }
  useEffect(() => {
    active.current = true;
    const request = ++revision.current;
    void api<{ intake: Intake | null }>(`/conversations/${conversationId}/intake`).then((result) => {
      if (active.current && request === revision.current && result.intake) {
        const saved = drafts.get(conversationId);
        if (saved && !result.intake.jobId) {
          setIntake({ ...result.intake, version: saved.version });
          setForm(saved.form); setDirty(true);
          if (saved.version !== result.intake.version) setError("This request changed while you were away. Your unsaved review was kept. Reload the latest request before reviewing again.");
        } else accept(result.intake);
      }
    }).catch((cause) => { if (active.current && request === revision.current) setError(cause.message); }).finally(() => {
      if (active.current && request === revision.current) setLoading(false);
    });
    return () => { active.current = false; revision.current++; };
  }, [conversationId]);
  async function perform(action: "analyze" | "save" | "convert" | "open", useAi = false) {
    if (operating.current || (dirty && (action === "analyze" || action === "convert"))) return;
    operating.current = true;
    const request = ++revision.current;
    const expectedVersion = intake?.version ?? 0;
    setBusy(true); setError(""); setConsent(false);
    try {
      if (action === "open" && intake?.jobId) {
        const result = await api<{ job: Job }>(`/jobs/${intake.jobId}`);
        if (active.current && request === revision.current) onOpenJob(result.job);
      } else if (action === "convert") {
        const result = await mutation<{ job: Job; intake: Intake }>(`/conversations/${conversationId}/intake/job`, "POST", { expectedVersion });
        if (active.current && request === revision.current) {
          accept(result.intake); onChanged(); notify("Draft job created. Review its details and arrange the visit with your customer.");
        }
      } else {
        const result = await mutation<{ intake: Intake }>(`/conversations/${conversationId}/intake${action === "analyze" ? "/analyze" : ""}`, action === "analyze" ? "POST" : "PATCH", action === "analyze" ? { useAi, expectedVersion } : { ...form, expectedVersion });
        if (active.current && request === revision.current) {
          accept(result.intake); onChanged(); notify(action === "save" ? "Reviewed request details saved." : "Request analyzed. Review the details against the customer’s messages.");
        }
      }
    } catch (cause) {
      if (active.current && request === revision.current) setError((cause as Error).message);
    } finally {
      operating.current = false;
      if (active.current && request === revision.current) setBusy(false);
    }
  }
  function field(name: keyof ReviewedFields, value: string) {
    setConsent(false); setDirty(true);
    setForm((current) => {
      if (!current || !intake) return current;
      const next = { ...current, [name]: value };
      drafts.set(conversationId, { version: intake.version, form: next });
      return next;
    });
  }
  return <section className="panel intake-panel" aria-labelledby="intake-title">
    <div className="panel-heading"><div><h2 id="intake-title"><ClipboardCheck size={19} /> Customer request</h2><p>Capture the brief, review the details, and prepare a service job.</p></div>
      <div className="intake-actions"><button className="button secondary compact" disabled={busy || loading || dirty || !!intake?.jobId} onClick={() => void perform("analyze")}>Analyze request</button>
        {aiConfigured && <button className="button secondary compact" disabled={busy || loading || dirty || !!intake?.jobId} onClick={() => setConsent(true)}><Sparkles size={15} /> Analyze with AI</button>}</div></div>
    {loading ? <p className="intake-hint"><LoaderCircle className="spin" size={17} /> Loading customer request…</p> : !intake ? <p className="intake-hint">Analyze the customer’s messages to gather service details. Nothing is booked or sent automatically.</p> : <>
      <div className="intake-state"><span className={`status status-${intake.status}`}><span />{intake.status === "converted" ? "Draft job created" : intake.status === "ready" ? "Ready for review" : "Gathering details"}</span>
        {(intake.urgency === "urgent" || intake.wantsHuman) && <span className="attention-chip"><ShieldCheck size={14} /> Needs human attention</span>}
        <small>{intake.source === "ai" ? "AI assisted · verify every detail" : intake.source === "manual" ? "Reviewed by your team" : "From customer messages"}</small></div>
      {intake.missingFields.length > 0 && <p className="intake-missing">Still needed: {intake.missingFields.map(readable).join(", ")}. Ask the customer before proceeding.</p>}
      {form && <form className="intake-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void perform("save"); }}>
        <label>Request summary<textarea value={form.summary} onChange={(event) => field("summary", event.target.value)} maxLength={500} rows={2} disabled={busy || !!intake.jobId} /></label>
        <div className="form-grid"><label>Request category<input value={form.category} onChange={(event) => field("category", event.target.value)} maxLength={80} disabled={busy || !!intake.jobId} /></label>
          <label>Request urgency<select value={form.urgency} onChange={(event) => field("urgency", event.target.value)} disabled={busy || !!intake.jobId}><option value="routine">Routine</option><option value="urgent">Urgent · human review needed</option></select></label>
          <label>Request address<input value={form.address} onChange={(event) => field("address", event.target.value)} maxLength={300} disabled={busy || !!intake.jobId} /></label>
          <label>Customer’s preferred time<input value={form.preferredTime} onChange={(event) => field("preferredTime", event.target.value)} maxLength={200} disabled={busy || !!intake.jobId} /><small>A preference; confirm availability with the customer.</small></label></div>
        {!intake.jobId && <div className="intake-actions"><button className="button secondary compact" disabled={busy || !dirty}>{busy ? <LoaderCircle className="spin" size={16} /> : null} Save reviewed details</button>
          <button type="button" className="button primary compact" disabled={busy || dirty || intake.status !== "ready"} onClick={() => void perform("convert")}>Create draft job <ArrowRight size={15} /></button></div>}
      </form>}
      {intake.evidence.length > 0 && <details className="intake-evidence"><summary>Original customer quotes ({intake.evidence.length})</summary><div>{intake.evidence.map((item, index) => <blockquote key={`${item.messageId}-${item.field}-${index}`}><span>{readable(item.field)}</span><p>“{item.quote}”</p></blockquote>)}</div></details>}
      {intake.jobId && <button className="button primary compact" disabled={busy} onClick={() => void perform("open")}>View linked job <ArrowRight size={15} /></button>}
      {dirty && <p className="intake-hint">Save your reviewed details before analyzing again or creating a job.</p>}
    </>}
    {consent && <div className="intake-consent" role="region" aria-label="AI analysis consent"><h3>Share this conversation with AI?</h3><p>Analysis shares this customer’s messages with OpenAI to suggest request details. Check the original messages before saving or creating a job. This action sends no WhatsApp reply.</p><div className="intake-actions"><button className="button secondary compact" onClick={() => setConsent(false)}>Cancel AI analysis</button><button className="button primary compact" disabled={busy || dirty} onClick={() => void perform("analyze", true)}>Share conversation and analyze</button></div></div>}
    {error && <div className="error-message" role="alert">{error} <button className="text-button" disabled={busy} onClick={() => {
      if (operating.current) return;
      operating.current = true;
      setBusy(true);
      const request = ++revision.current;
      void api<{intake: Intake | null}>(`/conversations/${conversationId}/intake`).then((result) => {
        if (active.current && request === revision.current) { if (result.intake) accept(result.intake); setError(""); }
      }).catch((cause) => { if (active.current && request === revision.current) setError(cause.message); }).finally(() => {
        operating.current = false;
        if (active.current && request === revision.current) setBusy(false);
      });
    }}>Reload latest request (discard edits)</button></div>}
  </section>;
}
