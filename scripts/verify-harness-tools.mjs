// verify:harness-tools — the gated autonomy tools (src/tools/schedule-tasks.js) +
// the autonomy grant (src/agent/autonomy-tools.js), over a REAL booted vault with the
// REAL registry (buildDomains + collectTools). Spec §5.6/§11.
//   P1 schedule_task/list_my_schedules/cancel_task are REGISTERED but NEVER grantable to
//      chat (absent from toolsForDomains even with ALL domains) — the exclusion invariant
//   P2 autonomyTools: read-safe always; gated tool only when explicitly enabled
//   P3 invalid schedule DSL → error string, NO task written
//   P4 valid schedule_task → task persisted; prompt ENCRYPTED at rest; next_run future
//   P5 reply is NOT in the autonomy grant when absent from the registry (AGENT_URL unset)
//   P6 list_my_schedules never reveals the prompt; cancel_task → status cancelled
//   P7 'once' without scheduled_at → error
//
// MUTATION-TESTED: re-added 'listReflections' to SAFE_AUTONOMOUS_TOOLS while it remained in
//   CYCLE_AUTONOMOUS_TOOLS → 'P2 all FOUR autonomy tiers are pairwise disjoint' REDs, naming the
//   overlap. This is the shadowing case: autonomyTools() checks SAFE first, so the duplicate
//   would have been granted UNCONDITIONALLY — to every untrusted channel turn holding `reply` —
//   while the cycle tier's isCycle requirement looked intact. The pre-existing three-tier
//   disjointness row above stayed GREEN under that same mutation, which is why the check was
//   widened to four (D-076; found by independent review of that change).
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { buildDomains, collectTools } from '../src/mcp.js';
import { toolsForDomains, ALL_DOMAIN_KEYS } from '../src/agent/tool-domains.js';
import { autonomyTools, SAFE_AUTONOMOUS_TOOLS, AUTONOMY_TOOLS, WRITE_AUTONOMOUS_TOOLS, CYCLE_AUTONOMOUS_TOOLS } from '../src/agent/autonomy-tools.js';

const DB = 'data/verify-harness-tools.db', KCV = 'data/verify-harness-tools-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const rawRead = (sql, params = []) => { const d = new Database(DB, { readonly: true }); try { return d.prepare(sql).get(...params); } finally { d.close(); } };

// Build the REAL registry exactly as boot does (AGENT_URL unset ⇒ no reply tool).
delete process.env.AGENT_URL;
const { domains } = buildDomains({ db, userId: U });
const { tools, handlers } = collectTools(domains);
const has = (arr, n) => arr.some((t) => t.name === n);
const SCHED_TOOLS = ['schedule_task', 'list_my_schedules', 'cancel_task'];

// ── P1 registered but NOT grantable to chat ──
{
  const registered = SCHED_TOOLS.every((n) => typeof handlers[n] === 'function' && has(tools, n));
  rec('P1 schedule tools are registered (handlers + registry)', registered);
  const chatGrant = toolsForDomains(tools, ALL_DOMAIN_KEYS).tools; // chat with EVERY domain granted
  const leaked = SCHED_TOOLS.filter((n) => has(chatGrant, n));
  rec('P1 chat (all domains) can NEVER grant the schedule tools', leaked.length === 0, leaked.join(',') || 'none');
  rec('P1 reply also excluded from chat grant', !has(chatGrant, 'reply'));
}

