// src/agent/resolve-harness.js — pick the agent engine (harness) for a chat turn.
//
// Reads settings.harnessMode (default 'native'), enforces eligibility, and ALWAYS
// returns a working loop — it never throws to the caller. This is the fail-safe:
// if 'cli' is chosen but ineligible (no binary / not a Claude subscription / the cli
// engine isn't shipped yet), it returns the native loop with a `reason` the UI can
// surface. Only the interactive chat uses this; the autonomous surfaces
// (channels/scheduler/narration) stay native. See docs/HARNESS-CLI-DESIGN-2026-07-02.md.
import { HARNESSES, isCliEngineReady } from './harnesses/index.js';
import { resolveClaudeBin } from '../inference/claude-bin.js';

/**
 * @param {object} a
 * @param {object} a.db
 * @param {string} a.userId
 * @param {object|null} a.provider          resolved inference config (resolveInferenceConfigForTask)
 * @param {object} a.deps                    { harness, logger, restPort } passed to the engine factory
 * @param {string|null} [a.claudeBin]        test seam: inject the binary path (undefined ⇒ auto-detect)
 * @returns {Promise<{ loop: {run: Function}, mode: 'native'|'cli', reason?: string }>}
 */
export async function resolveHarness({ db, userId, provider, deps, claudeBin }) {
  const native = (reason) => ({ loop: HARNESSES.native(deps), mode: 'native', ...(reason ? { reason } : {}) });

  let mode = 'native';
  try { mode = (await db.users.getSettings(userId))?.harnessMode || 'native'; }
  catch { return native(); }
  if (mode !== 'cli') return native();

  // 'cli' requested — every gate must pass, else fail safe to native with a reason.
  // The Claude Code engine is ORTHOGONAL to the active chat provider: it runs on the
  // user's Claude subscription (claude's OWN login) regardless of which provider powers
  // native chat, and uses that subscription row's model. So eligibility = "a
  // subscription is connected" (an auth_type='oauth' row) — NOT "the chat task resolves
  // to it". This is the SAME predicate GET /providers/harness reports to the UI, so the
  // switch can never claim an engine the runtime would refuse.
  const bin = claudeBin !== undefined ? claudeBin : resolveClaudeBin();
  if (!bin) return native('no-binary');
  if (!(Number(deps?.restPort) > 0)) return native('no-port');   // needs the loopback /internal/mcp port
  let subRow = null;
  try { subRow = (await db.providers.list(userId)).find((r) => String(r?.auth_type || '').toLowerCase() === 'oauth'); }
  catch { return native('no-subscription'); }
  if (!subRow) return native('no-subscription');
  // The cli engine is wired but stays OFF until the live-binary spike confirms it
  // (CLI_ENGINE_ENABLED). isCliEngineReady() gates on that flag AND the factory's
  // presence — so even with binary+subscription present, cli can't run until enabled.
  if (!isCliEngineReady()) return native('cli-unavailable');
  try {
    return { loop: HARNESSES.cli({ ...deps, claudeBin: bin, model: subRow.model_preference || undefined }), mode: 'cli' };
  } catch (e) {
    deps?.logger?.(`cli harness unavailable, using native: ${e?.message || e}`);
    return native('cli-unavailable');
  }
}
