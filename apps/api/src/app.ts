import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import formbody from '@fastify/formbody';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentConfig } from '@orderline/contracts/voice';
import { config, defaultSettings } from './config/index.js';
import { Store } from './platform/persistence/store.js';
import { registerHttpSecurity } from './platform/http/security.js';
import { startAudit } from './modules/audit/module.js';
import { startAuth } from './modules/auth/module.js';
import {
  createWorkspace,
  registerWorkspaceRoutes,
} from './modules/workspace/index.js';
import { startCallManagement } from './modules/call-management/module.js';
import { startIntegrations } from './modules/integrations/module.js';
import { webDist } from './config/paths.js';

type CallManagementOptions = Parameters<typeof startCallManagement>[2];

export async function createApp(
  options: {
    store?: Store;
    telephony?: CallManagementOptions['telephony'];
    voiceAgent?: CallManagementOptions['voiceAgent'];
    logging?: boolean;
  } = {},
) {
  const store =
    options.store ??
    new Store(config.DATABASE_PATH, defaultSettings, config.TEST_PHONE_NUMBER);
  const app = Fastify({
    logger:
      options.logging === false
        ? false
        : {
            level: 'info',
            redact: ['req.url', 'req.headers', 'err.message', 'err.stack'],
          },
    logController: new LogController({ disableRequestLogging: true }),
    // Practice SDP offers are larger than any other request body.
    bodyLimit: 131072,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 150, timeWindow: '1 minute' });
  await app.register(formbody);
  const audit = startAudit(app, store.db);
  const auth = await startAuth(store.db, audit.record);
  registerHttpSecurity(app, auth.session);
  app.get('/health', async () => ({ status: 'ok' }));

  // The attempt keeps this snapshot for its whole life, whatever the dashboard changes later.
  const agentConfig = (): AgentConfig => {
    const settings = store.settings();
    const shared = {
      language: settings.language,
      storeName: settings.storeName,
    };
    return settings.voiceProvider === 'gemini'
      ? { voiceProvider: 'gemini', model: settings.geminiModel, ...shared }
      : {
          voiceProvider: 'sarvam',
          model: settings.sarvamModel,
          sttModel: settings.sarvamSttModel,
          ttsModel: settings.sarvamTtsModel,
          ...shared,
        };
  };
  const practiceOrder = () => {
    const order = store.order('DEMO-1001')!;
    return {
      customer: {
        reference: 'practice',
        name: order.customerName,
        phone: order.phone,
      },
      order: {
        id: order.id,
        items: [{ name: order.items, quantity: 1 }],
        total: { amountMinor: order.amount * 100, currency: 'INR' as const },
        paymentMethod: 'cash_on_delivery' as const,
        deliveryAddress: order.address,
      },
    };
  };

  // Register on the same scope so every route shares authentication and error handling.
  auth.registerRoutes(app);
  const integrations = startIntegrations(app, store.db, audit.record);
  const callManagement = await startCallManagement(app, store.db, {
    onAttemptFinished: integrations.recordAttemptResult,
    agentConfig,
    practiceOrder,
    audit: audit.record,
    telephony: options.telephony,
    voiceAgent: options.voiceAgent,
  });
  await integrations.registerRoutes(callManagement.calls);
  registerWorkspaceRoutes(
    app,
    createWorkspace({
      store,
      voiceAgentStatus: callManagement.voiceAgentStatus,
      connections: {
        telephony: {
          provider: options.telephony ? 'test' : config.TELEPHONY_PROVIDER,
          callerId: config.PLIVO_FROM_NUMBER || null,
        },
        maxCallSeconds: config.MAX_CALL_SECONDS,
        maxConcurrentCalls: config.MAX_CONCURRENT_CALLS,
      },
    }),
    audit.record,
  );

  if (existsSync(resolve(webDist, 'index.html'))) {
    await app.register(staticFiles, { root: webDist, index: 'index.html' });
    app.addHook('onSend', async (request, reply, payload) => {
      if (!request.url.startsWith('/api/'))
        reply.header(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        );
      return payload;
    });
  }
  app.addHook('onClose', async () => {
    store.close();
  });
  return app;
}
