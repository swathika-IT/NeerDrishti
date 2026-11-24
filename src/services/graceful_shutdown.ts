export interface ClosableServer {
  close(callback: (error?: Error) => void): void;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}

export interface ShutdownLogger {
  info: (line: string) => void;
  error: (line: string) => void;
}

export interface GracefulShutdownOptions {
  server: ClosableServer;
  stopBackgroundJobs?: () => void | Promise<void>;
  closeDatabase?: () => unknown | Promise<unknown>;
  timeoutMs?: number;
  logger?: ShutdownLogger;
  exit?: (code: number) => void;
}

export interface GracefulShutdownController {
  isShuttingDown: () => boolean;
  shutdown: (reason: string) => Promise<void>;
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/(authorization|cookie|password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
}

export function toSafeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: redactSensitiveText(error.message).slice(0, 300) };
  }
  return { name: 'Error', message: redactSensitiveText(String(error)).slice(0, 300) };
}

const safeError = toSafeError;

export function createGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdownController {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 5000);
  const logger = options.logger || { info: console.log, error: console.error };
  const exit = options.exit || ((code: number) => process.exit(code));
  let shuttingDown = false;
  let finished = false;

  return {
    isShuttingDown: () => shuttingDown,
    shutdown: async (reason: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      const startedAt = Date.now();
      logger.info(JSON.stringify({ type: 'shutdown', event: 'started', reason: String(reason).slice(0, 100) }));

      if (options.stopBackgroundJobs) {
        try {
          await options.stopBackgroundJobs();
        } catch (error) {
          logger.error(JSON.stringify({ type: 'shutdown', event: 'background_stop_failed', error: safeError(error) }));
        }
      }

      try {
        options.server.closeIdleConnections?.();
      } catch (error) {
        logger.error(JSON.stringify({ type: 'shutdown', event: 'idle_connection_close_failed', error: safeError(error) }));
      }

      const closeDatabase = async () => {
        if (!options.closeDatabase) return;
        try {
          await options.closeDatabase();
        } catch (error) {
          logger.error(JSON.stringify({ type: 'shutdown', event: 'database_close_failed', error: safeError(error) }));
        }
      };

      await new Promise<void>((resolve) => {
        const finalize = (code: number, event: string) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
           void closeDatabase();
          logger.info(
            JSON.stringify({
              type: 'shutdown',
              event,
              exit_code: code,
              duration_ms: Math.max(0, Date.now() - startedAt),
            })
          );
          resolve();
          exit(code);
        };

        const timer = setTimeout(() => {
          if (finished) return;
          logger.error(
            JSON.stringify({
              type: 'shutdown',
              event: 'timeout',
              timeout_ms: timeoutMs,
            })
          );
          try {
            options.server.closeAllConnections?.();
          } catch (error) {
            logger.error(JSON.stringify({ type: 'shutdown', event: 'force_close_failed', error: safeError(error) }));
          }
          finalize(1, 'forced');
        }, timeoutMs);
        timer.unref?.();

        try {
          options.server.close((error?: Error) => {
            if (finished) return;
            if (error) {
              logger.error(JSON.stringify({ type: 'shutdown', event: 'server_close_failed', error: safeError(error) }));
              finalize(1, 'failed');
              return;
            }
            finalize(0, 'completed');
          });
        } catch (error) {
          logger.error(JSON.stringify({ type: 'shutdown', event: 'server_close_failed', error: safeError(error) }));
          finalize(1, 'failed');
        }
      });
    },
  };
}
