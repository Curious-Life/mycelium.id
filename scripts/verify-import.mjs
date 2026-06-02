// Verify Phase I — the Import surface (/api/v1/portal/upload[/chunk|/complete]).
// Builds synthetic Claude + ChatGPT export zips in memory, drives both the
// single-shot and chunked transports, and asserts the importResult shape +
// that messages landed encrypted-at-rest through captureMessage (deduping on
// re-import). Also: unsupported-format grace, unrecognized-file rejection, and
// a regression check that the raw /api/v1/upload + compat routes still resolve.
//
//   I1 single-shot Claude   POST /upload (multipart file) → {importResult:{type:'claude',imported:2}}
//   I2 rows encrypted        messages stored, content NOT plaintext in the db file
//   I3 dedup                 re-import → imported:0, skipped:2
//   I4 chunked ChatGPT       /upload/chunk×2 + /upload/complete → {type:'chatgpt',imported:2}
//   I5 unsupported           obsidian zip → {type:'obsidian',imported:0,note}
//   I6 unrecognized          non-zip → 400 (safe error, no leak)
//   I7 regression            raw /api/v1/upload + compat /documents still resolve
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import crypto from 'node:crypto';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';

const DB = 'data/verify-import.db';
const KCV = 'data/verify-import-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const CLAUDE_TEXT = 'unmistakable-claude-plaintext-marker';
const CHATGPT_TEXT = 'unmistakable-chatgpt-plaintext-marker';

async function claudeZip() {
  const zip = new JSZip();
  zip.file('conversations.json', JSON.stringify([{
    uuid: 'c1', name: 'Conv 1', chat_messages: [
      { uuid: 'm1', sender: 'human', text: CLAUDE_TEXT, created_at: '2026-01-01' },
      { uuid: 'm2', sender: 'assistant', text: 'a reply', created_at: '2026-01-01' },
    ],
  }]));
  return zip.generateAsync({ type: 'nodebuffer' });
}
async function chatgptZip() {
  const zip = new JSZip();
  zip.file('conversations.json', JSON.stringify([{
    id: 'g1', title: 'Chat 1', mapping: {
      root: { id: 'root', message: null },
      n1: { id: 'n1', message: { author: { role: 'user' }, content: { content_type: 'text', parts: [CHATGPT_TEXT] }, create_time: 1 } },
      n2: { id: 'n2', message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['an answer'] }, create_time: 2 } },
    },
  }]));
  return zip.generateAsync({ type: 'nodebuffer' });
}
async function obsidianZip() {
  const zip = new JSZip();
  zip.file('notes/idea.md', '# A note\nsome thoughts');
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB); applyMigrations(raw); raw.close();

  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const { url, db } = srv;
  const uid = 'local-user';
  const M = (p) => `${url}/api/v1/portal${p}`;
  const postFile = (path, buf, name = 'export.zip') => {
    const fd = new FormData();
    fd.append('file', new Blob([buf]), name);
    return fetch(M(path), { method: 'POST', body: fd });
  };
  const jget = async (p) => { const r = await fetch(`${url}${p}`); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
  const countBySource = async (src) => {
    const r = await db.rawQuery('SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND source = ?', [uid, src]);
    return r.results?.[0]?.c ?? 0;
  };

  try {
    // ── I1 single-shot Claude ──
    const cz = await claudeZip();
    const r1 = await postFile('/upload', cz);
    const b1 = await r1.json().catch(() => ({}));
    rec('I1. single-shot Claude → {importResult:{type:claude,imported:2}}',
      r1.status === 200 && b1.importResult?.type === 'claude' && b1.importResult?.imported === 2,
      `status=${r1.status} type=${b1.importResult?.type} imported=${b1.importResult?.imported}`);

    // ── I2 rows landed + encrypted at rest ──
    const claudeRows = await countBySource('claude-import');
    const fileBytes = readFileSync(DB);
    const plaintextLeak = fileBytes.includes(Buffer.from(CLAUDE_TEXT));
    rec('I2. messages stored + content encrypted at rest (no plaintext in db file)',
      claudeRows === 2 && !plaintextLeak, `rows=${claudeRows} plaintextLeak=${plaintextLeak}`);

    // ── I3 dedup on re-import ──
    const r3 = await postFile('/upload', cz);
    const b3 = await r3.json().catch(() => ({}));
    rec('I3. re-import dedups (imported:0, skipped:2)',
      b3.importResult?.imported === 0 && b3.importResult?.skipped === 2 && (await countBySource('claude-import')) === 2,
      `imported=${b3.importResult?.imported} skipped=${b3.importResult?.skipped}`);

    // ── I4 chunked ChatGPT ──
    const gz = await chatgptZip();
    const mid = Math.floor(gz.length / 2);
    const parts = [gz.subarray(0, mid), gz.subarray(mid)];
    const uploadId = 'up_test123';
    for (let i = 0; i < parts.length; i++) {
      const fd = new FormData();
      fd.append('chunk', new Blob([parts[i]]));
      fd.append('uploadId', uploadId);
      fd.append('index', String(i));
      fd.append('filename', 'chatgpt.zip');
      const rc = await fetch(M('/upload/chunk'), { method: 'POST', body: fd });
      if (rc.status !== 200) { rec('I4. chunked ChatGPT', false, `chunk ${i} status=${rc.status}`); break; }
    }
    const rcomplete = await fetch(M('/upload/complete'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId, filename: 'chatgpt.zip', totalChunks: parts.length, fileSize: gz.length }),
    });
    const bc = await rcomplete.json().catch(() => ({}));
    rec('I4. chunked ChatGPT → {type:chatgpt,imported:2}',
      rcomplete.status === 200 && bc.importResult?.type === 'chatgpt' && bc.importResult?.imported === 2 && (await countBySource('chatgpt-import')) === 2,
      `status=${rcomplete.status} type=${bc.importResult?.type} imported=${bc.importResult?.imported}`);

    // ── I5 unsupported format (obsidian) → graceful ──
    const oz = await obsidianZip();
    const r5 = await postFile('/upload', oz);
    const b5 = await r5.json().catch(() => ({}));
    rec('I5. unsupported format → {type:obsidian,imported:0,note}',
      r5.status === 200 && b5.importResult?.type === 'obsidian' && b5.importResult?.imported === 0 && typeof b5.importResult?.note === 'string',
      `type=${b5.importResult?.type} note=${!!b5.importResult?.note}`);

    // ── I6 unrecognized (non-zip) → 400, safe error ──
    const r6 = await postFile('/upload', Buffer.from('this is not a zip archive'));
    const b6 = await r6.json().catch(() => ({}));
    rec('I6. unrecognized file → 400 safe error',
      r6.status === 400 && typeof b6.error === 'string' && !b6.error.includes('not a zip archive'),
      `status=${r6.status} error=${JSON.stringify(b6.error)}`);

    // ── I7 regression: raw /api/v1/upload + compat /documents still resolve ──
    const rawUp = await fetch(`${url}/api/v1/upload?filename=note.txt`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('hello raw'),
    });
    const docs = await jget('/api/v1/portal/documents');
    rec('I7. raw /api/v1/upload + compat /documents unaffected',
      rawUp.status === 200 && docs.status === 200 && Array.isArray(docs.body?.documents),
      `rawUpload=${rawUp.status} docs=${docs.status}`);
  } finally {
    srv.server.close(); try { srv.close?.(); } catch {}
  }

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? 'GO — Phase I: Claude/ChatGPT import (single-shot + chunked) → captureMessage, encrypted, deduped, graceful' : 'NO-GO — see FAIL rows'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-import threw:', e); process.exit(1); });
