import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { settingsSchema } from '@orderline/contracts';
import { MAX_CALL_ATTEMPTS } from '@orderline/contracts/integration';
import { workspaceRoot } from './paths.js';

const envFile = resolve(workspaceRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const optional = z.string().trim().default('');
const schema = z
  .object({
    HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    APP_ORIGIN: z.url().default('http://localhost:3000'),
    // Only used to create the first administrator when the users table is empty.
    ADMIN_EMAIL: z.email().default('admin@orderline.local'),
    ADMIN_PASSWORD: z.string().min(16),
    SESSION_SECRET: z.string().min(32),
    DATABASE_PATH: z.string().default('data/agent.sqlite'),
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
    TELEPHONY_PROVIDER: z.enum(['plivo', 'simulated']).default('plivo'),
    PLIVO_AUTH_ID: optional,
    PLIVO_AUTH_TOKEN: optional,
    PLIVO_FROM_NUMBER: z
      .union([z.literal(''), z.string().regex(/^\+91\d{10}$/)])
      .default(''),
    // Public HTTPS origin Plivo calls back to, e.g. https://agent.example.com
    PUBLIC_BASE_URL: optional,
    // Private base URL of the Pipecat voice agent, and the shared token both services
    // use on their internal APIs. The AI provider keys live only with the voice agent.
    VOICE_AGENT_INTERNAL_URL: z.url().default('http://127.0.0.1:7860'),
    VOICE_AGENT_INTERNAL_TOKEN: z.string().min(32),
    // Public WSS endpoint of the Pipecat voice agent that Plivo streams call audio to.
    VOICE_AGENT_STREAM_URL: z
      .union([z.literal(''), z.url({ protocol: /^wss$/ })])
      .default(''),
    MAX_CONCURRENT_CALLS: z.coerce.number().int().min(1).max(10).default(10),
    MAX_CALL_SECONDS: z.coerce.number().int().min(30).max(600).default(180),
    // Blank disables the business-system endpoint; it then answers 503.
    INTEGRATION_INBOUND_SECRET: z
      .union([z.literal(''), z.string().min(32)])
      .default(''),
    // Signed call results go only to this approved destination. Plain HTTP is
    // accepted for loopback hosts so the local mock business system can receive them.
    INTEGRATION_RESULT_URL: z
      .union([
        z.literal(''),
        z.url().refine((value) => {
          const url = new URL(value);
          return (
            !url.username &&
            !url.password &&
            (url.protocol === 'https:' ||
              (url.protocol === 'http:' &&
                ['localhost', '127.0.0.1'].includes(url.hostname)))
          );
        }),
      ])
      .default(''),
    INTEGRATION_RESULT_SECRET: z
      .union([z.literal(''), z.string().min(32)])
      .default(''),
    // Hours are IST: [start, end).
    CALLING_HOURS_START: z.coerce.number().int().min(0).max(23).default(10),
    CALLING_HOURS_END: z.coerce.number().int().min(1).max(24).default(19),
    CALL_RETRY_DELAYS_MINUTES: z
      .string()
      .default('30,120')
      .transform((value) => value.split(',').map(Number))
      .pipe(
        z.array(z.number().int().min(1).max(1440)).min(MAX_CALL_ATTEMPTS - 1),
      ),
  })
  .refine((value) => value.CALLING_HOURS_END > value.CALLING_HOURS_START, {
    path: ['CALLING_HOURS_END'],
  })
  .superRefine((value, context) => {
    // Plivo is the default so a server never silently simulates calls.
    if (value.TELEPHONY_PROVIDER !== 'plivo') return;
    for (const key of [
      'PLIVO_AUTH_ID',
      'PLIVO_AUTH_TOKEN',
      'PLIVO_FROM_NUMBER',
      'PUBLIC_BASE_URL',
      'VOICE_AGENT_STREAM_URL',
    ] as const)
      if (!value[key])
        context.addIssue({ code: 'custom', path: [key], message: 'Required' });
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
