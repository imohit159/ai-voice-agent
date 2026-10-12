import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import { config, defaultSettings, voiceReadiness, phoneReadiness } from './config.js';
import { issueToken, verifyToken, passwordChecker } from './security.js';
import { Store } from './store.js';
import { ACTIVE_STATUSES, providerStatus, settingsSchema, type Call } from '../shared/domain.js';
import { dial, lookup, callUrls, ProviderError } from './integrations/exotel.js';
import { attachVoice } from './agent/streams.js';

class ApiError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
const callRequest = z.object({ orderId: z.string().min(1).max(80), mode: z.enum(['browser', 'phone']), requestKey: z.uuid() }).strict();
const idParams = z.object({ id: z.uuid() });
const callbackSchema = z.object({ CallSid: z.string().min(1).max(128), Status: z.string().max(30) });

export async function createApp(options: {
  store?: Store; dial?: typeof dial; lookup?: typeof lookup; voice?: typeof attachVoice;
  logging?: boolean;
} = {}) {
  const store = options.store ?? new Store(config.DATABASE_PATH, defaultSettings, config.TEST_PHONE_NUMBER);
  const app = Fastify({ logger: options.logging === false ? false : { level: 'info', redact: ['req.url', 'req.headers', 'err.message', 'err.stack'] }, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 16384 });
  const checkPassword = passwordChecker(config.ADMIN_PASSWORD, config.SESSION_SECRET);
  const origin = new URL(config.APP_ORIGIN).origin;
  const secure = origin.startsWith('https:');
  const isLoggedIn = (token?: string) => token && verifyToken(config.SESSION_SECRET, token, 'operator') === 'admin';
  const allowedHosts = new Set(['localhost', '127.0.0.1', new URL(origin).hostname]);
  if (config.PUBLIC_BASE_URL) allowedHosts.add(new URL(config.PUBLIC_BASE_URL).hostname);
  await app.register(cookie);
  await app.register(rateLimit, { max: 150, timeWindow: '1 minute' });
  await app.register(formbody);
  await app.register(websocket, {
    options: { maxPayload: 150000 },
    errorHandler: (_error, socket) => { app.log.warn('Voice socket failed'); socket.terminate(); },
    preClose: done => {
      // Close media sessions while the store is still open; their close handlers persist final state.
      for (const socket of app.websocketServer.clients) socket.terminate();
      app.websocketServer.close(done);
    },
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'microphone=(self)');
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      let hostname = '';
      try { hostname = new URL(`http://${request.headers.host}`).hostname; } catch { /* rejected below */ }
      if (!allowedHosts.has(hostname)) throw new ApiError(403, 'Unrecognized host.');
      if (request.method !== 'GET' && request.headers.origin !== origin) throw new ApiError(403, 'Invalid request origin.');
      const path = request.url.split('?')[0];
      if (path !== '/api/login' && path !== '/api/session' && !isLoggedIn(request.cookies.session)) throw new ApiError(401, 'Sign in to continue.');
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'Invalid request. Check the supplied fields.' });
    const status = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status >= 500) app.log.error({ errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Request failed');
    return reply.code(status).send({ error: status >= 500 ? 'The request failed. Check server configuration and retry safely.' : error instanceof Error ? error.message : 'Request rejected.' });
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/api/session', async request => ({ authenticated: Boolean(isLoggedIn(request.cookies.session)) }));
  app.post('/api/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { password } = z.object({ password: z.string().min(1).max(256) }).strict().parse(request.body);
    if (!checkPassword(password)) throw new ApiError(401, 'Incorrect operator password.');
    reply.setCookie('session', issueToken(config.SESSION_SECRET, 'operator', 'admin', 28800), { httpOnly: true, secure, sameSite: 'strict', path: '/', maxAge: 28800 });
    return { authenticated: true };
  });
  app.post('/api/logout', async (_request, reply) => {
    reply.clearCookie('session', { path: '/' });
    return { authenticated: false };
  });
  app.get('/api/state', async () => ({
    settings: store.settings(), orders: store.orders(), calls: store.calls(),
    connections: { geminiConfigured: Boolean(config.GEMINI_API_KEY), geminiModel: store.settings().geminiModel, sarvamConfigured: Boolean(config.SARVAM_API_KEY),
      selectedConfigured: voiceReadiness(store.settings().voiceProvider).length === 0,
      exotelReady: phoneReadiness(store.settings().voiceProvider).length === 0, missing: phoneReadiness(store.settings().voiceProvider), callerId: config.EXOTEL_CALLER_ID || null,
      testPhone: config.TEST_PHONE_NUMBER, maxCallSeconds: config.MAX_CALL_SECONDS, maxConcurrentCalls: config.MAX_CONCURRENT_CALLS },
  }));
  app.put('/api/settings', async request => {
    const settings = settingsSchema.parse(request.body);
    store.saveSettings(settings);
    return { settings };
  });
  app.post('/api/demo/reset', async () => {
    if (store.activeCount()) throw new ApiError(409, 'Finish or reconcile active calls first.');
    store.resetDemo();
    return { order: store.order('DEMO-1001') };
  });
  app.get('/api/calls/:id', async request => {
    const { id } = idParams.parse(request.params);
    const call = store.call(id);
    if (!call) throw new ApiError(404, 'Call not found.');
    return { call, transcript: store.transcripts(id) };
  });
  const browserResponse = (call: Call) => ({ call, token: call.mode === 'browser' && call.status === 'queued' ? issueToken(config.SESSION_SECRET, 'browser', call.id, 120) : undefined });
  app.post('/api/calls', async request => {
    const body = callRequest.parse(request.body);
    const existing = store.byKey(body.requestKey);
    if (existing) {
      if (existing.orderId !== body.orderId || existing.mode !== body.mode) throw new ApiError(409, 'Request key already used for a different call.');
      return browserResponse(existing);
    }
    const order = store.order(body.orderId);
    if (!order) throw new ApiError(404, 'Order not found.');
    const missingVoice = voiceReadiness(store.settings().voiceProvider);
    if (missingVoice.length) throw new ApiError(409, `Configure ${missingVoice.join(', ')} on the server first.`);
    if (body.mode === 'phone') {
      if (phoneReadiness(store.settings().voiceProvider).length) throw new ApiError(409, `Finish Exotel setup: ${phoneReadiness(store.settings().voiceProvider).join(', ')}.`);
      if (order.outcome === 'confirmed' || order.outcome === 'declined') throw new ApiError(409, 'This test order already has a decision. Reset the demo to test again.');
      if (store.calls().some(c => c.orderId === order.id && c.mode === 'phone' && ACTIVE_STATUSES.includes(c.status))) throw new ApiError(409, 'This order has an active or uncertain phone attempt. Reconcile before retrying.');
    }
    if (store.activeCount() >= config.MAX_CONCURRENT_CALLS) throw new ApiError(409, 'The configured call limit has been reached. Finish or reconcile an active attempt first.');
    const call = store.create(order.id, body.mode, body.requestKey);
    app.log.info({ callId: call.id, mode: call.mode }, 'Call attempt created');
    if (call.mode === 'browser') return browserResponse(call);
    try {
      const result = await (options.dial ?? dial)(call, order.phone);
      const current = store.call(call.id)!;
      if (current.providerSid && current.providerSid !== result.Sid) throw new ProviderError('Exotel returned a different call identifier. Reconcile this attempt.', true);
      store.update(call.id, { providerSid: result.Sid, status: providerStatus(result.Status) ?? 'unknown' });
    } catch (error) {
      const providerError = error instanceof ProviderError ? error : new ProviderError('Unexpected calling-provider failure. Reconcile before retrying.', true);
      store.update(call.id, { status: providerError.uncertain ? 'unknown' : 'failed', error: providerError.message });
      app.log.warn({ callId: call.id, uncertain: providerError.uncertain }, 'Call dial did not complete');
    }
    return { call: store.call(call.id) };
  });
  app.post('/api/calls/:id/reconcile', async request => {
    const { id } = idParams.parse(request.params);
    const call = store.call(id);
    if (!call || call.mode !== 'phone') throw new ApiError(404, 'Phone call not found.');
    if (!call.providerSid) throw new ApiError(409, 'No provider call ID was received. Match this attempt in Exotel logs; wait for its callback before retrying.');
    try {
      const result = await (options.lookup ?? lookup)(call.providerSid);
      const status = providerStatus(result.Status);
      if (!status) throw new ApiError(409, 'Exotel status is not recognized.');
      return { call: store.update(id, { status, error: null }) };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, 'Could not reconcile with Exotel. The attempt remains blocked against duplicate dialing.');
    }
  });
  app.get('/hooks/exotel/stream-url', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { token, CallSid } = z.object({ token: z.string().max(2048), CallSid: z.string().min(1).max(128) }).parse(request.query);
    if (!config.ENABLE_PHONE_CALLS || !config.EXOTEL_FLOW_ID || verifyToken(config.SESSION_SECRET, token, 'exotel-flow') !== config.EXOTEL_FLOW_ID) {
      throw new ApiError(403, 'Flow is not authorized.');
    }
    const call = store.byProviderSid(CallSid);
    if (!call || call.mode !== 'phone' || !ACTIVE_STATUSES.includes(call.status) || Date.now() - Date.parse(call.createdAt) > (config.MAX_CALL_SECONDS + 120) * 1000) {
      throw new ApiError(403, 'Call is not authorized.');
    }
    app.log.info({ callId: call.id }, 'Exotel flow resolved media endpoint');
    return { url: callUrls(call.id).stream };
  });
  app.post('/hooks/exotel', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async request => {
    const { token } = z.object({ token: z.string().max(2048) }).parse(request.query);
    const id = verifyToken(config.SESSION_SECRET, token, 'exotel-callback');
    if (!id) throw new ApiError(403, 'Invalid callback credentials.');
    const call = store.call(id);
    if (!call || call.mode !== 'phone') throw new ApiError(404, 'Call not found.');
    const body = callbackSchema.parse(request.body);
    if (call.providerSid && call.providerSid !== body.CallSid) throw new ApiError(403, 'Call identity mismatch.');
    const status = providerStatus(body.Status);
    if (!status) throw new ApiError(400, 'Unknown call status.');
    store.update(id, { providerSid: body.CallSid, status, error: null });
    app.log.info({ callId: id, status }, 'Exotel status received');
    return { received: true };
  });
  app.get('/ws/browser', {
    websocket: true,
    preValidation: async request => {
      if (request.headers.origin !== origin || !isLoggedIn(request.cookies.session)) throw new ApiError(403, 'Voice session is not authorized.');
      const { token } = z.object({ token: z.string().max(2048) }).parse(request.query);
      const id = verifyToken(config.SESSION_SECRET, token, 'browser');
      const call = id ? store.call(id) : null;
      if (!call || call.mode !== 'browser' || !store.claim(call.id)) throw new ApiError(403, 'Voice session expired or already used.');
    },
  }, (socket, request) => {
    const { token } = request.query as { token: string };
    const id = verifyToken(config.SESSION_SECRET, token, 'browser')!;
    (options.voice ?? attachVoice)(socket, store.call(id)!, store);
  });
  app.get('/ws/exotel', {
    websocket: true,
    preValidation: async request => {
      const { token } = z.object({ token: z.string().max(2048) }).parse(request.query);
      const id = verifyToken(config.SESSION_SECRET, token, 'exotel-stream');
      const call = id ? store.call(id) : null;
      if (!config.ENABLE_PHONE_CALLS || !call || call.mode !== 'phone' || !store.claim(call.id)) throw new ApiError(403, 'Stream is not authorized.');
    },
  }, (socket, request) => {
    const { token } = request.query as { token: string };
    const id = verifyToken(config.SESSION_SECRET, token, 'exotel-stream')!;
    (options.voice ?? attachVoice)(socket, store.call(id)!, store);
  });
  const cleanup = setInterval(() => {
    for (const call of store.calls()) {
      if (call.mode === 'browser' && call.status === 'queued' && Date.now() - Date.parse(call.createdAt) > 120000) store.update(call.id, { status: 'failed', error: 'Practice session was not connected in time.' });
    }
  }, 30000);
  cleanup.unref();
  if (existsSync(resolve('dist/index.html'))) {
    await app.register(staticFiles, { root: resolve('dist'), index: 'index.html' });
    app.addHook('onSend', async (request, reply, payload) => {
      if (!request.url.startsWith('/api/') && !request.url.startsWith('/ws/')) reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
      return payload;
    });
  }
  app.addHook('onClose', async () => { clearInterval(cleanup); store.close(); });
  return app;
}
