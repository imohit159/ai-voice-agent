import type { FastifyInstance } from 'fastify';
import { settingsSchema } from '@orderline/contracts';
import { requireAdmin } from '../../platform/http/security.js';
import type { AuditRecorder } from '../audit/module.js';
import type { createWorkspace } from './service.js';

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  workspace: ReturnType<typeof createWorkspace>,
  audit: AuditRecorder,
) {
  app.get('/api/state', async () => workspace.state());
  app.put('/api/settings', { preHandler: requireAdmin }, async (request) => {
    const result = workspace.saveSettings(settingsSchema.parse(request.body));
    audit({ userId: request.user!.id, action: 'settings.updated' });
    return result;
  });
  app.post('/api/demo/reset', { preHandler: requireAdmin }, async () =>
    workspace.resetDemo(),
  );
}
