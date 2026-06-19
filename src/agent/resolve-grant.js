// src/agent/resolve-grant.js — channel turn capability resolution (Phase 5, W3).
//
// Capability follows IDENTITY, not surface. A channel turn is one of two trust tiers:
//
//   • OWNER-TRUSTED — a 1:1 DM from the vault owner (senderRole==='owner' AND not a
//     group). This is owner-authored input, exactly as trusted as in-app chat, so the
//     turn gets the FULL assistant grant: read-safe (always) ∪ the gated egress/schedule
//     tools ∪ the vault-WRITE tools. The owner can ask their assistant to remember a fact
//     or save a document from their phone.
//
//   • UNTRUSTED — everyone else, and EVERY group context (even a message the owner sends
//     in a group, because other people are present and other messages are untrusted). The
//     turn keeps today's read-safe ∪ ['reply'] grant: it can read + reply, never write or
//     schedule. A prompt injection in untrusted content therefore can never write the vault.
//
// The grant is expressed as a list of opt-in tool NAMES handed to autonomyTools(), which
// stays the single fail-closed chokepoint: read-safe always; gated/write ONLY when named.
//
// SECURITY: this is the one seam that lets a channel turn write. It is gated on a daemon-
// computed senderRole forwarded over the trusted loopback (channel-turn.js is loopback-only,
// 403 otherwise). The owner binding is the daemon's ownerTelegramId check (inbound.js).

import { AUTONOMY_TOOLS, WRITE_AUTONOMOUS_TOOLS } from './autonomy-tools.js';

// Owner-trusted DM → the full assistant grant (gated egress/schedule + every write tool).
// read-safe tools come for free via autonomyTools(); only the opt-in names go here.
export const OWNER_CHANNEL_TOOLS = Object.freeze([...AUTONOMY_TOOLS, ...WRITE_AUTONOMOUS_TOOLS]);

// Untrusted (any non-owner sender, any group) → read-safe ∪ reply only. Fail-closed.
export const UNTRUSTED_CHANNEL_TOOLS = Object.freeze(['reply']);

/**
 * Is this channel turn owner-authored + private (⇒ trusted, full grant)?
 * @param {{senderRole?:string, group?:boolean}} ctx
 */
export function isOwnerTrustedTurn({ senderRole, group } = {}) {
  return senderRole === 'owner' && !group;
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
