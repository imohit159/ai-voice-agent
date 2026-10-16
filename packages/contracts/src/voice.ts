import { z } from 'zod';
import { AGENT_LANGUAGES, VOICE_PROVIDERS } from './models.js';
import type { CallRequest } from './integration.js';

// Internal contract between the API (sole database writer) and the Pipecat
// voice agent. services/voice-agent/src/voice_agent/node_client.py mirrors it.

export const VOICE_TRANSPORTS = ['plivo', 'webrtc'] as const;
export const TRANSCRIPT_ROLES = ['customer', 'agent'] as const;
export const VOICE_SESSION_END_REASONS = [
  'completed',
  'disconnected',
  'timeout',
  'error',
] as const;

export type VoiceTransport = (typeof VOICE_TRANSPORTS)[number];
export type TranscriptRole = (typeof TRANSCRIPT_ROLES)[number];

/** Agent configuration snapshotted on each attempt; fixed for the whole call. */
export const agentConfigSchema = z
  .object({
    voiceProvider: z.enum(VOICE_PROVIDERS),
    model: z.string().min(1).max(120),
    sttModel: z.string().min(1).max(60).optional(),
    ttsModel: z.string().min(1).max(60).optional(),
    language: z.enum(AGENT_LANGUAGES),
    storeName: z.string().min(1).max(80),
  })
  .strict();
export type AgentConfig = z.infer<typeof agentConfigSchema>;

const sessionToken = z.string().min(1).max(2048);

export const voiceSessionClaimSchema = z
  .object({
    attemptId: z.uuid(),
    sessionToken,
    transport: z.enum(VOICE_TRANSPORTS),
    /** Plivo CallUUID from the stream's start event; binds the stream to the answered call. */
    providerLegId: z.string().min(1).max(128).optional(),
  })
  .strict();
export type VoiceSessionClaim = z.infer<typeof voiceSessionClaimSchema>;

export interface VoiceSessionContext {
  attemptId: string;
  transport: VoiceTransport;
  isPractice: boolean;
  maxCallSeconds: number;
  agent: AgentConfig;
  customer: Pick<CallRequest['customer'], 'name'>;
  order: CallRequest['order'];
}

export const transcriptBatchSchema = z
  .object({
    sessionToken,
    entries: z
      .array(
        z
          .object({
            role: z.enum(TRANSCRIPT_ROLES),
            text: z.string().trim().min(1).max(4000),
            spokenAt: z.iso.datetime({ offset: true }),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type TranscriptBatch = z.infer<typeof transcriptBatchSchema>;

export const voiceSessionEndSchema = z
  .object({
    sessionToken,
    reason: z.enum(VOICE_SESSION_END_REASONS),
  })
  .strict();
export type VoiceSessionEnd = z.infer<typeof voiceSessionEndSchema>;
