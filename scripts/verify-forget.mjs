// verify:forget — Context Bank Phase 1 + D-040 ↻1 REACHABILITY. Boots the real MCP server
// and drives the forget + mark tools on a LOCAL vault.
//
// F1-F13  soft-redact correctness: content + both embedding fingerprints nulled, clustering
//         point deleted, in-RAM index evicted, row tombstoned (no hard delete), audited
//         WITHOUT plaintext, idempotent; mark sets salience and getContext surfaces pinned.
//
// G1-G4   D-040 ↻1 — "the agent tried to forget data and it didn't disappear". Three causes,
//         none of them the cascade (per the forget-reachability design):
//   G1  REACHABILITY — `forget` was in NO channel grant set, so the agent had no such tool
//       on the path the operator used. Driven through the REAL resolver over the REAL
//       registry (never a string-match on a list), including the negative that matters most:
//       a fired scheduled task naming `forget` in enabled_tools still cannot get it.
//   G2  ADDRESSABILITY — no read surface rendered an id `forget` accepts. DERIVED, not a
//       hand-maintained list (meta-defect M-002): every read tool in the live registry is
//       driven, and ANY output that echoes a seeded needle must also carry an id that the
//       REAL resolver resolves back to that row. A new read surface is covered the moment it
//       echoes an item. A coverage floor keeps it from passing vacuously when a surface
//       returns nothing.
//         What a green does NOT claim: a read tool that needs args this gate does not supply
//         is never exercised, so it is neither passed nor failed — only the floor is guaranteed.
//   G3  HONESTY — a miss returned "Nothing to forget: no message with id X", threw nothing,
//       and audited nothing, so the agent truthfully reported success over live data.
//   G4  END-TO-END — read → take the rendered ref → forget → gone from the surfaces the
//       shipped cascade covers.
//
// MUTATION-TESTED: `forget` removed from resolve-grant.js OWNER_DESTRUCTIVE (the state the
//   defect was reported in) → G1a REDs, G1b-G1g stay green
// MUTATION-TESTED: `forget` moved OUT of the destructive tier into WRITE_AUTONOMOUS_TOOLS —
//   the tempting one-line "fix" → G1b + G1d + G1e RED: the scheduled-task escalation and the
//   forged-token path both open up, which is exactly what the separate tier prevents
// MUTATION-TESTED: `ownerTrusted` dropped from run-turn's autonomyTools call, leaving
//   `humanTriggered` (sets correct, half the wiring broken) → G1g + G1h RED
// MUTATION-TESTED: `humanTriggered` dropped from that same call, leaving `ownerTrusted` →
//   G1g + G1h RED **and verify:agent-turn-taking S3b REDs too**. That cross-red is the point:
//   the two grant-time filters (#381's turn-taking and this destructive tier) share one
//   options object, and each is independently gated, so neither can be silently voided by a
//   future edit to the other. Run during the #381 rebase reconciliation.
// MUTATION-TESTED: `&& humanTriggered === true` removed from the destructive-tier condition
//   (i.e. `forget` gated on ownerTrusted alone, the pre-rebase behaviour) → G1c2 + G1e + G1g
//   RED. Kept as a conjunction deliberately: humanTriggered is BROADER than ownerTrusted
//   (channel-turn sets it true for a stranger's DM and for groups), so where the two filters
//   disagree the stricter one must win.
// MUTATION-TESTED: the id re-dropped from formatMessage (src/search/index.js — the original
//   defect, verbatim) → G2a REDs
// MUTATION-TESTED: the ref dropped from getDailyMessages → G2a + G4a RED
// MUTATION-TESTED: renderRef made to emit the FULL id instead of the prefix → G2c REDs
//   (G2a stays green — a full id IS forget-compatible; only the token-budget claim breaks)
// MUTATION-TESTED: the success-shaped miss restored (`return "Nothing to forget: …"`, i.e.
//   forgetFailed replaced by the old sentence) → G3a REDs (G3c/G3e RED as a consequence)
// MUTATION-TESTED: ambiguity resolved to the first match instead of failing closed → G3c REDs
// MUTATION-TESTED: the forget-miss audit call removed from the resolve path → G3b + G3d RED
// MUTATION-TESTED: `candidates` dropped from the ambiguous resolve result (so the advice
//   "pass the full id" has no full id to pass — a dead end) → the second G3c REDs
// MUTATION-TESTED: SAFE_ID's LENGTH minimum lowered back to 6 chars (re-opening the prefix
//   enumeration oracle) → G3f REDs (the 6-char probe starts resolving)
// MUTATION-TESTED: SAFE_ID's CHARSET half removed, keeping only the length bound → G3e REDs.
//   This one is the reason G3e's probes look the way they do: an earlier G3e used '%' and a
//   string that matched nothing, and it stayed GREEN under this mutation while
//   forget({id:'%%%%%%%%%%%%'}) destroyed a row (independent review, 2026-07-26). A blanket
//   wildcard matches EVERY row and so fails closed on ambiguity — only a pattern that
//   uniquely targets one row (the seeded `deadc0de1234f00d` / `deadc0de1_34`) can catch it.
// MUTATION-TESTED: renderRef made to truncate UNCONDITIONALLY (the pre-review behaviour) →
//   G2a REDs on the non-hex `obsidian:…` message id, which is un-prefix-resolvable and so
//   reproduced D-040 exactly, on the ref shipped to fix it
// MUTATION-TESTED: getDailyMessages made to stamp EVERY row with the first row's ref → G2a
//   REDs. The earlier G2a did `output.includes(renderRef(type,id))` — a substring search over
//   the whole blob — and stayed GREEN under this, i.e. "forget that one" would destroy the
//   wrong row with the gate green. G2a now extracts the ref that owns the needle's row and
//   requires the REAL resolver to return that exact id.
// MUTATION-TESTED: `|| OWNER_DESTRUCTIVE_TOOLS.has(toolName)` removed from run-turn's onWrite
//   ledger → G1h REDs (nothing in the suite exercised onWrite at all before this check)
// MUTATION-TESTED: the scope predicate dropped from resolveItemRef → G3h REDs (a
//   `wealth`-scoped row becomes resolvable, and destroyable, by an agent bound to `personal`)
// MUTATION-TESTED: auditForgetMiss reverted to testing the RAW argument instead of
//   parseRef(raw).id → G3g REDs (the bracketed form the schema asks for audits as 'invalid')
// MUTATION-TESTED: a second surface added to the REFLESS exemption set → the second G2a REDs
// MUTATION-TESTED: refs re-added to the getContext preamble → G2d REDs
// MUTATION-TESTED: `forget` added to #389's CYCLE_AUTONOMOUS_TOOLS as well (tiers no longer
//   disjoint) → G1f + G1i + G1a RED. The cycle branch is evaluated first, so the overlap
//   simultaneously HANDS `forget` to every reflection cycle and TAKES it from the owner DM —
//   the exact failure mode of stacking narrowing flags on overlapping sets. Run during the
//   #389 rebase reconciliation.
// All restored afterwards; the suite returns GREEN on the restored tree.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { diffTools, toolDiffDetail, EXPECTED_TOOL_COUNT } from './lib/expected-tools.mjs';
import { autonomyTools, OWNER_DESTRUCTIVE_TOOLS, SAFE_AUTONOMOUS_TOOLS, AUTONOMY_TOOLS, WRITE_AUTONOMOUS_TOOLS, CYCLE_AUTONOMOUS_TOOLS } from '../src/agent/autonomy-tools.js';
import { channelEnabledTools } from '../src/agent/resolve-grant.js';
import { runAgentTurn } from '../src/agent/run-turn.js';
import { CYCLES } from '../src/agent/cycle-prompts.js';
import { renderRef, resolveItemRef } from '../src/core/item-ref.js';

