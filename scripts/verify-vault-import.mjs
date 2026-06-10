// Verify — canonical-Mycelium vault import (the bring-your-vault-home path).
// Builds a synthetic `mycelium-vault-export` ZIP (manifest.json v4 + one
// attachment binary), drives POST /api/v1/portal/upload, and asserts:
//
//   V1 detection + result   type:'mycelium', per-family stats
//   V2 messages fidelity    ids + back-dated created_at preserved, nlp_processed=0
//   V3 encrypted at rest    plaintext marker ABSENT from the raw db file; the
//                           content envelope DECRYPTS back to the marker
//   V4 attachment           encrypted blob (MYCB) on disk + row linked (local_path)
//   V5 families landed      people/health/wealth/tasks/reflections/mindscape rows
//   V6 idempotent           re-import → 0 new rows (all deduped)
//   V7 unknown manifest     wrong `format` → safe 400 (no leak)
//   V8 honest reporting     skippedFamilies named in the result
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>. Design:
// docs/VAULT-IMPORT-FROM-CANONICAL-DESIGN-2026-06-10.md
import crypto from 'node:crypto';
import { rmSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import JSZip from 'jszip';

const DB = 'data/verify-vault-import.db';
const KCV = 'data/verify-vault-import-kcv.json';
const UPLOADS = 'data/verify-vault-import-uploads';
process.env.MYCELIUM_UPLOADS_ROOT = UPLOADS; // putBlob target (paths.js override)
process.env.MYCELIUM_DISABLE_EMBED = '1';

const { applyMigrations } = await import('../src/db/migrate.js');
const { startRestServer } = await import('../src/server-rest.js');
const { importMasterKey, decrypt } = await import('../src/crypto/crypto-local.js');
const { decryptVector } = await import('../src/search/ann/decode.js');

// A real 256D float32 vector, hex-encoded the way the canonical export does
// (`SELECT hex(nomic_embedding)` of RAW float bytes — reference:541).
const NOMIC_VEC = new Float32Array(256).map((_, i) => Math.fround(Math.sin(i + 1)));
const NOMIC_HEX = Buffer.from(NOMIC_VEC.buffer).toString('hex').toUpperCase();

const hex = () => crypto.randomBytes(32).toString('hex');
const USER_HEX = hex();
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const MARKER = 'unmistakable-vault-plaintext-marker';
const ATT_BYTES = Buffer.from('attachment-plaintext-binary-marker-0123456789');
const BACKDATE = '2024-03-15T10:20:30.000Z';
const PROVIDER_KEY = 'sk-canonical-plaintext-api-key-marker';
const AGENT_FILE_TEXT = 'agent memory file — continuity marker text';
const CANON_UID = 'canonical-user-1';

function manifest() {
  return {
    exportedAt: '2026-06-01T00:00:00.000Z',
    version: 4,
    format: 'mycelium-vault-export',
    user: { id: CANON_UID, displayName: 'Altus', timezone: 'Europe/Amsterdam', settings: { theme: 'dark' }, profile: { id: 'prof1', display_name: 'Altus' }, identities: [], passkeys: [{ id: 'pk1', credential_id: 'must-not-import' }] },
    messages: { total: 2, data: [
      { id: 'vm1', role: 'user', content: MARKER, source: 'telegram', message_type: 'chat', created_at: BACKDATE, conversation_id: 'conv1', nlp_processed: 1, embedding_768: 'stale-canonical-vector' },
      { id: 'vm2', role: 'assistant', content: 'a canonical reply', source: 'telegram', created_at: BACKDATE, conversation_id: 'conv1', attachment_id: 'att1' },
    ] },
    documents: { total: 1, data: [{ id: 'doc1', path: 'mind/areas/imported.md', title: 'Imported doc', content: 'doc body from canonical', created_at: BACKDATE }] },
    folders: [{ id: 'fold1', name: 'Imported', user_id: 'canonical-user-1' }],
    attachments: { total: 1, fetched: 1, failed: 0, data: [
      { id: 'att1', file_name: 'note.txt', file_type: 'text/plain', file_size: ATT_BYTES.length, zipPath: 'attachments/att1/note.txt', created_at: BACKDATE },
    ] },
    contacts: { total: 1, data: [{ id: 'p1', name: 'Ada Lovelace', email: 'ada@example.com' }], territoryLinks: [] },
    // getRange shape: parsed rows, numeric values, NO id (synthesis under test)
    health: [{ date: '2024-03-15', sleep_duration_min: 440, workout_types: ['run'] }],
    internalModel: [{ id: 'imi1', section: 'observations', content: 'an internal model item', created_at: BACKDATE }],
    connections: [{ id: 'conn1', user_a: CANON_UID, user_b: 'other-user-9', initiated_by: CANON_UID, status: 'accepted' }],
    aiProviders: [{ id: 7, provider: 'anthropic', auth_type: 'api_key', credentials: PROVIDER_KEY, created_at: BACKDATE }],
    activity: { sessions: [], daily: [] },
    wealth: { portfolios: [{ id: 'wp1', name: 'Main' }], assets: [], positions: [], transactions: [], snapshots: [], watchlist: [] },
    wealthExtra: { wallets: [], portfolioAccess: [] },
    canvases: { workspaces: [], nodes: [], edges: [], collaborators: [] },
    tasks: { agentTasks: [], personalTasks: [{ id: 't1', title: 'Imported task', status: 'open' }] },
    reflections: [{ id: 'r1', content: 'an imported reflection', created_at: BACKDATE }],
    cycleMetrics: [],
    scheduledEvents: [],
    agentEvents: { total: 0, data: [] },
    documents_meta: { versions: [], noteLinks: [], shareLinks: [], accessGrants: [] },
    mindscape: {
      realms: [{ id: 'rm1', realm_id: 1, name: 'Realm One' }],
      semanticThemes: [],
      territories: [{ id: 'tp1', territory_id: 7, realm_id: 1, name: 'Imported Territory', essence: 'a narrative essence', chronicle: 'territory chronicle marker text', embedding_768: '{"v":1,"s":"personal","iv":"FOREIGN","ct":"FOREIGN-KEY-ENVELOPE","dk":"x"}' }],
      themeCards: [],
      clusteringPoints: { total: 1, data: [{ id: 'cp1', source_type: 'message', source_id: 'vm1', territory_id: 7, landscape_x: 0.1, landscape_y: 0.2 }] },
      nomicEmbeddings: { total: 1, note: 'hex-encoded 256D Nomic float32 vectors, keyed by clustering_point id', data: { cp1: NOMIC_HEX } },
      clusterEvents: [],
    },
    topology: { realmNeighbors: [], cofiring: [], territoryNeighbors: [] },
    timeChronicles: [{ id: 'tc1', granularity: 'month', period_key: '2024-03', period_start: '2024-03-01', period_end: '2024-03-31', theme: 'a period theme', narrative: 'time chronicle narrative marker' }],
    currentArcChronicle: { theme: 'the current arc theme', narrative: 'current arc narrative marker', phase: 'emergence' },
    cognitiveMetrics: undefined, // v3-style absence for one family → must no-op
  };
}

async function vaultZip(man = manifest()) {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(man));
  zip.file('attachments/att1/note.txt', ATT_BYTES);
  zip.file('agents/personal/memory/note.md', AGENT_FILE_TEXT);
  zip.file('agents/personal/blob.bin', Buffer.from([0, 1, 2, 3]));
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
  try { rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* */ }
  mkdirSync('data', { recursive: true });
  const raw0 = new Database(DB); applyMigrations(raw0); raw0.close();

  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: USER_HEX, systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const { url } = srv;
  const postFile = async (buf, name = 'mycelium-vault-export.zip') => {
    const fd = new FormData();
    fd.append('file', new Blob([buf]), name);
    const r = await fetch(`${url}/api/v1/portal/upload`, { method: 'POST', body: fd });
    let body = null; try { body = await r.json(); } catch { /* */ }
    return { status: r.status, body };
  };

  try {
    // ── V1: detection + per-family stats ────────────────────────────────────
    const r1 = await postFile(await vaultZip());
    const ir = r1.body?.importResult;
    rec('V1 type detected + imported>0', r1.status === 200 && ir?.type === 'mycelium' && ir.imported >= 8,
      `status=${r1.status} type=${ir?.type} imported=${ir?.imported} failed=${ir?.failed}`);

    const raw = new Database(DB, { readonly: true });
    // ── V2: message fidelity ────────────────────────────────────────────────
    const m1 = raw.prepare('SELECT id, created_at, nlp_processed, conversation_id, attachment_id FROM messages WHERE id = ?').get('vm1');
    const m2 = raw.prepare('SELECT attachment_id FROM messages WHERE id = ?').get('vm2');
    rec('V2 ids + back-dated created_at preserved, nlp reset',
      m1 && m1.created_at === BACKDATE && Number(m1.nlp_processed) === 0 && m2?.attachment_id === 'att1',
      `created_at=${m1?.created_at} nlp=${m1?.nlp_processed}`);

    // ── V3: encrypted at rest + decrypts back ───────────────────────────────
    const dbBytes = readFileSync(DB);
    const noPlain = !dbBytes.includes(Buffer.from(MARKER));
    const env1 = raw.prepare('SELECT content FROM messages WHERE id = ?').get('vm1')?.content || '';
    let roundtrip = false;
    try { roundtrip = (await decrypt(env1, await importMasterKey(USER_HEX))) === MARKER; } catch { /* */ }
    rec('V3 marker absent from raw db; envelope decrypts to marker', noPlain && roundtrip, `noPlain=${noPlain} roundtrip=${roundtrip}`);

    // ── V4: attachment blob encrypted + row linked ──────────────────────────
    const att = raw.prepare('SELECT id, local_path, file_size FROM attachments WHERE id = ?').get('att1');
    let blobOk = false, blobNoPlain = false;
    if (att?.local_path) {
      const p = join(UPLOADS, att.local_path);
      if (existsSync(p)) {
        const b = readFileSync(p);
        blobOk = b.subarray(0, 4).toString('latin1') === 'MYCB';
        blobNoPlain = !b.includes(ATT_BYTES);
      }
    }
    rec('V4 attachment row + encrypted MYCB blob (no plaintext bytes)', Boolean(att?.local_path) && blobOk && blobNoPlain,
      `local_path=${att?.local_path} magic=${blobOk}`);

    // ── V5: structured families landed ──────────────────────────────────────
    const count = (t, idCol, idVal) => raw.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${idCol} = ?`).get(idVal)?.c || 0;
    const fams = {
      people: count('people', 'id', 'p1'),
      health_daily: raw.prepare("SELECT COUNT(*) c FROM health_daily WHERE date = '2024-03-15'").get()?.c || 0,
      wealth_portfolios: count('wealth_portfolios', 'id', 'wp1'),
      tasks: count('tasks', 'id', 't1'),
      reflections: count('reflections', 'id', 'r1'),
      documents: count('documents', 'id', 'doc1'),
      realms: count('realms', 'id', 'rm1'),
      territory_profiles: count('territory_profiles', 'id', 'tp1'),
      clustering_points: count('clustering_points', 'id', 'cp1'),
    };
    const missing = Object.entries(fams).filter(([, c]) => c !== 1).map(([k]) => k);
    rec('V5 all structured families landed (1 row each)', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : '');

    // nomic vector must be stored as a V1 envelope that decrypts back to the
    // original float32 vector (caller-encrypted pattern — never raw hex).
    const cp = raw.prepare('SELECT nomic_embedding FROM clustering_points WHERE id = ?').get('cp1');
    let vecOk = false;
    try {
      const v = await decryptVector(String(cp?.nomic_embedding || ''), await importMasterKey(USER_HEX), null, 256);
      vecOk = v.length === 256 && Math.abs(v[0] - NOMIC_VEC[0]) < 1e-5 && Math.abs(v[255] - NOMIC_VEC[255]) < 1e-5;
    } catch { /* */ }
    const notRaw = typeof cp?.nomic_embedding === 'string' && !cp.nomic_embedding.toUpperCase().includes(NOMIC_HEX.slice(0, 32));
    rec('V5b nomic vector re-encrypted under the V1 key (decryptVector round-trip)', vecOk && notRaw, `roundtrip=${vecOk}`);

    // ── continuity families (full-export parity) ────────────────────────────
    const userRow = raw.prepare('SELECT display_name, timezone, settings FROM users WHERE id = ?').get('local-user');
    rec('C1 user identity meta lands on the V1 users row (not a second row)',
      userRow?.display_name === 'Altus' && userRow?.timezone === 'Europe/Amsterdam' && String(userRow?.settings || '').includes('dark')
      && !raw.prepare('SELECT COUNT(*) c FROM users WHERE id = ?').get(CANON_UID)?.c,
      `display_name=${userRow?.display_name} tz=${userRow?.timezone}`);

    const imi = raw.prepare('SELECT COUNT(*) c FROM internal_model_items WHERE id = ?').get('imi1')?.c;
    rec('C2 internal_model_items (model internals) imported', imi === 1);

    const conn = raw.prepare('SELECT user_a, user_b, status FROM connections WHERE id = ?').get('conn1');
    rec('C3 connections imported with canonical uid remapped to the V1 user',
      conn?.user_a === 'local-user' && conn?.user_b === 'other-user-9' && conn?.status === 'accepted',
      `user_a=${conn?.user_a}`);

    const prov = raw.prepare('SELECT credentials FROM ai_providers WHERE id = ?').get(7);
    const provEncrypted = Boolean(prov?.credentials) && !String(prov.credentials).includes(PROVIDER_KEY);
    let provRoundtrip = false;
    try { provRoundtrip = (await decrypt(String(prov.credentials), await importMasterKey(USER_HEX))) === PROVIDER_KEY; } catch { /* */ }
    rec('C4 provider credentials re-encrypted at rest + decrypt back', provEncrypted && provRoundtrip
      && !dbBytes.includes(Buffer.from(PROVIDER_KEY)), `encrypted=${provEncrypted} roundtrip=${provRoundtrip}`);

    const agentDoc = raw.prepare("SELECT id, content, title FROM documents WHERE path = 'agents/personal/memory/note.md'").get();
    let agentDocPlain = null;
    try { agentDocPlain = await decrypt(String(agentDoc?.content || ''), await importMasterKey(USER_HEX)); } catch { /* */ }
    rec('C5 agents/ text file lands as an encrypted document (binary skipped, counted)',
      Boolean(agentDoc) && agentDocPlain === AGENT_FILE_TEXT && ir?.stats?.agent_files?.skippedBinary === 1
      && !dbBytes.includes(Buffer.from(AGENT_FILE_TEXT)),
      `doc=${Boolean(agentDoc)} binarySkipped=${ir?.stats?.agent_files?.skippedBinary}`);

    const hd = raw.prepare("SELECT id FROM health_daily WHERE date = '2024-03-15'").get();
    rec('C6 health id synthesized ({userId}:{date}) from getRange-shaped rows', hd?.id === 'local-user:2024-03-15', `id=${hd?.id}`);

    const msgScope = raw.prepare('SELECT scope FROM messages WHERE id = ?').get('vm1')?.scope;
    rec('C7 row scope aligned with the sealed envelope scope (personal)', msgScope === 'personal', `scope=${msgScope}`);

    const pk = raw.prepare("SELECT COUNT(*) c FROM passkey_credentials").get()?.c ?? 0;
    rec('C8 passkeys NOT imported (origin-bound)', pk === 0);

    // territory chronicle crosses (encrypted, decrypts back); the canonical-key
    // embedding_768 envelope is NULLED, never copied as undecryptable junk.
    const tp = raw.prepare('SELECT chronicle, embedding_768 FROM territory_profiles WHERE id = ?').get('tp1');
    let chronPlain = null;
    try { chronPlain = await decrypt(String(tp?.chronicle || ''), await importMasterKey(USER_HEX)); } catch { /* */ }
    rec('C9 territory chronicle re-encrypted + decrypts; foreign embedding_768 nulled',
      chronPlain === 'territory chronicle marker text' && tp?.embedding_768 === null
      && !dbBytes.includes(Buffer.from('territory chronicle marker text')),
      `chronicle=${chronPlain === 'territory chronicle marker text'} emb=${tp?.embedding_768}`);

    // temporal chronicles (receiver-side readiness for the exporter patch)
    const tc = raw.prepare("SELECT narrative FROM time_chronicles WHERE period_key = '2024-03'").get();
    const arc = raw.prepare("SELECT narrative, phase FROM current_arc_chronicles WHERE user_id = 'local-user'").get();
    let tcPlain = null, arcPlain = null;
    try { tcPlain = await decrypt(String(tc?.narrative || ''), await importMasterKey(USER_HEX)); } catch { /* */ }
    try { arcPlain = await decrypt(String(arc?.narrative || ''), await importMasterKey(USER_HEX)); } catch { /* */ }
    rec('C10 time_chronicles + current_arc imported, encrypted, decrypt back',
      tcPlain === 'time chronicle narrative marker' && arcPlain === 'current arc narrative marker' && arc?.phase === 'emergence',
      `tc=${tcPlain === 'time chronicle narrative marker'} arc=${arcPlain === 'current arc narrative marker'}`);

    // ── V6: idempotent re-import ────────────────────────────────────────────
    const before = raw.prepare('SELECT COUNT(*) c FROM messages').get()?.c;
    const r2 = await postFile(await vaultZip());
    const after = new Database(DB, { readonly: true }).prepare('SELECT COUNT(*) c FROM messages').get()?.c;
    rec('V6 re-import duplicates nothing', r2.status === 200 && r2.body?.importResult?.imported === 0 && before === after,
      `second imported=${r2.body?.importResult?.imported} skipped=${r2.body?.importResult?.skipped} rows ${before}→${after}`);

    // ── V7: unknown manifest format → safe 400 ──────────────────────────────
    const badZip = new JSZip(); badZip.file('manifest.json', JSON.stringify({ format: 'not-a-mycelium-export' }));
    const r3 = await postFile(await badZip.generateAsync({ type: 'nodebuffer' }));
    rec('V7 wrong manifest format → 400, no leak', r3.status === 400 && !JSON.stringify(r3.body || {}).includes(MARKER), `status=${r3.status}`);

    // ── V8: honest skip reporting — ONLY passkeys + secrets remain skipped ──
    rec('V8 skippedFamilies = exactly passkeys + secrets (everything else crosses)',
      Array.isArray(ir?.skippedFamilies) && ir.skippedFamilies.length === 2
      && ir.skippedFamilies.some((s) => /passkeys/.test(s)) && ir.skippedFamilies.some((s) => /secrets/.test(s)));

    raw.close();
  } finally {
    await new Promise((r) => srv.server.close(r)); srv.close?.();
    for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
    try { rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* */ }
  }

  const fails = ledger.filter((p) => !p).length;
  console.log(`\n${ledger.length - fails} passed, ${fails} failed`);
  console.log(fails ? 'VERDICT: NO-GO' : 'VERDICT: GO — canonical-Mycelium vault import (detect, fidelity, encrypt-at-rest, blobs, idempotency, honest skips)');
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
