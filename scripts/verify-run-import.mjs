// Verify — the import spine (src/ingest/run-import.js) routes every archive
// source to the right adapter and returns the uniform {importResult}|{error}
// shape. Guards the Phase-2a seam: a new `kind`/adapter must not regress
// detection, dispatch, the zip-bomb guard, or the unsupported-format errors.
//
//   R1 claude zip       → { importResult: { type:'claude', imported≥1 } }
//   R2 chatgpt zip      → { importResult: { type:'chatgpt', imported≥1 } }
//   R3 markdown zip     → imported as a `bundle` (was: a dead-end error telling the
//                         user to go find the folder importer — QA6 P7)
//   R4 garbage bytes    → { error } unrecognized (no throw)
//   R5 unknown kind     → throws (fail-closed, not a silent no-op)
//
// QA6 P7 — auto-detect at ANY DEPTH + the `bundle` kind:
//   R6 a NESTED / re-zipped Claude export detects (export-2026/conversations.json)
//   R6b a NESTED ChatGPT export detects, and a nested Mycelium vault manifest does too
//   R7 TWO conversations.json in different folders → an honest AMBIGUITY error,
//      naming the ambiguity, content-free (no archive paths), nothing imported
//   R8 a plain zip of documents/media imports through the loose-file router
//      (md/txt → documents, image → attachment), with fail-loud counts
//   R9 an entry named `../../escape.md` cannot write outside the vault's logical
//      space — the stored document path is `uploads/escape.md`
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import { applyMigrations } from '../src/db/migrate.js';
import { boot } from '../src/index.js';
import { runImport } from '../src/ingest/run-import.js';
import { safeEntryBasename } from '../src/ingest/archive-entries.js';

const DB = 'data/verify-run-import.db';
const KCV = 'data/verify-run-import-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
mkdirSync('data', { recursive: true });
{ const seed = new Database(DB); applyMigrations(seed); seed.close(); }

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex() });
const ctx = { db, userId: 'verify-spine-user', enqueueEnrichment: null };
const zipBytes = (files) => { const z = new JSZip(); for (const [n, c] of Object.entries(files)) z.file(n, c); return z.generateAsync({ type: 'nodebuffer' }); };

// R1 — Claude export routes to the claude adapter.
const claudeBuf = await zipBytes({ 'conversations.json': JSON.stringify([
  { uuid: 'c1', name: 'C', chat_messages: [{ uuid: 'm1', sender: 'human', text: 'hi from claude', created_at: '2021-01-01T00:00:00Z' }] },
]) });
const r1 = await runImport({ kind: 'archive', buffer: claudeBuf }, ctx);
rec('R1 claude zip → importResult.type=claude, imported≥1',
  r1.importResult?.type === 'claude' && r1.importResult?.imported >= 1, JSON.stringify(r1.importResult || r1));

// R2 — ChatGPT export routes to the chatgpt adapter.
const chatgptBuf = await zipBytes({ 'conversations.json': JSON.stringify([
  { id: 'g1', title: 'G', mapping: { root: { id: 'root', children: ['n1'] },
    n1: { id: 'n1', message: { author: { role: 'user' }, create_time: 1609459200, content: { content_type: 'text', parts: ['hi from chatgpt'] } }, children: [] } } },
]) });
const r2 = await runImport({ kind: 'archive', buffer: chatgptBuf }, ctx);
rec('R2 chatgpt zip → importResult.type=chatgpt, imported≥1',
  r2.importResult?.type === 'chatgpt' && r2.importResult?.imported >= 1, JSON.stringify(r2.importResult || r2));

// R3 — a zip of markdown IMPORTS (bundle). It used to dead-end with "use the
// folder importer", which is a wall, not an import (QA6 P7 §3).
const obsidianBuf = await zipBytes({ 'notes/idea.md': '# Idea\nbody' });
const r3 = await runImport({ kind: 'archive', buffer: obsidianBuf }, ctx);
rec('R3 markdown zip → bundle import (no dead-end error)',
  r3.importResult?.type === 'bundle' && r3.importResult?.imported === 1 && r3.error === undefined, JSON.stringify(r3.importResult || r3));