const DB = 'data/verify-forget.db', KCV = 'data/verify-forget-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close, tools, handlers, searchHelpers } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';
const SECRET = 'secret thought to forget xyzzy';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const one = async (sql, params) => (await db.rawQuery(sql, params)).results?.[0] || {};

const names = tools.map((t) => t.name);
rec(`F1. forget + mark registered; full roster intact (${EXPECTED_TOOL_COUNT} tools)`, names.includes('forget') && names.includes('mark') && diffTools(tools).ok, toolDiffDetail(tools));

// Seed a message + fingerprints + clustering point, and index it (BM25, no embedder).
const id = 'm-forget';
await db.messages.insert([{ id, user_id: U, role: 'user', content: SECRET, scope: 'personal', created_at: '2026-06-02T10:00:00.000Z' }]);
await db.rawQuery(`UPDATE messages SET embedding_768 = ? WHERE id = ? AND user_id = ?`, ['ENVELOPE', id, U]);
await db.rawQuery(`INSERT INTO clustering_points (id, user_id, source_type, source_id, content) VALUES (?,?,?,?,?)`, ['cp', U, 'message', id, 'x']);
await searchHelpers.backend.add({ id, text: SECRET, ts: 1 });
const hitBefore = (await searchHelpers.backend.query({ text: 'xyzzy', topK: 5 })).hits.some((h) => h.id === id);
rec('F2. message searchable before forget', hitBefore, `found via 'xyzzy'`);

const out = await handlers.forget({ type: 'message', id });
rec('F3. forget tool reports success', /Forgotten: message/.test(out), out);

const raw = await one(`SELECT content, embedding_768, forgotten_at FROM messages WHERE id = ? AND user_id = ?`, [id, U]);
rec('F4. content + embedding nulled, forgotten_at stamped', raw.content == null && raw.embedding_768 == null && !!raw.forgotten_at, `content=${raw.content} emb=${raw.embedding_768} forgotten=${!!raw.forgotten_at}`);

const exists = (await one(`SELECT COUNT(*) AS c FROM messages WHERE id = ?`, [id])).c;
rec('F5. row still exists (soft-redact, no hard delete)', exists === 1, `rows=${exists}`);

const cp = (await one(`SELECT COUNT(*) AS c FROM clustering_points WHERE source_id = ?`, [id])).c;
rec('F6. clustering point deleted', cp === 0, `count=${cp}`);

