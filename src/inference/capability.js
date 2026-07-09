// src/inference/capability.js — resolve whether a task's model is configured + tool-capable.
//
// The autonomous cycles are only meaningful on a model that can call tools (read the day,
// write memory). A no-model install skips silently; a weak local model without the `tools`
// capability gets its tools DROPPED in run-turn and then fabricates ("empty results…"). This
// shared probe lets the scheduler skip such cycles BEFORE composing, and the dashboard warn
// the user — using the SAME resolution run-turn uses, so the answer never diverges.

import { resolveInferenceConfigForTask } from './resolve.js';
import { describeProvider } from '../agent/harness.js';
import { resolveModelProfile } from './model-profile.js';

/**
 * @returns {Promise<{configured:boolean, toolsCapable:boolean, model:(string|null), local:boolean}>}
 *   configured=false → no provider for this task (cycles will skip 'no-model').
 *   toolsCapable=false with configured=true → a model that can't call tools (warn / skip).
 */
export async function resolveTaskCapability(db, userId, task, { fetch = globalThis.fetch } = {}) {
  let provider = null;
  try { provider = await resolveInferenceConfigForTask(db, userId, task); } catch { provider = null; }
  const info = describeProvider(provider);
  if (!info) return { configured: false, toolsCapable: false, model: null, local: false };
  const local = !!info.local;
  let toolsCapable = !local; // fail-safe: cloud capable, bare local not — mirrors run-turn.js
  try {
    const profile = await resolveModelProfile(provider, { fetch, defaultModel: info.model });
    if (profile?.capabilities) toolsCapable = !!profile.capabilities.tools;
  } catch { /* keep the fail-safe default */ }
  return { configured: true, toolsCapable, model: info.model || null, local };
}

export default resolveTaskCapability;
