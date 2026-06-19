// src/agent/resolve-grant.js — channel turn capability resolution (Phase 5, W3).
//
// Capability follows IDENTITY, not surface. A channel turn is one of two trust tiers:
//
//   • OWNER-TRUSTED — a 1:1 DM from the vault owner (senderRole==='owner' AND not a
//     group). This is owner-authored input, exactly as trusted as in-app chat. When the
//     owner-write capability is ENABLED (see the flag below), this turn gets read-safe ∪
//     the gated egress/schedule tools ∪ a TRIMMED vault-write set, and the message is not
//     untrusted-wrapped — the owner can ask their assistant to remember a fact or save a
//     note from their phone.
//
//   • UNTRUSTED — everyone else, EVERY group context (even a message the owner sends in a
//     group, because other people + other messages are present), AND every turn when the
//     owner-write capability is disabled. read-safe ∪ ['reply'], untrusted-wrapped. A
//     prompt injection therefore can never write the vault.
//
// SECURITY (red-team 2026-06-19; owner-write now ON by default for the personal agent):
//   • The owner-write escalation does NOT rest on the flag — it rests on the per-boot
//     daemon↔server shared secret (CHANNEL_TURN_TOKEN, channel-turn.js). A forged loopback
//     POST with senderRole='owner' has no token → it can NEVER write, regardless of this
//     setting. The token gate (not the flag) is the anti-forgery protection. All red-team
//     prerequisites shipped: per-boot token (RT1), write-audit (RT2-H2), overwrite
//     recoverability (RT2-H1) — so default-on is safe.
//   • Destructive mind-model rewriters (editMindFile / writeMindFileWhole /
//     updateInternalModel), forget, and publish are EXCLUDED from the channel set even when
//     enabled — they belong to the deliberate consolidation cycle, not a phone DM, and are
//     the deepest, hardest-to-recover surfaces. The remaining writes are additive or
//     document-scoped (and any overwrite is recoverable via document/fact/entity versions).
//
// The grant is a list of opt-in tool NAMES handed to autonomyTools(), which stays the
// single fail-closed chokepoint: read-safe always; gated/write ONLY when named.

/**
 * Is the owner-write capability enabled for this turn?
 *
 * Default ON for the personal agent. Resolution order:
 *   • env MYCELIUM_CHANNEL_OWNER_WRITE='0' → operator KILL-SWITCH (force off)
 *   • env MYCELIUM_CHANNEL_OWNER_WRITE='1' → operator FORCE-ON (back-compat)
 *   • otherwise → the per-agent stored setting (users.settings.agent.channelWrite);
 *     undefined ⇒ ON (default), false ⇒ off (the user disabled it in the Agents page).
 *
 * @param {boolean|undefined} storedSetting  users.settings.agent.channelWrite
 */
export function ownerWriteEnabled(storedSetting) {
  const env = process.env.MYCELIUM_CHANNEL_OWNER_WRITE;
  if (env === '0') return false;        // operator kill-switch
  if (env === '1') return true;         // operator force-on
  return storedSetting !== false;       // default ON unless the user disabled it
}

// Owner-trusted DM gated egress/schedule tools (NOT describeEntity — narration is the
// cycle's job, not a DM's).
const OWNER_GATED_TOOLS = ['reply', 'schedule_task', 'list_my_schedules', 'cancel_task'];
// Owner-trusted DM write tools — TRIMMED: additive + document-scoped only. No mind-model
// rewriters (editMindFile/writeMindFileWhole/updateInternalModel), no forget, no publish.
const OWNER_WRITE_TOOLS = ['remember', 'link', 'mark', 'saveDocument', 'updateDocument', 'captureMessage', 'createTask', 'flagForDiscussion'];

// Full owner-trusted grant (names handed to autonomyTools as enabledNames).
export const OWNER_CHANNEL_TOOLS = Object.freeze([...OWNER_GATED_TOOLS, ...OWNER_WRITE_TOOLS]);
// Untrusted (any non-owner sender, any group, or owner-write disabled) → reply only.
export const UNTRUSTED_CHANNEL_TOOLS = Object.freeze(['reply']);

/**
 * Is this channel turn owner-authored + private + write-enabled (⇒ trusted, full grant)?
 * Fail-closed: requires senderRole==='owner', a 1:1 (non-group) context, AND the owner-write
 * capability (default ON for the personal agent; see ownerWriteEnabled). Any one missing ⇒
 * untrusted. NOTE: the caller MUST still AND this with a valid daemon token (channel-turn.js)
 * — this function answers "should the owner be trusted", the token answers "is it really the
 * owner's daemon"; both are required for a write.
 * @param {{senderRole?:string, group?:boolean, channelWrite?:boolean}} ctx
 */
export function isOwnerTrustedTurn({ senderRole, group, channelWrite } = {}) {
  return senderRole === 'owner' && !group && ownerWriteEnabled(channelWrite);
}

/**
 * Resolve the opt-in tool names a channel turn may use, by sender trust.
 * @param {{senderRole?:string, group?:boolean}} ctx
 * @returns {string[]}  names handed to autonomyTools() as enabledNames
 */
export function channelEnabledTools(ctx = {}) {
  return isOwnerTrustedTurn(ctx) ? [...OWNER_CHANNEL_TOOLS] : [...UNTRUSTED_CHANNEL_TOOLS];
}

export default channelEnabledTools;
