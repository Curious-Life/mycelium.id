// scripts/verify-character-rest.mjs — the owner-gated self.md REST surface (P3).
//
// Boots the real portalCharacterRouter on an ephemeral port over a real encrypted
// mind-files store and drives it via HTTP. Proves: owner-gate (401 unauth), the
// read/write/diff/revert contract, that the fail-closed sanitize gate is REACHED
// through the REST write path (not just the tool path), operator provenance is
// entry-point-derived (a payload author is ignored), and traversal/oversize are
// refused.

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import crypto from 'node:crypto';
process.env.ENCRYPTION_MASTER_KEY = crypto.randomBytes(32).toString('hex');

import http from 'node:http';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { portalCharacterRouter } from '../src/portal-character.js';
import { createVoiceSampleStore } from '../src/tts/voice-sample-store.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

const root = await mkdtemp(path.join(tmpdir(), 'charrest-'));
// Voice samples resolve under dataDir; pin it to the test root so the router's
// renderer and our test store agree on one voice-samples dir.
process.env.MYCELIUM_DATA_DIR = root;
// Mock loopback render service so the audition endpoint is deterministic in CI
// (real MLX audio only exists on Apple Silicon).
let renderCalls = 0;
const mockRenderFetch = async () => { renderCalls++; return { ok: true, status: 200, async arrayBuffer() { return Buffer.from('AUDIO').buffer; } }; };
// Minimal in-memory settings store (mirrors db.users.{getSettings,updateSettings,create}).
const settings = new Map();
const db = { users: {
  create: async () => {},
  getSettings: async (u) => settings.get(u) || null,
  updateSettings: async (u, s) => { settings.set(u, s); },
} };
const app = express();
// Stub owner gate: owner iff the test header is present. Mirrors makePortalOwnerGate's
// req→user|null contract; the point is that the ROUTER refuses when it returns null.
app.use('/api/v1/portal', portalCharacterRouter({
  userId: 'local-user',
  agentRoot: root,
  fetch: mockRenderFetch,
  db,
  authenticatePortalRequest: (req) => (req.headers['x-test-owner'] === '1' ? { userId: 'local-user' } : null),
}));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/portal`;

const call = async (method, p, { owner = true, body } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(owner ? { 'x-test-owner': '1' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
};

try {
  const ZWSP = String.fromCharCode(0x200B); // zero-width space → invisible-unicode block
  const RLO = String.fromCharCode(0x202E);  // right-to-left override → bidi block
  const today = new Date().toISOString().split('T')[0];

  // ── C1: owner-gate — every route 401s without the owner header ─────────────
  ok((await call('GET',  '/character/being',        { owner: false })).status === 401, 'C1 GET being 401 unauth');
  ok((await call('PUT',  '/character/being',        { owner: false, body: { content: 'x' } })).status === 401, 'C1b PUT being 401 unauth');
  ok((await call('GET',  '/character/being/diff?date=' + today, { owner: false })).status === 401, 'C1c diff 401 unauth');
  ok((await call('POST', '/character/being/revert', { owner: false, body: { date: today } })).status === 401, 'C1d revert 401 unauth');

  // ── C2: empty being reads honestly ─────────────────────────────────────────
  let r = await call('GET', '/character/being');
  ok(r.status === 200 && r.json.content === '' && r.json.author === null && Array.isArray(r.json.snapshots) && r.json.snapshots.length === 0,
    'C2 empty being → content:"" author:null snapshots:[]', JSON.stringify(r.json));
  ok(r.json.tokenCap === 1200, 'C2b tokenCap surfaced (1200)');

  // ── C3: operator PUT writes + attributes 'operator'; a payload author is IGNORED ──
  r = await call('PUT', '/character/being', { body: { content: '# WHO YOU ARE\nWarm, direct.', author: 'agent', authorship: 'agent' } });
  ok(r.status === 200 && r.json.ok === true && r.json.tokens > 0, 'C3 PUT being ok + tokens', JSON.stringify(r.json));
  r = await call('GET', '/character/being');
  ok(r.json.content.includes('Warm, direct.') && r.json.author === 'operator', 'C3b GET shows operator authorship (payload author ignored)', r.json.author);

  // ── C4: a second PUT snapshots the prior state; diff shows the change ───────
  r = await call('PUT', '/character/being', { body: { content: '# WHO YOU ARE\nWarm, and blunt.' } });
  ok(r.status === 200, 'C4 second PUT ok');
  r = await call('GET', '/character/being');
  ok(r.json.snapshots.includes(today), 'C4b prior state snapshotted under today', JSON.stringify(r.json.snapshots));
  r = await call('GET', '/character/being/diff?date=' + today);
  const types = (r.json.ops || []).map((o) => o.type);
  ok(r.status === 200 && r.json.stat.changed === true && types.includes('add') && types.includes('del'),
    'C4c diff(snapshot→current) shows add+del', JSON.stringify(r.json.stat));

  // ── C5: revert restores the snapshot + re-attributes operator ──────────────
  r = await call('POST', '/character/being/revert', { body: { date: today } });
  ok(r.status === 200 && r.json.ok === true, 'C5 revert ok');
  r = await call('GET', '/character/being');
  ok(r.json.content.includes('Warm, direct.') && !r.json.content.includes('blunt') && r.json.author === 'operator',
    'C5b reverted to snapshot content, author operator', r.json.author);

  // ── C6: the fail-closed SANITIZE gate is REACHED through REST (F2) ──────────
  r = await call('PUT', '/character/being', { body: { content: 'hello' + RLO + 'world' } });
  ok(r.status === 422 && /^mindfile-blocked:/.test(r.json.error) && !/world/.test(JSON.stringify(r.json)),
    'C6 bidi-injection PUT → 422 content-free code', JSON.stringify(r.json));
  r = await call('PUT', '/character/being', { body: { content: 'a' + ZWSP + 'b' } });
  ok(r.status === 422 && /^mindfile-blocked:/.test(r.json.error), 'C6b zero-width PUT → 422');
  // and the blocked write did NOT change the stored being
  r = await call('GET', '/character/being');
  ok(r.json.content.includes('Warm, direct.'), 'C6c blocked write left being unchanged (no partial persist)');

  // ── C7: diff date validation — traversal / invalid / unknown ───────────────
  ok((await call('GET', '/character/being/diff?date=' + encodeURIComponent('../../self'))).status === 400, 'C7 diff traversal date → 400');
  ok((await call('GET', '/character/being/diff?date=2026-13-45')).status === 400, 'C7b diff invalid date → 400');
  ok((await call('GET', '/character/being/diff?date=2099-01-01')).status === 404, 'C7c diff unknown snapshot → 404');
  ok((await call('POST', '/character/being/revert', { body: { date: '2099-01-01' } })).status === 404, 'C7d revert unknown → 404');

  // ── C8: oversize PUT refused before the write path ─────────────────────────
  r = await call('PUT', '/character/being', { body: { content: 'x'.repeat(64 * 1024 + 1) } });
  ok(r.status === 413, 'C8 oversize PUT → 413', String(r.status));

  // ── C9: missing content → 400 ──────────────────────────────────────────────
  ok((await call('PUT', '/character/being', { body: {} })).status === 400, 'C9 PUT without content → 400');

  // ── C10: fresh operator write is NOT stale (hash matches live content) ──────
  await call('PUT', '/character/being', { body: { content: '# WHO YOU ARE\nStable.' } });
  r = await call('GET', '/character/being');
  ok(r.json.stale === false && r.json.undecryptable === false, 'C10 fresh write not stale', JSON.stringify({ s: r.json.stale, u: r.json.undecryptable }));

  // ── C11: ⭐ Lens-B fix — a self.md that EXISTS but won't decrypt is reported
  //    undecryptable+stale, NOT as an empty capsule the operator might overwrite.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(root, 'mind', 'self.md'), Buffer.concat([Buffer.from('MIND', 'latin1'), Buffer.from('not-a-valid-base64-envelope')]));
  r = await call('GET', '/character/being');
  ok(r.json.undecryptable === true && r.json.stale === true, 'C11 undecryptable self.md → undecryptable+stale flags', JSON.stringify({ u: r.json.undecryptable, s: r.json.stale, c: r.json.content }));

  // ── CV: the audition endpoint (▶ hear) ─────────────────────────────────────
  // CV1: owner-gated
  ok((await call('POST', '/character/voice/preview', { owner: false, body: { text: 'hi' } })).status === 401, 'CV1 preview 401 unauth');
  // CV2: no sample → honest 501 (voice-sample-pending), no render attempted
  renderCalls = 0;
  let cv = await call('POST', '/character/voice/preview', { body: { text: 'hi' } });
  ok(cv.status === 501 && cv.json?.error === 'voice-sample-pending', 'CV2 no sample → 501', JSON.stringify(cv.json));
  ok(renderCalls === 0, 'CV2b no render attempted without a sample');
  // CV3: with a sample → 200 audio/wav (mock service), one render call
  await createVoiceSampleStore({ baseDir: path.join(root, 'voice-samples') })
    .saveSample('personal-agent', { wav: Buffer.from('RIFFxxxxWAVE-sample'), sampleText: 'hello' });
  renderCalls = 0;
  const cvRes = await fetch(base + '/character/voice/preview', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': '1' }, body: JSON.stringify({ text: 'speak this' }),
  });
  ok(cvRes.status === 200 && (cvRes.headers.get('content-type') || '').includes('audio/wav') && renderCalls === 1,
    'CV3 sample present → 200 audio/wav via loopback render', `${cvRes.status}/${renderCalls}`);
  // CV4: rate limit — burst past 5/min → 429 eventually
  let got429 = false;
  for (let i = 0; i < 8; i++) { const rr = await call('POST', '/character/voice/preview', { body: { text: 'x' } }); if (rr.status === 429) { got429 = true; break; } }
  ok(got429, 'CV4 rate-limited after burst → 429');

  // ── CV5–CV8: the voice-sample management endpoints (capture → freeze → clear) ─
  ok((await call('POST', '/character/voice/sample', { owner: false, body: { wavB64: 'AAAA', sampleText: 'x' } })).status === 401, 'CV5 sample save 401 unauth');
  ok((await call('GET', '/character/voice', { owner: false })).status === 401, 'CV5b voice GET 401 unauth');
  // reset to a known-empty state, then freeze via the endpoint
  await call('DELETE', '/character/voice');
  cv = await call('GET', '/character/voice');
  ok(cv.status === 200 && cv.json.hasSample === false, 'CV6 empty → hasSample:false', JSON.stringify(cv.json));
  const wavB64 = Buffer.from('RIFF____WAVE-frozen-sample-bytes').toString('base64');
  cv = await call('POST', '/character/voice/sample', { body: { wavB64, sampleText: 'the quick brown fox' } });
  ok(cv.status === 200 && cv.json.ok === true, 'CV6b freeze sample → 200', JSON.stringify(cv.json));
  cv = await call('GET', '/character/voice');
  ok(cv.json.hasSample === true && cv.json.sampleText === 'the quick brown fox', 'CV6c GET reflects frozen sample', JSON.stringify(cv.json));
  // CV7: validation — missing transcript → 400; oversize → 413
  ok((await call('POST', '/character/voice/sample', { body: { wavB64, sampleText: '  ' } })).status === 400, 'CV7 blank transcript → 400');
  const bigB64 = 'A'.repeat(9 * 1024 * 1024 * 4 / 3 | 0); // ~9MB decoded > 8MB cap
  ok((await call('POST', '/character/voice/sample', { body: { wavB64: bigB64, sampleText: 'x' } })).status === 413, 'CV7b oversize sample → 413');
  // CV8: delete clears it
  ok((await call('DELETE', '/character/voice')).status === 200, 'CV8 delete → 200');
  ok((await call('GET', '/character/voice')).json.hasSample === false, 'CV8b hasSample:false after delete');

  // ── CV9: the voice DESCRIPTION (character sheet, §3) — CRUD + owner-gate ─────
  ok((await call('PUT', '/character/voice/description', { owner: false, body: { description: 'x' } })).status === 401, 'CV9 description 401 unauth');
  cv = await call('GET', '/character/voice');
  ok(cv.json.description === null, 'CV9b description null before set');
  const desc = 'A deep, resonant voice with the weight of age; dry humour underneath.';
  cv = await call('PUT', '/character/voice/description', { body: { description: desc } });
  ok(cv.status === 200 && cv.json.description === desc, 'CV9c set description → 200', String(cv.status));
  ok((await call('GET', '/character/voice')).json.description === desc, 'CV9d GET reflects description');
  // persists independently of the sample (deleting the sample keeps the description)
  await call('DELETE', '/character/voice');
  ok((await call('GET', '/character/voice')).json.description === desc, 'CV9e description survives sample delete');
  // over-length truncated to 500; null clears
  const long = 'z'.repeat(900);
  ok((await call('PUT', '/character/voice/description', { body: { description: long } })).json.description.length === 500, 'CV9f over-length truncated to 500');
  cv = await call('PUT', '/character/voice/description', { body: { description: null } });
  ok(cv.status === 200 && cv.json.description === null, 'CV9g null clears description');
} finally {
  await new Promise((r) => server.close(r));
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);
