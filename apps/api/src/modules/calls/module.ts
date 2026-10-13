import type { FastifyInstance } from 'fastify';
import { config, voiceReadiness, phoneReadiness } from '../../config/index.js';
import type { Store } from '../../platform/persistence/store.js';
import { createCalls } from './service.js';
import { dial, lookup } from './infrastructure/exotel.js';
import { registerCallRoutes } from './routes.js';
import { registerExotelRoutes } from './callbacks.routes.js';

export type CallingOptions = { dial?: typeof dial; lookup?: typeof lookup };

export function registerCallsModule(
  app: FastifyInstance,
  store: Store,
  options: CallingOptions,
) {
  const calls = createCalls({
    store,
    maxConcurrentCalls: config.MAX_CONCURRENT_CALLS,
    voiceReadiness,
    phoneReadiness,
    dialCall: options.dial ?? dial,
    lookupCall: options.lookup ?? lookup,
    log: app.log,
  });
  registerCallRoutes(app, store, calls);
  registerExotelRoutes(app, store, calls);

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
