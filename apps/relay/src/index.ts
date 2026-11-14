import { ConfigError, loadConfig, resolveBind } from './config';
import { createRelay } from './app';
import { consoleLogger as log } from './log';

async function main(): Promise<void> {
  let config;
  let bind;
  try {
    config = loadConfig(process.env);
    bind = resolveBind(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error(`config error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  const relay = createRelay(config, { logger: log });
  const addr = await relay.listen(bind.port, bind.host);
  log.info('kesoku relay listening', {
    host: addr.address,
    port: addr.port,
    media: config.localMediaDir ? 'local' : config.mediaBucket ? 'gcs' : 'none',
    google_signin: Boolean(config.firebaseProjectId),
    static_dir: config.staticDir,
  });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    const hard = setTimeout(() => process.exit(0), 8000);
    hard.unref();
    relay
      .shutdown()
      .catch((err) => log.error('shutdown failed', { error: err instanceof Error ? err.message : String(err) }))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err) => {
  log.error('fatal', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
