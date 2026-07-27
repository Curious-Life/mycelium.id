// scripts/verify-claims-consent.mjs — the claim-discovery consent gate.
//
// pipeline/discover-claims.mjs profiles the owner from their OWN raw messages and runs
// every model call with sensitive:true. Under §4g the router's sensitive hard-block
// routes that content to runLocal — so the SENSITIVE path is precisely the one that
// lands on-box, on the most intimate content in the vault. It may therefore run ONLY
// the model the owner approved (settings.taskModels.categorize.model, resolved
// fail-closed by defaultLabelModel) — never a default.
//
// The defect this gate closes (increment M / #148, the same class as the narrate and
// area-summary fixes): the child built its router from resolveInferenceConfigForTask,
// which NEVER sets `localModel` (src/inference/resolve.js — grep it: zero hits). So the
// router's `localModel || env.LOCAL_MODEL || DEFAULT_LOCAL_MODEL` coalesce (router.js:77)
// silently resolved llama3.1 (local.js:14) — an 8B nobody approved.
//
// ALL THREE runLocal paths are reachable from this child, so no provider shape is safe:
//   - §4g sensitive US hard-block   (router.js:264)
//   - cloud-failure fallback        (router.js:281)
//   - no cloud configured           (router.js:287)
// Hence the contract asserted here: nothing approved ⇒ REFUSE, whatever the providers say.
//
// HONEST FAILURE: discovery is a background pipeline. A refusal must not read as
// "no claims found", so it exits 2 (not 0) and writes `run REFUSED` to the run log.
// Tier-3 fail-soft is PRESERVED for the genuinely transient case (model approved but
// Ollama unreachable ⇒ still exit 0) — this gate proves both halves of that split.
//
// Spawns the REAL child process against a REAL keyed vault and intercepts the Ollama
// wire, so every claim is about the model name that ACTUALLY reached /api/generate —
// not what a mock said.
//
// SCOPE, stated honestly: the child is a separate PROCESS, so this gate cannot patch
// its fetch — it redirects the child's OLLAMA_URL / provider base_url / embed port at
// loopback stubs and asserts on what arrives. It therefore observes the on-box model
// wire and the cloud-provider wire; it is NOT a general egress monitor and cannot see
// a call to a host it did not redirect. verify:egress + verify:providers-leak own that.
// Every outbound dependency IS redirected here (Ollama, cloud, embed), so the child
// has no un-stubbed network dependency and the gate is hermetic + deterministic.

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import Database from 'better-sqlite3';
import http from 'node:http';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { applyMigrations } from '../src/db/migrate.js';
import { createInferenceRouter } from '../src/inference/router.js';
import { DEFAULT_LOCAL_MODEL } from '../src/inference/local.js';
import { defaultLabelModel } from '../src/enrich/drainer.js';

const ledger = [];
const rec = (name, pass, detail = '') => { ledger.push(pass); console.log(`${pass ? '[✓]' : '[✗]'} ${name}${detail ? ` — ${detail}` : ''}`); };

const U = 'local-user';
const APPROVED = 'qwen3.5:4b';

console.log('\n=== verify:claims-consent — claim discovery never runs an unapproved on-box model ===\n');

const dir = mkdtempSync(join(tmpdir(), 'myc-claims-consent-'));
const DB = join(dir, 'vault.db');
const LOG = join(dir, 'claims-discovery.log');
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');

// ── A REAL keyed vault, seeded with the owner's own messages in the last complete
// day window (role='user' — what gatherEvidence actually reads).
const raw = new Database(DB);
applyMigrations(raw);
const now = new Date();
const yday = new Date(now.getTime() - 24 * 3600 * 1000);
const at = (h) => new Date(Date.UTC(yday.getUTCFullYear(), yday.getUTCMonth(), yday.getUTCDate(), h)).toISOString();
raw.prepare(`INSERT INTO users (id, display_name, type) VALUES (?,?,?)`).run(U, 'Owner', 'human');
for (let i = 0; i < 6; i++) {
  raw.prepare(`INSERT INTO messages (id, user_id, role, content, created_at) VALUES (?,?,?,?,?)`)
    .run(`m${i}`, U, 'user', `I keep choosing depth over speed when the work matters (${i}).`, at(9 + i));
}
const setSettings = (s) => raw.prepare(`UPDATE users SET settings = ? WHERE id = ?`).run(JSON.stringify(s), U);