// R4 — garbage bytes → unrecognized error, no throw.
let r4;
try { r4 = await runImport({ kind: 'archive', buffer: Buffer.from('not a zip at all') }, ctx); }
catch (e) { r4 = { threw: String(e?.message || e) }; }
rec('R4 garbage bytes → {error}, no throw',
  typeof r4.error === 'string' && !r4.threw, JSON.stringify(r4));

// R5 — unknown kind → throws (fail-closed).
let threw = false;
try { await runImport({ kind: 'banana' }, ctx); } catch { threw = true; }
rec('R5 unknown kind throws (fail-closed)', threw, `threw=${threw}`);

// ── QA6 P7 ────────────────────────────────────────────────────────────────────
// R6 — a NESTED / re-zipped export detects. THE bug: detection matched exact
// names at the archive ROOT, so `export-2026/conversations.json` (what you get
// when you re-zip your download, or from any export that ships a folder) fell
// through to "unrecognized export".
const nestedClaude = await zipBytes({ 'chatgpt-export-2026-07/conversations.json': JSON.stringify([
  { uuid: 'c2', name: 'N', chat_messages: [{ uuid: 'm2', sender: 'human', text: 'nested claude msg', created_at: '2021-02-01T00:00:00Z' }] },
]) });
const r6 = await runImport({ kind: 'archive', buffer: nestedClaude }, ctx);
rec('R6 nested/re-zipped Claude export detects (basename at any depth)',
  r6.importResult?.type === 'claude' && r6.importResult?.imported >= 1, JSON.stringify(r6.importResult || r6));

const nestedChatgpt = await zipBytes({ 'a/b/conversations.json': JSON.stringify([
  { id: 'g2', title: 'N', mapping: { n1: { id: 'n1', message: { author: { role: 'user' }, create_time: 1609459300, content: { parts: ['nested chatgpt msg'] } } } } },
]) });
const r6b = await runImport({ kind: 'archive', buffer: nestedChatgpt }, ctx);
rec('R6b nested ChatGPT export detects (basename at any depth)',
  r6b.importResult?.type === 'chatgpt' && r6b.importResult?.imported >= 1, JSON.stringify(r6b.importResult || r6b));

// R6c — THE RESTORE-PATH DATA-LOSS GATE (QA6 P7 review, FIX 1).
// A ROOT Mycelium vault manifest still imports. A NESTED one (the shape you get
// by re-zipping your export folder) must be REFUSED with an honest error — it
// used to fall through to `bundle`, which returns {type:'bundle',imported:2} for
// a photo and an AGENT.md while DROPPING the entire message/document history,
// success-shaped, on the one path where the user is restoring a backup.
// The fixture is a REALISTIC vault export (manifest + tables + attachments +
// agents), not a manifest-plus-one-note: a thin fixture cannot expose this.
const rootVault = await zipBytes({ 'manifest.json': JSON.stringify({ format: 'mycelium-vault-export', users: [] }) });
const nestedVault = await zipBytes({
  'my-vault-export/manifest.json': JSON.stringify({ format: 'mycelium-vault-export', users: [], messages: [] }),
  'my-vault-export/tables/messages.ndjson': '{"id":"m1","content":"a real memory"}\n',
  'my-vault-export/tables/documents.ndjson': '{"id":"d1","path":"notes/x.md"}\n',
  'my-vault-export/attachments/a1/photo.png': Buffer.from('89504e470d0a1a0a', 'hex'),
  'my-vault-export/agents/main/AGENT.md': '# agent',
});
const r6cRoot = await runImport({ kind: 'archive', buffer: rootVault }, ctx);
const r6cNested = await runImport({ kind: 'archive', buffer: nestedVault }, ctx);
rec('R6c nested VAULT export → honest ERROR (never a success-shaped bundle that drops the history); root still imports',
  r6cRoot.importResult?.type === 'mycelium'
  && r6cNested.importResult === undefined
  && typeof r6cNested.error === 'string'
  && /nested|inner/i.test(r6cNested.error) && /vault/i.test(r6cNested.error)
  && !/my-vault-export|photo\.png|AGENT\.md/.test(r6cNested.error),   // content-free
  JSON.stringify({ root: r6cRoot.importResult?.type, nested: r6cNested.importResult?.type ?? r6cNested.error?.slice(0, 60) }));

