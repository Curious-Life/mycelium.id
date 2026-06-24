// src/agent/narration-runner.js — assembles the REAL narration-walk runner from a
// keyed db + userId, so the Phase-3 job (src/jobs.js startNarrationWalkJob) can drive
// the agent walk in-process without the route having to thread the agent runtime.
//
// Builds the same registry the MCP server uses (buildDomains → collectTools) for the
// tool handlers, and the same loop the scheduler uses (createAgentHarness +
// createAgentLoop) with leak-safe egress/usage sinks. Returns a runWalk(...) with the
// shape the job expects: ({ runId, scope, skipIds, onProgress, shouldStop }).
import { buildDomains, collectTools } from '../mcp.js';
import { createAgentHarness } from './harness.js';
import { createAgentLoop } from './loop.js';
import { createAgentHooks, autonomousToolGuard } from './hooks.js';
import { createEgressAuditSink } from '../inference/egress.js';
import { createUsageSink } from '../inference/usage.js';
import { runNarrationWalk } from './narration-walk.js';

/**
 * @param {{ db: object, userId: string, embedder?: object|null, fetchImpl?: Function }} deps
 * @returns {(opts: { runId, scope, skipIds, onProgress, shouldStop, signal? }) => Promise<object>}
 */
export function makeNarrationRunner({ db, userId, embedder = null, fetchImpl = globalThis.fetch } = {}) {
  if (!db || !userId) throw new TypeError('makeNarrationRunner: db + userId required');
  const { domains } = buildDomains({ db, userId, embedder });
  const { tools, handlers } = collectTools(domains);
  const hooks = createAgentHooks({ db, userId, source: 'narration-walk', toolGuard: autonomousToolGuard() });
  const harness = createAgentHarness({
    onEgress: createEgressAuditSink(db, userId),
    onUsage: createUsageSink(db, userId, { source: 'narration-walk' }),
    hooks, surface: 'narration',
    fetch: fetchImpl,
  });
  const loop = createAgentLoop({ harness });

  return (opts) => runNarrationWalk(
    { db, userId, tools, handlers, loop, fetchImpl, signal: opts?.signal, hooks },
    opts,
  );
}

export default makeNarrationRunner;