const hitAfter = (await searchHelpers.backend.query({ text: 'xyzzy', topK: 5 })).hits.some((h) => h.id === id);
rec('F7. evicted from in-RAM search index', !hitAfter, `searchable after = ${hitAfter}`);

const recent = await db.messages.selectRecent(U, { scope: 'personal', limit: 10 });
rec('F8. excluded from selectRecent', !recent.some((m) => m.id === id), `ids=${recent.map((m) => m.id).join(',') || '(none)'}`);

let events = [];
let auditErr = '';
try { events = await db.audit.recent({ eventType: 'forget' }); } catch (e) { auditErr = e.message; }
const ev = events.find((e) => e.method === id);
const det = ev?.details || '';
const auditOk = !!ev && /[0-9a-f]{64}/.test(det) && !det.includes('secret thought') && ev.event_type === 'forget' && ev.endpoint === 'message';
rec('F9. audit row written with hash, NO plaintext', auditOk, auditErr ? `audit.recent threw: ${auditErr}` : `details=${det}`);

const out2 = await handlers.forget({ type: 'message', id });
rec('F10. re-forget is idempotent (already forgotten)', /Already forgotten/.test(out2), out2);

const id2 = 'm-keep';
await db.messages.insert([{ id: id2, user_id: U, role: 'user', content: 'important note', scope: 'personal', created_at: '2026-06-02T11:00:00.000Z' }]);
const m = await handlers.mark({ type: 'message', id: id2, pinned: true });
rec('F11. mark pins a message', /pinned/.test(m), m);

const ctx = await handlers.getContext({});
rec('F12. getContext surfaces pinned with 📌 marker', ctx.includes('📌') && ctx.includes('important note'), `has marker=${ctx.includes('📌')}`);

let failClosed = false;
try { await handlers.forget({ type: 'bogus', id: 'x' }); } catch { failClosed = true; }
rec('F13. unknown ref type fails closed', failClosed, failClosed ? 'threw' : 'did NOT throw');

