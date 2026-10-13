import { createApp } from './app.js';
import { config } from './config/index.js';

const app = await createApp();
try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch {
  app.log.error(
    'Could not start the server. Check configuration and whether the port is free.',
  );
  process.exit(1);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void app.close();
  });
