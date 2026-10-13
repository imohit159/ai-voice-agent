import { rmSync } from 'node:fs';

// TypeScript does not remove outputs for source files that were moved or deleted.
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