// ── The Ollama interceptor, in a stub server. The child is a separate PROCESS, so it
// cannot see a monkey-patched fetch — we point OLLAMA_URL at this server instead and
// record every model name that reaches it. Any path other than Ollama's is recorded as
// an unexpected hit and fails the gate.
const seen = { models: [], other: [] };
const ollama = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url.includes('/api/generate') || req.url.includes('/api/chat')) {
      try { seen.models.push(JSON.parse(body).model); } catch { seen.models.push('<unparseable>'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // A well-formed but claim-free reply: this gate is about WHICH MODEL RAN, not
      // about the lifecycle's parse/persist (verify:claims-discovery owns that).
      res.end(JSON.stringify({ response: '[]', message: { content: '[]' }, done: true }));
      return;
    }
    seen.other.push(req.url);
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
const OLLAMA_URL = `http://127.0.0.1:${ollama.address().port}`;

// A stand-in CLOUD provider, bound on loopback and always 401. Two reasons it is not
// a real base_url: a gate must not depend on the network, and pointing a test provider
// at a live vendor makes the gate ITSELF egress on every run. 401 also buys us the
// cloud-FALLBACK path (router.js:281) — the second of the three runLocal routes.
const cloudHits = [];
const cloud = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; });
  req.on('end', () => {
    cloudHits.push(req.url);
    res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'token_not_found_in_db' }));
  });
});
await new Promise((r) => cloud.listen(0, '127.0.0.1', r));
const CLOUD_URL = `http://127.0.0.1:${cloud.address().port}/v1`;

const reset = () => { seen.models.length = 0; seen.other.length = 0; cloudHits.length = 0; try { rmSync(LOG); } catch { /* fresh */ } };

// ASYNC spawn, deliberately NOT spawnSync: the Ollama interceptor above is an
// in-process HTTP server, and spawnSync blocks this process's event loop — the child's
// request would never be answered and would time out, making a green "no model ran"
// that proves nothing. (That exact deadlock produced a false NO-GO while writing this.)
const runChild = (extraEnv = {}, args = []) => new Promise((resolve) => {
  const c = spawn('node', ['pipeline/discover-claims.mjs', '--cadence=day', ...args], {
    env: {
      ...process.env,
      MYCELIUM_DB: DB,
      MYCELIUM_USER_ID: U,
      MYCELIUM_DATA_DIR: dir,
      USER_MASTER: userHex,
      SYSTEM_KEY: systemHex,
      OLLAMA_URL,
      // Point the claim-matching embedder at a dead port: discoverWindow falls back to
      // lexical matching, which is all this gate needs. Without it the child reaches the
      // developer's REAL embed service on :8091 when it happens to be up — making the
      // gate non-hermetic (green or red depending on a service it isn't testing) and
      // quietly sending real claim text to a process this gate never observes.
      MYCELIUM_EMBED_PORT: '1',
      MYCELIUM_CLAIMS_TIMEOUT_MS: '8000',
      ...extraEnv,
    },
  });
  let stderr = '', stdout = '';
  c.stderr.on('data', (d) => { stderr += d; });
  c.stdout.on('data', (d) => { stdout += d; });
  c.on('close', (status) => resolve({ status, stderr, stdout }));
});
const logText = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '');

// ── A. NOTHING APPROVED ⇒ refuse, run nothing, and SAY SO. The core claim.
reset();
setSettings({});
let r = await runChild();
rec('A1 no approved on-box model ⇒ child exits 2 (refuses; does not substitute a default)',
  r.status === 2, `exit ${r.status}`);
rec('A2 …and NO model ran — zero calls reached Ollama',
  seen.models.length === 0, seen.models.join(','));
rec('A3 …the refusal is RECORDED in the run log (an empty run is diagnosable)',
  /run REFUSED/.test(logText()), logText().trim().split('\n').pop() || '<empty log>');
rec('A4 …the refusal names the remedy on stderr',
  /Settings → Intelligence/.test(r.stderr || ''), (r.stderr || '').trim().split('\n').pop() || '');
