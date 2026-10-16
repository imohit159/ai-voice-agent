type Log = {
  error: (fields: Record<string, unknown>, message: string) => void;
};

/**
 * Runs `work` every `intervalMs` without overlapping runs. Returns a stop
 * function that waits for an in-flight run, so shutdown never cuts one short.
 * Single-process only: correctness relies on this being the sole worker.
 */
export function startIntervalJob(
  name: string,
  intervalMs: number,
  work: () => Promise<void> | void,
  log: Log,
): () => Promise<void> {
  let running: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (running) return;
    running = Promise.resolve()
      .then(work)
      .catch((error: unknown) =>
        log.error(
          {
            job: name,
            errorType: error instanceof Error ? error.name : 'UnknownError',
            error: error instanceof Error ? error.message : undefined,
          },
          'Background job failed',
        ),
      )
      .finally(() => {
        running = null;
      });
  }, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