// R6d — the refusal is DEPTH-agnostic and survives the buffered (JSZip) dispatch
// too, so neither transport can quietly bundle a vault export.
const deepVault = await zipBytes({
  'backups/2026/my-vault/manifest.json': JSON.stringify({ format: 'mycelium-vault-export' }),
  'backups/2026/my-vault/attachments/a1/photo.png': Buffer.from('89504e470d0a1a0a', 'hex'),
});
const r6dStream = await runImport({ kind: 'archive', buffer: deepVault }, ctx);
const r6dBuffered = await runImport({ kind: 'archive', zip: await JSZip.loadAsync(deepVault) }, ctx);
rec('R6d nested vault refused at any depth, on BOTH the streaming and the buffered dispatch',
  typeof r6dStream.error === 'string' && r6dStream.importResult === undefined
  && typeof r6dBuffered.error === 'string' && r6dBuffered.importResult === undefined,
  JSON.stringify({ stream: r6dStream.importResult?.type ?? 'error', buffered: r6dBuffered.importResult?.type ?? 'error' }));

// R6e — THE DECOY-ROOT-MANIFEST BYPASS (QA6 P7 review round-2). The refusal was
// behind an `else if` so it only ran when there was NO root manifest.json. A
// decoy / unrelated NON-vault root manifest sitting ALONGSIDE a real nested vault
// export skipped the probe, fell through to `bundle`, imported a couple of loose
// media files and returned {type:'bundle'} — SILENTLY DROPPING the whole
// message/document history, no error, on the RESTORE path. The nested probe must
// run even when a non-vault root manifest is present.
const decoyPlusNestedVault = await zipBytes({
  'manifest.json': JSON.stringify({ name: 'some-web-app', version: '1.0.0' }), // decoy — NOT a vault
  'my-vault/manifest.json': JSON.stringify({ format: 'mycelium-vault-export', users: [], messages: [] }),
  'my-vault/tables/messages.ndjson': '{"id":"m1","content":"a real memory"}\n',
  'my-vault/attachments/a1/photo.png': Buffer.from('89504e470d0a1a0a', 'hex'),
});
const r6eDecoyStream = await runImport({ kind: 'archive', buffer: decoyPlusNestedVault }, ctx);
const r6eDecoyBuffered = await runImport({ kind: 'archive', zip: await JSZip.loadAsync(decoyPlusNestedVault) }, ctx);
// And the CONTROL — don't OVER-refuse: a plain root NON-vault manifest with NO
// nested vault must still import normally (as a bundle here — .json isn't a bundle
// ext, so only the note imports).
const plainRootManifest = await zipBytes({
  'manifest.json': JSON.stringify({ name: 'some-web-app', version: '1.0.0' }),
  'r6e-readme.md': '# just a readme',
});
const r6ePlain = await runImport({ kind: 'archive', buffer: plainRootManifest }, ctx);
rec('R6e decoy NON-vault root manifest does NOT mask a nested vault export (refused on BOTH transports); a plain non-vault root manifest with no nested vault still imports',
  r6eDecoyStream.importResult === undefined && typeof r6eDecoyStream.error === 'string'
  && /nested|inner/i.test(r6eDecoyStream.error) && /vault/i.test(r6eDecoyStream.error)
  && r6eDecoyBuffered.importResult === undefined && typeof r6eDecoyBuffered.error === 'string'
  && /vault/i.test(r6eDecoyBuffered.error)
  && r6ePlain.importResult?.type === 'bundle' && r6ePlain.error === undefined,
  JSON.stringify({
    decoyStream: r6eDecoyStream.importResult?.type ?? r6eDecoyStream.error?.slice(0, 50),
    decoyBuffered: r6eDecoyBuffered.importResult?.type ?? r6eDecoyBuffered.error?.slice(0, 50),
    plain: r6ePlain.importResult?.type ?? r6ePlain.error?.slice(0, 50),
  }));

// R6f — the nested-manifest PROBE reader must pass a FINITE maxBytes to
// openEntryStream so the streaming layer-2 observed-byte counter is LIVE, not
// Infinity (QA6 P7 review round-2 #2). The manual head loop + ratio guard bound it
// today, but a refactor dropping the manual loop must not silently uncap the
// inflation. Assert the SOURCE of readOneEntryText, not just a runtime shape —
// the cap is invisible at runtime while the manual loop is present.
const runImportSrc = readFileSync(
  fileURLToPath(new URL('../src/ingest/run-import.js', import.meta.url)), 'utf8');
