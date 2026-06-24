// src/agent/triage.js — the channel reply/skip gate (Phase 5, Step 6e). Spec §6.
//
// A full agent turn per group message is wasteful (and noisy). Triage decides — cheaply,
// BEFORE the turn — whether a message warrants a reply. Today the daemon has no such gate
// (it replies to every authorized message), so this is net-new.
//
// Heuristic-first (zero cost): a DM always gets a turn; a group message only when it is
// addressed — the daemon passes an `addressed` hint (mention / reply-to-bot), with a
// name-mention fallback here in case it didn't. An optional model-classification path
// (flag-gated, OFF by default) handles ambiguous group messages by asking a cheap,
// tools-off model "does this need a reply?". Fail-safe: any model error → the heuristic
// (skip), so a triage failure never spams a channel.

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Pure heuristic decision. */
export function triageHeuristic({ text = '', group = false, addressed = false, agentName = '' } = {}) {
  if (!group) return { reply: true, reason: 'dm' };
  if (addressed) return { reply: true, reason: 'addressed' };
  if (agentName && new RegExp(`(^|[^\\w])${escapeRe(agentName)}([^\\w]|$)`, 'i').test(text)) {
    return { reply: true, reason: 'name-mention' };
  }
  return { reply: false, reason: 'group-not-addressed' };
}

/**
 * Build a triage function `({text,source,group,addressed}) => Promise<{reply,reason}>`.
 * @param {object} [o]
 * @param {string}   [o.agentName]         the assistant's name (for the mention fallback)
 * @param {(text:string)=>Promise<boolean>} [o.modelClassify]  cheap yes/no classifier
 * @param {boolean}  [o.groupModelTriage]  enable model triage for ambiguous group msgs (default off)
 */
export function createTriage({ agentName = 'Mycelium', modelClassify = null, groupModelTriage = false } = {}) {
  return async ({ text = '', group = false, addressed = false } = {}) => {
    const h = triageHeuristic({ text, group, addressed, agentName });
    // Heuristic already decided to reply, or it's a DM, or model triage is off → done.
    if (h.reply || !group || !groupModelTriage || typeof modelClassify !== 'function') return h;
    // Ambiguous group message + model triage enabled → ask the model (fail to skip).
    try {
      const yes = await modelClassify(text);
      return yes ? { reply: true, reason: 'model-yes' } : { reply: false, reason: 'model-no' };
    } catch { return h; }
  };
}

export default createTriage;
