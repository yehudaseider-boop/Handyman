import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Activity as ActivityIcon,
  BookOpen,
  FlaskConical,
  Zap,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  CalendarDays,
  BriefcaseBusiness,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Clock3,
  Inbox,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  MessageCircle,
  MessageSquare,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import {
  api,
  ApiError,
  mutation,
  initials,
  formatDate,
  formatTime,
  relativeTime,
  type Activity,
  type Conversation,
  type Dashboard,
  type Integration,
  type IntegrationReadiness,
  type Job,
  type Message,
  type Settings,
  type User,
} from "./api";

import { IntakePanel, type IntakeDraft } from "./IntakePanel";
import { SchedulePage } from "./SchedulePage";
import { useVisiblePolling } from "./useVisiblePolling";
import { KnowledgePage, AutomationPage, ReceptionLabPage, type ReceptionMemory } from "./ReceptionPages";

type Page = "overview" | "inbox" | "jobs" | "schedule" | "automation" | "knowledge" | "automatic" | "lab" | "activity";
const navigation: { id: Page; label: string; icon: typeof Inbox }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "jobs", label: "Service jobs", icon: BriefcaseBusiness },
  { id: "schedule", label: "Schedule", icon: CalendarDays },
  { id: "automation", label: "Reception settings", icon: Settings2 },
  { id: "knowledge", label: "Business knowledge", icon: BookOpen },
  { id: "automatic", label: "Automatic reception", icon: Zap },
  { id: "lab", label: "Reception lab", icon: FlaskConical },
  { id: "activity", label: "Activity log", icon: ActivityIcon },
];
const pageCopy = {
  overview: [
    "A little clarity. A lot of progress.",
    "Your business, at a glance.",
  ],
  inbox: ["Every conversation, in good hands.", "Keep your customers close."],
  jobs: ["Good work starts here.", "From first request to a job well done."],
  schedule: ["Make room for good work.", "A clear plan for your team’s week."],
  automation: [
    "Make a great first impression.",
    "Set up your WhatsApp reception.",
  ],
  knowledge: ["Give reception the right answers.", "Business facts your customers can trust."],
  automatic: ["A helpful first response. Clear limits.", "Control what your receptionist can answer automatically."],
  lab: ["Try it here. Learn before going live.", "A safe place to test your receptionist’s decisions."],
  activity: [
    "The details behind your day.",
    "A clear record of your workspace.",
  ],
};

