export type User = { id: string; email: string; name: string };
export type Conversation = {
  id: string;
  customerName: string;
  phone: string;
  preview: string;
  updatedAt: string;
  unreadCount: number;
  status: "open" | "waiting" | "resolved";
  assignedTo: string;
  automationPaused: boolean;
  category: string;
};
export type Message = {
  id: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  text: string;
  createdAt: string;
  status: string;
  providerId: string | null;
};
export type Job = {
  id: string;
  title: string;
  customerName: string;
  phone: string;
  category: string;
  address: string;
  scheduledAt: string;
  status: "new" | "scheduled" | "in_progress" | "completed";
  notes: string;
  createdAt: string;
  updatedAt: string;
  conversationId: string | null;
  assignedTo: string;
  durationMinutes: number;
  version: number;
};
export type Activity = {
  id: string;
  action: string;
  detail: string;
  createdAt: string;
};
export type Settings = {
  businessName: string;
  businessHours: string;
  welcomeMessage: string;
  awayMessage: string;
  automationEnabled: boolean;
};
export type Integration = {
  mode: "demo" | "live";
  whatsappConfigured: boolean;
  webhookConfigured: boolean;
  automaticReplies: boolean;
  aiConfigured: boolean;
};
export type IntegrationReadiness = {
  mode: "demo" | "live";
  ready: boolean;
  webhookUrl: string | null;
  missingNames: string[];
  checks: Record<string, boolean>;
  aiConfigured: boolean;
  automaticReplies: false;
  providerVerified: false;
};
export type Dashboard = {
  stats: {
    openConversations: number;
    unreadMessages: number;
    activeJobs: number;
    completedJobs: number;
  };
  recentActivity: Activity[];
  dailyMessages: { date: string; inbound: number; outbound: number }[];
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(options.method && options.method !== "GET" ? 20000 : 8000);
  let response: Response;
  try { response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  }); } catch (cause) {
    if (options.signal?.aborted) throw cause;
    throw new ApiError(0, timeout.aborted
      ? "The request took too long. Refresh to check the latest state before retrying."
      : "Could not reach the server. Check your connection and try again.");
  }
  let data: Record<string, any>;
  try { data = await response.json(); }
  catch {
    throw new ApiError(response.status, "The server returned an unreadable response. Refresh to check the latest state.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new ApiError(response.status, "The server returned an unexpected response. Please refresh.");
  if (!response.ok) {
    if (
      response.status === 401 &&
      path !== "/auth/login" &&
      path !== "/auth/me"
    )
      window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(
      response.status,
      data.error?.message || "Something went wrong. Please try again.",
    );
  }
  return data as T;
}
export const mutation = <T>(path: string, method: string, body: unknown) =>
  api<T>(path, { method, body: JSON.stringify(body) });
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();
export const formatTime = (date: string) =>
  new Intl.DateTimeFormat("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
export const formatDate = (date: string) =>
  date
    ? new Intl.DateTimeFormat("en-ZA", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(new Date(date))
    : "Not scheduled";
export function relativeTime(date: string) {
  const minutes = Math.max(
    0,
    Math.round((Date.now() - new Date(date).getTime()) / 60000),
  );
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return formatDate(date);
}

export type Intake = {
  conversationId: string;
  summary: string;
  category: string;
  address: string;
  preferredTime: string;
  urgency: "routine" | "urgent";
  wantsHuman: boolean;
  source: string;
  version: number;
  updatedAt: string;
  jobId: string | null;
  missingFields: string[];
  status: "collecting" | "ready" | "converted";
  evidence: { field: string; messageId: string; quote: string }[];
};