const probeFn = (() => {
  const start = runImportSrc.indexOf('async function readOneEntryText');
  if (start < 0) return '';
  const rest = runImportSrc.slice(start + 1);
  const next = rest.search(/\n(?:async )?function \w/);
  return rest.slice(0, next < 0 ? undefined : next);
})();
const probeOpen = /openEntryStream\([^)]*maxBytes\s*:\s*(?!Infinity)\w/.test(probeFn);
rec('R6f nested-manifest probe (readOneEntryText) passes a FINITE maxBytes to openEntryStream — layer-2 byte cap is live, not Infinity',
  probeFn.length > 0 && probeOpen,
  JSON.stringify({ foundFn: probeFn.length > 0, finiteMaxBytes: probeOpen }));

// R7 — ambiguity is an HONEST ERROR, never a silent guess. And the message stays
// CONTENT-FREE: an import error can reach the activity feed, which is content-free
// by contract (verify:import-activity A2), so it may name the ambiguity but never
// the archive's paths.
const convA = JSON.stringify([{ uuid: 'x', name: 'A', chat_messages: [{ uuid: 'xa', sender: 'human', text: 'a' }] }]);
const ambiguous = await zipBytes({ 'exportA/conversations.json': convA, 'exportB/conversations.json': convA });
const r7 = await runImport({ kind: 'archive', buffer: ambiguous }, ctx);
rec('R7 two conversations.json in different folders → honest ambiguity error, content-free, nothing imported',
  typeof r7.error === 'string' && /2 files named conversations\.json/.test(r7.error)
  && !/exportA|exportB/.test(r7.error) && r7.importResult === undefined, JSON.stringify(r7));

// R8 — a plain zip of documents/media imports through the SAME loose-file router
// a single upload takes (md/txt → documents, image → attachment). This is also
// the zero-auth Google-Takeout path.
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const bundleBuf = await zipBytes({
  'Takeout/Drive/notes.md': '# Notes\nbundle body',
  'Takeout/Drive/plan.txt': 'plan body',
  'Takeout/Drive/photo.png': png,
  '__MACOSX/._notes.md': 'resource fork junk',   // noise — must NOT be imported
  'Takeout/Drive/.DS_Store': 'junk',             // dotfile — must NOT be imported
  'Takeout/Drive/binary.xyz': 'unknown ext',     // not allowlisted — must NOT be imported
});
const r8 = await runImport({ kind: 'archive', buffer: bundleBuf }, ctx);
rec('R8 plain zip of docs/media → bundle: 3 imported (2 documents + 1 attachment), noise/unknown-ext excluded',
  r8.importResult?.type === 'bundle' && r8.importResult?.imported === 3
  && r8.importResult?.stats?.documents === 2 && r8.importResult?.stats?.attachments === 1
  && r8.importResult?.stats?.files === 3 && r8.importResult?.failed === 0,
  JSON.stringify(r8.importResult || r8));

// R8b — progress is COUNTS ONLY. A filename in a progress payload would land in
// the activity feed's stage label (content-free by contract).
const seen = [];
const r8b = await runImport({ kind: 'archive', buffer: bundleBuf }, { ...ctx, onProgress: (p) => seen.push(p) });
const progressLeaks = seen.some((p) => JSON.stringify(p).match(/notes|plan|photo|\.md|\.png|Takeout/i));
rec('R8b bundle progress is content-free (counts only, no filename/path)',
  seen.length > 0 && !progressLeaks && seen.every((p) => typeof p.processed === 'number' && typeof p.total === 'number'),
  `ticks=${seen.length} last=${JSON.stringify(seen[seen.length - 1])}`);
// R8c — a re-import is idempotent for documents: the 2 notes come back as
// `deduped` (same path, unchanged content → an update, not a new item), not
// re-counted as fresh imports.
rec('R8c re-import is idempotent for documents (unchanged notes → deduped, not re-imported)',
  r8b.importResult?.stats?.deduped === 2 && r8b.importResult?.stats?.documents === 0,
  JSON.stringify(r8b.importResult?.stats));

