// scripts/verify-streams-registry.mjs — the source-registry classifier gate.
//
// Pure unit test (no DB): every known ingest source maps to a stable kind, every
// per-platform variant collapses to its canonical key, #10's namespaced connector
// ids prefix-match, and ANY unknown source self-places to kind 'other' (never a
// crash, never a void). This is the contract the spectrum + river depend on.

import { classifySource, canonicalSource, sourceForDocumentType, STREAM_KINDS } from '../src/streams/source-registry.js';

const ledger = [];
const rec = (name, pass, detail = '') => { ledger.push(pass); console.log(`${pass ? '[✓]' : '[✗]'} ${name}${detail ? ` — ${detail}` : ''}`); };
const kind = (s) => classifySource(s).kind;
const canon = (s) => classifySource(s).canonical;

console.log('\n=== verify:streams-registry — source classifier ===\n');

// Known sources → expected kind.
const KNOWN = {
  telegram: 'messaging', whatsapp: 'messaging', discord: 'messaging',
  gmail: 'connector', linear: 'connector',
  obsidian: 'knowledge', 'claude-import': 'knowledge', 'chatgpt-import': 'knowledge', import: 'knowledge',
  'claude-code': 'agent', gateway: 'agent', opencode: 'agent', openclaw: 'agent', hermes: 'agent', bridge: 'agent', mcp: 'agent',
  apple: 'device', apple_health: 'device',
  portal: 'portal', api: 'portal',
  task: 'task',
};
let allKnown = true;
for (const [src, want] of Object.entries(KNOWN)) {
  const got = kind(src);
  if (got !== want) { allKnown = false; rec(`${src} → ${want}`, false, `got ${got}`); }
}
rec('every known source maps to its kind', allKnown, `${Object.keys(KNOWN).length} sources`);

// Every kind a source maps to must be in the published STREAM_KINDS set.
const kindsValid = Object.keys(KNOWN).every((s) => STREAM_KINDS.includes(kind(s)));
rec('all kinds are in STREAM_KINDS', kindsValid);

// Variant collapse: telegram-group → telegram, discord-thread → discord,
// inference:chat → portal. The variant must classify to the canonical key.
rec('telegram-group collapses to telegram', canon('telegram-group') === 'telegram' && kind('telegram-group') === 'messaging');
rec('discord-thread collapses to discord', canon('discord-thread') === 'discord' && kind('discord-thread') === 'messaging');
rec('inference:chat collapses to portal', canon('inference:chat') === 'portal' && kind('inference:chat') === 'portal');

// Per-conversation id suffixes fold to the platform (telegram_123 → telegram).
rec('telegram_<chatId> folds to telegram', canon('telegram_123456') === 'telegram' && kind('telegram_123456') === 'messaging');
rec('telegram-group_<id> folds to telegram', canon('telegram-group_99') === 'telegram');
rec('discord_<channelId> folds to discord', canon('discord_42') === 'discord' && kind('discord_42') === 'messaging');
rec('suffixed non-platform NOT folded (claude-import untouched)', canon('claude-import') === 'claude-import');

// #10 namespaced connector ids prefix-match to 'connector'.
rec('http-poll:<uuid> → connector', kind('http-poll:abc-123') === 'connector');
rec('webhook:<uuid> → connector', kind('webhook:xyz') === 'connector');

// Real live tags seen against actual vaults must land in the right kind/chip.
rec("apple-health → device (folds to apple_health)", canon('apple-health') === 'apple_health' && kind('apple-health') === 'device');
rec("portal-chat → portal", canon('portal-chat') === 'portal' && kind('portal-chat') === 'portal');
rec("upload → knowledge", kind('upload') === 'knowledge');
rec("claude-code/subagent → agent (folds to claude-code)", canon('claude-code/subagent') === 'claude-code' && kind('claude-code/subagent') === 'agent');
rec("agent-* tags → agent (own chip, Agents group)", kind('agent-file') === 'agent' && kind('agent-output') === 'agent' && kind('agent-delegation') === 'agent' && canon('agent-file') === 'agent-file');

// Unknown self-places to 'other' (no crash, no void) and keeps its raw key.
rec("unknown 'frobnicator' → other", kind('frobnicator') === 'other' && canon('frobnicator') === 'frobnicator');
rec('null/empty source → other (kind), no throw', kind(null) === 'other' && kind('') === 'other');

// Document source_type folding.
rec("doc source_type 'obsidian' → obsidian", sourceForDocumentType('obsidian') === 'obsidian');
rec("doc source_type 'agent' → claude-code", sourceForDocumentType('agent') === 'claude-code');
rec("doc source_type 'portal' → portal", sourceForDocumentType('portal') === 'portal');

const pass = ledger.filter(Boolean).length;
console.log(`\n${pass}/${ledger.length} checks passed`);
console.log(ledger.every(Boolean) ? 'VERDICT: GO' : 'VERDICT: NO-GO');
process.exit(ledger.every(Boolean) ? 0 : 1);
