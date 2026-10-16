import { z } from 'zod';
import type { PracticeAnswer } from '@orderline/contracts/api';

const TIMEOUT_MS = 15_000;
const statusSchema = z.object({
  providers: z.object({ gemini: z.boolean(), sarvam: z.boolean() }),
});
export type VoiceAgentStatus = z.infer<typeof statusSchema>;

const answerSchema = z.object({
  sdp: z.string().min(1).max(100_000),
  type: z.literal('answer'),
});

export class VoiceAgentUnavailableError extends Error {
  statusCode = 502;
  constructor() {
    super('The voice agent is not reachable. Check that it is running.');
  }
}

/** Private HTTP channel to the Pipecat service; the browser never talks to it directly. */
export function createVoiceAgentClient(options: {
  baseUrl: string;
  token: string;
}) {
  const headers = { authorization: `Bearer ${options.token}` };
  return {
    /** Which AI providers the agent holds credentials for; null when unreachable. */
    async status(): Promise<VoiceAgentStatus | null> {
      try {
        const response = await fetch(
          new URL('/internal/status', options.baseUrl),
          {
            headers,
            redirect: 'error',
            signal: AbortSignal.timeout(3_000),
          },
        );
        return response.ok
          ? (statusSchema.safeParse(await response.json()).data ?? null)
          : null;
      } catch {
        return null;
      }
    },

    async practiceOffer(input: {
      attemptId: string;
      sessionToken: string;
      sdp: string;
    }): Promise<PracticeAnswer> {
      let response: Response;
      try {
        response = await fetch(new URL('/practice/offer', options.baseUrl), {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ ...input, type: 'offer' }),
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new VoiceAgentUnavailableError();
      }
      const parsed = answerSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (!response.ok || !parsed.success)
        throw new VoiceAgentUnavailableError();
      return parsed.data;
    },
  };
}

export type VoiceAgentClient = ReturnType<typeof createVoiceAgentClient>;
