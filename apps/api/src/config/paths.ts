import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source and compiled API files sit four levels below the workspace root.
export const workspaceRoot = fileURLToPath(
  new URL('../../../../', import.meta.url),
);
export const webDist = resolve(workspaceRoot, 'apps/web/dist');