rec('A5 …and it does NOT look like a successful empty run ("run done" is absent)',
  !/run done/.test(logText()));

// ── A'. SCOPE: the refusal gates INFERENCE, not the process. --dry-run only counts
// evidence and never reaches a model, so it must still work on an unconfigured vault —
// it is the one diagnostic left when nothing is approved. Over-refusing here would
// break the tool you reach for precisely when discovery is refusing.
reset();
setSettings({});
r = await runChild({}, ['--dry-run']);
rec('A\'1 --dry-run on an unapproved vault still runs (consent gates inference, not the process)',
  r.status === 0, `exit ${r.status}`);
rec('A\'2 …and it still ran NO model', seen.models.length === 0, seen.models.join(','));
rec('A\'3 …and it reported the evidence count it found',
  /\(dry\).*6 evidence/.test(r.stdout || ''), (r.stdout || '').trim().split('\n').pop() || '');

// ── B. FAIL-CLOSED: an unreadable/garbage settings blob is not consent.
reset();
raw.prepare(`UPDATE users SET settings = ? WHERE id = ?`).run('{not json', U);
r = await runChild();
rec('B1 unreadable settings ⇒ still refuses (an error is not an approval)', r.status === 2, `exit ${r.status}`);
rec('B2 …and NO model ran', seen.models.length === 0, seen.models.join(','));

// ── C. THE REGRESSION: a connected CLOUD provider must not authorize an on-box run.
// Discovery is sensitive:true → §4g routes it on-box regardless of the cloud key, and
// even an EU provider can fall back to local on failure. A cloud key is not on-box consent.
reset();
raw.prepare(`INSERT INTO ai_providers (user_id, provider, label, auth_type, credentials, model_preference, base_url, is_active, status)
             VALUES (?,?,?,?,?,?,?,1,'active')`)
  .run(U, 'custom', 'StubCloud', 'api_key', JSON.stringify({ apiKey: 'sk-TEST' }), 'maestrale', CLOUD_URL);
setSettings({});
r = await runChild();
rec('C1 cloud provider connected but nothing approved on-box ⇒ still refuses', r.status === 2, `exit ${r.status}`);
rec('C2 …no on-box model ran on the strength of a cloud key', seen.models.length === 0, seen.models.join(','));
rec('C3 …and nothing unexpected was requested', seen.other.length === 0, seen.other.join(','));

// ── D. env is NOT consent. LOCAL_MODEL must not smuggle a model past the gate —
// it is the second arm of the very coalesce this fix defeats.
reset();
setSettings({});
r = await runChild({ LOCAL_MODEL: 'sneaky:70b' });
rec('D1 env LOCAL_MODEL set but nothing approved ⇒ still refuses (env is not consent)',
  r.status === 2, `exit ${r.status}`);
rec('D2 …and sneaky:70b never ran', !seen.models.includes('sneaky:70b'), seen.models.join(','));

// ── E'. CLOUD-FALLBACK lands on the APPROVED model (runLocal path #2, router.js:281).
// The stub cloud 401s, so the router falls back on-box. Before the fix that fallback
// was llama3.1; it must now be the owner's pick. This is the path narrate's #151 fix
// covers for narration — asserted here for claims.
reset();
setSettings({ taskModels: { categorize: { model: APPROVED } } });
r = await runChild();
// E'0 first: without it, a provider row that stops resolving would send this case down
// the no-cloud path with the approved model — and E'1/E'2 would BOTH still pass while
// silently testing the same thing as E. Assert the cloud was really tried.
rec('E\'0 the stub cloud was actually called (so this case really is the FALLBACK path)',
  cloudHits.length > 0, `${cloudHits.length} cloud call(s)`);
rec('E\'1 cloud fails ⇒ falls back on-box to the APPROVED model, never llama3.1',
  seen.models.length > 0 && seen.models.every((m) => m === APPROVED), [...new Set(seen.models)].join(',') || '<no on-box call>');
rec('E\'2 …and the child still exits 0 (a cloud 401 is not a consent failure)', r.status === 0, `exit ${r.status}`);

