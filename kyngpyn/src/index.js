// KYNGPYN TRADE CONTROL SYSTEM™ — entrypoint.
// Runs continuously (PM2/Docker friendly): starts all layers plus the HTTP
// dashboard and shuts down cleanly on SIGINT/SIGTERM.
import { loadConfig } from './config.js';
import { TradingSystem } from './system.js';
import { createServer } from './server/server.js';

async function main() {
  const config = loadConfig();
  const system = new TradingSystem(config);
  await system.start();

  const server = createServer(system);
  server.listen(config.server.port, config.server.host, () => {
    system.logger.info(`Dashboard + API listening on http://${config.server.host}:${config.server.port}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    system.logger.info(`${signal} received — shutting down`);
    server.close();
    await system.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A trading system must never die silently.
  process.on('uncaughtException', (err) => {
    system.logger.error(`UNCAUGHT EXCEPTION: ${err.stack || err.message}`);
  });
  process.on('unhandledRejection', (reason) => {
    system.logger.error(`UNHANDLED REJECTION: ${reason?.stack || reason}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`Fatal startup error: ${err.message}`);
  process.exit(1);
});
