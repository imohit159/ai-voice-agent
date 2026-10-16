import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { issueToken, verifyToken } from '../../platform/security/tokens.js';
import type { OperatorSession } from '../../platform/http/security.js';
import type { AuditRecorder } from '../audit/module.js';
import { createUserRepository } from './repository.js';
import { createAuth } from './service.js';
import { registerAuthRoutes } from './routes.js';

const SESSION_SECONDS = 8 * 60 * 60;
const TOKEN_PURPOSE = 'operator';

/** Creates the first administrator from ADMIN_EMAIL/ADMIN_PASSWORD when no users exist. */
export async function startAuth(db: DatabaseSync, audit: AuditRecorder) {
  const auth = createAuth({
    users: createUserRepository(db),
    audit,
    issueSessionToken: (subject) =>
      issueToken(
        config.SESSION_SECRET,
        TOKEN_PURPOSE,
        subject,
        SESSION_SECONDS,
      ),
    readSessionToken: (token) =>
      verifyToken(config.SESSION_SECRET, token, TOKEN_PURPOSE),
    now: () => new Date(),
    newId: randomUUID,
  });
  await auth.bootstrapAdmin(config.ADMIN_EMAIL, config.ADMIN_PASSWORD);
  const session: OperatorSession = {
    origin: new URL(config.APP_ORIGIN).origin,
    resolve: auth.resolve,
  };
  return {
    session,
    registerRoutes: (app: FastifyInstance) =>
      registerAuthRoutes(app, auth, {
        secureCookies: session.origin.startsWith('https:'),
      }),
  };
}
