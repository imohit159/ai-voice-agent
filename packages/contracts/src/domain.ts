import { z } from 'zod';
import type { CallOutcome } from './integration.js';
import {
  AGENT_LANGUAGES,
  VOICE_PROVIDERS,
  DEFAULT_GEMINI_MODEL,
  SARVAM_MODELS,
  SARVAM_STT_MODELS,
  SARVAM_TTS_MODELS,
} from './models.js';

export interface Order {
  id: string;
  customerName: string;
  phone: string;
  items: string;
  amount: number;
  currency: 'INR';
  address: string;
  outcome: CallOutcome | null;
  isDemo: boolean;
}
export type Settings = z.infer<typeof settingsSchema>;
export const settingsSchema = z
  .object({
    storeName: z.string().trim().min(1).max(80),
    language: z.enum(AGENT_LANGUAGES),
    voiceProvider: z.enum(VOICE_PROVIDERS).default('gemini'),
    geminiModel: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9._/-]{1,120}$/)
      .default(DEFAULT_GEMINI_MODEL),
    // Saved settings or .env values naming a retired model fall back to the
    // default rather than blocking startup.
    sarvamModel: z.enum(SARVAM_MODELS).catch(SARVAM_MODELS[0]),
    sarvamSttModel: z.enum(SARVAM_STT_MODELS).catch(SARVAM_STT_MODELS[0]),
    sarvamTtsModel: z.enum(SARVAM_TTS_MODELS).catch(SARVAM_TTS_MODELS[0]),
  })
  .strict();
