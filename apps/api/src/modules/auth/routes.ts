import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { USER_ROLES } from '@orderline/contracts';
import type { SessionInfo } from '@orderline/contracts/api';
import { requireAdmin } from '../../platform/http/security.js';
import type { Auth } from './service.js';

const SESSION_SECONDS = 8 * 60 * 60;
const password = z.string().min(12).max(256);
const idParams = z.object({ id: z.uuid() });

export function registerAuthRoutes(
  app: FastifyInstance,
  auth: Auth,
  { secureCookies }: { secureCookies: boolean },
) {
  const setSession = (reply: FastifyReply, token: string) =>
    reply.setCookie('session', token, {
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_SECONDS,
    });

  app.get('/api/session', async (request): Promise<SessionInfo> => ({
    authenticated: request.user !== null,
    user: request.user,
  }));
  app.post(
    '/api/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply): Promise<SessionInfo> => {
      const body = z
        .object({
          email: z.email().max(254),
          password: z.string().min(1).max(256),
        })
        .strict()
        .parse(request.body);
      const { token, user } = await auth.login(body.email, body.password);
      setSession(reply, token);
      return { authenticated: true, user };
    },
  );
  app.post('/api/logout', async (_request, reply): Promise<SessionInfo> => {
    reply.clearCookie('session', { path: '/' });
    return { authenticated: false, user: null };
  });
  app.post(
    '/api/me/password',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = z
        .object({
          currentPassword: z.string().min(1).max(256),
          newPassword: password,
        })
        .strict()
        .parse(request.body);
      setSession(
        reply,
        await auth.changeOwnPassword(
          request.user!,
          body.currentPassword,
          body.newPassword,
        ),
      );
      return { changed: true };
    },
  );

  app.get('/api/users', { preHandler: requireAdmin }, async () => ({
    users: auth.listUsers(),
  }));
  app.post('/api/users', { preHandler: requireAdmin }, async (request) => {
    const body = z
      .object({
        email: z.email().max(254),
        name: z.string().trim().min(1).max(80),
        role: z.enum(USER_ROLES),
        password,
      })
      .strict()
      .parse(request.body);
    return { user: await auth.createUser(request.user!, body) };
  });
  app.patch('/api/users/:id', { preHandler: requireAdmin }, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        role: z.enum(USER_ROLES).optional(),
        disabled: z.boolean().optional(),
      })
      .strict()
      .parse(request.body);
    return { user: auth.updateUser(request.user!, id, body) };
  });
  app.post(
    '/api/users/:id/password',
    { preHandler: requireAdmin },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const body = z.object({ password }).strict().parse(request.body);
      await auth.resetPassword(request.user!, id, body.password);
      return { reset: true };
    },
  );
}