// R9 — ZIP-SLIP, defense in depth (two independent layers, either alone suffices):
//   (a) the streaming reader (yauzl, the production path) FAIL-CLOSES on a `..`
//       entry — the whole archive is refused, so no traversal byte is ever read;
//   (b) if a name ever DID reach a writer, entry names are lookup keys, never
//       filesystem paths — the only thing derived is a sanitized BASENAME
//       (safeEntryBasename), so a document lands at `uploads/<basename>` and an
//       attachment at a random-UUID blob. Neither can escape the vault.
const slip = await zipBytes({
  'a/b/../../../../../../tmp/escape2.md': '# escaped too?',   // resolves to a `..`-bearing name
  'ok/legit.md': '# legit',
});
const r9 = await runImport({ kind: 'archive', buffer: slip }, ctx);
// Layer (a): the archive is refused (error) — the secure default. And NO document
// path anywhere in the vault contains a traversal / absolute / temp-dir segment.
const allPaths = ((await db.documents.list(ctx.userId, { limit: 1000 })) || []).map((d) => d.path);
const anyEscape = allPaths.some((p) => p.includes('..') || p.startsWith('/') || /(^|\/)(etc|tmp|windows|system32)(\/|$)/i.test(p) || p.includes('escape2'));
const refused = typeof r9.error === 'string' && r9.importResult === undefined && !anyEscape;
// Layer (b): prove safeEntryBasename neutralizes every escape shape a name can take.
const slipCases = [
  ['../../../../etc/passwd', 'passwd'],
  ['a/b/../../c/evil.md', 'evil.md'],
  ['..\\..\\windows\\system32\\x.md', 'x.md'],
  ['/abs/secret.pdf', 'secret.pdf'],
  ['....//....//x.txt', 'x.txt'],
  ['.hidden', 'hidden'],
  ['nul ptr.md', 'nulptr.md'],
];
const sanitizedOk = slipCases.every(([raw, want]) => safeEntryBasename(raw) === want)
  && !slipCases.some(([raw]) => { const b = safeEntryBasename(raw); return b.includes('/') || b.includes('\\') || b.includes('..') || b.startsWith('.') || b.startsWith('/'); });
rec('R9 zip-slip: streaming path fail-closes on `..`, and safeEntryBasename neutralizes every traversal/separator/control shape',
  refused && sanitizedOk,
  JSON.stringify({ refused: r9.error?.slice(0, 40), anyEscape, sanitizedOk, sample: safeEntryBasename('../../etc/passwd') }));

// R9b — USAGE, not FORM (repo lesson "gate PROJECTION vs PROPERTY"). R9 alone
// unit-tests safeEntryBasename and credits yauzl's `..` refusal — both stay
// green under the review's mutation A2 (the bundle WRITER using `entry.name`
// instead of the sanitizer). So assert the PROPERTY on the STORED row: the path
// the writer produced must be exactly `uploads/<sanitized-basename>`. The
// fixtures are shapes the writer's own `baseName()` does NOT absorb — a nested
// FOLDER and an over-length name — so a raw-entry-name write shows up as a stray
// folder segment or an un-capped length. (A CP437-printable control byte is a
// red herring here: yauzl decodes a bare 0x07 to U+2022, a legit filename char.)
const LONG = 'L'.repeat(200);
const usageZip = await zipBytes({
  'sub/dir/r9b-note.md': '# nested one folder deep',
  [`sub/deeper/${LONG}.md`]: '# very long name',
});
const r9b = await runImport({ kind: 'archive', buffer: usageZip }, ctx);
const r9bPaths = ((await db.documents.list(ctx.userId, { limit: 1000 })) || []).map((d) => d.path);
const wantNote = `uploads/${safeEntryBasename('sub/dir/r9b-note.md')}`;   // uploads/r9b-note.md
const wantLong = `uploads/${safeEntryBasename(`${LONG}.md`)}`;            // capped at 120, ext kept
// Scope the leak-checks to THIS fixture's own paths (the global doc list carries
// prior tests). Mutation A2 (writer uses entry.name) would store the raw name:
// `uploads/sub/dir/r9b-note.md` (a folder segment) and `uploads/<200 L's>.md`
// (un-capped) — so the raw variants must be ABSENT and the sanitized ones present.
const rawNote = r9bPaths.some((p) => p.includes('r9b-note') && p !== 'uploads/r9b-note.md'); // e.g. uploads/sub/dir/r9b-note.md
const rawLong = r9bPaths.some((p) => /L{130}/.test(p));                                       // >120 L's ⇒ not capped
rec('R9b bundle WRITER derives the stored path from safeEntryBasename (sub/dir/x.md -> uploads/x.md), not the raw entry name: folder dropped, length capped',
  r9b.importResult?.type === 'bundle' && r9b.importResult?.stats?.documents === 2
  && wantNote === 'uploads/r9b-note.md'
  && r9bPaths.includes(wantNote) && r9bPaths.includes(wantLong)
  && !rawNote && !rawLong,
  JSON.stringify({ want: [wantNote, wantLong], got: r9bPaths.filter((p) => /r9b-note|L{10}/.test(p)), rawNote, rawLong }));

