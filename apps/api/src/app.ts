import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  config,
  defaultSettings,
  voiceReadiness,
  phoneReadiness,
} from './config/index.js';
import { Store } from './platform/persistence/store.js';
import { registerHttpSecurity } from './platform/http/security.js';
import {
  createOperatorSession,
  registerAuthRoutes,
} from './modules/auth/index.js';
import {
  createWorkspace,
  registerWorkspaceRoutes,
} from './modules/workspace/index.js';
import {
  registerCallsModule,
  type CallingOptions,
} from './modules/calls/module.js';
import { attachVoice, registerVoiceRoutes } from './modules/voice/index.js';
import { startCallManagement } from './modules/call-management/module.js';
import { startIntegrations } from './modules/integrations/module.js';
import { webDist } from './config/paths.js';

export async function createApp(
  options: CallingOptions & {
    store?: Store;
    voice?: typeof attachVoice;
    telephony?: Parameters<typeof startCallManagement>[2]['telephony'];
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
    bodyLimit: 16384,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 150, timeWindow: '1 minute' });
  await app.register(formbody);
  await app.register(websocket, {
    options: { maxPayload: 150000 },
    errorHandler: (_error, socket) => {
      app.log.warn('Voice socket failed');
      socket.terminate();
    },
    preClose: (done) => {
      // Close media sessions while the store is still open; their close handlers persist final state.
      for (const socket of app.websocketServer.clients) socket.terminate();
      app.websocketServer.close(done);
    },
  });
  const session = createOperatorSession();
  registerHttpSecurity(app, session);
  const workspace = createWorkspace({
    store,
    voiceReadiness,
    phoneReadiness,
    connections: {
      geminiConfigured: Boolean(config.GEMINI_API_KEY),
      sarvamConfigured: Boolean(config.SARVAM_API_KEY),
      callerId: config.EXOTEL_CALLER_ID || null,
      testPhone: config.TEST_PHONE_NUMBER,
      maxCallSeconds: config.MAX_CALL_SECONDS,
      maxConcurrentCalls: config.MAX_CONCURRENT_CALLS,
    },
  });
  app.get('/health', async () => ({ status: 'ok' }));
  // Register on the same scope so every route shares authentication and error handling.
  registerAuthRoutes(app, session);
  registerWorkspaceRoutes(app, workspace);
  registerCallsModule(app, store, options);
  registerVoiceRoutes(app, store, session, options.voice ?? attachVoice);
  const integrations = startIntegrations(app, store.db);
  const callManagement = startCallManagement(app, store.db, {
    onAttemptFinished: integrations.recordAttemptResult,
    aiConfig: () => {
      const {
        voiceProvider,
        geminiModel,
        sarvamModel,
        sarvamSttModel,
        sarvamTtsModel,
      } = store.settings();
      return voiceProvider === 'gemini'
        ? { voiceProvider, model: geminiModel }
        : {
            voiceProvider,
            model: sarvamModel,
            sttModel: sarvamSttModel,
            ttsModel: sarvamTtsModel,
          };
    },
    telephony: options.telephony,
  });
  await integrations.registerRoutes(callManagement);

  if (existsSync(resolve(webDist, 'index.html'))) {
    await app.register(staticFiles, { root: webDist, index: 'index.html' });
    app.addHook('onSend', async (request, reply, payload) => {
      if (!request.url.startsWith('/api/') && !request.url.startsWith('/ws/'))
        reply.header(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        );
      return payload;
    });
  }
  app.addHook('onClose', async () => {
    store.close();
  });
  return app;
}