// ══════════════════════════════════════════════════════════════════════════════
// G1 — REACHABILITY: is `forget` on the turn where the owner can ask for it?
// Driven through the REAL grant resolver over the REAL registry.
// ══════════════════════════════════════════════════════════════════════════════
{
  const grant = (ctx, opts) => autonomyTools(tools, channelEnabledTools(ctx), opts).map((t) => t.name);
  const OWNER_DM = { senderRole: 'owner', group: false };
  // The REAL shape a live owner channel turn produces after #381 (D-063 turn-taking): the
  // channel router sets humanTriggered:true for every inbound message, and ownerTrusted only
  // when the daemon token verifies. Both flags now reach the same chokepoint.
  const LIVE_OWNER = { ownerTrusted: true, humanTriggered: true };

  // (a) the path the operator actually used: owner 1:1 DM, token-proved, human-started.
  rec('G1a. owner 1:1 DM (token-proved, human-triggered) GRANTS forget', grant(OWNER_DM, LIVE_OWNER).includes('forget'));

  // (b) the same DM WITHOUT the per-boot daemon token (forged loopback POST) gets nothing.
  rec('G1b. owner DM without a valid daemon token does NOT grant forget',
    !grant(OWNER_DM, { ownerTrusted: false, humanTriggered: true }).includes('forget'));

  // (c) every untrusted shape: a group (even from the owner), and any non-owner sender.
  // Both are humanTriggered:true in production (an inbound message IS a human's) — which is
  // exactly why `forget` must NOT lean on that flag alone.
  const groupOwner = grant({ senderRole: 'owner', group: true }, LIVE_OWNER);
  const stranger = grant({ senderRole: 'other', group: false }, LIVE_OWNER);
  rec('G1c. group + non-owner turns NEVER grant forget (even with both flags set)',
    !groupOwner.includes('forget') && !stranger.includes('forget'), `group=[${groupOwner}] stranger=[${stranger}]`);

  // (c2) COMPOSITION WITH D-063 (#381), the reconciliation this rebase had to make by hand.
  // `humanTriggered` and `ownerTrusted` are enforced in the SAME function and answer different
  // questions. Assert they compose rather than one voiding the other, and that the destructive
  // tier takes the STRICTER conjunction — an owner-proved turn that no human started must not
  // destroy data, even though nothing passes that combination today.
  const ownerNotHuman = grant(OWNER_DM, { ownerTrusted: true, humanTriggered: false });
  rec('G1c2. ownerTrusted WITHOUT humanTriggered does NOT grant forget (stricter wins)',
    !ownerNotHuman.includes('forget'), `granted=[${ownerNotHuman}]`);
  // …and #381's own rule is not voided by this tier: schedule_task is still stripped when the
  // turn is not human-triggered, and still granted when it is.
  const selfArmDenied = grant(OWNER_DM, { ownerTrusted: true, humanTriggered: false });
  const selfArmOk = grant(OWNER_DM, LIVE_OWNER);
  rec('G1c2. D-063 self-arming strip still holds through the destructive tier',
    !selfArmDenied.includes('schedule_task') && selfArmOk.includes('schedule_task'),
    `noHuman=[${selfArmDenied.includes('schedule_task')}] human=[${selfArmOk.includes('schedule_task')}]`);

  // (d) THE escalation this design exists to prevent: schedule_task takes an ARBITRARY
  // enabled_tools array (src/tools/schedule-tasks.js:73-77) and the scheduler hands it
  // straight to autonomyTools with no ownerTrusted (src/agent/scheduler.js:130). A fired
  // task — no human present — must not be able to destroy data by naming the tool.
  const schedulerGrant = autonomyTools(tools, ['forget', 'searchMindscape'], {}).map((t) => t.name);
  const schedulerDefault = autonomyTools(tools, ['forget']).map((t) => t.name);   // exactly the scheduler's call shape
  rec('G1d. a scheduled task naming forget in enabled_tools NEVER gets it',
    !schedulerGrant.includes('forget') && !schedulerDefault.includes('forget'), `granted=[${schedulerDefault}]`);

  // (e) fail-closed on a non-boolean: a JSON-parsed "true" must not widen the grant — on
  // EITHER flag, since both are now required.
  const truthy = autonomyTools(tools, ['forget'], { ownerTrusted: 'true', humanTriggered: true }).map((t) => t.name);
  const truthyHuman = autonomyTools(tools, ['forget'], { ownerTrusted: true, humanTriggered: 1 }).map((t) => t.name);
  rec('G1e. a truthy-but-not-true flag does not widen the grant (either flag)',
    !truthy.includes('forget') && !truthyHuman.includes('forget'), `ownerTrusted='true'→${truthy.includes('forget')} humanTriggered=1→${truthyHuman.includes('forget')}`);

  // (f) the destructive tier is disjoint from EVERY other tier — no accidental second door.
  // Four tiers now share this chokepoint (read-safe · gated · write · cycle · destructive),
  // each with its own unlock flag, so an overlap would mean one flag silently granting
  // another tier's power. Derived from the live sets, so a future tier is covered too.
  const otherTiers = [SAFE_AUTONOMOUS_TOOLS, AUTONOMY_TOOLS, WRITE_AUTONOMOUS_TOOLS, CYCLE_AUTONOMOUS_TOOLS];
  const overlap = [...OWNER_DESTRUCTIVE_TOOLS].filter((n) => otherTiers.some((s) => s.has(n)));
  rec('G1f. the destructive tier is disjoint from every other tier (incl. #389 cycle tier)',
    overlap.length === 0, overlap.length ? `also in another tier: ${overlap.join(',')}` : 'no overlap');

  // (g) the WIRING, not just the sets: drive the REAL runAgentTurn with a fake loop and read
  // back the tool defs it actually handed the model. Checks (a)-(f) would all stay green if
  // run-turn simply never forwarded `ownerTrusted` — this is the check that catches that.
  const pid = await db.providers.create(U, { provider: 'anthropic', label: 'Anthropic', authType: 'api_key', credentials: JSON.stringify({ apiKey: 'sk-test' }), model: 'claude-x' });
  await db.providers.setActive(pid, U);
  const drive = async (opts, invoke = null) => {
    let captured = null;
    const fakeLoop = { run: async (o) => { captured = o; if (invoke) await invoke(o); return { text: 'x', toolsUsed: [] }; } };
    await runAgentTurn(
      { db, userId: U, tools, handlers, loop: fakeLoop, fetchImpl: async () => { throw new Error('no-net'); } },
      { userMessage: 'forget that', systemExtra: 'X', ...opts },
    );
    return (captured?.tools || []).map((t) => t.name);
  };
  const ownerNames = await drive({ enabledTools: channelEnabledTools(OWNER_DM), ...LIVE_OWNER });
  const plainNames = await drive({ enabledTools: channelEnabledTools(OWNER_DM) });
  // run-turn must forward BOTH flags into the same options object. Dropping either one from
  // that call site leaves every set-level check above green, so this is where it is caught.
  const noHumanNames = await drive({ enabledTools: channelEnabledTools(OWNER_DM), ownerTrusted: true });
  const noOwnerNames = await drive({ enabledTools: channelEnabledTools(OWNER_DM), humanTriggered: true });
  rec('G1g. runAgentTurn FORWARDS both ownerTrusted and humanTriggered into the grant',
    ownerNames.includes('forget') && !plainNames.includes('forget')
      && !noHumanNames.includes('forget') && !noOwnerNames.includes('forget'),
    `both→${ownerNames.includes('forget')} · none→${plainNames.includes('forget')} · ownerOnly→${noHumanNames.includes('forget')} · humanOnly→${noOwnerNames.includes('forget')}`);

  // (h) widening capability must widen the AUDIT with it (CLAUDE.md §8). run-turn's onWrite
  // ledger was gated on WRITE_AUTONOMOUS_TOOLS only, so a channel `forget` would have been
  // the one vault mutation with no write-ledger row. Drive the real `call` dispatcher and
  // watch the sink — nothing else in the suite exercises onWrite at all (review, 2026-07-26).
  const wrote = [];
  await drive(
    { enabledTools: channelEnabledTools(OWNER_DM), ...LIVE_OWNER, onWrite: (r) => { wrote.push(r.tool); } },
    async (o) => { await o.call('forget', { type: 'message', id: 'no-such-id-here' }); await o.call('getContext', {}); },
  );
  rec('G1h. a channel forget rides the harness write ledger; a read does not',
    wrote.includes('forget') && !wrote.includes('getContext'), `onWrite saw: [${wrote.join(',')}]`);

  // (i) THE NEGATIVE DIRECTION, through the REAL runAgentTurn rather than the set logic:
  // every no-human-present surface, driven with ITS OWN call shape as it appears in the
  // source, with `forget` injected where an attacker would put it. This is the check that
  // has to keep holding as #381's turn-taking and this destructive tier evolve together —
  // both mechanisms independently refuse here, and the gate says so per-surface.
  const deniedSurfaces = [
    // src/agent/scheduler.js:136 — enabled_tools is caller data (schedule_task takes an
    // ARBITRARY array, src/tools/schedule-tasks.js:73-77), so this is the injected case.
    ['fired scheduled task', { enabledTools: ['forget', 'searchMindscape'], inferenceTask: 'harness' }],
    // A reflection cycle's real grant (src/agent/cycle-prompts.js) + forget — driven with
    // `isCycle: true`, the REAL shape since #389 (D-076) gave cycles their own tool tier
    // (cycleTurnOpts → scheduler.js:111). A cycle now unlocks a tier of its own, so this
    // asserts that unlocking it does NOT drag the destructive tier along: the two flags gate
    // disjoint sets and neither relaxes the other.
    ['reflection cycle (isCycle:true)', { enabledTools: [...CYCLES[0].enabledTools, 'forget'], isCycle: true, inferenceTask: 'reflection' }],
    // …and the mirror: a cycle that ALSO claims to be human-triggered still cannot forget,
    // because ownerTrusted is the flag it can never have.
    ['cycle claiming humanTriggered', { enabledTools: ['forget'], isCycle: true, humanTriggered: true, inferenceTask: 'reflection' }],
    // src/agent/narration-walk.js:127 — verbatim, plus forget.
    ['narration walk', { enabledTools: ['describeEntity', 'getEntityContext', 'forget'], localTools: true, inferenceTask: 'narrate' }],
  ];
  const leaked = [];
  for (const [label, opts] of deniedSurfaces) {
    if ((await drive(opts)).includes('forget')) leaked.push(label);
  }
  rec('G1i. no-human-present surfaces (scheduled task · reflection cycle · narration walk) NEVER get forget',
    leaked.length === 0, leaked.length ? `LEAKED to: ${leaked.join(', ')}` : `${deniedSurfaces.length}/${deniedSurfaces.length} refused through the real runAgentTurn`);
}