// R10 — a plain zip of nested projects each with a (non-root, non-Mycelium)
// manifest.json is the NORMAL shape of a bundle: it imports its docs, never
// errors on the manifests (mycelium is root-anchored, so nested manifests are
// just ordinary files — .json isn't a bundle ext, so only the notes import).
const npmish = await zipBytes({ 'a/manifest.json': '{"name":"x"}', 'b/manifest.json': '{"name":"y"}', 'a/r10-readme.md': '# a', 'b/r10-changelog.md': '# b' });
const r10 = await runImport({ kind: 'archive', buffer: npmish }, ctx);
rec('R10 nested non-root manifests → bundle (imports the 2 notes, no false ambiguity/mycelium)',
  r10.importResult?.type === 'bundle' && r10.importResult?.imported === 2 && r10.error === undefined,
  JSON.stringify({ type: r10.importResult?.type, imported: r10.importResult?.imported }));

// R11 — two DISTINCT files that flatten to the same basename must NOT silently
// overwrite each other: the 2nd is disambiguated (uploads/dup.md, uploads/dup-2.md),
// so both survive. Order is the archive's stable listing → a re-import is idempotent.
const collide = await zipBytes({ 'chapterA/dup.md': '# from A', 'chapterB/dup.md': '# from B' });
const r11 = await runImport({ kind: 'archive', buffer: collide }, ctx);
const r11paths = ((await db.documents.list(ctx.userId, { limit: 1000 })) || []).map((d) => d.path);
const r11b = await runImport({ kind: 'archive', buffer: collide }, ctx); // re-import → both dedup, no new items
rec('R11 same-basename entries do not silently overwrite (disambiguated + idempotent on re-import)',
  r11.importResult?.stats?.documents === 2 && r11paths.includes('uploads/dup.md') && r11paths.includes('uploads/dup-2.md')
  && r11b.importResult?.stats?.documents === 0 && r11b.importResult?.stats?.deduped === 2,
  JSON.stringify({ first: r11.importResult?.stats?.documents, rerun: r11b.importResult?.stats }));

// ── QA6 P7 review — PER-GUARD bomb gates ──────────────────────────────────────
// Why these exist: the bomb defense is LAYERED, and layers MASK each other (repo
// lessons "two guards can MASK each other" + "bomb guard: declared-size is
// masked"). Deleting layer 2 in EITHER reader left every gate green, because
// layer 1 (or yauzl's own size check) refuses the same fixture with the SAME
// observable — a skip/null. So each gate below mutes ONE layer's input and
// asserts on BYTES READ, the only signal that distinguishes "bounded" from
// "inflated, then rejected".
const { readEntryBytes } = await import('../src/ingest/import-parsers.js');
const { readStreamCapped, readEntriesSequential, listEntries } = await import('../src/ingest/zip-stream.js');
const { Readable } = await import('node:stream');
const CAP = 50_000;
const BOMB = 400_000;

// A source that RECORDS how many bytes it was actually asked to produce.
const recordingSource = (bytes, chunk = 16 * 1024) => {
  const state = { pulled: 0 };
  let off = 0;
  state.stream = new Readable({
    read() {
      if (off >= bytes) return this.push(null);
      const n = Math.min(chunk, bytes - off);
      off += n; state.pulled += n;
      this.push(Buffer.alloc(n, 0x41));
    },
  });
  return state;
};

// R12 — STREAMING reader, LAYER 2 ALONE. The declared size is out of the picture
// entirely (the seam takes a raw stream), so this observes only the observed-byte
// counter: the reader must stop pulling at ~the cap, not at the bomb's full size.
const s2 = recordingSource(BOMB);
const l2 = await readStreamCapped((cb) => cb(null, s2.stream), CAP);
rec('R12 zip-stream LAYER 2 (observed-byte counter) bounds a bomb by BYTES READ, not by an error code',
  l2.bytes === null && l2.read > 0 && l2.read <= CAP + 16 * 1024 && s2.pulled < BOMB,
  `read=${l2.read} pulledFromSource=${s2.pulled} cap=${CAP} bomb=${BOMB}`);

