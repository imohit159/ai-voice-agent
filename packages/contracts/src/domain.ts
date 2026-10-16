import { z } from 'zod';
import {
  VOICE_PROVIDERS,
  DEFAULT_GEMINI_MODEL,
  SARVAM_MODELS,
  SARVAM_STT_MODELS,
  SARVAM_TTS_MODELS,
} from './models.js';

export const OUTCOMES = ['confirmed', 'declined', 'needs_follow_up'] as const;
export const CALL_STATUSES = [
  'queued',
  'connecting',
  'active',
  'completed',
  'failed',
  'busy',
  'no_answer',
  'unknown',
] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type CallStatus = (typeof CALL_STATUSES)[number];
export const ACTIVE_STATUSES: CallStatus[] = [
  'queued',
  'connecting',
  'active',
  'unknown',
];
export const TERMINAL_STATUSES: CallStatus[] = [
  'completed',
  'failed',
  'busy',
  'no_answer',
];

export interface Order {
  id: string;
  customerName: string;
  phone: string;
  items: string;
  amount: number;
  currency: 'INR';
  address: string;
  outcome: Outcome | null;
  isDemo: boolean;
}
export type Settings = z.infer<typeof settingsSchema>;
export interface Call {
  id: string;
  orderId: string;
  mode: 'browser' | 'phone';
  status: CallStatus;
  outcome: Outcome | null;
  summary: string | null;
  providerSid: string | null;
  createdAt: string;
  endedAt: string | null;
  error: string | null;
  agentSettings?: Settings;
}
export interface Transcript {
  id: number;
  role: 'customer' | 'agent';
  text: string;
  createdAt: string;
}
export const outcomeSchema = z
  .object({
    outcome: z.enum(OUTCOMES),
    evidence: z.string().trim().min(3).max(1000),
  })
  .strict();
export const settingsSchema = z
  .object({
    storeName: z.string().trim().min(1).max(80),
    language: z.enum(['Hindi', 'English', 'Hindi and English']),
    voiceProvider: z.enum(VOICE_PROVIDERS).default('gemini'),
    geminiModel: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9._/-]{1,120}$/)
      .default(DEFAULT_GEMINI_MODEL),
    sarvamModel: z.enum(SARVAM_MODELS).default(SARVAM_MODELS[0]),
    sarvamSttModel: z.enum(SARVAM_STT_MODELS).default(SARVAM_STT_MODELS[0]),
    sarvamTtsModel: z.enum(SARVAM_TTS_MODELS).default(SARVAM_TTS_MODELS[0]),
  })
  .strict();