// ── E. NO CLOUD AT ALL + APPROVED ⇒ runs EXACTLY the approved model (runLocal path #3).
raw.prepare(`UPDATE ai_providers SET is_active = 0 WHERE user_id = ?`).run(U);
reset();
setSettings({ taskModels: { categorize: { model: APPROVED } } });
r = await runChild({ LOCAL_MODEL: 'sneaky:70b' });
rec('E1 approved on-box model ⇒ child runs (exit 0)', r.status === 0, `exit ${r.status} ${(r.stderr || '').slice(-200)}`);
rec('E2 …at least one on-box call was made', seen.models.length > 0, `${seen.models.length}`);
rec(`E3 …EVERY on-box call used the APPROVED model (${APPROVED}), not the default`,
  seen.models.length > 0 && seen.models.every((m) => m === APPROVED), [...new Set(seen.models)].join(','));
rec(`E4 …llama3.1 (the coalesce default) never ran`,
  !seen.models.includes(DEFAULT_LOCAL_MODEL), [...new Set(seen.models)].join(','));
rec('E5 …approval beats a conflicting env LOCAL_MODEL', !seen.models.includes('sneaky:70b'));
rec('E6 …and the run log names the on-box model that ran', new RegExp(`onbox=${APPROVED.replace('.', '\\.')}`).test(logText()),
  logText().trim().split('\n')[0] || '');

// ── F. TIER-3 FAIL-SOFT IS PRESERVED. The refusal must be narrow: an APPROVED model
// that is merely UNREACHABLE is transient, and must still no-op at exit 0. If this
// flips, the fix has over-reached and turned every Ollama hiccup into a hard failure.
reset();
setSettings({ taskModels: { categorize: { model: APPROVED } } });
r = await runChild({ OLLAMA_URL: 'http://127.0.0.1:1' }); // nothing listening
rec('F1 approved but model UNREACHABLE ⇒ exit 0 (Tier-3 fail-soft intact, not a refusal)',
  r.status === 0, `exit ${r.status}`);
rec('F2 …and it is logged as a run, not as a consent refusal',
  !/run REFUSED/.test(logText()), logText().trim().split('\n').pop() || '');

// ── G. FALSIFIABILITY / negative control. The hazard must still be live in the router:
// a router built the OLD way (no localModel) coalesces to llama3.1. If that ever stops
// being true, the assertions above are testing a straw man and must be rewritten.
const oldShape = createInferenceRouter({ env: {} }).config.localModel;
rec(`G1 negative control: a router with NO localModel still coalesces to '${DEFAULT_LOCAL_MODEL}'`,
  oldShape === DEFAULT_LOCAL_MODEL, String(oldShape));
rec('G2 …and env LOCAL_MODEL is the coalesce\'s second arm (so D1 guards a real hazard)',
  createInferenceRouter({ env: { LOCAL_MODEL: 'sneaky:70b' } }).config.localModel === 'sneaky:70b');
// The resolver is now the drainer's defaultLabelModel — THE one sanctioned reader of
// taskModels.categorize.model (resolveOnBoxModel was retired 2026-07-16: a second reader
// that disagreed about what silence means; see resolve.js's retirement note). Its default
// fallback IS null, so fail-closed is the resolver's own contract, not this call site's
// discipline. Pin it, so a future default change breaks here rather than silently
// re-arming the assume-consent defect.
rec('G3 …the resolver this fix relies on is fail-closed by default (unset AND throw ⇒ null)',
  (await defaultLabelModel({ users: { getSettings: async () => ({}) } }, U)) === null
  && (await defaultLabelModel({ users: { getSettings: async () => { throw new Error('x'); } } }, U)) === null);
rec('G4 …and the default is not what discovery ran (the fix is load-bearing)',
  DEFAULT_LOCAL_MODEL !== APPROVED);

ollama.close();
cloud.close();
raw.close();
rmSync(dir, { recursive: true, force: true });

const pass = ledger.filter(Boolean).length;
console.log(`\n${pass}/${ledger.length} checks passed`);
const ok = ledger.every(Boolean);
console.log('='.repeat(64));
console.log(ok
  ? 'VERDICT: GO — claim discovery runs only the owner-approved on-box model, refuses loudly when there is none, and stays fail-soft when it is merely unreachable'
  : 'VERDICT: NO-GO — see FAIL rows');
console.log('='.repeat(64));
process.exit(ok ? 0 : 1);