// R12b — STREAMING reader, LAYER 1 ALONE: an HONEST oversized entry must be
// refused BEFORE any inflation. `read === 0` is the property; a skip alone is not
// (layer 2 also produces a skip, which is exactly how the two masked each other).
const honestBig = await zipBytes({ 'big.md': 'B'.repeat(BOMB) });
let l1read = null, l1skip = null;
for await (const e of readEntriesSequential(honestBig, ['big.md'], { maxEntryBytes: CAP })) { l1read = e.read; l1skip = e.skipped; }
rec('R12b zip-stream LAYER 1 (declared size) refuses an honest oversized entry with ZERO bytes inflated (read===0)',
  l1skip === 'oversize' && l1read === 0, `skipped=${l1skip} read=${l1read}`);

// R13 — BUFFERED (JSZip) reader, LAYER 2 ALONE. Injected zip: the DECLARED size
// lies low (40 bytes) so layer 1 cannot fire, and the stream is a recording source
// that would happily emit the whole bomb. Bounded ⇒ layer 2 held.
const fakeEntry = (declared, compressed, srcState) => ({
  _data: { uncompressedSize: declared, compressedSize: compressed },
  nodeStream: () => srcState.stream,
});
const b2 = recordingSource(BOMB);
let b2read = 0;
const b2out = await readEntryBytes({ file: () => fakeEntry(40, 40, b2) }, 'x', CAP, { onRead: (n) => { b2read = n; } });
rec('R13 import-parsers LAYER 2 bounds a LYING-LOW header by BYTES READ (layer 1 cannot fire at declared=40)',
  b2out === null && b2read > 0 && b2read <= CAP + 16 * 1024 && b2.pulled < BOMB,
  `read=${b2read} pulledFromSource=${b2.pulled} cap=${CAP} bomb=${BOMB}`);

// R13b — BUFFERED reader, LAYER 1 ALONE: an honest oversized declared size is
// refused with ZERO bytes pulled from the stream.
const b1 = recordingSource(BOMB);
let b1read = null;
const b1out = await readEntryBytes({ file: () => fakeEntry(BOMB, BOMB, b1) }, 'x', CAP, { onRead: (n) => { b1read = n; } });
rec('R13b import-parsers LAYER 1 refuses an honest oversized declared size with ZERO bytes pulled',
  b1out === null && b1read === 0 && b1.pulled === 0, `read=${b1read} pulled=${b1.pulled}`);

// R13c — BUFFERED reader, LAYER 0 (RATIO) ALONE. The buffered reader had NO ratio
// guard at all before this review: an HONEST 1000:1 archive whose declared size is
// under the (generous, gig-scale) byte cap inflated the full budget. Declared size
// stays under the cap here, so only the ratio can refuse it — with zero bytes read.
const b0 = recordingSource(BOMB);
let b0read = null;
const HUGE = 64 * 1024 * 1024;                  // > RATIO_FLOOR_BYTES (10MB)
const b0out = await readEntryBytes({ file: () => fakeEntry(HUGE, 1024, b0) }, 'x', HUGE * 2, { onRead: (n) => { b0read = n; } });
rec('R13c import-parsers LAYER 0 (ratio) refuses a 64MB-from-1KB entry that is UNDER the byte cap, with zero bytes pulled',
  b0out === null && b0read === 0 && b0.pulled === 0, `read=${b0read} pulled=${b0.pulled} ratio=${Math.round(HUGE / 1024)}:1`);

