import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  BookOpen,
  Check,
  FlaskConical,
  LoaderCircle,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { api, ApiError, mutation } from "./api";

export type BusinessKnowledge = {
  version: number;
  approved: boolean;
  services: {
    id: string;
    name: string;
    description: string;
    keywords: string[];
  }[];
  serviceAreas: string[];
  pricingPolicy: string;
  bookingPolicy: string;
  faqs: { id: string; question: string; answer: string; keywords: string[] }[];
  timezone: string;
  weeklyHours: { day: number; open: string; close: string; closed: boolean }[];
};
type ReceptionPolicy = {
  version: number;
  enabled: boolean;
  maxRepliesPerConversation: number;
  maxRepliesPerMinute: number;
  cooldownSeconds: number;
  businessHoursOnly: boolean;
};
type PolicyResponse = {
  policy: ReceptionPolicy;
  liveSendingAllowed: boolean;
  mode: "demo" | "live";
};
type LabTurn = { direction: "inbound" | "outbound"; text: string };
type Decision = {
  action: string;
  reasonCode: string;
  reason: string;
  reply: string | null;
  source: "rules";
  matchedFactIds: string[];
};
type LabResult = {
  decision: Decision;
  elapsedMs: number;
  mode: "simulation";
  sent: false;
};
type Evaluation = {
  cases: {
    id: string;
    title: string;
    passed: boolean;
    decision: Decision;
    expectedAction: string;
  }[];
  passed: number;
  total: number;
  providerVerified: false;
};
export type ReceptionMemory = {
  knowledge?: { draft: BusinessKnowledge; dirty: boolean };
  turns?: LabTurn[];
  labResult?: LabResult;
  automation?: { draft: ReceptionPolicy; dirty: boolean; data: PolicyResponse };
};
const days = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const weekdays = [1, 2, 3, 4, 5, 6, 0];
const splitList = (text: string) =>
  text
    .split(/[,\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
const errorMessage = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : "Something went wrong. Please try again.";
function Notice({
  children,
  danger = false,
}: {
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <div
      className={danger ? "error-message" : "reception-notice"}
      role={danger ? "alert" : undefined}
    >
      {children}
    </div>
  );
}
function Loading() {
  return (
    <div className="panel-loading">
      <LoaderCircle className="spin" size={20} /> Loading reception workspace…
    </div>
  );
}
function useLifetime() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

export function KnowledgePage({
  notify,
  memory,
}: {
  notify: (message: string) => void;
  memory: ReceptionMemory;
}) {
  const [draft, setDraft] = useState<BusinessKnowledge | null>(
    () => memory.knowledge?.draft || null,
  );
  const [dirty, setDirty] = useState(memory.knowledge?.dirty || false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const alive = useLifetime();
  const lock = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ knowledge: BusinessKnowledge }>("/knowledge", {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) {
          if (memory.knowledge?.dirty) {
            if (memory.knowledge.draft.version !== result.knowledge.version)
              setConflict(true);
          } else {
            setDraft(result.knowledge);
            memory.knowledge = { draft: result.knowledge, dirty: false };
          }
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [memory]);
  function edit(next: BusinessKnowledge, facts = true) {
    const value = { ...next, approved: facts ? false : next.approved };
    memory.knowledge = { draft: value, dirty: true };
    setDraft(value);
    setDirty(true);
    setError("");
  }
  async function reload() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ knowledge: BusinessKnowledge }>("/knowledge");
      if (alive.current) {
        memory.knowledge = { draft: result.knowledge, dirty: false };
        setDraft(result.knowledge);
        setDirty(false);
        setConflict(false);
        setConfirmReload(false);
      }
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || lock.current) return;
    if (
      draft.serviceAreas.length > 50 ||
      draft.serviceAreas.some((value) => value.length > 100)
    ) {
      setError(
        "Use up to 50 service areas, with each area no longer than 100 characters.",
      );
      return;
    }
    if (
      [...draft.services, ...draft.faqs].some(
        (fact) =>
          fact.keywords.length > 20 ||
          fact.keywords.some((keyword) => keyword.length > 80),
      )
    ) {
      setError(
        "Use up to 20 keywords per service or FAQ, with each keyword no longer than 80 characters.",
      );
      return;
    }
    lock.current = true;
    setBusy(true);
    setError("");
    const { version, ...fields } = draft;
    try {
      const result = await mutation<{ knowledge: BusinessKnowledge }>(
        "/knowledge",
        "PATCH",
        { ...fields, expectedVersion: version },
      );
      if (alive.current) {
        memory.knowledge = { draft: result.knowledge, dirty: false };
        delete memory.labResult;
        if (!memory.automation?.dirty) delete memory.automation;
        setDraft(result.knowledge);
        setDirty(false);
        setConflict(false);
        notify(
          result.knowledge.approved
            ? "Business knowledge reviewed and saved."
            : "Business knowledge saved. Review the facts before enabling automatic reception.",
        );
      }
    } catch (cause) {
      if (alive.current) {
        setError(errorMessage(cause));
        setConflict(cause instanceof ApiError && cause.status === 409);
      }
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  if (!draft)
    return error ? (
      <>
        <Notice danger>{error}</Notice>
        <button className="button" onClick={() => void reload()}>
          Try again
        </button>
      </>
    ) : (
      <Loading />
    );
  return (
    <form
      className="panel reception-editor"
      onSubmit={(event) => void save(event)}
    >
      <div className="panel-heading">
        <div>
          <h2>
            <BookOpen size={20} /> Business knowledge
          </h2>
          <p>
            Facts your receptionist may share. Keep them accurate and approved.
          </p>
        </div>
        <span className={`reception-badge ${draft.approved ? "approved" : ""}`}>
          {draft.approved ? "Reviewed" : "Needs review"}
        </span>
      </div>
      <div className="reception-body">
        <Notice>
          Automatic reception uses these approved facts. It cannot promise a
          price, appointment, or service that you have not defined. Editing a
          fact clears its approval.
        </Notice>
        {error && <Notice danger>{error}</Notice>}
        {conflict && (
          <Notice>
            Your saved knowledge changed while this form was open. Your edits
            are preserved.{" "}
            <button
              type="button"
              className="text-button"
              onClick={() => setConfirmReload(true)}
            >
              Reload saved knowledge
            </button>
          </Notice>
        )}
        {confirmReload && (
          <div className="reception-discard" role="alert">
            <strong>Discard your unsaved edits?</strong>
            <p>
              Reloading replaces this form with the latest saved business facts.
            </p>
            <div className="intake-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setConfirmReload(false)}
              >
                Keep my edits
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => void reload()}
              >
                Discard edits and reload
              </button>
            </div>
          </div>
        )}
        <fieldset className="reception-fields" disabled={busy}>
          <section className="knowledge-section">
            <div className="knowledge-section-heading">
              <div>
                <h3>Services you offer</h3>
                <p>Use short descriptions and natural words customers use.</p>
              </div>
              <button
                type="button"
                className="button"
                disabled={draft.services.length >= 30}
                onClick={() =>
                  edit({
                    ...draft,
                    services: [
                      ...draft.services,
                      {
                        id: crypto.randomUUID(),
                        name: "",
                        description: "",
                        keywords: [],
                      },
                    ],
                  })
                }
              >
                <Plus size={15} /> Add service
              </button>
            </div>
            {draft.services.length === 0 && (
              <p className="reception-muted">
                Add at least one service before approving automatic reception.
              </p>
            )}
            {draft.services.map((service, index) => (
              <div className="knowledge-row" key={service.id}>
                <div className="knowledge-row-heading">
                  <strong>Service {index + 1}</strong>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove service ${index + 1}`}
                    onClick={() =>
                      edit({
                        ...draft,
                        services: draft.services.filter(
                          (item) => item.id !== service.id,
                        ),
                      })
                    }
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
                <div className="reception-form-grid">
                  <label>
                    Service name
                    <input
                      required
                      maxLength={100}
                      value={service.name}
                      onChange={(event) =>
                        edit({
                          ...draft,
                          services: draft.services.map((item) =>
                            item.id === service.id
                              ? { ...item, name: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                  <label>
                    Service keywords
                    <input
                      maxLength={700}
                      key={`${service.id}-${draft.version}`}
                      defaultValue={service.keywords.join(", ")}
                      onChange={(event) =>
                        edit({
                          ...draft,
                          services: draft.services.map((item) =>
                            item.id === service.id
                              ? {
                                  ...item,
                                  keywords: splitList(event.target.value),
                                }
                              : item,
                          ),
                        })
                      }
                      placeholder="For example: tap, leak, plumbing"
                    />
                  </label>
                </div>
                <label>
                  Service description
                  <textarea
                    required
                    rows={2}
                    maxLength={1000}
                    value={service.description}
                    onChange={(event) =>
                      edit({
                        ...draft,
                        services: draft.services.map((item) =>
                          item.id === service.id
                            ? { ...item, description: event.target.value }
                            : item,
                        ),
                      })
                    }
                  />
                </label>
              </div>
            ))}
          </section>
          <section className="knowledge-section">
            <h3>Coverage and policies</h3>
            <label>
              Service areas
              <textarea
                rows={2}
                maxLength={2000}
                key={`areas-${draft.version}`}
                defaultValue={draft.serviceAreas.join("\n")}
                onChange={(event) =>
                  edit({
                    ...draft,
                    serviceAreas: splitList(event.target.value),
                  })
                }
                placeholder="One area per line, or separated by commas"
              />
              <small>
                Use specific neighbourhoods or towns. These are business facts,
                not a map or distance calculation.
              </small>
            </label>
            <div className="reception-form-grid">
              <label>
                Pricing policy
                <textarea
                  rows={4}
                  maxLength={1500}
                  value={draft.pricingPolicy}
                  onChange={(event) =>
                    edit({ ...draft, pricingPolicy: event.target.value })
                  }
                  placeholder="Your approved wording about quotes and call-out fees"
                />
              </label>
              <label>
                Booking policy
                <textarea
                  rows={4}
                  maxLength={1500}
                  value={draft.bookingPolicy}
                  onChange={(event) =>
                    edit({ ...draft, bookingPolicy: event.target.value })
                  }
                  placeholder="How your team confirms appointments"
                />
              </label>
            </div>
            <p className="reception-muted">
              Leave unknown policies blank. The receptionist hands those
              questions to your team.
            </p>
          </section>
          <section className="knowledge-section">
            <div className="knowledge-section-heading">
              <div>
                <h3>Frequently asked questions</h3>
                <p>
                  Exact answers for the routine questions your team receives.
                </p>
              </div>
              <button
                type="button"
                className="button"
                disabled={draft.faqs.length >= 50}
                onClick={() =>
                  edit({
                    ...draft,
                    faqs: [
                      ...draft.faqs,
                      {
                        id: crypto.randomUUID(),
                        question: "",
                        answer: "",
                        keywords: [],
                      },
                    ],
                  })
                }
              >
                <Plus size={15} /> Add FAQ
              </button>
            </div>
            {draft.faqs.map((faq, index) => (
              <div className="knowledge-row" key={faq.id}>
                <div className="knowledge-row-heading">
                  <strong>FAQ {index + 1}</strong>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove FAQ ${index + 1}`}
                    onClick={() =>
                      edit({
                        ...draft,
                        faqs: draft.faqs.filter((item) => item.id !== faq.id),
                      })
                    }
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
                <label>
                  Question
                  <input
                    required
                    maxLength={300}
                    value={faq.question}
                    onChange={(event) =>
                      edit({
                        ...draft,
                        faqs: draft.faqs.map((item) =>
                          item.id === faq.id
                            ? { ...item, question: event.target.value }
                            : item,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  Approved answer
                  <textarea
                    required
                    rows={3}
                    maxLength={1500}
                    value={faq.answer}
                    onChange={(event) =>
                      edit({
                        ...draft,
                        faqs: draft.faqs.map((item) =>
                          item.id === faq.id
                            ? { ...item, answer: event.target.value }
                            : item,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  Question keywords
                  <input
                    maxLength={700}
                    key={`${faq.id}-${draft.version}`}
                    defaultValue={faq.keywords.join(", ")}
                    onChange={(event) =>
                      edit({
                        ...draft,
                        faqs: draft.faqs.map((item) =>
                          item.id === faq.id
                            ? {
                                ...item,
                                keywords: splitList(event.target.value),
                              }
                            : item,
                        ),
                      })
                    }
                  />
                </label>
              </div>
            ))}
          </section>
          <section className="knowledge-section">
            <h3>Reception hours</h3>
            <label>
              Business timezone
              <input
                required
                maxLength={100}
                value={draft.timezone}
                onChange={(event) =>
                  edit({ ...draft, timezone: event.target.value })
                }
                placeholder="Africa/Johannesburg"
              />
              <small>
                Use an IANA timezone, such as Africa/Johannesburg. These hours
                control automatic reception, not team availability.
              </small>
            </label>
            <div className="weekly-hours">
              {weekdays.map((day) => {
                const hours = draft.weeklyHours.find(
                  (item) => item.day === day,
                ) || { day, open: "08:00", close: "17:00", closed: true };
                const update = (patch: Partial<typeof hours>) =>
                  edit({
                    ...draft,
                    weeklyHours: [
                      ...draft.weeklyHours.filter((item) => item.day !== day),
                      { ...hours, ...patch },
                    ].sort((a, b) => a.day - b.day),
                  });
                return (
                  <div className="hours-row" key={day}>
                    <strong>{days[day]}</strong>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={hours.closed}
                        aria-label={`${days[day]} closed`}
                        onChange={(event) =>
                          update({ closed: event.target.checked })
                        }
                      />{" "}
                      Closed
                    </label>
                    <label>
                      Opens
                      <input
                        type="time"
                        required
                        disabled={hours.closed}
                        aria-label={`${days[day]} opening time`}
                        value={hours.open}
                        onChange={(event) =>
                          update({ open: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Closes
                      <input
                        type="time"
                        required
                        disabled={hours.closed}
                        aria-label={`${days[day]} closing time`}
                        value={hours.close}
                        onChange={(event) =>
                          update({ close: event.target.value })
                        }
                      />
                    </label>
                  </div>
                );
              })}
            </div>
          </section>
          <div className="reception-approval">
            <ShieldCheck size={23} />
            <div>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={draft.approved}
                  onChange={(event) =>
                    edit({ ...draft, approved: event.target.checked }, false)
                  }
                />{" "}
                I reviewed these business facts
              </label>
              <p>
                Approve only facts you are comfortable sharing automatically
                with customers.
              </p>
            </div>
          </div>
        </fieldset>
        <div className="reception-form-footer">
          <span>
            {dirty
              ? "Unsaved changes · preserved while you navigate"
              : `Saved version ${draft.version}`}
          </span>
          <button
            className="button primary"
            disabled={busy || !dirty || conflict}
          >
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Check size={16} />
            )}{" "}
            Save business knowledge
          </button>
        </div>
      </div>
    </form>
  );
}

export function AutomationPage({
  notify,
  memory,
}: {
  notify: (message: string) => void;
  memory: ReceptionMemory;
}) {
  const [data, setData] = useState<PolicyResponse | null>(
    memory.automation?.data || null,
  );
  const [draft, setDraft] = useState<ReceptionPolicy | null>(
    memory.automation?.draft || null,
  );
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(memory.automation?.dirty || false);
  const [conflict, setConflict] = useState(false);
  const alive = useLifetime();
  const lock = useRef(false);
  async function load(discard = false) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const [result, facts] = await Promise.all([
        api<PolicyResponse>("/automation"),
        api<{ knowledge: BusinessKnowledge }>("/knowledge"),
      ]);
      if (alive.current) {
        const remembered = !discard ? memory.automation : undefined;
        const nextDraft = remembered?.dirty ? remembered.draft : result.policy;
        const nextDirty = remembered?.dirty || false;
        setData(result);
        setDraft(nextDraft);
        setApproved(
          facts.knowledge.approved &&
            facts.knowledge.services.length > 0 &&
            facts.knowledge.serviceAreas.length > 0,
        );
        setDirty(nextDirty);
        setConflict(nextDraft.version !== result.policy.version);
        setError("");
        memory.automation = {
          data: result,
          draft: nextDraft,
          dirty: nextDirty,
        };
      }
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function save(enabled?: boolean) {
    if (!draft || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const { version, ...fields } = draft;
    try {
      const result = await mutation<PolicyResponse>(
        enabled === false ? "/automation/stop" : "/automation",
        enabled === false ? "POST" : "PATCH",
        enabled === false
          ? {}
          : {
              ...fields,
              ...(enabled === undefined ? {} : { enabled }),
              expectedVersion: version,
            },
      );
      if (alive.current) {
        memory.automation = {
          data: result,
          draft: result.policy,
          dirty: false,
        };
        setData(result);
        setDraft(result.policy);
        setDirty(false);
        setConflict(false);
        notify(
          result.policy.enabled
            ? "Automatic reception enabled with the saved limits."
            : "Automatic reception is off.",
        );
      }
    } catch (cause) {
      if (alive.current) {
        setError(errorMessage(cause));
        setConflict(cause instanceof ApiError && cause.status === 409);
      }
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  if (!data || !draft)
    return error ? (
      <>
        <Notice danger>{error}</Notice>
        <button className="button" onClick={() => void load()}>
          Try again
        </button>
      </>
    ) : (
      <Loading />
    );
  const validLimits =
    Number.isInteger(draft.maxRepliesPerConversation) &&
    draft.maxRepliesPerConversation >= 1 &&
    draft.maxRepliesPerConversation <= 10 &&
    Number.isInteger(draft.maxRepliesPerMinute) &&
    draft.maxRepliesPerMinute >= 1 &&
    draft.maxRepliesPerMinute <= 30 &&
    Number.isInteger(draft.cooldownSeconds) &&
    draft.cooldownSeconds >= 10 &&
    draft.cooldownSeconds <= 600;
  function edit(patch: Partial<ReceptionPolicy>) {
    if (!draft || !data) return;
    const next = { ...draft, ...patch };
    memory.automation = { data, draft: next, dirty: true };
    setDraft(next);
    setDirty(true);
  }
  return (
    <div className="reception-stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>
              <Zap size={20} /> Automatic reception
            </h2>
            <p>A limited first response, using approved business facts.</p>
          </div>
          <span
            className={`reception-badge ${data.policy.enabled ? "approved" : ""}`}
          >
            {data.policy.enabled ? "Enabled" : "Off"}
          </span>
        </div>
        <div className="reception-body">
          <div className="automation-control">
            <div>
              <strong>
                {data.policy.enabled
                  ? "Automatic reception is enabled"
                  : "Human review is the default"}
              </strong>
              <p>
                AI-generated drafts still require a person to review and send
                them. Automatic reception uses bounded business rules. Replies
                already submitted to WhatsApp cannot be recalled.
              </p>
            </div>
            {data.policy.enabled ? (
              <button
                type="button"
                className="button reception-stop"
                disabled={busy}
                onClick={() => void save(false)}
              >
                Turn off automatic reception
              </button>
            ) : (
              <button
                type="button"
                className="button primary"
                disabled={
                  busy ||
                  !approved ||
                  conflict ||
                  (data.mode === "live" && !data.liveSendingAllowed)
                }
                onClick={() => void save(true)}
              >
                Enable automatic reception
              </button>
            )}
          </div>
          {data.mode === "demo" ? (
            <Notice>
              Demo only: automatic responses stay inside this workspace. Nothing
              is delivered to WhatsApp.
            </Notice>
          ) : !data.liveSendingAllowed ? (
            <Notice>
              Live automatic sending is locked by the server. Finish Meta setup
              and explicitly configure the live sending gate before enabling it.
            </Notice>
          ) : (
            <Notice>
              Live automatic sending is allowed by the server. Enabling this
              control permits customer replies within the saved limits.
            </Notice>
          )}
          {!approved && (
            <Notice>
              Review and approve Business knowledge before enabling automatic
              reception.
            </Notice>
          )}
          {error && <Notice danger>{error}</Notice>}
          {conflict && (
            <Notice>
              Another operator changed these controls. Your form is preserved.{" "}
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void load(true)}
              >
                Discard changes and reload controls
              </button>
            </Notice>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset className="reception-fields" disabled={busy}>
              <div className="reception-form-grid">
                <label>
                  Replies per conversation
                  <input
                    type="number"
                    required
                    min={1}
                    max={10}
                    value={draft.maxRepliesPerConversation}
                    onChange={(event) =>
                      edit({
                        maxRepliesPerConversation: Number(event.target.value),
                      })
                    }
                  />
                  <small>
                    A cap on automatic replies in each conversation over a
                    rolling 24-hour period.
                  </small>
                </label>
                <label>
                  Replies per minute
                  <input
                    type="number"
                    required
                    min={1}
                    max={30}
                    value={draft.maxRepliesPerMinute}
                    onChange={(event) =>
                      edit({ maxRepliesPerMinute: Number(event.target.value) })
                    }
                  />
                  <small>A workspace-wide limit on automatic replies.</small>
                </label>
                <label>
                  Cooldown between replies (seconds)
                  <input
                    type="number"
                    required
                    min={10}
                    max={600}
                    value={draft.cooldownSeconds}
                    onChange={(event) =>
                      edit({ cooldownSeconds: Number(event.target.value) })
                    }
                  />
                </label>
                <div className="reception-hours-toggle">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={draft.businessHoursOnly}
                      onChange={(event) =>
                        edit({ businessHoursOnly: event.target.checked })
                      }
                    />{" "}
                    Reply only during business hours
                  </label>
                  <p>
                    Uses the timezone and weekly hours saved in Business
                    knowledge.
                  </p>
                </div>
              </div>
            </fieldset>
            <div className="reception-form-footer">
              <span>
                {dirty
                  ? "Unsaved limit changes"
                  : `Saved version ${draft.version}`}
              </span>
              <button
                className="button primary"
                disabled={busy || !dirty || conflict}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Check size={16} />
                )}{" "}
                Save reception limits
              </button>
            </div>
          </form>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>
              <ShieldCheck size={20} /> A clear boundary for your receptionist
            </h2>
            <p>
              Useful routine answers. Your team handles judgement and
              commitments.
            </p>
          </div>
        </div>
        <div className="reception-body">
          <div className="automation-boundaries">
            <div>
              <h3>May answer</h3>
              <p>
                Approved services, coverage, policies, and routine questions
                that match your business facts.
              </p>
            </div>
            <div>
              <h3>Hands over</h3>
              <p>
                Urgent safety concerns, requests for a person, unclear
                questions, unavailable facts, and booking commitments.
              </p>
            </div>
            <div>
              <h3>Always limited</h3>
              <p>
                Reply caps, cooldowns, human takeover, approved facts, and
                WhatsApp’s customer-service window.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function DecisionCard({ result }: { result: LabResult }) {
  return (
    <div className="lab-decision" role="status">
      <div className="lab-decision-heading">
        <strong>{({reply: "Routine reply", handoff: "Needs a person", ignore: "No automatic reply"} as Record<string,string>)[result.decision.action] || result.decision.action}</strong>
        <span>{Math.round(result.elapsedMs)} ms · Business rules</span>
      </div>
      <p>{result.decision.reason}</p>
      {result.decision.reply && (
        <blockquote>{result.decision.reply}</blockquote>
      )}
      <details>
        <summary>Why this decision?</summary>
        <p>{result.decision.reason}</p>
        <p>
          {result.decision.matchedFactIds.length
            ? `This decision uses ${result.decision.matchedFactIds.length} approved business fact${result.decision.matchedFactIds.length === 1 ? "" : "s"}. Review them in Business knowledge.`
            : "This decision did not require a business fact."}
        </p>
        <p>
          Simulation only. No message was sent and no AI provider was called.
        </p>
      </details>
    </div>
  );
}
export function ReceptionLabPage({ memory }: { memory: ReceptionMemory }) {
  const [turns, setTurns] = useState<LabTurn[]>(memory.turns || []);
  const [text, setText] = useState("");
  const [direction, setDirection] = useState<LabTurn["direction"]>("inbound");
  const [result, setResult] = useState<LabResult | null>(
    memory.labResult || null,
  );
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [busy, setBusy] = useState<"preview" | "checks" | "ai" | null>(null);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [consent, setConsent] = useState(false);
  const [aiResult, setAiResult] = useState<{
    text: string;
    reason: string;
    source: "ai";
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ integration: { aiConfigured: boolean } }>("/settings", {
      signal: controller.signal,
    })
      .then((response) => {
        if (!controller.signal.aborted)
          setAiConfigured(response.integration.aiConfigured);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const [error, setError] = useState("");
  const alive = useLifetime();
  const lock = useRef(false);
  function addTurn(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || turns.length >= 12 || busy) return;
    if (
      turns.reduce((sum, turn) => sum + turn.text.length, 0) +
        text.trim().length >
      12000
    ) {
      setError(
        "Keep the test conversation within 12,000 characters. Reset the conversation to start again.",
      );
      return;
    }
    const next = [...turns, { direction, text: text.trim() }];
    memory.turns = next;
    delete memory.labResult;
    setTurns(next);
    setText("");
    setResult(null);
    setAiResult(null);
    setError("");
  }
  async function preview() {
    if (lock.current || !turns.length) return;
    lock.current = true;
    setBusy("preview");
    setError("");
    try {
      const response = await mutation<LabResult>(
        "/reception/simulate",
        "POST",
        { messages: turns },
      );
      if (alive.current) {
        memory.labResult = response;
        setResult(response);
      }
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
    } finally {
      lock.current = false;
      if (alive.current) setBusy(null);
    }
  }
  async function previewAi() {
    if (lock.current || !turns.length) return;
    lock.current = true;
    setBusy("ai");
    setConsent(false);
    setError("");
    setAiResult(null);
    try {
      const response = await mutation<{
        draft: { text: string; reason: string; source: "ai" };
        sent: false;
        mode: "simulation";
      }>("/reception/ai-draft", "POST", { messages: turns, useAi: true });
      if (alive.current) setAiResult(response.draft);
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
    } finally {
      lock.current = false;
      if (alive.current) setBusy(null);
    }
  }
  async function evaluate() {
    if (lock.current) return;
    lock.current = true;
    setBusy("checks");
    setError("");
    try {
      const response = await mutation<Evaluation>(
        "/reception/evaluate",
        "POST",
        {},
      );
      if (alive.current) setEvaluation(response);
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
    } finally {
      lock.current = false;
      if (alive.current) setBusy(null);
    }
  }
  return (
    <div className="reception-stack">
      <Notice>
        Private sandbox: use fictional customer details. Rule previews and
        safety scenarios send no messages and make no external AI calls.
        Optional AI previews require your permission to share test text and
        business facts with OpenAI.
      </Notice>
      {error && <Notice danger>{error}</Notice>}
      <div className="lab-layout">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>
                <FlaskConical size={20} /> Conversation sandbox
              </h2>
              <p>Preview your business facts before enabling reception.</p>
            </div>
            <button
              className="text-button"
              disabled={!!busy || !turns.length}
              onClick={() => {
                memory.turns = [];
                delete memory.labResult;
                setTurns([]);
                setResult(null);
                setAiResult(null);
                setError("");
              }}
            >
              Reset conversation
            </button>
          </div>
          <div className="reception-body">
            <div
              className="lab-turns"
              role="log"
              aria-label="Simulated conversation"
              tabIndex={0}
            >
              {turns.length ? (
                turns.map((turn, index) => (
                  <div className={`lab-turn ${turn.direction}`} key={index}>
                    <span>
                      {turn.direction === "inbound"
                        ? "Customer"
                        : "Receptionist"}{" "}
                      · Turn {index + 1}
                    </span>
                    <p>{turn.text}</p>
                  </div>
                ))
              ) : (
                <div className="lab-placeholder">
                  <MessageHint />
                  <h3>Try a real-world question</h3>
                  <p>
                    Add a fictional customer message, then preview how reception
                    would respond.
                  </p>
                </div>
              )}
            </div>
            <form onSubmit={addTurn}>
              <fieldset
                className="reception-fields"
                disabled={!!busy || consent}
              >
                <label>
                  Speaker
                  <select
                    value={direction}
                    onChange={(event) =>
                      setDirection(event.target.value as LabTurn["direction"])
                    }
                  >
                    <option value="inbound">Customer</option>
                    <option value="outbound">Receptionist</option>
                  </select>
                </label>
                <label>
                  Test message
                  <textarea
                    rows={3}
                    maxLength={2000}
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    placeholder="For example: Do you repair leaking taps?"
                  />
                </label>
                <div className="lab-actions">
                  <span>{turns.length}/12 turns</span>
                  <button
                    className="button"
                    disabled={!text.trim() || turns.length >= 12}
                  >
                    <Plus size={15} /> Add turn
                  </button>
                </div>
              </fieldset>
            </form>
            <button
              className="button primary lab-preview-button"
              disabled={
                !!busy || !turns.some((turn) => turn.direction === "inbound")
              }
              onClick={() => void preview()}
            >
              {busy === "preview" ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Zap size={16} />
              )}{" "}
              Preview reception decision
            </button>
            {aiConfigured && (
              <button
                className="button lab-preview-button"
                disabled={
                  !!busy || !turns.some((turn) => turn.direction === "inbound")
                }
                onClick={() => setConsent(true)}
              >
                {busy === "ai" ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Sparkles size={16} />
                )}{" "}
                Preview AI draft
              </button>
            )}
          </div>
        </section>
        <section className="panel lab-result-panel">
          <div className="panel-heading">
            <div>
              <h2>Decision preview</h2>
              <p>Uses your current saved and approved business knowledge.</p>
            </div>
          </div>
          <div className="reception-body">
            {result ? (
              <DecisionCard result={result} />
            ) : (
              <p className="reception-muted">
                Add a customer turn and preview a decision. Automatic reception
                does not need to be enabled to use this sandbox.
              </p>
            )}
            <p className="lab-footnote">
              This preview does not use a customer's reply allowance. In live
              conversations, reply limits, WhatsApp eligibility, and delivery
              checks also apply.
            </p>
            {aiResult && (
              <div className="lab-ai-result" role="status">
                <h3>
                  <Sparkles size={16} /> AI draft preview
                </h3>
                <blockquote>{aiResult.text}</blockquote>
                <p>{aiResult.reason}</p>
                <p>
                  Generated by the configured AI provider. Review accuracy and
                  business facts before using this draft. No message was sent.
                </p>
              </div>
            )}
          </div>
        </section>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>
              <ShieldCheck size={20} /> Sandbox safety scenarios
            </h2>
            <p>Repeatable checks against an isolated fictional business.</p>
          </div>
          <button
            className="button"
            disabled={!!busy}
            onClick={() => void evaluate()}
          >
            {busy === "checks" ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <ShieldCheck size={16} />
            )}{" "}
            Run safety checks
          </button>
        </div>
        <div className="reception-body">
          <p className="reception-muted">
            Scenarios check routine answers, handoff, unknown facts, and safety
            boundaries. They do not certify an AI model or verify Meta
            connectivity.
          </p>
          {evaluation && (
            <>
              <div className="lab-score" role="status">
                <strong>
                  {evaluation.passed} / {evaluation.total}
                </strong>
                <span>scenarios passed · Live provider unverified</span>
              </div>
              <div className="lab-cases">
                {evaluation.cases.map((item) => (
                  <details key={item.id}>
                    <summary>
                      <span
                        className={`reception-badge ${item.passed ? "approved" : ""}`}
                      >
                        {item.passed ? "Passed" : "Failed"}
                      </span>
                      <strong>{item.title}</strong>
                    </summary>
                    <p>{item.decision.reason}</p>
                    <p>
                      Expected: {item.expectedAction.replace(/_/g, " ")} ·
                      Received: {item.decision.action.replace(/_/g, " ")}
                    </p>
                    {item.decision.reply && (
                      <blockquote>{item.decision.reply}</blockquote>
                    )}
                  </details>
                ))}
              </div>
            </>
          )}
        </div>
      </section>
      {consent && (
        <AiConsentDialog
          onClose={() => setConsent(false)}
          onApprove={() => void previewAi()}
        />
      )}
    </div>
  );
}
function MessageHint() {
  return <FlaskConical size={29} aria-hidden="true" />;
}

function AiConsentDialog({
  onClose,
  onApprove,
}: {
  onClose: () => void;
  onApprove: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const elements = () =>
      Array.from(
        panel.current?.querySelectorAll<HTMLButtonElement>("button") || [],
      );
    elements()[1]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      if (event.key === "Tab") {
        const buttons = elements();
        if (event.shiftKey && document.activeElement === buttons[0]) {
          event.preventDefault();
          buttons.at(-1)?.focus();
        } else if (
          !event.shiftKey &&
          document.activeElement === buttons.at(-1)
        ) {
          event.preventDefault();
          buttons[0]?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal lab-consent-modal"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lab-ai-consent-title"
        aria-describedby="lab-ai-consent-detail"
      >
        <div className="modal-heading">
          <h2 id="lab-ai-consent-title">Share this test with OpenAI?</h2>
          <button
            className="icon-button"
            aria-label="Close AI preview dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <div className="reception-body">
          <p id="lab-ai-consent-detail">
            Generating an AI preview sends the test conversation and your
            approved business knowledge to the configured OpenAI provider. Use
            fictional customer details.
          </p>
          <p>
            This produces a draft for review. It does not send a WhatsApp
            message or enable automatic AI replies.
          </p>
          <div className="intake-actions">
            <button className="button" onClick={onClose}>
              Keep testing locally
            </button>
            <button className="button primary" onClick={onApprove}>
              <Sparkles size={16} /> Share and generate preview
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
