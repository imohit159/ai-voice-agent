import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { settingsSchema, type Settings } from '@orderline/contracts';
import { workspaceRoot } from './paths.js';

const envFile = resolve(workspaceRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const optional = z.string().trim().default('');
const schema = z.object({
  HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_ORIGIN: z.url().default('http://localhost:3000'),
  ADMIN_PASSWORD: z.string().min(16),
  SESSION_SECRET: z.string().min(32),
  DATABASE_PATH: z.string().default('data/agent.sqlite'),
  GEMINI_API_KEY: optional,
  SARVAM_API_KEY: optional,
  SARVAM_VOICE_AGENTS_API_KEY: optional,
  VOICE_PROVIDER: settingsSchema.shape.voiceProvider,
  SARVAM_MODEL: settingsSchema.shape.sarvamModel,
  SARVAM_STT_MODEL: settingsSchema.shape.sarvamSttModel,
  SARVAM_TTS_MODEL: settingsSchema.shape.sarvamTtsModel,
  GEMINI_LIVE_MODEL: settingsSchema.shape.geminiModel,
  TEST_PHONE_NUMBER: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/)
    .default('+919625532959'),
  STORE_NAME: z.string().trim().min(1).max(80).default('Demo Store'),
  AGENT_LANGUAGE: z
    .enum(['Hindi', 'English', 'Hindi and English'])
    .default('Hindi and English'),
  EXOTEL_ACCOUNT_SID: optional,
  EXOTEL_API_KEY: optional,
  EXOTEL_API_TOKEN: optional,
  EXOTEL_CALLER_ID: optional,
  EXOTEL_REGION: z.enum(['in', 'sg']).default('in'),
  EXOTEL_FLOW_ID: z.string().regex(/^\d*$/).max(20).default(''),
  PUBLIC_BASE_URL: optional,
  ENABLE_PHONE_CALLS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  MAX_CONCURRENT_CALLS: z.coerce.number().int().min(1).max(5).default(2),
  MAX_CALL_SECONDS: z.coerce.number().int().min(30).max(600).default(180),
});
const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Report field names only; validation details may contain supplied secrets.
  throw new Error(
    `Invalid configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}. See .env.example.`,
  );
}
export const config = {
  ...parsed.data,
  DATABASE_PATH:
    parsed.data.DATABASE_PATH === ':memory:'
      ? ':memory:'
      : resolve(workspaceRoot, parsed.data.DATABASE_PATH),
};
if (config.PUBLIC_BASE_URL) {
  const url = new URL(config.PUBLIC_BASE_URL);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'PUBLIC_BASE_URL must be an HTTPS origin without a path or credentials.',
    );
  }
}
export const defaultSettings = settingsSchema.parse({
  storeName: config.STORE_NAME,
  language: config.AGENT_LANGUAGE,
  voiceProvider: config.VOICE_PROVIDER,
  geminiModel: config.GEMINI_LIVE_MODEL,
  sarvamModel: config.SARVAM_MODEL,
  sarvamSttModel: config.SARVAM_STT_MODEL,
  sarvamTtsModel: config.SARVAM_TTS_MODEL,
});
export function voiceReadiness(provider: Settings['voiceProvider']): string[] {
  const key = provider === 'sarvam' ? 'SARVAM_API_KEY' : 'GEMINI_API_KEY';
  return config[key] ? [] : [key];
}
export function phoneReadiness(
  provider: Settings['voiceProvider'] = config.VOICE_PROVIDER,
): string[] {
  const missing: string[] = voiceReadiness(provider);
  for (const name of [
    'EXOTEL_ACCOUNT_SID',
    'EXOTEL_API_KEY',
    'EXOTEL_API_TOKEN',
    'EXOTEL_CALLER_ID',
    'PUBLIC_BASE_URL',
  ] as const) {
    if (!config[name]) missing.push(name);
  }
  if (!config.ENABLE_PHONE_CALLS) missing.push('ENABLE_PHONE_CALLS');
  return missing;
}
