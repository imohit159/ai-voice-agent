import type { FastifyInstance } from 'fastify';
import { settingsSchema } from '@orderline/contracts';
import type { createWorkspace } from './service.js';

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  workspace: ReturnType<typeof createWorkspace>,
) {
  app.get('/api/state', async () => workspace.state());
  app.put('/api/settings', async (request) =>
    workspace.saveSettings(settingsSchema.parse(request.body)),
  );
  app.post('/api/demo/reset', async () => workspace.resetDemo());
}
