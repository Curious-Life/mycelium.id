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
// SECURITY (red-team 2026-06-19, before enabling MYCELIUM_CHANNEL_OWNER_WRITE):
//   • The grant rests on a daemon-computed senderRole forwarded over loopback. Until the
//     daemon↔server call is authenticated (per-boot shared secret), ANY local process can
//     POST senderRole='owner' to the loopback endpoint → so the owner-write capability is
//     GATED OFF BY DEFAULT (this flag). With it off, a forged owner claim grants only
//     read+reply, exactly as before W3 — the CRITICAL finding is dormant by default.
//   • Destructive mind-model rewriters (editMindFile / writeMindFileWhole /
//     updateInternalModel) are EXCLUDED from the channel set even when enabled — they
//     belong to the deliberate consolidation cycle, not a phone DM, and are the deepest,
//     hardest-to-recover surfaces. The remaining writes are additive or document-scoped.
//
// The grant is a list of opt-in tool NAMES handed to autonomyTools(), which stays the
// single fail-closed chokepoint: read-safe always; gated/write ONLY when named.

// Owner-write is OFF until the daemon↔server auth + write-audit + recoverability land
// (red-team prerequisites). Set MYCELIUM_CHANNEL_OWNER_WRITE=1 only after those ship.
export function ownerWriteEnabled() {
  return process.env.MYCELIUM_CHANNEL_OWNER_WRITE === '1';
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
 * Fail-closed: requires senderRole==='owner', a 1:1 (non-group) context, AND the
 * owner-write capability flag. Any one missing ⇒ untrusted.
 * @param {{senderRole?:string, group?:boolean}} ctx
 */
export function isOwnerTrustedTurn({ senderRole, group } = {}) {
  return senderRole === 'owner' && !group && ownerWriteEnabled();
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
