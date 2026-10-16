import type { FastifyInstance } from 'fastify';
import { config, voiceReadiness } from '../../config/index.js';
import type { Store } from '../../platform/persistence/store.js';
import { createCalls } from './service.js';
import { registerCallRoutes } from './routes.js';

export function registerCallsModule(app: FastifyInstance, store: Store) {
  const calls = createCalls({
    store,
    maxConcurrentCalls: config.MAX_CONCURRENT_CALLS,
    voiceReadiness,
    log: app.log,
  });
  registerCallRoutes(app, store, calls);

  const cleanup = setInterval(() => {
    for (const call of store.calls()) {
      if (
        call.mode === 'browser' &&
        call.status === 'queued' &&
        Date.now() - Date.parse(call.createdAt) > 120000
      ) {
        store.update(call.id, {
          status: 'failed',
          error: 'Practice session was not connected in time.',
        });
      }
    }
  }, 30000);
  cleanup.unref();
  app.addHook('onClose', async () => {
    clearInterval(cleanup);
  });
}