// ══════════════════════════════════════════════════════════════════════════════
// G2 — ADDRESSABILITY (derived): every read surface that shows an item must show an
// id that resolves BACK to that item. Not an expected-string match, and not a
// hand-maintained list of files.
// ══════════════════════════════════════════════════════════════════════════════
const today = new Date().toISOString().slice(0, 10);
const seeded = [];
const byType = (t) => seeded.find((s) => s.type === t);
{
  const MID = 'ab12cd34ef567890';
  // A NON-HEX message id — not a curiosity: the Obsidian importer mints
  // `obsidian:<vault>/<path>` (src/ingest/obsidian-import.js) and importMessages takes a
  // caller-supplied id (src/tools/ingest.js). Shortening one of those yields a ref nothing
  // can resolve — D-040 reproduced by the fix itself. Seeded so G2/G4 actually see it.
  const OID = 'obsidian:MyVault/notes/kept.md';
  await db.messages.insert([
    { id: MID, user_id: U, role: 'user', content: 'NEEDLEMSG quokka reflection', scope: 'personal', created_at: `${today}T10:00:00.000Z` },
    { id: OID, user_id: U, role: 'user', content: 'NEEDLEOBS imported note body', scope: 'personal', created_at: `${today}T10:05:00.000Z` },
  ]);
  await handlers.remember({ kind: 'fact', category: 'work', key: 'refprobe', value: 'NEEDLEFACT axolotl' });
  await handlers.remember({ kind: 'entity', entityType: 'person', name: 'NEEDLEENT Wanda', summary: 'ref probe', pinned: true });
  await handlers.saveDocument({ path: 'refprobe/needle.md', content: 'NEEDLEDOC pangolin body', title: 'Ref Probe Doc', summary: 'NEEDLEDOC pangolin summary' });
  try { await searchHelpers.rebuild(); } catch { /* BM25-only rebuild */ }

  const fact = (await db.facts.list({ userId: U })).find((f) => f.key === 'refprobe');
  const ent = (await db.entities.list({ userId: U })).find((e) => (e.name || '').includes('NEEDLEENT'));
  seeded.push(
    { type: 'message', id: MID, needle: 'NEEDLEMSG' },
    { type: 'message', id: OID, needle: 'NEEDLEOBS' },
    { type: 'fact', id: fact.id, needle: 'NEEDLEFACT' },
    { type: 'entity', id: ent.id, needle: 'NEEDLEENT' },
    { type: 'document', id: 'refprobe/needle.md', needle: 'NEEDLEDOC' },
  );

  // Every read tool in the LIVE registry (read-safe grant = the set an agent always has),
  // with the args each needs to actually surface something. A tool absent from the map is
  // still driven with {} — if it echoes a needle it is held to the same rule.
  const ARGS = {
    searchMindscape: [{ query: 'quokka' }, { query: 'pangolin', scope: 'documents' }, { scope: 'facts' }, { scope: 'entities' }],
    getDailyMessages: [{ date: today }],
    getDocument: [{ path: 'refprobe/needle.md' }],
  };
  const readTools = tools.map((t) => t.name).filter((n) => SAFE_AUTONOMOUS_TOOLS.has(n));

  // The ONE deliberate exemption, and it is a security requirement rather than an oversight:
  // getContext output is concatenated into the SYSTEM prompt of every turn and replays rows
  // that can be attacker-authored (connector-captured email, ingested message). Rendering a
  // deletion handle for every neighbouring row beside injected text, on a turn that has
  // `forget`, makes "delete everything above" actionable. See the block comment in
  // src/tools/context.js. Asserted as an EXACT set below, so a NEW ref-less surface still REDs.
  const REFLESS = new Set(['getContext']);

  const observed = new Set();     // `${tool}|${type}` pairs actually exercised
  const refless = new Set();      // surfaces that showed an item with NO usable id
  const violations = [];
  for (const name of readTools) {
    for (const args of (ARGS[name] || [{}])) {
      let out;
      try { out = String(await handlers[name](args)); } catch { continue; }   // a tool that can't run here proves nothing
      for (const item of seeded) {
        if (!out.includes(item.needle)) continue;
        observed.add(`${name}|${item.type}`);
        if (REFLESS.has(name)) { refless.add(name); continue; }
        // "forget-compatible" is proved by RESOLUTION, and the ref is EXTRACTED FROM THE
        // OUTPUT — never reconstructed here from the id we already know. An earlier version
        // did `out.includes(renderRef(type,id))`, a substring search over the whole blob:
        // it passed even when every row in a listing carried the SAME (wrong) ref, so
        // "forget that one" would have destroyed a different row with the gate green
        // (independent review, 2026-07-26). Take the ref off the LINE that carries the
        // needle, resolve THAT, and require it to come back as this exact row.
        // "The row" = everything up to and including the needle's line; the ref that owns it
        // is the LAST token in that span. That covers a one-line listing row (token on the
        // line) AND a multi-line block whose header carries the token (formatDocument,
        // getDocument), while still binding: under a mutation that stamps every row with the
        // same ref, the last token before the needle is the WRONG one and this REDs.
        const cut = out.indexOf(item.needle);
        const upto = out.slice(0, out.indexOf('\n', cut) === -1 ? out.length : out.indexOf('\n', cut));
        const tokens = upto.match(/\[(?:msg|doc|fact|ent):[^\n\]]*(?:\][^\n\]]*)*?\](?=[\s.,:]|$)/g) || [];
        const shown = tokens.length ? tokens[tokens.length - 1] : (upto.includes(item.id) ? item.id : null);
        const r = shown ? await resolveItemRef(db, U, item.type, shown) : { ok: false, reason: 'no-id-rendered-for-the-row' };
        if (!r.ok || r.id !== item.id) violations.push(`${name}(${JSON.stringify(args)}) → ${item.type}: ${r.reason || `resolved to ${r.id}, not ${item.id}`} [ref: ${shown}]`);
      }
    }
  }
  rec('G2a. every read surface that shows an item shows a resolvable ref for it',
    violations.length === 0, violations.join('\n      ') || `${observed.size} (tool,type) pairs checked, ${refless.size} exempt, 0 violations`);

  // The exemption is EXACT, in both directions: getContext must still be ref-less (an
  // "improvement" that re-adds refs to the system prompt REDs here), and nothing else may
  // quietly join the list to dodge G2a.
  const exemptSeen = [...refless].sort().join(',');
  rec('G2a. the ref-less exemption is exactly {getContext} — no more, no less',
    exemptSeen === 'getContext', `observed ref-less: [${exemptSeen}]`);

  // Non-vacuity floor: the surfaces D-040 ↻1 named must have been REACHED. Without this, a
  // surface that silently returned nothing would make G2a a green about nothing.
  const FLOOR = [
    'searchMindscape|message', 'searchMindscape|document', 'searchMindscape|fact', 'searchMindscape|entity',
    'getDailyMessages|message', 'listDocuments|document', 'getDocument|document',
    // getContext is the ref-less exemption, but it must still be REACHED — otherwise G2d
    // (it shows the row and no ref) could pass on an empty briefing.
    'getContext|message', 'getContext|fact', 'getContext|entity',
  ];
  const unreached = FLOOR.filter((k) => !observed.has(k));
  rec('G2b. all the D-040 surfaces were actually exercised (no vacuous green)',
    unreached.length === 0, unreached.join(', ') || `${FLOOR.length}/${FLOOR.length} reached`);

  // The compact form is the one that ships (token budget — a day review renders 30 rows).
  // Assert it, so a "fix" that dumps full ids everywhere is visible.
  const day0 = await handlers.getDailyMessages({ date: today });
  rec('G2c. the COMPACT ref (not the full id) is what a listing renders',
    day0.includes(renderRef('message', seeded[0].id)) && !day0.includes(seeded[0].id),
    `ref=${renderRef('message', seeded[0].id)}`);

  // The turn preamble carries the content but NO deletion handle — the injection boundary.
  const ctx = await handlers.getContext({});
  rec('G2d. getContext shows the rows but NO ref for any of them (injection boundary)',
    ctx.includes('NEEDLEMSG') && !ctx.includes(renderRef('message', seeded[0].id)) && !ctx.includes(seeded[0].id)
      && !ctx.includes(renderRef('fact', byType('fact').id)) && !ctx.includes(renderRef('entity', byType('entity').id)),
    `showsRow=${ctx.includes('NEEDLEMSG')} showsRef=${ctx.includes(renderRef('message', seeded[0].id))}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// G3 — HONESTY: a forget that destroyed nothing must not look like one that did.
// ══════════════════════════════════════════════════════════════════════════════
{
  const SUCCESS_SHAPED = /^(Forgotten|Already forgotten|Nothing to forget)/;
  const missOut = await handlers.forget({ type: 'message', id: 'deadbeef99' });
  rec('G3a. a non-matching id is an explicit FAILURE, not a success-shaped string',
    !SUCCESS_SHAPED.test(missOut) && /FORGET FAILED/.test(missOut) && /still there/i.test(missOut), missOut.slice(0, 140));

  const missEvents = await db.audit.recent({ eventType: 'forget-miss' });
  rec('G3b. the miss is AUDITED (it left no trace at all before)',
    missEvents.length > 0 && missEvents.some((e) => e.endpoint === 'message'), `rows=${missEvents.length}`);

  // Ambiguity fails CLOSED — a destructive verb never picks one of two.
  const A = 'facefeed0000aaaa', B = 'facefeed0000bbbb';
  await db.messages.insert([
    { id: A, user_id: U, role: 'user', content: 'ambiguous one', scope: 'personal', created_at: `${today}T11:00:00.000Z` },
    { id: B, user_id: U, role: 'user', content: 'ambiguous two', scope: 'personal', created_at: `${today}T11:01:00.000Z` },
  ]);
  const amb = await handlers.forget({ type: 'message', id: 'facefeed0000' });   // the 12-char shared prefix
  const bothLive = (await one(`SELECT COUNT(*) AS c FROM messages WHERE id IN (?,?) AND forgotten_at IS NULL`, [A, B])).c;
  rec('G3c. an ambiguous short ref fails CLOSED — nothing destroyed',
    /FORGET FAILED/.test(amb) && /more than one/.test(amb) && bothLive === 2, `${amb.slice(0, 100)} | live=${bothLive}`);
  // …and it is not a DEAD END (QA6): "pass the full id" is useless advice unless the full
  // ids come with it, because no read surface renders one.
  rec('G3c. the ambiguity hands back the candidate FULL ids (never a dead end)',
    amb.includes(A) && amb.includes(B), amb.slice(amb.indexOf('Identify')));

  // A hallucinated id is arbitrary text and may be user content — it must NOT land in the
  // audit row verbatim (§1).
  await handlers.forget({ type: 'fact', id: 'the thing about my affair' });
  const after = await db.audit.recent({ eventType: 'forget-miss' });
  rec('G3d. a non-id-shaped attempt is audited as "invalid", never verbatim (§1)',
    after.some((e) => e.method === 'invalid') && !after.some((e) => /affair/.test(String(e.method))));

  // A LIKE metacharacter must never reach the pattern. The probes are LENGTH-12 ON PURPOSE:
  // an earlier version used '%' (1 char) and a string that matched nothing, so BOTH were
  // caught by the length floor / by luck and the CHARSET half of SAFE_ID was ungated —
  // removing it left the whole suite GREEN while `forget({id:'%%%%%%%%%%%%'})` destroyed a
  // real row (independent review, 2026-07-26). `%` matches any run, `_` any single char, so
  // a 12-char run of either matches every id in the table if it ever reaches the LIKE.
  // A row whose id is UNIQUELY targetable by a metacharacter pattern. This is the part that
  // bites: a blanket '%%%%%%%%%%%%' matches every row, so it fails closed on AMBIGUITY even
  // with the charset check removed — which is exactly why the earlier probes were a false
  // green. `deadc0de1_34` / `deadc0de%34f` match this row and NOTHING else, so if a
  // metacharacter ever reaches the LIKE, resolution succeeds and the row is destroyed.
  const T = 'deadc0de1234f00d';
  await db.messages.insert([{ id: T, user_id: U, role: 'user', content: 'wildcard target row', scope: 'personal', created_at: `${today}T11:30:00.000Z` }]);
  const wildProbes = ['deadc0de1_34', 'deadc0de%34f', '%%%%%%%%%%%%', '____________', '%'];
  const wildOut = [];
  for (const p of wildProbes) wildOut.push(await handlers.forget({ type: 'message', id: p }));
  const stillLive = (await one(`SELECT COUNT(*) AS c FROM messages WHERE id IN (?,?,?) AND forgotten_at IS NULL`, [A, B, T])).c;
  const anyForgotten = (await one(`SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND forgotten_at IS NOT NULL`, [U])).c;
  rec('G3e. LIKE metacharacters (%, _) never reach the pattern — nothing destroyed',
    wildOut.every((o) => /FORGET FAILED/.test(o)) && stillLive === 3 && anyForgotten === 1,   // only F3's m-forget
    `${wildOut.filter((o) => !/FORGET FAILED/.test(o)).length} non-failures · live=${stillLive}/3 · totalForgotten=${anyForgotten}`);

  // A prefix SHORTER than the rendered form is refused outright — prefix resolution is an
  // enumeration oracle, and a short prefix is the sweepable end of it (see SAFE_ID).
  const shortProbe = await handlers.forget({ type: 'message', id: 'facefe' });
  const stillLive2 = (await one(`SELECT COUNT(*) AS c FROM messages WHERE id IN (?,?) AND forgotten_at IS NULL`, [A, B])).c;
  rec('G3f. a prefix shorter than a rendered ref never resolves (no enumeration oracle)',
    /FORGET FAILED/.test(shortProbe) && !/more than one/.test(shortProbe) && stillLive2 === 2, shortProbe.slice(0, 90));

  // The audit must record the id from the BRACKETED token — the form the tool's own schema
  // tells the model to send. Testing the raw argument audited 'invalid' for the commonest
  // miss and left the trail blank exactly where it was needed.
  await handlers.forget({ type: 'message', id: '[msg:deadbeef9999]' });
  const wrapped = await db.audit.recent({ eventType: 'forget-miss' });
  rec('G3g. a miss on the BRACKETED ref audits the id, not "invalid"',
    wrapped.some((e) => e.method === 'deadbeef9999'), `methods=${wrapped.map((e) => e.method).join('|')}`);

  // SCOPE: an agent bound to AGENT_SCOPES must not be able to RESOLVE — and therefore
  // destroy — a row it is forbidden to read. selectRecent enforces this on the read side;
  // prefix resolution is a read too.
  const W = 'abcdef012345wealthrow';
  await db.messages.insert([{ id: W, user_id: U, role: 'user', content: 'wealth-scoped row', scope: 'wealth', created_at: `${today}T12:00:00.000Z` }]);
  const prevScopes = process.env.AGENT_SCOPES;
  process.env.AGENT_SCOPES = JSON.stringify(['personal']);
  const outOfScope = await handlers.forget({ type: 'message', id: 'abcdef012345' });
  process.env.AGENT_SCOPES = prevScopes;
  const wealthLive = (await one(`SELECT forgotten_at FROM messages WHERE id = ?`, [W])).forgotten_at;
  rec('G3h. a row outside AGENT_SCOPES cannot be resolved or destroyed',
    /FORGET FAILED/.test(outOfScope) && !wealthLive, `${outOfScope.slice(0, 70)} | forgotten=${!!wealthLive}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// G4 — END-TO-END: read → take the ref the surface rendered → forget → it is gone.
// ══════════════════════════════════════════════════════════════════════════════
{
  const item = seeded[0];                                   // the seeded message
  const day = await handlers.getDailyMessages({ date: today });
  const line = day.split('\n').find((l) => l.includes('NEEDLEMSG')) || '';
  const shown = (/\[msg:[^\]]+\]/.exec(line) || [])[0];
  rec('G4a. the day review rendered a ref the agent can copy', !!shown, `ref=${shown} line=${line.slice(0, 60)}`);

  // Pass back EXACTLY what was rendered — brackets and all.
  const out = await handlers.forget({ type: 'message', id: shown });
  rec('G4b. forget accepts the rendered ref verbatim', /^Forgotten: message/.test(out), out.slice(0, 80));

  const row = await one(`SELECT content, embedding_768, forgotten_at FROM messages WHERE id = ?`, [item.id]);
  rec('G4c. content + embedding destroyed, row tombstoned', row.content == null && row.embedding_768 == null && !!row.forgotten_at);

  const dayAfter = await handlers.getDailyMessages({ date: today });
  const ctxAfter = await handlers.getContext({});
  const searchAfter = await handlers.searchMindscape({ query: 'quokka' });
  rec('G4d. gone from every surface it was readable on (day review · briefing · search)',
    !dayAfter.includes('NEEDLEMSG') && !ctxAfter.includes('NEEDLEMSG') && !searchAfter.includes('NEEDLEMSG'),
    `day=${dayAfter.includes('NEEDLEMSG')} ctx=${ctxAfter.includes('NEEDLEMSG')} search=${searchAfter.includes('NEEDLEMSG')}`);

  // Forgetting the same ref again is the honest "already", not a second FAILED.
  rec('G4e. re-forgetting the same ref reports already-forgotten', /^Already forgotten/.test(await handlers.forget({ type: 'message', id: shown })));
}

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — forget: redact/evict/tombstone/audit + reachable on the owner DM (and NOWHERE else), addressable from every read surface, loud + audited on a miss, gone end-to-end' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
