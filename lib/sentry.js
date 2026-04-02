/**
 * Sentry Error Tracking
 *
 * Centralized Sentry initialization for all mycelium processes.
 * Import this as the FIRST import in every entry point:
 *   import './lib/sentry.js';
 *
 * Reads SENTRY_DSN from environment. If not set, Sentry is a no-op.
 * Each process identifies itself via AGENT_ID or process name.
 */

import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;
const agentId = process.env.AGENT_ID || process.env.pm_id || 'unknown';

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    serverName: agentId,
    sendDefaultPii: true,
    // Tag every event with the agent/process identity
    initialScope: {
      tags: {
        agent: agentId,
        tier: process.env.AGENT_TIER || 'unknown',
      },
    },
  });
  // Capture crashes that would otherwise just kill the process
  process.on('uncaughtException', (error) => {
    console.error('[Sentry] Uncaught exception:', error);
    Sentry.captureException(error);
    // Flush and exit — process is in unknown state
    Sentry.close(2000).finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[Sentry] Unhandled rejection:', reason);
    Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
  });

  console.log(`[Sentry] Initialized for ${agentId}`);
} else {
  console.log('[Sentry] SENTRY_DSN not set — error tracking disabled');
}

export { Sentry };
export default Sentry;