// R14 — UNCHARGED INFLATION (FIX 2). The DoS: an entry that trips the per-entry
// cap is inflated (up to the cap) then DISCARDED, and the old code charged only
// ACCEPTED bytes — so a small archive of lying-header bombs bought unbounded CPU
// while the total-observed budget stayed at 0. The measured PoC routed to the
// BUFFERED (JSZip) bundle reader (readBufferedEntries), so that is the target.
//
// A lying-LOW header cannot be forged through an in-memory JSZip (its declared
// sizes are honest), so we inject a fake zip whose entries declare 40 bytes but
// STREAM 400KB — exactly the bomb shape. Run in a CHILD so the per-entry/total
// caps (module consts read from env at load) can be lowered. Property: the walk
// CHARGES the refused entries' attempted bytes and HALTS — under the pre-fix
// `total += bytes.length`, every refused entry contributes 0 and it never halts.
const r14src = `
import { readBufferedEntries } from ${JSON.stringify(new URL('../src/ingest/run-import.js', import.meta.url).href)};
import { Readable } from 'node:stream';
const BOMB = 400000;
const rec = () => { const st = { pulled: 0 }; let off = 0;
  st.stream = new Readable({ read() { if (off >= BOMB) return this.push(null);
    const n = Math.min(16384, BOMB - off); off += n; st.pulled += n; this.push(Buffer.alloc(n, 0x41)); } });
  return st; };
const fakeZip = { file: () => ({ _data: { uncompressedSize: 40, compressedSize: 40 }, nodeStream: () => rec().stream }) };
let charged = 0, halted = false, walked = 0, refused = 0;
for await (const e of readBufferedEntries(fakeZip, ['a','b','c','d','e','f'])) {
  walked += 1; charged += e.read || 0; if (!e.bytes) refused += 1; if (e.halted) halted = true;
}
console.log(JSON.stringify({ walked, charged, halted, refused }));
`;
let r14 = { walked: 0, charged: 0, halted: false, refused: 0 };
try {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', r14src], {
    env: { ...process.env, MYCELIUM_IMPORT_BUNDLE_MAX_ENTRY_BYTES: '50000', MYCELIUM_IMPORT_BUNDLE_MAX_TOTAL_BYTES: '100000' },
    encoding: 'utf8',
  });
  r14 = JSON.parse(out.trim().split('\n').pop());
} catch (e) { r14.err = String(e?.message || e).slice(0, 120); }
rec('R14 buffered bundle reader CHARGES attempted inflation of REFUSED entries and HALTS (pre-fix charged 0 and never halted)',
  r14.refused >= 2 && r14.charged > 50000 && r14.halted === true && r14.walked <= 3,
  JSON.stringify(r14));

// R15 — the yauzl DEPENDENCY we rely on, pinned (FIX 4). yauzl's own
// `validateFileName` (node_modules/yauzl/index.js:871-883) rejects a `..` path
// segment — but ONLY because `decodeStrings` defaults to true. A bump, or an
// added `decodeStrings:false`, would remove that outer layer SILENTLY. This gate
// is the tripwire; our own defense (safeEntryBasename) is asserted by R9/R9b.
const slipZip = await zipBytes({ 'a/b/../../../../../../tmp/escape3.md': '# nope', 'ok/fine.md': '# fine' });
let yauzlRefused = false, yauzlMsg = '';
try { await listEntries(slipZip); } catch (e) { yauzlRefused = true; yauzlMsg = String(e?.message || e); }
rec('R15 DEPENDENCY PIN: yauzl (decodeStrings default) refuses an archive containing a `..` entry name',
  yauzlRefused && /invalid|\.\./i.test(yauzlMsg), `refused=${yauzlRefused} msg=${JSON.stringify(yauzlMsg.slice(0, 70))}`);

// R16 — hidden DIRECTORIES are noise too, not just dotfiles (FIX 5b): `.git/x.md`
// is tool state, never a document the user asked to import.
const hiddenZip = await zipBytes({
  '.git/r16-config.md': '# git internals',
  '.obsidian/r16-workspace.md': '# editor state',
  'notes/r16-real.md': '# a real note',
});
const r16 = await runImport({ kind: 'archive', buffer: hiddenZip }, ctx);
const r16paths = ((await db.documents.list(ctx.userId, { limit: 1000 })) || []).map((d) => d.path);
rec('R16 files under a hidden directory (.git/, .obsidian/) are never imported; the real note is',
  r16.importResult?.stats?.files === 1 && r16paths.includes('uploads/r16-real.md')
  && !r16paths.some((p) => /r16-config|r16-workspace/.test(p)),
  JSON.stringify({ files: r16.importResult?.stats?.files, imported: r16.importResult?.imported }));

const ok = ledger.every(Boolean);
console.log(`\nVERDICT: ${ok ? 'GO' : 'NO-GO'} — import spine routes archives, fails closed, no silent success`);
await close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
console.log(`EXIT=${ok ? 0 : 1}`);
process.exit(ok ? 0 : 1);
