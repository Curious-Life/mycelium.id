// Drives the REAL src/lib/generate.ts store against a stubbed `api`, so the phase mapping is
// verified by RUNNING it — not by grepping the source, which is a projection (S8's first
// version was satisfied by a comment; P6e before it by its own fix's prose).
//
// Why this harness exists at all: the store was UNGATED on the client and the route's skip
// branch was UNGATED on the server, which is exactly how "Illuminate does nothing" survived —
// the server returns 200 {jobId:null,status:'skipped'} (a SUCCESS: the map already exists) and
// the client mapped it to `error`, which nothing renders. @see DISTILLATION-SURFACE-DESIGN §2a.
//
// esbuild strips the TS types (vite's own dep, already present); everything else is the real
// module, including its real state machine.
import { build } from 'esbuild';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const GEN = '.gen-drive-generate';
rmSync(GEN, { recursive: true, force: true });
mkdirSync(GEN, { recursive: true });

// The scenario is chosen by the caller; each response is what the REAL route returns.
const SCENARIO = process.env.SCENARIO || 'skipped';
const RESPONSES = {
  // portal-mindscape.js:626-634 — topology already exists ⇒ nothing to do.
  skipped: { ok: true, status: 200, body: { jobId: null, status: 'skipped', reason: 'topology_exists', note: 'Map already built; pass ?force=1 to rebuild.' } },
  // a real start
  started: { ok: true, status: 200, body: { jobId: 'job-123', status: 'running' } },
  // a genuinely malformed 200 — this one MUST still be an error
  malformed: { ok: true, status: 200, body: { status: 'ok' } },
  // 503 keys/pipeline not ready
  unavailable: { ok: false, status: 503, body: { error: 'mindscape generation is unavailable' } },
};

const posts = [];
writeFileSync(`${GEN}/api-stub.js`, `
export const posts = ${JSON.stringify([])};
export async function api(path, init) {
  globalThis.__posts.push({ path, method: init?.method || 'GET' });
  const r = ${JSON.stringify(RESPONSES[SCENARIO])};
  return { ok: r.ok, status: r.status, body: null, json: async () => r.body };
}
`);

// esbuild's `alias` rejects relative specifiers, so intercept `./api` with a resolve plugin.
// ONLY that specifier is redirected; the rest of the module graph stays real.
const stubApi = {
  name: 'stub-api',
  setup(b) {
    b.onResolve({ filter: /^\.\/api$/ }, () => ({ path: `${process.cwd()}/${GEN}/api-stub.js` }));
  },
};

await build({
  entryPoints: ['src/lib/generate.ts'],
  outfile: `${GEN}/generate.js`,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  external: ['svelte/store'],
  plugins: [stubApi],
  logLevel: 'silent',
});

globalThis.__posts = posts;
const mod = await import(pathToFileURL(`${process.cwd()}/${GEN}/generate.js`).href);
const { generate, start, reset } = mod;
const { get } = await import('svelte/store');

await start();
const s = get(generate);
console.log(JSON.stringify({
  ok: true,
  scenario: SCENARIO,
  phase: s.phase,
  error: s.error,
  message: s.message,
  jobId: s.jobId,
  postCount: posts.filter((p) => p.method === 'POST').length,
}));

// A REAL start arms a 1.5s poll interval that never resolves against a stub, so the process
// would hang forever — which is a property of the module under test, not a harness bug.
// reset() clears it; exit(0) is the belt to that braces.
try { reset(); } catch { /* */ }
rmSync(GEN, { recursive: true, force: true });
process.exit(0);
