#!/usr/bin/env node
// verify:import-streaming — proves the gig-scale streaming import primitives:
//   • json-array-stream: parses a JSON array LARGER than V8's 512MB string cap
//     in constant memory, and REJECTS truncated/malformed input;
//   • zip-stream: reads ONE known entry out of a zip as a stream, enforces the
//     decompression byte cap, returns null for an absent entry.
// Tier-1 (no ML, no vault). Exits 0 / VERDICT: GO when all pass.
import { Readable } from 'node:stream';
import JSZip from 'jszip';
import { streamJsonArray } from '../src/ingest/json-array-stream.js';
import { openEntryStream, listEntries } from '../src/ingest/zip-stream.js';

let fail = 0;
const rec = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) fail = 1; };

// A1 — JSON array bigger than the 512MB V8 string cap, constant memory.
{
  const N = 6000, PAD = 100 * 1024; // ~586 MB of array text
  function* gen() { yield '['; for (let i = 0; i < N; i++) yield (i ? ',' : '') + JSON.stringify({ id: i, role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(PAD) }); yield ']'; }
  let bytes = 0; for (const s of gen()) bytes += Buffer.byteLength(s);
  let count = 0, peak = 0, ordered = true, last = -1;
  for await (const el of streamJsonArray(Readable.from(gen()))) { count++; if (el.id !== last + 1) ordered = false; last = el.id; const r = process.memoryUsage().rss; if (r > peak) peak = r; }
  const peakMB = Math.round(peak / 1048576), sizeMB = Math.round(bytes / 1048576);
  rec(`A1. ${sizeMB}MB array (> 512MB V8 string cap) streamed in constant memory`, count === N && ordered && peakMB < 1500, `elements=${count}/${N} peakRSS=${peakMB}MB`);
}

// A2 — truncated/malformed input rejects (never silently yields a partial set).
{
  let threw = false, n = 0;
  try { for await (const _ of streamJsonArray(Readable.from(['[{"id":0},{"id":1},{"id":2'].values()))) n++; } catch { threw = true; }
  rec('A2. truncated array rejected (not silently accepted)', threw, `yielded=${n}`);
}

// B — zip-stream: stream one entry, byte cap, missing entry.
{
  const M = 2000;
  const zip = new JSZip();
  zip.file('conversations.json', JSON.stringify(Array.from({ length: M }, (_, i) => ({ id: i, mapping: {}, title: 't' + i }))));
  zip.file('user.json', '{"email":"x"}');
  zip.folder('dalle-generations').file('img.png', Buffer.alloc(2048));
  const buf = await zip.generateAsync({ type: 'nodebuffer' });

  const names = await listEntries(buf);
  rec('B1. listEntries enumerates without reading content', names.includes('conversations.json') && names.includes('user.json'));

  let count = 0;
  for await (const el of streamJsonArray(await openEntryStream(buf, 'conversations.json', { maxBytes: 50 * 1024 * 1024 }))) count++;
  rec('B2. stream one zip entry → incremental parse', count === M, `elements=${count}/${M}`);

  let capped = false;
  try { for await (const _ of streamJsonArray(await openEntryStream(buf, 'conversations.json', { maxBytes: 100 }))) {} } catch (e) { capped = e.code === 'ENTRY_TOO_LARGE' || /byte cap/.test(e.message); }
  rec('B3. decompression byte cap aborts the stream', capped);

  rec('B4. absent entry → null (no throw)', (await openEntryStream(buf, 'nope.json', {})) === null);
}

// B5 — decompression-RATIO bomb refused even under a GENEROUS byte cap (the cap
//      must stay high for gig-scale, so the ratio guard is what stops the bomb).
{
  const bomb = new JSZip();
  bomb.file('conversations.json', 'A'.repeat(11 * 1024 * 1024)); // ~11MB, compresses ~1000:1
  const buf = await bomb.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  let refused = false;
  try { await openEntryStream(buf, 'conversations.json', { maxBytes: 8 * 1024 * 1024 * 1024 }); } // 8GB cap — only the ratio guard can catch it
  catch (e) { refused = e.code === 'ENTRY_TOO_LARGE'; }
  rec('B5. high-ratio bomb refused under a generous byte cap (ratio guard)', refused, `compressed=${buf.length}B`);
}

