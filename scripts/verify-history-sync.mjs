// verify:history-sync — the durable periodic sync (scripts/sync-claude-history.mjs)
// is incremental, idempotent, and fail-soft. Each scenario runs the real script in a
// fresh node subprocess against a stub :4711 + a temp HOME/projects dir, asserting:
//   H1 fresh import of a transcript (meta/tool entries skipped)
//   H2 unchanged file → stat-skip (NO re-read, NO server hit)
//   H3 appended turn → only the new turn syncs (line high-water mark)
//   H4 app down → exit 0, work deferred, state NOT advanced (retried next run)
//   H5 after the app is back → the deferred turn is picked up
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// ── stub :4711 — records imported ids, dedups, returns the bridge's result string ──
const seen = new Set();
let hits = 0, up = true;
const server = http.createServer((req, res) => {
  hits += 1;
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => {
    let msgs = [];
    try { msgs = JSON.parse(b).messages || []; } catch {}
    let nw = 0, dup = 0;
    for (const m of msgs) { if (seen.has(m.id)) dup += 1; else { seen.add(m.id); nw += 1; } }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: `imported ${msgs.length}: ${nw} new, ${dup} duplicates` }));
  });
});
const base = await new Promise((r) => { const s = server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)); });

// ── temp HOME (state dir) + projects dir ──
const home = mkdtempSync(join(tmpdir(), 'hsync-home-'));
const projects = mkdtempSync(join(tmpdir(), 'hsync-proj-'));
const projDir = join(projects, 'proj-a');
mkdirSync(projDir, { recursive: true });
const T = join(projDir, 'sess1.jsonl');

let ts = 1700000000000;
const entry = (type, text, extra = {}) => JSON.stringify({
  type, uuid: `u-${++ts}`, sessionId: 'sess1', timestamp: new Date(ts).toISOString(),
  message: { role: type, content: text }, ...extra,
}) + '\n';
// a real conversation turn + entries that MUST be skipped (tool_result user, meta types)
const toolResult = JSON.stringify({ type: 'user', uuid: `tr-${++ts}`, sessionId: 'sess1', timestamp: new Date(ts).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } }) + '\n';
const metaTitle = JSON.stringify({ type: 'ai-title', uuid: `m-${++ts}`, sessionId: 'sess1', message: { role: 'assistant', content: 'a title' } }) + '\n';

writeFileSync(T, entry('user', 'hello one') + toolResult + entry('assistant', 'reply one') + metaTitle);

const SCRIPT = join(process.cwd(), 'scripts/sync-claude-history.mjs');
function run() {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, CLAUDE_PROJECTS_DIR: projects, MYCELIUM_BASE_URL: base, MYCELIUM_MCP_BEARER: 'test-bearer', MYCELIUM_SYNC_DELAY_MS: '0' };
    let out = '';
    const cp = spawn('node', [SCRIPT], { env });
    cp.stdout.on('data', (d) => (out += d)); cp.stderr.on('data', (d) => (out += d));
    cp.on('close', (code) => resolve({ code, out: out.trim() }));
  });
}
const stateFile = join(home, '.mycelium-bridge', 'sync-state.json');
const readState = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return null; } }

// ── H1: fresh import (2 real turns; tool_result + meta skipped) ──
let before = hits;
let r = await run();
rec('H1. fresh import: 2 turns new, meta/tool skipped',
  r.code === 0 && seen.size === 2 && /2 new/.test(r.out) && hits > before, `seen=${seen.size} hits=${hits - before} :: ${r.out.split('\n').pop()}`);
rec('H1b. state file written with a high-water mark', !!readState() && Object.values(readState())[0]?.hwm > 0, JSON.stringify(readState()));

// ── H2: unchanged → stat-skip, no server hit ──
before = hits;
r = await run();
rec('H2. unchanged file → stat-skip (no server request)', r.code === 0 && hits === before && /0 changed/.test(r.out), `hits=${hits - before} :: ${r.out.split('\n').pop()}`);

// ── H3: append one new turn → only it syncs ──
before = hits; const seenBefore = seen.size;
appendFileSync(T, entry('user', 'hello two'));
r = await run();
rec('H3. appended turn → incremental sync of just the new turn',
  r.code === 0 && hits > before && seen.size === seenBefore + 1 && /1 new/.test(r.out), `+seen=${seen.size - seenBefore} :: ${r.out.split('\n').pop()}`);

// ── H4: app down → defer, exit 0, state NOT advanced for the changed file ──
await new Promise((res) => server.close(res)); up = false;
const stateBeforeDown = JSON.stringify(readState());
appendFileSync(T, entry('assistant', 'reply two while down'));
r = await run();
const deferred = /deferred/.test(r.out);
const stateUnchanged = JSON.stringify(readState()) === stateBeforeDown;
rec('H4. app down → exit 0, deferred, state for changed file NOT advanced',
  r.code === 0 && deferred && stateUnchanged, `exit=${r.code} deferred=${deferred} stateHeld=${stateUnchanged}`);

// ── H5: app back → the deferred turn is picked up ──
const server2 = http.createServer((req, res) => {
  hits += 1; let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => { let msgs = []; try { msgs = JSON.parse(b).messages || []; } catch {}; let nw = 0, dup = 0; for (const m of msgs) { if (seen.has(m.id)) dup += 1; else { seen.add(m.id); nw += 1; } } res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result: `${nw} new, ${dup} duplicates` })); });
});
// rebind the SAME port the script was configured with
const port = Number(base.split(':').pop());
await new Promise((res, rej) => { server2.listen(port, '127.0.0.1', res); server2.on('error', rej); });
const seenBeforeBack = seen.size;
r = await run();
rec('H5. app back → deferred turn now synced',
  r.code === 0 && seen.size === seenBeforeBack + 1 && /1 new/.test(r.out), `+seen=${seen.size - seenBeforeBack} :: ${r.out.split('\n').pop()}`);

await new Promise((res) => server2.close(res));
try { rmSync(home, { recursive: true, force: true }); rmSync(projects, { recursive: true, force: true }); } catch {}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(72));
console.log(`VERDICT: ${allPass ? 'GO — history-sync: incremental · idempotent · stat-skip · fail-soft defer/resume' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(72));
process.exit(allPass ? 0 : 1);
