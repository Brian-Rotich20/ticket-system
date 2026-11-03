import { buildApp } from './app.js';
import { createDb } from './config/db.js';
import { loadEnv } from './config/env.js';

const env = loadEnv();
const { db, close } = createDb(env.DATABASE_URL);
const { app, services } = await buildApp({ env, db });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await services.notifier.flush();
  await close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: env.PORT, host: env.HOST });