// ── P2 autonomy grant: read-safe always; gated only when enabled ──
{
  const none = autonomyTools(tools, []);
  rec('P2 read-safe tools granted with no opt-in (getContext, searchMindscape)', has(none, 'getContext') && has(none, 'searchMindscape'));
  rec('P2 gated schedule_task NOT granted without opt-in', !has(none, 'schedule_task'));
  // D-063 turn-taking: schedule_task is SELF-ARMING (it creates the agent's next turn), so
  // the grant now also requires the turn to have been started by a human. Both polarities
  // are asserted — the capability still exists for owner DMs, and is gone for the scheduler.
  const opted = autonomyTools(tools, ['schedule_task'], { humanTriggered: true });
  rec('P2 schedule_task granted when explicitly enabled on a HUMAN-triggered turn', has(opted, 'schedule_task') && has(opted, 'getContext'));
  const autoOpted = autonomyTools(tools, ['schedule_task']);
  rec('P2 schedule_task STRIPPED on a turn no human started, even when named (D-063)',
    !has(autoOpted, 'schedule_task') && has(autoOpted, 'getContext'));
  // W3: vault-write tools are a gated set — granted ONLY when explicitly named (owner DMs).
  rec('P2 write tool (saveDocument) NOT granted without opt-in', !has(none, 'saveDocument'));
  rec('P2 write tool (saveDocument) granted when explicitly enabled (W3 owner grant)', has(autonomyTools(tools, ['saveDocument']), 'saveDocument'));
  // A tool in NONE of the sets (e.g. publishDocument — egress, deliberately excluded) is
  // never granted even if named: fail-closed still holds.
  rec('P2 a truly non-listed tool is never granted, even if named (fail-closed)', !has(autonomyTools(tools, ['publishDocument']), 'publishDocument'));
  rec('P2 sets are disjoint + cover the gated names', !SCHED_TOOLS.some((n) => SAFE_AUTONOMOUS_TOOLS.has(n)) && SCHED_TOOLS.every((n) => AUTONOMY_TOOLS.has(n))
    && ![...WRITE_AUTONOMOUS_TOOLS].some((n) => SAFE_AUTONOMOUS_TOOLS.has(n) || AUTONOMY_TOOLS.has(n)));
  // The tiers are checked in order inside autonomyTools(), so a name in TWO tiers silently
  // takes whichever is checked first — SAFE wins over everything, CYCLE wins over WRITE. That
  // is a shadowing bug in either direction (a CYCLE tool re-added to SAFE becomes
  // unconditional; a CYCLE tool also in WRITE loses its isCycle requirement's visibility).
  // Disjointness is the invariant that makes the ordering irrelevant, so assert it over ALL
  // FOUR tiers rather than three — the fourth was added by D-076 and was not covered.
  {
    const tiers = [['SAFE', SAFE_AUTONOMOUS_TOOLS], ['AUTONOMY', AUTONOMY_TOOLS], ['WRITE', WRITE_AUTONOMOUS_TOOLS], ['CYCLE', CYCLE_AUTONOMOUS_TOOLS]];
    const overlaps = [];
    for (let i = 0; i < tiers.length; i++) {
      for (let j = i + 1; j < tiers.length; j++) {
        for (const n of tiers[i][1]) if (tiers[j][1].has(n)) overlaps.push(`${n} in ${tiers[i][0]}+${tiers[j][0]}`);
      }
    }
    rec('P2 all FOUR autonomy tiers are pairwise disjoint (no shadowing)', overlaps.length === 0, overlaps.join(', ') || 'disjoint');
  }
}

// ── P3 invalid DSL → error, no write ──
{
  const before = (await db.harness.listTasks(U)).length;
  const out = await handlers.schedule_task({ prompt: 'do a thing', schedule: 'garbage-cadence' });
  const after = (await db.harness.listTasks(U)).length;
  rec('P3 invalid schedule → error string, no task created', /Error/i.test(out) && after === before, out.slice(0, 60));
}

// ── P4 valid schedule_task → persisted + encrypted ──
const SECRET = 'Summarise my unread mail and flag anything urgent — SENSITIVE-SCHED-7788';
{
  const out = await handlers.schedule_task({ prompt: SECRET, schedule: 'daily:8', name: 'Morning mail', tz: 'Europe/Lisbon', output_target: 'chat', enabled_tools: ['searchMindscape'] });
  rec('P4 schedule_task confirms with id + next run', /Scheduled/.test(out) && /next run/.test(out), out.slice(0, 80));
  const list = await db.harness.listTasks(U);
  const t = list.find((x) => x.name === 'Morning mail');
  rec('P4 task persisted with decrypted prompt + future next_run', t?.prompt === SECRET && t.next_run > new Date().toISOString() && Array.isArray(t.enabled_tools) && t.enabled_tools.includes('searchMindscape'));
  const raw = rawRead('SELECT prompt FROM scheduled_tasks WHERE id = ?', [t.id]);
  // SQLCipher collapse (Stage B/C cut 4): scheduled_tasks.prompt is plaintext-in-cipher
  // — at-rest = whole-file SQLCipher (verify:at-rest), not a per-field envelope.
  rec('P4 prompt PLAINTEXT-in-cipher at rest (collapse cut 4; verify:at-rest)', !!raw?.prompt && raw.prompt === SECRET, `raw=${String(raw?.prompt).slice(0, 24)}…`);
  globalThis.__taskId = t.id;
}

// ── P5 reply absent from autonomy grant when not in the registry ──
{
  rec('P5 reply not registered without AGENT_URL → cannot be granted even if opted-in', !has(tools, 'reply') && !has(autonomyTools(tools, ['reply']), 'reply'));
}

// ── P6 list never reveals the prompt; cancel works ──
{
  const listing = await handlers.list_my_schedules({});
  rec('P6 list_my_schedules shows the task WITHOUT its prompt', listing.includes('Morning mail') && !listing.includes('SENSITIVE-SCHED-7788'));
  const out = await handlers.cancel_task({ id: globalThis.__taskId });
  const t = await db.harness.getTask(U, globalThis.__taskId);
  rec('P6 cancel_task → status cancelled', /Cancelled/.test(out) && t.status === 'cancelled');
  rec('P6 cancel unknown id → error', /Error/i.test(await handlers.cancel_task({ id: 'nope-404' })));
}

// ── P7 'once' without scheduled_at ──
{
  const out = await handlers.schedule_task({ prompt: 'one-off', schedule: 'once' });
  rec("P7 'once' without scheduled_at → error", /Error/i.test(out) && /scheduled_at/.test(out), out.slice(0, 60));
}

await close?.();
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — autonomy tools: chat-exclusion invariant · opt-in autonomy grant · DSL validation · encrypted-at-rest · prompt-safe listing · cancel · once-guard' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