// C — end-to-end: runImport routes AI exports through the streaming path
//     (buffer AND disk filePath), mycelium → JSZip, unknown → error.
{
  const { promises: fs } = await import('node:fs');
  const os = await import('node:os'); const path = await import('node:path');
  const { runImport } = await import('../src/ingest/run-import.js');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'imp-strm-'));
  const mkZip = async (files) => { const z = new JSZip(); for (const [k, v] of Object.entries(files)) z.file(k, v); return z.generateAsync({ type: 'nodebuffer' }); };
  const chatgpt = Array.from({ length: 30 }, (_, i) => ({ id: 'c' + i, mapping: { a: { message: { author: { role: 'user' }, content: { parts: ['q' + i] }, create_time: i } }, b: { message: { author: { role: 'assistant' }, content: { parts: ['a' + i] }, create_time: i + 0.5 } } } }));
  const claude = Array.from({ length: 20 }, (_, i) => ({ uuid: 'u' + i, chat_messages: [{ uuid: 'x' + i, sender: 'human', text: 'h' + i, created_at: '2026-01-01T00:00:00Z' }, { uuid: 'y' + i, sender: 'assistant', text: 'r' + i, created_at: '2026-01-01T00:01:00Z' }] }));
  const cgBuf = await mkZip({ 'conversations.json': JSON.stringify(chatgpt), 'img/x.png': Buffer.alloc(256) });
  const clBuf = await mkZip({ 'conversations.json': JSON.stringify(claude) });
  const cgFile = path.join(tmp, 'cg.zip'); await fs.writeFile(cgFile, cgBuf);
  let cap = []; const ctx = () => ({ db: {}, userId: 'u', capture: async (m) => { cap.push(m); return { deduped: false }; } });
  cap = []; const a = await runImport({ kind: 'archive', buffer: cgBuf }, ctx()); const aN = cap.length;
  cap = []; const b = await runImport({ kind: 'archive', buffer: clBuf }, ctx()); const bN = cap.length;
  cap = []; const c = await runImport({ kind: 'archive', filePath: cgFile }, ctx()); const cN = cap.length;
  let mycRouted = false;
  try { await runImport({ kind: 'archive', buffer: await mkZip({ 'manifest.json': JSON.stringify({ format: 'mycelium-vault-export' }) }) }, ctx()); }
  catch (e) { mycRouted = /rawQuery|importMyceliumVault|vault/i.test(e.message); }
  const unk = await runImport({ kind: 'archive', buffer: await mkZip({ 'random.txt': 'hi' }) }, ctx());
  await fs.rm(tmp, { recursive: true, force: true });
  rec('C1. ChatGPT export streamed from buffer', a.importResult?.type === 'chatgpt' && aN === 60, `type=${a.importResult?.type} msgs=${aN}`);
  rec('C2. Claude export streamed from buffer', b.importResult?.type === 'claude' && bN === 40, `type=${b.importResult?.type} msgs=${bN}`);
  rec('C3. ChatGPT export streamed from disk filePath', c.importResult?.type === 'chatgpt' && cN === 60, `type=${c.importResult?.type} msgs=${cN}`);
  rec('C4. mycelium manifest routes to the JSZip vault importer', mycRouted);
  rec('C5. unrecognized archive → honest error', !!unk.error);
}

console.log('\n' + '='.repeat(64));
console.log(fail ? 'VERDICT: NO-GO — streaming import primitives failed' : 'VERDICT: GO — gig-scale streaming primitives: >512MB JSON + streamed zip entry + caps');
console.log('='.repeat(64));
process.exit(fail);
