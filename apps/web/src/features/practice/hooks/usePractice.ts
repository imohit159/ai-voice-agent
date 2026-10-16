import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { callsService } from '../../calls/services/calls.js';
import { practiceService } from '../services/practice.js';
import { PracticeConnection } from '../services/webrtc.js';

export type PracticeStatus = 'idle' | 'connecting' | 'live' | 'ended';
const TRANSCRIPT_POLL_MS = 2_000;

export function usePractice(onError: (message: string) => void) {
  const queryClient = useQueryClient();
  const connection = useRef<PracticeConnection | null>(null);
  const [status, setStatus] = useState<PracticeStatus>('idle');
  const [attemptId, setAttemptId] = useState<string | null>(null);

  // The voice agent writes the transcript through the API; follow it while live.
  const detail = useQuery({
    queryKey: ['call-attempt', attemptId],
    queryFn: () => callsService.detail(attemptId!),
    enabled: attemptId !== null,
    refetchInterval:
      status === 'live' || status === 'connecting' ? TRANSCRIPT_POLL_MS : false,
  });

  const stop = useCallback(() => connection.current?.stop(), []);

  const start = useCallback(async () => {
    if (connection.current) return;
    const current = new PracticeConnection(() => {
      connection.current = null;
      setStatus('ended');
      void queryClient.invalidateQueries({ queryKey: ['call-attempts'] });
    });
    connection.current = current;
    setStatus('connecting');
    try {
      const { attemptId: id } = await practiceService.start();
      setAttemptId(id);
      await current.start(
        async (sdp) => (await practiceService.offer(id, sdp)).sdp,
      );
      if (connection.current === current) setStatus('live');
    } catch (error) {
      current.stop();
      onError(
        error instanceof Error ? error.message : 'Could not start practice.',
      );
    }
  }, [onError, queryClient]);

  // Leaving the page hangs up rather than leaving a microphone open.
  useEffect(() => () => connection.current?.stop(), []);

  return { status, start, stop, attempt: detail.data };
}
