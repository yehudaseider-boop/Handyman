import { useCallback, useState } from "react";
import { ArrowLeft, ArrowRight, CalendarDays, LoaderCircle, Wrench } from "lucide-react";
import { api, formatTime, type Job } from "./api";
import { useVisiblePolling } from "./useVisiblePolling";

function monday(date: Date) { const value = new Date(date); value.setHours(0, 0, 0, 0); value.setDate(value.getDate() - (value.getDay() + 6) % 7); return value; }
function dayKey(date: Date) { return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; }
const dateLabel = (date: Date) => new Intl.DateTimeFormat("en-ZA", { day: "numeric", month: "short" }).format(date);

export function SchedulePage({ revision, onEdit, onNewJob }: { revision: number; onEdit: (job: Job) => void; onNewJob: () => void }) {
  const [week, setWeek] = useState(() => monday(new Date()));
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await api<{ jobs: Job[] }>("/jobs", { signal });
      if (!signal.aborted) { setJobs(result.jobs); setError(""); }
    } catch (cause) { if (!signal.aborted) setError((cause as Error).message); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [revision]);
  useVisiblePolling(refresh, 15000);
  const days = Array.from({ length: 7 }, (_, index) => { const date = new Date(week); date.setDate(date.getDate() + index); return date; });
  const scheduled = jobs.filter((job) => job.scheduledAt && (job.status === "scheduled" || job.status === "in_progress")).sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
  const weekJobs = scheduled.filter((job) => days.some((day) => dayKey(day) === dayKey(new Date(job.scheduledAt))));
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  function move(direction: number) { setWeek((current) => { const next = new Date(current); next.setDate(next.getDate() + direction * 7); return next; }); }
  return <section className="panel schedule-panel" aria-label="Weekly service schedule">
    <div className="panel-heading schedule-heading"><div><h2><CalendarDays size={19} /> {dateLabel(days[0])} – {dateLabel(days[6])}, {days[6].getFullYear()}</h2><p>Team visits · {timezone} · {weekJobs.length} {weekJobs.length === 1 ? "job" : "jobs"} this week</p></div><div className="intake-actions"><button className="icon-button" aria-label="Previous week" onClick={() => move(-1)}><ArrowLeft size={18} /></button><button className="button secondary compact" onClick={() => setWeek(monday(new Date()))}>Today</button><button className="icon-button" aria-label="Next week" onClick={() => move(1)}><ArrowRight size={18} /></button></div></div>
    <p className="schedule-note">The team’s planned visits. Confirm appointment details with the customer before sending a reply.</p>
    {error && <div className="error-message" role="alert">{error}</div>}
    {loading ? <div className="panel-loading"><LoaderCircle className="spin" size={20} /> Loading schedule…</div> : <div className="week-grid">{days.map((day) => {
      const dayJobs = scheduled.filter((job) => dayKey(new Date(job.scheduledAt)) === dayKey(day));
      const today = dayKey(day) === dayKey(new Date());
      return <section className={`schedule-day ${today ? "is-today" : ""}`} key={dayKey(day)} aria-label={new Intl.DateTimeFormat("en-ZA", { dateStyle: "full" }).format(day)}><div className="schedule-day-heading"><span>{new Intl.DateTimeFormat("en-ZA", { weekday: "short" }).format(day)}</span><strong>{day.getDate()}</strong>{today && <small>Today</small>}</div><div className="schedule-day-jobs">{dayJobs.length ? dayJobs.map((job) => {
        const end = new Date(new Date(job.scheduledAt).getTime() + job.durationMinutes * 60000);
        return <button className={`schedule-job ${job.status === "in_progress" ? "in-progress" : ""}`} key={job.id} onClick={() => onEdit(job)} aria-label={`Edit scheduled job ${job.title}`}><span className="schedule-job-time">{formatTime(job.scheduledAt)}–{formatTime(end.toISOString())}</span><strong>{job.title}</strong><span>{job.customerName}</span><span className="schedule-team"><Wrench size={12} /> {job.assignedTo || "Team"}</span><small>{job.status === "in_progress" ? "In progress" : `${job.durationMinutes} min`}</small></button>;
      }) : <p className="schedule-free">No visits planned</p>}</div></section>;
    })}</div>}
    {!loading && !error && !weekJobs.length && <div className="schedule-empty"><p>A clear week ahead. Schedule a service job when the details are agreed.</p><button className="button secondary compact" onClick={onNewJob}>Create a service job</button></div>}
  </section>;
}
