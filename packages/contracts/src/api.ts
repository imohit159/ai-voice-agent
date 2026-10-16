import type { AuditAction, Order, Settings, UserRole } from './domain.js';
import type {
  AttemptStatus,
  CallOutcome,
  CallRequestStatus,
} from './integration.js';
import type { AgentConfig, TranscriptRole } from './voice.js';

export interface WorkspaceState {
  settings: Settings;
  orders: Order[];
  connections: {
    geminiConfigured: boolean;
    sarvamConfigured: boolean;
    selectedConfigured: boolean;
    geminiModel: string;
    /** Provider credentials are validated at server start, so a running server is ready. */
    telephony: { provider: string; callerId: string | null };
    maxCallSeconds: number;
    maxConcurrentCalls: number;
  };
}

export interface CallAttemptSummary {
  id: string;
  requestId: string;
  source: 'integration' | 'practice';
  orderRef: string;
  attemptNumber: number;
  status: AttemptStatus;
  requestStatus: CallRequestStatus;
  outcome: CallOutcome | null;
  outcomeSummary: string | null;
  callbackAt: string | null;
  agent: AgentConfig | null;
  failureReason: string | null;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
}

export interface TranscriptEntry {
  role: TranscriptRole;
  text: string;
  spokenAt: string;
}

export interface CallAttemptDetail {
  attempt: CallAttemptSummary;
  transcript: TranscriptEntry[];
}

export interface PracticeSession {
  attemptId: string;
}

export interface PracticeOffer {
  sdp: string;
  type: 'offer';
}

export interface PracticeAnswer {
  sdp: string;
  type: 'answer';
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export interface SessionInfo {
  authenticated: boolean;
  user: SessionUser | null;
}

export interface UserSummary extends SessionUser {
  disabled: boolean;
  createdAt: string;
}

export interface ResultDeliverySummary {
  eventId: string;
  requestId: string;
  attemptId: string | null;
  requestStatus: string;
  status: 'pending' | 'delivered' | 'failed';
  deliveryAttempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  deliveredAt: string | null;
  createdAt: string;
}

export interface AuditEventSummary {
  id: number;
  action: AuditAction;
  userEmail: string | null;
  subjectType: string | null;
  subjectId: string | null;
  createdAt: string;
}