function Spinner() {
  return <LoaderCircle className="spin" size={20} aria-hidden="true" />;
}
function ErrorMessage({ message }: { message: string }) {
  return message ? (
    <div className="error-message" role="alert">
      {message}
    </div>
  ) : null;
}
function Empty({
  icon: Icon = MessageSquare,
  title,
  detail,
  children,
}: {
  icon?: typeof Inbox;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={25} />
      </div>
      <h3>{title}</h3>
      <p>{detail}</p>
      {children}
    </div>
  );
}
function Status({ status }: { status: string }) {
  return (
    <span className={`status status-${status}`}>
      <span />
      {status.replace(/_/g, " ")}
    </span>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const elements = () =>
      Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'button, input, select, textarea, [tabindex="0"]',
        ) || [],
      ).filter((el) => !el.hasAttribute("disabled"));
    elements()[1]?.focus();
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") closeRef.current();
      if (event.key === "Tab") {
        const list = elements();
        if (event.shiftKey && document.activeElement === list[0]) {
          event.preventDefault();
          list.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === list.at(-1)) {
          event.preventDefault();
          list[0]?.focus();
        }
      }
    }
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
        ref={panel}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div className="modal-heading">
          <h2 id="modal-title">{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [mode, setMode] = useState<"demo" | "live">("live");
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState("");
  const [page, setPage] = useState<Page>("overview");
  const [sidebar, setSidebar] = useState(false);
  const [mobileNav, setMobileNav] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const navigationPanel = useRef<HTMLElement>(null);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const update = () => { setMobileNav(query.matches); if (!query.matches) setSidebar(false); };
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!sidebar || !mobileNav || !user) return;
    const focusable = () => Array.from(navigationPanel.current?.querySelectorAll<HTMLElement>('button, a[href]') || []).filter(element => !element.hasAttribute('disabled') && element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setSidebar(false); }
      if (event.key === 'Tab') {
        const elements = focusable();
        if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); navigationToggle.current?.focus(); };
  }, [sidebar, mobileNav, user]);
  const [globalSearch, setGlobalSearch] = useState("");
  const [toast, setToast] = useState("");
  const [jobModal, setJobModal] = useState(false);
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [jobCustomer, setJobCustomer] = useState<Conversation | undefined>();
  const [revision, setRevision] = useState(0);
  const receptionMemory = useRef<ReceptionMemory>({});
  const inboxMemory = useRef({ drafts: new Map<string, string>(), intakeDrafts: new Map<string, IntakeDraft>(), sendIntents: new Map<string, { text: string; id: string }>(), selected: "" });
  const notify = useCallback((message: string) => {
    setToast(message);
    setRevision((v) => v + 1);
  }, []);
  const initialize = useCallback(async () => {
    setLoading(true);
    setConnectionError("");
    try {
      const health = await api<{ mode: "demo" | "live" }>("/health");
      setMode(health.mode);
      try {
        const session = await api<{ user: User; mode: "demo" | "live" }>(
          "/auth/me",
        );
        setUser(session.user);
        setMode(session.mode);
      } catch (error) {
        if (!(
          error instanceof Error &&
          "status" in error &&
          error.status === 401
        ))
          throw error;
      }
    } catch (error) {
      setConnectionError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void initialize();
  }, [initialize]);
  useEffect(() => {
    const expire = () => {
      receptionMemory.current = {};
      inboxMemory.current.drafts.clear();
      inboxMemory.current.intakeDrafts.clear();
      inboxMemory.current.sendIntents.clear();
      inboxMemory.current.selected = "";
      setUser(null);
      setToast("Your session expired. Please sign in again.");
    };
    window.addEventListener("session-expired", expire);
    return () => window.removeEventListener("session-expired", expire);
  }, []);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 5000);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  function go(next: Page) {
    setPage(next);
    setSidebar(false);
    if (next !== "inbox") setGlobalSearch("");
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }
  async function logout() {
    try {
      await mutation("/auth/logout", "POST", {});
      receptionMemory.current = {};
      inboxMemory.current.drafts.clear();
      inboxMemory.current.intakeDrafts.clear();
      inboxMemory.current.sendIntents.clear();
      inboxMemory.current.selected = "";
      setUser(null);
    } catch (error) {
      notify((error as Error).message);
    }
  }
  if (loading)
    return (
      <div className="boot">
        <div className="brand-mark">
          <Wrench size={26} />
        </div>
        <Spinner />
        <p>Getting your workspace ready…</p>
      </div>
    );
  if (connectionError)
    return (
      <div className="boot">
        <Empty
          title="We couldn’t reach your workspace"
          detail={connectionError}
        >
          <button className="button primary" onClick={() => void initialize()}>
            Try again
          </button>
        </Empty>
      </div>
    );
  if (!user)
    return (
      <>
        <Login
          mode={mode}
          onLogin={(nextUser, nextMode) => {
            setUser(nextUser);
            setMode(nextMode);
          }}
        />
        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
      </>
    );
  return (
    <div className="app-shell">
      {sidebar && (
        <button
          className="sidebar-scrim"
          tabIndex={-1}
          aria-label="Close navigation"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside ref={navigationPanel} className={`sidebar ${sidebar ? "visible" : ""}`} inert={mobileNav && !sidebar} aria-hidden={mobileNav && !sidebar ? true : undefined}>
        <button className="icon-button mobile-nav-close" aria-label="Close navigation drawer" onClick={() => setSidebar(false)}><X size={20} /></button>
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            go("overview");
          }}
        >
          <span className="brand-mark">
            <Wrench size={23} />
          </span>
          <span>
            handyman<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="workspace-switch">
          <span className="workspace-avatar">H</span>
          <div>
            <strong>Handyman workspace</strong>
            <span>WhatsApp reception</span>
          </div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? "active" : ""}`}
              onClick={() => go(id)}
              aria-current={page === id ? "page" : undefined}
            >
              <Icon size={19} />
              <span>{label}</span>
              {page === id && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="reception-card">
            <div className="reception-card-icon">
              <MessageCircle size={21} />
              <span className="online-dot" />
            </div>
            <strong>A warmer welcome.</strong>
            <p>One place for your messages, customers, and service jobs.</p>
            <button onClick={() => go("automation")}>
              Set up reception <ArrowRight size={15} />
            </button>
          </div>
          <div className="sidebar-user">
            <div className="avatar">{initials(user.name || user.email)}</div>
            <div>
              <strong>{user.name || "Administrator"}</strong>
              <span>Workspace admin</span>
            </div>
            <button
              className="icon-button"
              onClick={() => void logout()}
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell" inert={mobileNav && sidebar} aria-hidden={mobileNav && sidebar ? true : undefined}>
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button menu-toggle"
              ref={navigationToggle}
              aria-label="Open navigation"
              aria-expanded={sidebar}
              onClick={() => setSidebar(true)}
            >
              <Menu size={21} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>
              {navigation.find((item) => item.id === page)?.label}
            </strong>
          </div>
          <div className="topbar-right">
            <span
              className={`connection-pill ${mode === "demo" ? "demo-pill" : ""}`}
            >
              <span />
              {mode === "demo" ? "Demo workspace" : "Live workspace"}
            </span>
            <button
              className="icon-button activity-shortcut"
              title="View activity"
              aria-label="View recent activity"
              onClick={() => go("activity")}
            >
              <Bell size={20} />
            </button>
            <div className="avatar small">
              {initials(user.name || user.email)}
            </div>
          </div>
        </header>
        <main>
          {mode === "demo" && (
            <div className="demo-banner">
              <Sparkles size={15} />
              <span>
                <strong>You’re exploring demo mode.</strong> Messages stay in
                this workspace; no WhatsApp messages are delivered.
              </span>
              <button onClick={() => go("automation")}>
                Connection details <ArrowRight size={14} />
              </button>
            </div>
          )}
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                YOUR {page === "overview" ? "DAILY PICTURE" : "WORKSPACE"}
              </div>
              <h1>{pageCopy[page][0]}</h1>
              <p>{pageCopy[page][1]}</p>
            </div>
            <button
              className="button primary"
              onClick={() => {
                setJobCustomer(undefined);
                setJobModal(true);
              }}
            >
              <Plus size={17} /> New service job
            </button>
          </div>
          {page === "overview" && (
            <Overview
              revision={revision}
              onNavigate={go}
              onNewJob={() => setJobModal(true)}
            />
          )}
          {page === "inbox" && (
            <InboxPage
              memory={inboxMemory.current}
              mode={mode}
              query={globalSearch}
              setQuery={setGlobalSearch}
              notify={notify}
              onOpenJob={setEditingJob}
              onNewJob={(customer) => {
                setJobCustomer(customer);
                setJobModal(true);
              }}
            />
          )}
          {page === "jobs" && (
            <JobsPage
              revision={revision}
              notify={notify}
              onNewJob={() => setJobModal(true)}
            />
          )}
          {page === "schedule" && <SchedulePage revision={revision} onEdit={setEditingJob} onNewJob={() => { setJobCustomer(undefined); setJobModal(true); }} />}
          {page === "automation" && <SettingsPage notify={notify} />}
          {page === "knowledge" && <KnowledgePage notify={notify} memory={receptionMemory.current} />}
          {page === "automatic" && <AutomationPage notify={notify} memory={receptionMemory.current} />}
          {page === "lab" && <ReceptionLabPage memory={receptionMemory.current} />}
          {page === "activity" && <ActivityPage revision={revision} />}
          <footer className="page-footer">
            <span>Built for the people who get things done.</span>
            <span>
              <ShieldCheck size={13} /> Your workspace, protected
            </span>
          </footer>
        </main>
      </div>
      {editingJob && <JobModal job={editingJob} onClose={() => setEditingJob(null)} onCreated={() => { setEditingJob(null); notify("Service job details saved."); }} />}
      {jobModal && (
        <JobModal
          customer={jobCustomer}
          onClose={() => setJobModal(false)}
          onCreated={() => {
            setJobModal(false);
            notify("Service job created. You’re ready to get to work.");
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <CircleCheck size={18} />
          {toast}
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function Login({
  mode,
  onLogin,
}: {
  mode: "demo" | "live";
  onLogin: (user: User, mode: "demo" | "live") => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function signIn(credentials: { email: string; password: string }) {
    setBusy(true);
    setError("");
    try {
      const result = await mutation<{ user: User; mode: "demo" | "live" }>(
        "/auth/login",
        "POST",
        credentials,
      );
      onLogin(result.user, result.mode);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-story">
        <div className="brand light">
          <span className="brand-mark">
            <Wrench size={23} />
          </span>
          <span>handyman.</span>
        </div>
        <div className="login-story-copy">
          <span className="story-kicker">
            <span /> A BETTER WAY TO RUN YOUR DAY
          </span>
          <h1>
            Good service.
            <br />
            Starts with a<br />
            <em>great conversation.</em>
          </h1>
          <p>
            Your WhatsApp messages, customer requests, and service jobs.
            Together at last.
          </p>
          <div className="story-preview">
            <div className="story-preview-top">
              <span className="story-avatar">JM</span>
              <div>
                <strong>James M.</strong>
                <span>New service request</span>
              </div>
              <MessageCircle size={23} />
            </div>
            <div className="story-bubble">
              Hi! Could you help fix a leaking kitchen tap?
            </div>
            <div className="story-reply">
              Of course. You’re in the right place.
              <CheckCheck size={15} />
            </div>
            <span className="story-note">
              <CircleCheck size={15} /> Small details. Happier customers.
            </span>
          </div>
        </div>
        <div className="story-footer">
          Made for the business you’re building.
        </div>
      </div>
      <div className="login-form-panel">
        <div className="login-form">
          <span className="login-small-brand">
            <Wrench size={24} /> handyman.
          </span>
          <div className="eyebrow">WELCOME TO YOUR WORKSPACE</div>
          <h2>Let’s get to work.</h2>
          <p>Sign in to keep your business moving.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void signIn({ email, password });
            }}
          >
            <label>
              Email address
              <input
                type="email"
                autoComplete="username"
                placeholder="you@yourbusiness.com"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                maxLength={254}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                placeholder="Enter your password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                maxLength={200}
              />
            </label>
            <ErrorMessage message={error} />
            <button className="button primary login-submit" disabled={busy}>
              {busy ? (
                <Spinner />
              ) : (
                <>
                  Sign in <ArrowRight size={17} />
                </>
              )}
            </button>
          </form>
          {mode === "demo" && (
            <div className="demo-login">
              <div className="divider">
                <span>JUST LOOKING AROUND?</span>
              </div>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void signIn({
                    email: "admin@handyman.local",
                    password: "DemoPass!2026",
                  })
                }
              >
                <Sparkles size={17} /> Explore the demo workspace
              </button>
              <p>
                Try the full experience with sample customers.
                <br />
                No real WhatsApp messages are sent.
              </p>
            </div>
          )}
          <div className="login-security">
            <ShieldCheck size={15} /> Secure sign-in. Your business stays yours.
          </div>
        </div>
      </div>
    </div>
  );
}

function Overview({
  revision,
  onNavigate,
  onNewJob,
}: {
  revision: number;
  onNavigate: (page: Page) => void;
  onNewJob: () => void;
}) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([
      api<Dashboard>("/dashboard"),
      api<{ jobs: Job[] }>("/jobs"),
    ])
      .then(([next, result]) => {
        if (active) {
          setData(next);
          setJobs(result.jobs);
          setError("");
        }
      })
      .catch((cause) => {
        if (active) setError(cause.message);
      });
    return () => {
      active = false;
    };
  }, [revision]);
  if (error) return <ErrorMessage message={error} />;
  if (!data)
    return (
      <div className="panel-loading">
        <Spinner /> Loading your daily picture…
      </div>
    );
  const statItems = [
    {
      label: "Open conversations",
      value: data.stats.openConversations,
      icon: MessageSquare,
      note: "Customers to connect with",
      color: "green",
    },
    {
      label: "Unread messages",
      value: data.stats.unreadMessages,
      icon: Inbox,
      note: "A little attention goes a long way",
      color: "orange",
    },
    {
      label: "Active service jobs",
      value: data.stats.activeJobs,
      icon: BriefcaseBusiness,
      note: "Good work in the making",
      color: "blue",
    },
    {
      label: "Jobs completed",
      value: data.stats.completedJobs,
      icon: CircleCheck,
      note: "Another happy customer",
      color: "purple",
    },
  ];
  const messageTotal = data.dailyMessages.reduce(
    (sum, day) => sum + day.inbound + day.outbound,
    0,
  );
  const maxMessages = Math.max(
    1,
    ...data.dailyMessages.map((day) => day.inbound + day.outbound),
  );
  const activeJobs = jobs
    .filter((job) => job.status !== "completed")
    .slice(0, 4);
  return (
    <>
      <div className="stats-grid">
        {statItems.map(({ label, value, icon: Icon, note, color }) => (
          <button
            className="stat-card"
            key={label}
            onClick={() =>
              onNavigate(
                color === "green" || color === "orange" ? "inbox" : "jobs",
              )
            }
          >
            <div className="stat-top">
              <span>{label}</span>
              <span className={`stat-icon ${color}`}>
                <Icon size={19} />
              </span>
            </div>
            <div className="stat-value">
              {value}
              <ArrowUpRight size={20} />
            </div>
            <div className="stat-note">{note}</div>
          </button>
        ))}
      </div>
      <div className="overview-main-grid">
        <section className="panel chart-panel">
          <div className="panel-heading">
            <div>
              <h2>Conversations in motion</h2>
              <p>Incoming and outgoing messages over the last 7 days</p>
            </div>
            <span className="subtle-pill">
              <Clock3 size={13} /> Last 7 days
            </span>
          </div>
          <div className="chart-summary">
            <strong>{messageTotal}</strong>
            <span>messages exchanged</span>
            <div className="chart-legend">
              <span>
                <i className="legend-in" /> Incoming
              </span>
              <span>
                <i className="legend-out" /> Outgoing
              </span>
            </div>
          </div>
          <div
            className="chart"
            aria-label={`${messageTotal} messages over the last seven days`}
          >
            <div className="chart-guides">
              <span>{maxMessages}</span>
              <span>{Math.round(maxMessages / 2)}</span>
              <span>0</span>
            </div>
            <div className="chart-bars">
              {data.dailyMessages.map((day) => (
                <div className="chart-day" key={day.date}>
                  <div
                    className="bar-pair"
                    title={`${formatDate(day.date)}: ${day.inbound} incoming, ${day.outbound} outgoing`}
                  >
                    <div
                      className="bar inbound"
                      style={{
                        height: `${(day.inbound / maxMessages) * 100}%`,
                      }}
                    />
                    <div
                      className="bar outbound"
                      style={{
                        height: `${(day.outbound / maxMessages) * 100}%`,
                      }}
                    />
                  </div>
                  <span>
                    {new Intl.DateTimeFormat("en-ZA", {
                      weekday: "short",
                    }).format(new Date(day.date))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
        <section className="focus-card">
          <div className="focus-icon">
            <Sparkles size={23} />
          </div>
          <span className="eyebrow">A LITTLE MOMENTUM</span>
          <h2>
            Turn a conversation
            <br />
            into your next
            <br />
            <em>great job.</em>
          </h2>
          <p>
            Keep the details together and give every customer a clear next step.
          </p>
          <button className="button" onClick={onNewJob}>
            Create a service job <ArrowRight size={16} />
          </button>
          <div className="focus-decoration">
            <Wrench size={96} strokeWidth={1} />
          </div>
        </section>
      </div>
      <div className="overview-bottom-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Work on the horizon</h2>
              <p>Your latest active service jobs</p>
            </div>
            <button className="text-button" onClick={() => onNavigate("jobs")}>
              View all jobs <ArrowRight size={15} />
            </button>
          </div>
          {activeJobs.length ? (
            <div className="jobs-preview">
              {activeJobs.map((job) => (
                <button
                  className="job-preview-row"
                  key={job.id}
                  onClick={() => onNavigate("jobs")}
                >
                  <div className={`job-icon ${job.category.toLowerCase()}`}>
                    <Wrench size={19} />
                  </div>
                  <div>
                    <strong>{job.title}</strong>
                    <span>
                      {job.customerName} <i>·</i>{" "}
                      {job.category || "General service"}
                    </span>
                  </div>
                  <div className="job-preview-meta">
                    <Status status={job.status} />
                    <span>{formatDate(job.scheduledAt)}</span>
                  </div>
                  <ChevronRight size={16} />
                </button>
              ))}
            </div>
          ) : (
            <Empty
              icon={BriefcaseBusiness}
              title="Your next job starts here"
              detail="Create a service job to keep customer details and scheduling together."
            />
          )}
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Recent activity</h2>
              <p>The latest around your workspace</p>
            </div>
            <button
              className="icon-button"
              aria-label="View all activity"
              onClick={() => onNavigate("activity")}
            >
              <ArrowUpRight size={19} />
            </button>
          </div>
          {data.recentActivity.length ? (
            <div className="activity-preview">
              {data.recentActivity.slice(0, 5).map((item) => (
                <div className="activity-row" key={item.id}>
                  <span className="activity-point">
                    <ActivityIcon size={14} />
                  </span>
                  <div>
                    <strong>{item.action.replace(/[_.]/g, " ")}</strong>
                    <p>{item.detail}</p>
                    <span>{relativeTime(item.createdAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              icon={ActivityIcon}
              title="A fresh start"
              detail="Your workspace activity will appear here as you get to work."
            />
          )}
        </section>
      </div>
    </>
  );
}

type ConversationDetail = {
  conversation: Conversation;
  messages: Message[];
  pagination?: { hasMore: boolean; before: string | null };
};
function mergeHistory(current: ConversationDetail | null, latest: ConversationDetail): ConversationDetail {
  if (!current || current.conversation.id !== latest.conversation.id) return latest;
  const messages = [...new Map([...current.messages, ...latest.messages].map((message) => [message.id, message])).values()]
    .sort((a, b) => a.createdAt.slice(0, 19).localeCompare(b.createdAt.slice(0, 19)));
  return { ...latest, messages, pagination: current.pagination || latest.pagination };
}

function InboxPage({
  memory,
  mode,
  query,
  setQuery,
  notify,
  onNewJob,
  onOpenJob,
}: {
  memory: { drafts: Map<string, string>; intakeDrafts: Map<string, IntakeDraft>; sendIntents: Map<string, { text: string; id: string }>; selected: string };
  mode: "demo" | "live";
  query: string;
  setQuery: (query: string) => void;
  notify: (message: string) => void;
  onNewJob: (customer: Conversation) => void;
  onOpenJob: (job: Job) => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState(memory.selected);
  memory.selected = selected;
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [filter, setFilter] = useState("all");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [simulate, setSimulate] = useState(false);
  const [simulationText, setSimulationText] = useState(
    "Hi, I need help with a leaking kitchen tap. Are you available tomorrow?",
  );
  const bottom = useRef<HTMLDivElement>(null);
  const messageArea = useRef<HTMLDivElement>(null);
  const loadingEarlier = useRef(false);
  const [earlierBusy, setEarlierBusy] = useState(false);
  const readingLatest = useRef(true);
  const [newMessages, setNewMessages] = useState(false);
  const replyDrafts = useRef(memory.drafts);
  const listRevision = useRef(0);
  const detailRevision = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; listRevision.current++; detailRevision.current++; };
  }, []);
  const operation = useRef(false);
  const operationConversation = useRef<string | null>(null);
  const selectedRef = useRef(selected);
  const selectionRevision = useRef(0);
  const composerRevision = useRef(0);
  if (selectedRef.current !== selected) selectionRevision.current++;
  selectedRef.current = selected;
  const editComposer = (value: string) => {
    composerRevision.current++;
    if (selectedRef.current) {
      if (value) replyDrafts.current.set(selectedRef.current, value);
      else replyDrafts.current.delete(selectedRef.current);
    }
    setText(value);
  };
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [draftsEnabled, setDraftsEnabled] = useState(false);
  const [automaticEnabled, setAutomaticEnabled] = useState(false);
  const [draftConsent, setDraftConsent] = useState(false);
  const initialized = useRef(false);
  const refreshReceptionState = useCallback(async (signal: AbortSignal) => {
    const [result, automatic] = await Promise.all([
      api<{ integration: Integration; settings: Settings }>("/settings", { signal }),
      api<{ policy: { enabled: boolean } }>("/automation", { signal }),
    ]);
    if (!signal.aborted && mounted.current) {
      setIntegration(result.integration);
      setDraftsEnabled(result.settings.automationEnabled);
      setAutomaticEnabled(automatic.policy.enabled);
    }
  }, []);
  useVisiblePolling(refreshReceptionState, 15000);
  const load = useCallback(async (signal?: AbortSignal) => {
    const request = ++listRevision.current;
    const result = await api<{ conversations: Conversation[] }>("/conversations", { signal });
    if (!mounted.current || signal?.aborted || request !== listRevision.current) return;
    setConversations(result.conversations);
    if (!initialized.current) {
      initialized.current = true;
      setSelected((current) => result.conversations.some((item) => item.id === current) ? current : result.conversations[0]?.id || "");
    }
  }, []);
  const refreshList = useCallback(async (signal: AbortSignal) => {
    try { await load(signal); if (!signal.aborted && mounted.current) setListError(""); }
    catch (cause) { if (!signal.aborted && mounted.current) setListError((cause as Error).message); }
    finally { if (!signal.aborted && mounted.current) setLoading(false); }
  }, [load]);
  useVisiblePolling(refreshList);
  useEffect(() => {
    detailRevision.current++;
    setDetail(null);
    setDraftConsent(false);
    composerRevision.current++;
    setText(replyDrafts.current.get(selected) || "");
    readingLatest.current = true;
    loadingEarlier.current = false;
    setEarlierBusy(false);
    setNewMessages(false);
    setError("");
    setDetailError("");
  }, [selected]);
  const refreshDetail = useCallback(async (signal: AbortSignal) => {
    if (!selected || (operation.current && operationConversation.current === selected)) return;
    const request = ++detailRevision.current;
    try {
      const result = await api<ConversationDetail>(`/conversations/${selected}`, { signal });
      if (!signal.aborted && mounted.current && selectedRef.current === selected && request === detailRevision.current) {
        setDetail((current) => mergeHistory(current, result));
        setDetailError("");
      }
    } catch (cause) {
      if (!signal.aborted && mounted.current && selectedRef.current === selected && request === detailRevision.current) setDetailError((cause as Error).message);
    }
  }, [selected]);
  useVisiblePolling(refreshDetail);
  useEffect(() => {
    if (loadingEarlier.current) return;
    if (readingLatest.current) bottom.current?.scrollIntoView({ behavior: "auto", block: "nearest" });
    else setNewMessages(true);
  }, [detail?.messages.length]);
  async function loadEarlier() {
    if (loadingEarlier.current || !detail?.pagination?.hasMore || !detail.pagination.before) return;
    const conversationId = selected;
    const selection = selectionRevision.current;
    const area = messageArea.current;
    loadingEarlier.current = true; setEarlierBusy(true);
    try {
      const earlier = await api<ConversationDetail>(`/conversations/${conversationId}?before=${encodeURIComponent(detail.pagination.before)}&limit=50`);
      if (selectedRef.current !== conversationId || selectionRevision.current !== selection) return;
      const previousHeight = area?.scrollHeight || 0;
      const previousTop = area?.scrollTop || 0;
      setDetail((current) => {
        if (!current || current.conversation.id !== conversationId) return current;
        const merged = mergeHistory(earlier, current);
        return { ...merged, conversation: current.conversation, pagination: earlier.pagination };
      });
      requestAnimationFrame(() => {
        if (selectedRef.current === conversationId && selectionRevision.current === selection && area) {
          area.scrollTop = previousTop + area.scrollHeight - previousHeight;
          readingLatest.current = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
          loadingEarlier.current = false;
        }
      });
    } catch (cause) {
      if (selectedRef.current === conversationId && selectionRevision.current === selection) {
        setError((cause as Error).message);
        loadingEarlier.current = false;
      }
    } finally {
      if (selectedRef.current === conversationId && selectionRevision.current === selection) setEarlierBusy(false);
    }
  }
  async function update(body: Partial<Conversation>) {
    if (!detail || detail.conversation.id !== selected || operation.current) return;
    const conversationId = selected;
    const selection = selectionRevision.current;
    operation.current = true;
    operationConversation.current = conversationId;
    detailRevision.current++;
    setBusy(true);
    setError("");
    try {
      const result = await mutation<{ conversation: Conversation }>(
        `/conversations/${conversationId}`,
        "PATCH",
        body,
      );
      if (selectedRef.current === conversationId && selectionRevision.current === selection)
        setDetail((current) =>
          current?.conversation.id === conversationId
            ? { ...current, conversation: result.conversation }
            : current,
        );
      await load();
      notify("Conversation updated.");
    } catch (cause) {
      if (selectedRef.current === conversationId && selectionRevision.current === selection)
        setError((cause as Error).message);
    } finally {
      operation.current = false;
      operationConversation.current = null;
      setBusy(false);
    }
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (
      !text.trim() ||
      operation.current ||
      !selected ||
      detail?.conversation.id !== selected
    )
      return;
    const conversationId = selected;
    const selection = selectionRevision.current;
    const composer = composerRevision.current;
    const reply = text.trim();
    operation.current = true;
    operationConversation.current = conversationId;
    detailRevision.current++;
    setBusy(true);
    setError("");
    const previousIntent = memory.sendIntents.get(conversationId);
    const intent = previousIntent?.text === reply ? previousIntent : { text: reply, id: crypto.randomUUID() };
    memory.sendIntents.set(conversationId, intent);
    try {
      const result = await mutation<{
        message: Message;
        conversation: Conversation;
      }>(`/conversations/${conversationId}/messages`, "POST", {
        text: reply,
        idempotencyKey: intent.id,
      });
      if (memory.sendIntents.get(conversationId)?.id === intent.id && result.message.status !== "pending" && result.message.status !== "unconfirmed") memory.sendIntents.delete(conversationId);
      if (replyDrafts.current.get(conversationId)?.trim() === reply) replyDrafts.current.delete(conversationId);
      if (selectedRef.current === conversationId && selectionRevision.current === selection) {
        setDetail((current) =>
          current?.conversation.id === conversationId
            ? {
                conversation: result.conversation,
                pagination: current.pagination,
                messages: current.messages.some(
                  (message) => message.id === result.message.id,
                )
                  ? current.messages
                  : [...current.messages, result.message],
              }
            : current,
        );
        if (composerRevision.current === composer) editComposer("");
      }
      await load();
      notify(
        mode === "demo"
          ? "Reply simulated in demo mode. No real message was sent."
          : result.message.status === "unconfirmed"
            ? "Delivery is unconfirmed. Check the conversation before retrying to avoid duplicate messages."
            : result.message.status === "pending"
              ? "Reply is pending. Delivery has not been confirmed."
              : result.message.status === "failed"
                ? "Delivery failed. Check your WhatsApp connection."
                : "Reply accepted by WhatsApp. Delivery updates appear in the conversation.",
      );
    } catch (cause) {
      if (selectedRef.current === conversationId && selectionRevision.current === selection) {
        setError((cause as Error).message);
        try {
          const refreshed = await api<ConversationDetail>(`/conversations/${conversationId}`);
          if (selectedRef.current === conversationId && selectionRevision.current === selection) setDetail((current) => mergeHistory(current, refreshed));
        } catch {
          /* Keep the existing conversation if refresh also fails. */
        }
      }
    } finally {
      operation.current = false;
      operationConversation.current = null;
      setBusy(false);
    }
  }
  async function generateDraft() {
    if (operation.current || !selected || detail?.conversation.id !== selected || !integration) return;
    const conversationId = selected;
    const selection = selectionRevision.current;
    const composer = composerRevision.current;
    operation.current = true;
    operationConversation.current = conversationId;
    detailRevision.current++;
    setBusy(true);
    setError("");
    setDraftConsent(false);
    try {
      const result = await mutation<{
        draft: { text: string; reason: string; source: string };
      }>(`/conversations/${conversationId}/draft`, "POST", {});
      if (selectedRef.current === conversationId && selectionRevision.current === selection) {
        if (composerRevision.current !== composer) {
          notify("Your reply changed while the suggestion was prepared. Your text was kept; generate again if needed.");
          return;
        }
        editComposer(result.draft.text);
        notify(
          result.draft.source === "ai"
            ? "AI draft ready. Review the details before sending."
            : "Suggested reply ready. Review and personalise it before sending.",
        );
      }
    } catch (cause) {
      if (selectedRef.current === conversationId && selectionRevision.current === selection)
        setError((cause as Error).message);
    } finally {
      operation.current = false;
      operationConversation.current = null;
      setBusy(false);
    }
  }
  async function simulateIncoming(event: FormEvent) {
    event.preventDefault();
    if (operation.current || !simulationText.trim()) return;
    const conversationId = selected;
    const selection = selectionRevision.current;
    operation.current = true;
    operationConversation.current = conversationId;
    detailRevision.current++;
    setBusy(true);
    setError("");
    try {
      const result = await mutation<{
        message: Message;
        conversation: Conversation;
      }>("/demo/inbound", "POST", {
        conversationId: conversationId || undefined,
        text: simulationText.trim(),
      });
      if (selectedRef.current === conversationId && selectionRevision.current === selection) {
        setSelected(result.conversation.id);
        const next = await api<ConversationDetail>(`/conversations/${result.conversation.id}`);
        if (selectedRef.current === result.conversation.id) setDetail((current) => mergeHistory(current, next));
      }
      await load();
      setSimulate(false);
      notify("Demo customer message received.");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      operation.current = false;
      operationConversation.current = null;
      setBusy(false);
    }
  }
  const visible = conversations.filter(
    (conversation) =>
      (filter === "all" ||
        (filter === "unread"
          ? conversation.unreadCount > 0
          : conversation.status === filter)) &&
      `${conversation.customerName} ${conversation.phone} ${conversation.preview}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <>
      <div
        className={`inbox-workspace ${selected ? "conversation-selected" : ""}`}
      >
        <section className="conversation-list">
          <div className="inbox-list-heading">
            <h2>
              Messages <span>{conversations.length}</span>
            </h2>
            {mode === "demo" && (
              <button
                className="icon-button"
                title="Simulate incoming customer message"
                aria-label="Simulate incoming customer message"
                onClick={() => setSimulate(true)}
              >
                <Plus size={19} />
              </button>
            )}
          </div>
          <label className="search-field">
            <Search size={17} />
            <input
              aria-label="Search conversations"
              placeholder="Search conversations…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="inbox-filters">
            {["all", "unread", "open", "resolved"].map((value) => (
              <button
                key={value}
                className={filter === value ? "selected" : ""}
                onClick={() => setFilter(value)}
              >
                {value}
              </button>
            ))}
          </div>
          <div
            className="conversation-items"
            tabIndex={0}
            role="region"
            aria-label="Customer conversations"
          >
            {loading ? (
              <div className="panel-loading">
                <Spinner />
              </div>
            ) : visible.length ? (
              visible.map((conversation) => (
                <button
                  className={`conversation-item ${selected === conversation.id ? "selected" : ""}`}
                  key={conversation.id}
                  onClick={() => setSelected(conversation.id)}
                >
                  <div
                    className={`avatar avatar-${conversation.customerName.length % 4}`}
                  >
                    {initials(conversation.customerName)}
                  </div>
                  <div className="conversation-item-content">
                    <div>
                      <strong>{conversation.customerName}</strong>
                      <time>{relativeTime(conversation.updatedAt)}</time>
                    </div>
                    <p>{conversation.preview || "Start the conversation"}</p>
                    <div>
                      <span className="conversation-category">
                        {conversation.category || "General enquiry"}
                      </span>
                      {conversation.unreadCount > 0 ? (
                        <span className="unread-count">
                          {conversation.unreadCount}
                        </span>
                      ) : (
                        <CheckCheck size={14} />
                      )}
                    </div>
                  </div>
                </button>
              ))
            ) : (
              <Empty
                title="No conversations found"
                detail={
                  query || filter !== "all"
                    ? "Try another search or filter."
                    : "Incoming WhatsApp conversations will appear here."
                }
              />
            )}
          </div>
        </section>
        <section className="conversation-detail">
          {detail ? (
            <>
              <div className="conversation-heading">
                <button
                  className="icon-button conversation-back"
                  aria-label="Back to conversation list"
                  onClick={() => setSelected("")}
                >
                  <ChevronRight
                    size={20}
                    style={{ transform: "rotate(180deg)" }}
                  />
                </button>
                <div className="avatar">
                  {initials(detail.conversation.customerName)}
                </div>
                <div className="conversation-heading-person">
                  <h2>{detail.conversation.customerName}</h2>
                  <span>
                    {detail.conversation.phone} <i>·</i> WhatsApp
                  </span>
                </div>
                {detail.conversation.status === "waiting" && detail.conversation.automationPaused && <span className="attention-chip">Needs human attention</span>}
                <Status status={detail.conversation.status} />
                <button
                  className="button secondary compact resolve-button"
                  disabled={busy}
                  onClick={() =>
                    void update({
                      status:
                        detail.conversation.status === "resolved"
                          ? "open"
                          : "resolved",
                    })
                  }
                >
                  <Check size={15} />{" "}
                  {detail.conversation.status === "resolved"
                    ? "Reopen"
                    : "Resolve"}
                </button>
              </div>
              <div className="handoff-bar">
                <span>
                  <span
                    className={`online-dot ${detail.conversation.automationPaused ? "paused" : ""}`}
                  />
                  {detail.conversation.automationPaused
                    ? "Human handoff · automation paused"
                    : automaticEnabled
                      ? "Automatic reception enabled · approved business rules"
                      : draftsEnabled
                      ? "Reply drafts available · human review required"
                      : "Manual reception · reply drafts disabled"}
                </span>
                <button
                  disabled={busy}
                  onClick={() =>
                    void update({
                      automationPaused: !detail.conversation.automationPaused,
                    })
                  }
                >
                  {detail.conversation.automationPaused
                    ? "Resume reception"
                    : "Take over"}
                  <ArrowRight size={13} />
                </button>
              </div>
              <div
                className="messages-area"
                ref={messageArea}
                onScroll={(event) => {
                  const area = event.currentTarget;
                  readingLatest.current = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
                  if (readingLatest.current) setNewMessages(false);
                }}
                tabIndex={0}
                role="log"
                aria-label="Conversation message history"
                aria-live="polite"
                aria-relevant="additions text"
              >
                {detail.pagination?.hasMore && <button className="button secondary compact" disabled={earlierBusy} onClick={() => void loadEarlier()}>{earlierBusy ? "Loading earlier messages…" : "Load earlier messages"}</button>}
                <div className="message-date">
                  {detail.messages.length
                    ? formatDate(detail.messages[0].createdAt)
                    : "New conversation"}
                </div>
                {detail.messages.map((message, index) => (
                  <div key={message.id}>
                    {index > 0 &&
                      message.createdAt.slice(0, 10) !==
                        detail.messages[index - 1].createdAt.slice(0, 10) && (
                        <div className="message-date">
                          {formatDate(message.createdAt)}
                        </div>
                      )}
                    <div className={`message-row ${message.direction}`}>
                      <div className="message-bubble">
                        <p>{message.text}</p>
                        <div>
                          <time>{formatTime(message.createdAt)}</time>
                          {message.direction === "outbound" && (
                            <span
                              className={`delivery-status ${message.status}`}
                              title={message.status}
                            >
                              {mode === "demo" ? (
                                "Simulated"
                              ) : message.status === "read" ||
                                message.status === "delivered" ? (
                                <>
                                  <CheckCheck size={13} />{" "}
                                  {message.status === "read"
                                    ? "Read"
                                    : "Delivered"}
                                </>
                              ) : message.status === "sent" ? (
                                <>
                                  <Check size={13} /> Accepted
                                </>
                              ) : message.status === "unconfirmed" ? (
                                "Delivery unconfirmed"
                              ) : message.status === "pending" ? (
                                "Pending"
                              ) : message.status === "failed" ? (
                                "Failed"
                              ) : (
                                message.status
                              )}
                              <span className="sr-only">{message.status}</span>
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
                <div ref={bottom} />
              </div>
              <div className="composer-wrap">
                {newMessages && <button className="text-button" onClick={() => {
                  readingLatest.current = true; setNewMessages(false);
                  bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                }}>New messages · jump to latest</button>}
                <div className="draft-tools">
                  <button
                    className="text-button"
                    disabled={
                      busy ||
                      !integration ||
                      !draftsEnabled ||
                      detail.conversation.automationPaused
                    }
                    onClick={() =>
                      integration?.aiConfigured
                        ? setDraftConsent(true)
                        : void generateDraft()
                    }
                  >
                    <Sparkles size={14} />
                    {!integration
                      ? "Reply drafts unavailable"
                      : integration.aiConfigured
                        ? "Generate AI draft"
                        : "Draft a reply"}
                  </button>
                  <button
                    className="text-button"
                    onClick={() => onNewJob(detail.conversation)}
                  >
                    <Plus size={14} /> Create job for customer
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => void update({ unreadCount: 0 })}
                  >
                    <Check size={14} /> Mark read
                  </button>
                </div>
                <ErrorMessage message={error || detailError || listError} />
                <form
                  className="message-composer"
                  onSubmit={(event) => void send(event)}
                >
                  <textarea
                    aria-label="Reply to customer"
                    placeholder="Write a thoughtful reply…"
                    value={text}
                    onChange={(event) => editComposer(event.target.value)}
                    maxLength={4000}
                    rows={2}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        void send(event);
                      }
                    }}
                  />
                  <div className="composer-footer">
                    <span>
                      {mode === "demo"
                        ? "Demo reply · stays in this workspace"
                        : "Replies are delivered through WhatsApp"}
                      <small>
                        Enter to send · Shift + Enter for a new line
                      </small>
                    </span>
                    <button
                      className="button primary"
                      disabled={busy || !text.trim()}
                    >
                      {busy ? (
                        <Spinner />
                      ) : (
                        <>
                          <Send size={16} />{" "}
                          {mode === "demo" ? "Simulate reply" : "Send reply"}
                        </>
                      )}
                    </button>
                  </div>
                </form>
              </div>
            </>
          ) : error || detailError || listError ? (
            <div><ErrorMessage message={error || detailError || listError} /><button className="button secondary compact" onClick={() => {
              const controller = new AbortController();
              void (selected ? refreshDetail(controller.signal) : refreshList(controller.signal));
            }}>Retry opening conversation</button></div>
          ) : (
            <Empty
              title={
                selected
                  ? "Opening conversation…"
                  : "A good conversation starts here"
              }
              detail={
                selected
                  ? "Gathering the latest customer messages."
                  : "Select a conversation to read and reply."
              }
            />
          )}
        </section>
      </div>
      {detail?.conversation.id === selected && <IntakePanel key={selected} drafts={memory.intakeDrafts} conversationId={detail.conversation.id} aiConfigured={!!integration?.aiConfigured} notify={notify} onOpenJob={onOpenJob} onChanged={() => {
        const conversationId = detail.conversation.id;
        const selection = selectionRevision.current;
        const request = ++detailRevision.current;
        void api<ConversationDetail>(`/conversations/${conversationId}`).then((result) => {
          if (selectedRef.current === conversationId && selectionRevision.current === selection && request === detailRevision.current) setDetail((current) => mergeHistory(current, result));
        }).catch(() => {});
        void load().catch(() => {});
      }} />}
      {draftConsent && (
        <Modal
          title="Generate a reply with AI"
          onClose={() => setDraftConsent(false)}
        >
          <p className="form-description">
            Generating a draft shares this customer’s conversation and your
            reception settings with OpenAI. The reply is only a draft: review it
            before sending, especially appointments, prices, and safety advice.
          </p>
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setDraftConsent(false)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              onClick={() => void generateDraft()}
            >
              <Sparkles size={16} /> Generate draft
            </button>
          </div>
        </Modal>
      )}
      {simulate && (
        <Modal
          title="Simulate a customer message"
          onClose={() => setSimulate(false)}
        >
          <form onSubmit={(event) => void simulateIncoming(event)}>
            <p className="form-description">
              Send a sample incoming message to{" "}
              {detail?.conversation.customerName || "a new demo customer"}. This
              stays inside the demo workspace.
            </p>
            <label>
              Customer message
              <textarea
                value={simulationText}
                onChange={(event) => setSimulationText(event.target.value)}
                required
                maxLength={4000}
                rows={4}
              />
            </label>
            <ErrorMessage message={error || detailError || listError} />
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setSimulate(false)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                disabled={busy || !simulationText.trim()}
              >
                {busy ? (
                  <Spinner />
                ) : (
                  <>
                    <ArrowDownLeft size={16} /> Receive demo message
                  </>
                )}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

function JobsPage({
  revision,
  notify,
  onNewJob,
}: {
  revision: number;
  notify: (message: string) => void;
  onNewJob: () => void;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const statusUpdates = useRef(new Set<string>());
  const requests = useRef(0);
  const [selected, setSelected] = useState<Job | null>(null);
  const [editing, setEditing] = useState(false);
  const refreshJobs = useCallback(async (signal: AbortSignal) => {
    if (statusUpdates.current.size) return;
    const request = ++requests.current;
    try {
      const result = await api<{ jobs: Job[] }>("/jobs", { signal });
      if (!signal.aborted && request === requests.current) setJobs(result.jobs);
    } catch (cause) { if (!signal.aborted && request === requests.current) setError((cause as Error).message); }
    finally { if (!signal.aborted && request === requests.current) setLoading(false); }
  }, [revision]);
  useVisiblePolling(refreshJobs, 15000);
  async function update(job: Job, status: Job["status"]) {
    if (statusUpdates.current.has(job.id)) return;
    statusUpdates.current.add(job.id);
    requests.current++;
    setBusy(job.id);
    setError("");
    try {
      const result = await mutation<{ job: Job }>(`/jobs/${job.id}`, "PATCH", {
        status,
        expectedVersion: job.version,
      });
      setJobs((current) =>
        current.map((item) => (item.id === job.id ? result.job : item)),
      );
      setSelected((current) => current?.id === job.id ? result.job : current);
      notify("Job status updated.");
    } catch (cause) {
      setError((cause as Error).message);
      if (cause instanceof ApiError && cause.status === 409) {
        try {
          const { job: latest } = await api<{ job: Job }>(`/jobs/${job.id}`);
          setJobs((current) => current.map((item) => item.id === job.id ? latest : item));
          setSelected((current) => current?.id === job.id ? latest : current);
        } catch { /* Keep the conflict explanation if recovery cannot connect. */ }
      }
    } finally {
      statusUpdates.current.delete(job.id);
      setBusy("");
    }
  }
  const visible = jobs.filter(
    (job) =>
      (filter === "all" || job.status === filter) &&
      `${job.title} ${job.customerName} ${job.phone} ${job.category}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <>
      <section className="panel jobs-panel">
        <div className="jobs-toolbar">
          <div className="segmented-tabs">
            {["all", "new", "scheduled", "in_progress", "completed"].map(
              (status) => (
                <button
                  key={status}
                  className={filter === status ? "selected" : ""}
                  onClick={() => setFilter(status)}
                >
                  {status === "all" ? "All jobs" : status.replace("_", " ")}
                  {status === "all" && <span>{jobs.length}</span>}
                </button>
              ),
            )}
          </div>
          <label className="search-field">
            <Search size={17} />
            <input
              aria-label="Search service jobs"
              placeholder="Search jobs…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        <ErrorMessage message={error} />
        {loading ? (
          <div className="panel-loading">
            <Spinner /> Loading service jobs…
          </div>
        ) : visible.length ? (
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Service jobs table"
          >
            <table className="jobs-table">
              <thead>
                <tr>
                  <th>Service job</th>
                  <th>Customer</th>
                  <th>Scheduled</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <button
                        className="table-job-button"
                        onClick={() => setSelected(job)}
                      >
                        <span className="job-icon">
                          <Wrench size={18} />
                        </span>
                        <span>
                          <strong>{job.title}</strong>
                          <small>{job.category || "General service"}</small>
                        </span>
                      </button>
                    </td>
                    <td>
                      <strong>{job.customerName}</strong>
                      <small>{job.phone}</small>
                    </td>
                    <td>
                      <span>{formatDate(job.scheduledAt)}</span>
                      {job.scheduledAt && (
                        <small>{formatTime(job.scheduledAt)}</small>
                      )}
                    </td>
                    <td>
                      <label className={`status-select status-${job.status}`}>
                        <span className="sr-only">Status for {job.title}</span>
                        <select
                          value={job.status}
                          disabled={busy === job.id}
                          onChange={(event) =>
                            void update(
                              job,
                              event.target.value as Job["status"],
                            )
                          }
                        >
                          <option value="new">New</option>
                          <option value="scheduled">Scheduled</option>
                          <option value="in_progress">In progress</option>
                          <option value="completed">Completed</option>
                        </select>
                        <ChevronDown size={12} />
                      </label>
                    </td>
                    <td>
                      <button
                        className="icon-button"
                        aria-label={`View ${job.title}`}
                        onClick={() => setSelected(job)}
                      >
                        <ArrowUpRight size={18} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon={BriefcaseBusiness}
            title={
              query || filter !== "all"
                ? "No matching service jobs"
                : "Let’s make good work happen"
            }
            detail={
              query || filter !== "all"
                ? "Try a different search or status filter."
                : "Create your first service job to manage requests and scheduling."
            }
          >
            {!query && filter === "all" && (
              <button className="button primary" onClick={onNewJob}>
                <Plus size={16} /> Create a service job
              </button>
            )}
          </Empty>
        )}
        <div className="table-footer">
          <span>
            {visible.length} {visible.length === 1 ? "job" : "jobs"} shown
          </span>
          <span>Keep every detail in one place.</span>
        </div>
      </section>
      {selected && editing && <JobModal job={selected} onClose={() => setEditing(false)} onCreated={() => { setEditing(false); setSelected(null); notify("Service job details saved."); }} />}
      {selected && !editing && (
        <Modal title={selected.title} onClose={() => setSelected(null)}>
          <div className="job-detail">
            <Status status={selected.status} />
            <dl>
              <div>
                <dt>Customer</dt>
                <dd>{selected.customerName}</dd>
              </div>
              <div>
                <dt>WhatsApp number</dt>
                <dd>{selected.phone}</dd>
              </div>
              <div>
                <dt>Service category</dt>
                <dd>{selected.category || "General service"}</dd>
              </div>
              <div>
                <dt>Scheduled for</dt>
                <dd>
                  {formatDate(selected.scheduledAt)}
                  {selected.scheduledAt &&
                    ` at ${formatTime(selected.scheduledAt)}`}
                </dd>
              </div>
              <div>
                <dt>Service address</dt>
                <dd>{selected.address || "No address added"}</dd>
              </div>
              <div>
                <dt>Notes</dt>
                <dd className="preserve-whitespace">
                  {selected.notes || "No notes added"}
                </dd>
              </div>
            </dl>
            <label>
              Job status
              <select
                value={selected.status}
                disabled={busy === selected.id}
                onChange={(event) =>
                  void update(selected, event.target.value as Job["status"])
                }
              >
                <option value="new">New</option>
                <option value="scheduled">Scheduled</option>
                <option value="in_progress">In progress</option>
                <option value="completed">Completed</option>
              </select>
            </label>
            <ErrorMessage message={error} />
            <div className="modal-actions">
              <button
                className="button secondary"
                onClick={() => setSelected(null)}
              >
                Close details
              </button>
              <button className="button primary" onClick={() => setEditing(true)}>Edit job details</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function localDatetime(iso: string) {
  const value = new Date(iso);
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function JobModal({
  onClose,
  onCreated,
  customer,
  job,
}: {
  onClose: () => void;
  onCreated: () => void;
  customer?: Conversation;
  job?: Job;
}) {
  const [form, setForm] = useState({
    title: job?.title || "",
    customerName: job?.customerName || customer?.customerName || "",
    phone: job?.phone || customer?.phone || "",
    category: job?.category || customer?.category || "Plumbing",
    address: job?.address || "",
    scheduledAt: job?.scheduledAt ? localDatetime(job.scheduledAt) : "",
    status: job?.status || "new",
    notes: job?.notes || "",
    assignedTo: job?.assignedTo || "Team",
    durationMinutes: String(job?.durationMinutes || 60),
  });
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [expectedVersion, setExpectedVersion] = useState(job?.version);
  const active = useRef(true);
  const submitting = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [error, setError] = useState("");
  const field = (name: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [name]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      if (!/^\+[1-9]\d{7,14}$/.test(form.phone))
        throw new Error(
          "Enter a valid international phone number, for example +27821234567.",
        );
      await mutation(job ? `/jobs/${job.id}` : "/jobs", job ? "PATCH" : "POST", {
        ...form,
        durationMinutes: Number(form.durationMinutes),
        ...(job ? { expectedVersion } : {}),
        ...(customer ? { conversationId: customer.id } : {}),
        title: form.title.trim(),
        customerName: form.customerName.trim(),
        scheduledAt: form.scheduledAt
          ? new Date(form.scheduledAt).toISOString()
          : "",
      });
      if (active.current) onCreated();
    } catch (cause) {
      if (active.current) { setError((cause as Error).message); setConflict(cause instanceof ApiError && cause.status === 409); }
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <Modal title={job ? "Edit service job" : "Create a service job"} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <p className="form-description">
          Keep customer details and the team’s plan together. Scheduling records
          an internal plan; confirm appointment details with the customer separately.
        </p>
        <fieldset className="job-form-fields" disabled={busy}>
        <label>
          Job title
          <input
            required
            maxLength={120}
            placeholder="e.g. Repair leaking kitchen tap"
            value={form.title}
            onChange={(event) => field("title", event.target.value)}
          />
        </label>
        <div className="form-grid">
          <label>
            Customer name
            <input
              required
              maxLength={100}
              placeholder="Full name"
              value={form.customerName}
              onChange={(event) => field("customerName", event.target.value)}
            />
          </label>
          <label>
            WhatsApp number
            <input
              type="tel"
              aria-label="WhatsApp number"
              required
              maxLength={16}
              placeholder="+27821234567"
              value={form.phone}
              onChange={(event) =>
                field("phone", event.target.value.replace(/[\s()-]/g, ""))
              }
            />
            <small>Include the country code.</small>
          </label>
          <label>
            Service category
            <select
              value={form.category}
              onChange={(event) => field("category", event.target.value)}
            >
              {Array.from(new Set([
                form.category,
                "Plumbing",
                "Electrical",
                "Carpentry",
                "Painting",
                "General maintenance",
                "Other",
              ])).filter(Boolean).map((category) => (
                <option key={category}>{category}</option>
              ))}
            </select>
          </label>
          <label>
            Scheduled date & time
            <input
              type="datetime-local"
              value={form.scheduledAt}
              onChange={(event) => { field("scheduledAt", event.target.value); if (!job || form.status === "new" || form.status === "scheduled") field("status", event.target.value ? "scheduled" : "new"); }}
            />
            <small>Optional · {Intl.DateTimeFormat().resolvedOptions().timeZone}</small>
          </label>
        </div>
        <div className="form-grid">
          <label>Assigned team<input value={form.assignedTo} onChange={(event) => field("assignedTo", event.target.value)} maxLength={100} required /></label>
          <label>Visit duration (minutes)<input type="number" min={15} max={480} step={1} value={form.durationMinutes} onChange={(event) => field("durationMinutes", event.target.value)} required /></label>
          <label>Job status<select value={form.status} onChange={(event) => field("status", event.target.value)}><option value="new">New</option><option value="scheduled">Scheduled</option><option value="in_progress">In progress</option><option value="completed">Completed</option></select></label>
        </div>
        <label>
          Service address
          <input
            maxLength={300}
            placeholder="Street address, suburb, city"
            value={form.address}
            onChange={(event) => field("address", event.target.value)}
          />
        </label>
        <label>
          Notes
          <textarea
            maxLength={2000}
            rows={3}
            placeholder="What should your team know?"
            value={form.notes}
            onChange={(event) => field("notes", event.target.value)}
          />
        </label>
        </fieldset>
        <ErrorMessage message={error} />
        {conflict && job && <button type="button" className="text-button" disabled={busy} onClick={() => {
          if (submitting.current) return;
          submitting.current = true; setBusy(true);
          void api<{job: Job}>(`/jobs/${job.id}`).then(({job: latest}) => {
            if (!active.current) return;
            setForm({ title: latest.title, customerName: latest.customerName, phone: latest.phone, category: latest.category, address: latest.address, scheduledAt: latest.scheduledAt ? localDatetime(latest.scheduledAt) : "", status: latest.status, notes: latest.notes, assignedTo: latest.assignedTo, durationMinutes: String(latest.durationMinutes) });
            setExpectedVersion(latest.version); setConflict(false); setError("");
          }).catch((cause) => { if (active.current) setError(cause.message); }).finally(() => { submitting.current = false; if (active.current) setBusy(false); });
        }}>Reload latest job (discard edits)</button>}
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? (
              <Spinner />
            ) : (
              <>
                {job ? <Check size={16} /> : <Plus size={16} />} {job ? "Save job details" : "Create service job"}
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SettingsPage({ notify }: { notify: (message: string) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [readiness, setReadiness] = useState<IntegrationReadiness | null>(null);
  const [readinessError, setReadinessError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    let active = true;
    void api<IntegrationReadiness>("/integration/readiness")
      .then((result) => { if (active) setReadiness(result); })
      .catch(() => { if (active) setReadinessError("Connection checklist is unavailable. Reload this page to try again."); });
    void api<{ settings: Settings; integration: Integration }>("/settings")
      .then((result) => {
        if (active) {
          setSettings(result.settings);
          setIntegration(result.integration);
        }
      })
      .catch((cause) => {
        if (active) setError(cause.message);
      });
    return () => {
      active = false;
    };
  }, []);
  function field<K extends keyof Settings>(name: K, value: Settings[K]) {
    setSettings((current) => (current ? { ...current, [name]: value } : null));
    setDirty(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    setError("");
    try {
      const result = await mutation<{
        settings: Settings;
        integration: Integration;
      }>("/settings", "PATCH", settings);
      setSettings(result.settings);
      setIntegration(result.integration);
      setDirty(false);
      notify("Reception settings saved.");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!settings || !integration)
    return error ? (
      <ErrorMessage message={error} />
    ) : (
      <div className="panel-loading">
        <Spinner /> Loading reception settings…
      </div>
    );
  return (
    <div className="settings-layout">
      <form
        className="panel settings-form"
        onSubmit={(event) => void save(event)}
      >
        <div className="panel-heading">
          <div>
            <h2>Your business reception</h2>
            <p>A clear, friendly welcome for every customer.</p>
          </div>
          <span className="settings-heading-icon">
            <Settings2 size={23} />
          </span>
        </div>
        <div className="settings-content">
          <label>
            Business name
            <input
              required
              maxLength={100}
              value={settings.businessName}
              onChange={(event) => field("businessName", event.target.value)}
            />
          </label>
          <label>
            Business hours
            <input
              required
              maxLength={200}
              value={settings.businessHours}
              onChange={(event) => field("businessHours", event.target.value)}
            />
            <small>
              Display text for your team, for example Mon–Fri, 08:00–17:00.
            </small>
          </label>
          <div className="settings-divider" />
          <div className="settings-section-title">
            <MessageCircle size={19} />
            <div>
              <h3>Reception messages</h3>
              <p>Reusable greetings for your customer conversations.</p>
            </div>
          </div>
          <label>
            Welcome message
            <textarea
              required
              rows={4}
              maxLength={2000}
              value={settings.welcomeMessage}
              onChange={(event) => field("welcomeMessage", event.target.value)}
            />
            <small>Keep it warm, useful, and true to your business.</small>
          </label>
          <label>
            Away message
            <textarea
              required
              rows={3}
              maxLength={2000}
              value={settings.awayMessage}
              onChange={(event) => field("awayMessage", event.target.value)}
            />
            <small>Let customers know when they can expect to hear back.</small>
          </label>
          <div className="settings-toggle-row">
            <div>
              <strong>Enable reply drafts</strong>
              <p>
                Prepare helpful replies for your team to review before sending.
              </p>
            </div>
            <button
              type="button"
              className={`toggle ${settings.automationEnabled ? "on" : ""}`}
              role="switch"
              aria-checked={settings.automationEnabled}
              aria-label="Enable reply drafts"
              onClick={() =>
                field("automationEnabled", !settings.automationEnabled)
              }
            >
              <span />
            </button>
          </div>
          <div className="info-note">
            <ShieldCheck size={18} />
            <p>
              <strong>People stay in control.</strong> Drafts use your reception
              messages and conversation context. Your team reviews every reply
              before sending. Appointments and prices must be confirmed by a
              person.
            </p>
          </div>
          <ErrorMessage message={error} />
        </div>
        <div className="settings-save">
          <span>
            {dirty ? "You have unsaved changes" : "All settings are up to date"}
          </span>
          <button className="button primary" disabled={busy || !dirty}>
            {busy ? (
              <Spinner />
            ) : (
              <>
                <Check size={16} /> Save changes
              </>
            )}
          </button>
        </div>
      </form>
      <div className="settings-aside">
        <section className="panel connection-card">
          <div className="connection-icon">
            <MessageCircle size={28} />
          </div>
          <h2>WhatsApp connection</h2>
          <p>
            {integration.mode === "demo"
              ? "Explore with confidence. This workspace uses safe, local demo conversations."
              : "Your workspace uses the official WhatsApp Cloud API."}
          </p>
          <div className="connection-facts">
            <div>
              <span>Workspace mode</span>
              <strong
                className={
                  integration.mode === "demo" ? "text-amber" : "text-green"
                }
              >
                {integration.mode === "demo" ? "Demo" : "Live"}
              </strong>
            </div>
            <div>
              <span>Message delivery</span>
              <strong>
                {integration.mode === "demo"
                  ? "Simulated locally"
                  : integration.whatsappConfigured
                    ? "Configured"
                    : "Not configured"}
              </strong>
            </div>
            <div>
              <span>Incoming webhook</span>
              <strong>
                {integration.mode === "demo"
                  ? "Demo simulator"
                  : integration.webhookConfigured
                    ? "Configured"
                    : "Not configured"}
              </strong>
            </div>
            <div>
              <span>Reply assistance</span>
              <strong>
                {integration.aiConfigured
                  ? "AI configured"
                  : "Smart reply templates"}
              </strong>
            </div>
            <div>
              <span>Automatic replies</span>
              <strong>Not active</strong>
            </div>
          </div>
          <div className="connection-notice">
            <ShieldCheck size={15} />
            <span>
              {integration.mode === "demo"
                ? "No real messages are sent from demo mode."
                : "API credentials are managed securely on the server."}
            </span>
          </div>
        </section>
        <section className="panel connection-card" aria-labelledby="readiness-title">
          <h2 id="readiness-title">Launch checklist</h2>
          {readiness ? <>
            <p>{readiness.ready ? "Server configuration is ready for a WhatsApp test." : "Complete server configuration before connecting your Meta test number."} A real message test is still required.</p>
            <div className="connection-facts">{Object.entries(readiness.checks).map(([name, complete]) => <div key={name}><span>{({ liveMode: "Live workspace", httpsOrigin: "HTTPS address", secureCookies: "Secure sign-in", whatsappToken: "WhatsApp access token", whatsappPhoneId: "WhatsApp phone number ID", whatsappAppSecret: "Meta app secret", whatsappVerifyToken: "Webhook verification token" } as Record<string, string>)[name] || name}</span><strong className={complete ? "text-green" : "text-amber"}>{complete ? "Ready" : "Required"}</strong></div>)}</div>
            {readiness.webhookUrl && <label>Meta webhook callback<input readOnly value={readiness.webhookUrl} onFocus={(event) => event.currentTarget.select()} /><small>Copy this address into Meta’s webhook configuration.</small></label>}
            <div className="connection-notice"><ShieldCheck size={15} /><span>Every reply is reviewed by your team. Credentials stay on the server.</span></div>
          </> : <p>{readinessError || "Checking server configuration…"}</p>}
        </section>
        <div className="settings-tip">
          <Sparkles size={20} />
          <h3>A thoughtful first hello.</h3>
          <p>
            The best welcome messages tell customers three things: who you are,
            how you can help, and what happens next.
          </p>
        </div>
      </div>
    </div>
  );
}

function ActivityPage({ revision }: { revision: number }) {
  const [activity, setActivity] = useState<Activity[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void api<{ activity: Activity[] }>("/activity")
      .then((result) => {
        if (active) setActivity(result.activity);
      })
      .catch((cause) => {
        if (active) setError(cause.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [revision]);
  const visible = activity.filter((item) =>
    `${item.action} ${item.detail}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section className="panel activity-panel">
      <div className="panel-heading">
        <div>
          <h2>Your workspace timeline</h2>
          <p>Messages, service jobs, and settings in one clear record.</p>
        </div>
        <label className="search-field">
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search activity…"
            aria-label="Search activity"
          />
        </label>
      </div>
      <ErrorMessage message={error} />
      {loading ? (
        <div className="panel-loading">
          <Spinner /> Loading activity…
        </div>
      ) : visible.length ? (
        <div className="activity-timeline">
          {visible.map((item) => (
            <div className="timeline-item" key={item.id}>
              <span className="timeline-icon">
                {item.action.includes("job") ? (
                  <BriefcaseBusiness size={18} />
                ) : item.action.includes("message") ? (
                  <MessageSquare size={18} />
                ) : item.action.includes("setting") ? (
                  <Settings2 size={18} />
                ) : (
                  <ActivityIcon size={18} />
                )}
              </span>
              <div>
                <strong>{item.action.replace(/[_.]/g, " ")}</strong>
                <p>{item.detail}</p>
                <span>
                  {formatDate(item.createdAt)} at {formatTime(item.createdAt)}
                </span>
              </div>
              <time>{relativeTime(item.createdAt)}</time>
            </div>
          ))}
        </div>
      ) : (
        <Empty
          icon={ActivityIcon}
          title={
            query
              ? "No matching activity"
              : "Your story is just getting started"
          }
          detail={
            query
              ? "Try another search term."
              : "Messages, job changes, and settings updates will appear here."
          }
        />
      )}
    </section>
  );
}
