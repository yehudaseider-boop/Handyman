export type Mode = 'demo' | 'live';

export interface AppOptions {
  dbPath?: string;
  mode?: Mode;
  adminEmail?: string;
  adminPassword?: string;
  appOrigin?: string;
  secureCookies?: boolean;
  whatsappToken?: string;
  whatsappPhoneId?: string;
  whatsappAppSecret?: string;
  whatsappVerifyToken?: string;
  aiApiKey?: string;
  aiModel?: string;
  fetchImpl?: typeof fetch;
  serveDir?: string;
  allowLiveAutomation?: boolean;
}

export interface Conversation {
  id: string;
  customerName: string;
  phone: string;
  preview: string;
  updatedAt: string;
  unreadCount: number;
  status: string;
  assignedTo: string;
  automationPaused: boolean;
  category: string;
}

export interface Message {
  id: string;
  conversationId: string;
  direction: 'inbound' | 'outbound';
  text: string;
  createdAt: string;
  status: string;
  providerId: string | null;
}

export interface Intake {
  conversationId: string; summary: string; category: string; address: string; preferredTime: string;
  urgency: 'routine' | 'urgent'; wantsHuman: boolean; source: 'template' | 'ai' | 'manual';
  evidence: Array<{ field: string; messageId: string; quote: string }>;
  version: number; updatedAt: string; jobId: string | null; missingFields: string[];
  status: 'collecting' | 'ready' | 'converted';
}

export interface Job {
  conversationId: string | null;
  assignedTo: string;
  durationMinutes: number;
  version: number;
  id: string;
  title: string;
  customerName: string;
  phone: string;
  category: string;
  address: string;
  scheduledAt: string;
  status: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}
