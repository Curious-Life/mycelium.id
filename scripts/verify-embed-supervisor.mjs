// Verify the embed-service supervisor (src/embed/supervisor.js) — the in-process
// owner of :8091 whose getEmbedderHealth() lets the UI tell "still embedding" from
// "embedder broken, here's the fix". Hermetic: injects a stub /health client and
// fake interpreters so NOTHING loads the real 132MB model.
//
// Asserts the health state machine + the actionable deps-missing path that is the
// root cause of the "generation hangs at Processing 0/N" report:
//   S1 healthy /health         → status 'ok'        (adopts; never spawns)
//   S2 model still loading      → status 'loading'   (NOT an error; keep waiting)
//   S3 model load failed        → status 'error'     (+ detail = the load_error)
//   S4 deps-less interpreter    → status 'deps_missing' + actionable setup.sh hint
//   S5 MYCELIUM_PYTHON honored   → resolvePython precedence (detail names that path)
//   S6 getEmbedderHealth before start → 'unknown' (never throws for the route)
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import { startEmbedSupervisor, getEmbedderHealth, _resetEmbedSupervisor } from '../src/embed/supervisor.js';

const ledger = [];
const rec = (name, pass, detail = '') => {
  ledger.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// A stub embed client: health() resolves the given payload, or throws (unreachable).
const stubClient = (payloadOrThrow) => ({
  async health() {
    if (payloadOrThrow instanceof Error) throw payloadOrThrow;
    return payloadOrThrow;
  },
});

async function main() {
  // S6 first — before any supervisor exists, the route's getter must be safe.
  {
    _resetEmbedSupervisor();
    const h = getEmbedderHealth();
    rec("S6. getEmbedderHealth() pre-start → 'unknown' (route-safe, no throw)",
      h && h.status === 'unknown', JSON.stringify(h));
  }

  // S1 — adopt a healthy service: probe succeeds → 'ok', and it never spawns.
  {
    _resetEmbedSupervisor();
    const sup = startEmbedSupervisor({ embed: stubClient({ status: 'ok', loaded: true, dim: 768 }), pythonBin: '/usr/bin/false' });
    await settle(80);
    const h = getEmbedderHealth();
    rec("S1. healthy /health → status 'ok' (adopted, no spawn)", h.status === 'ok', JSON.stringify(h));
    sup.stop();
  }

  // S2 — model loading: loaded:false → 'loading' (must NOT be an error).
  {
    _resetEmbedSupervisor();
    const sup = startEmbedSupervisor({ embed: stubClient({ status: 'loading', loaded: false }), pythonBin: '/usr/bin/false' });
    await settle(80);
    const h = getEmbedderHealth();
    rec("S2. model loading → status 'loading' (not an error)", h.status === 'loading', JSON.stringify(h));
    sup.stop();
  }

  // S3 — model load failed: status 'error' surfaced with the reason as detail.
  {
    _resetEmbedSupervisor();
    const sup = startEmbedSupervisor({ embed: stubClient({ status: 'error', loaded: false, load_error: 'onnx boom' }), pythonBin: '/usr/bin/false' });
    await settle(80);
    const h = getEmbedderHealth();
    rec("S3. model load failed → status 'error' + detail carries the reason",
      h.status === 'error' && /onnx boom/.test(h.detail || ''), JSON.stringify(h));
    sup.stop();
  }

  // S4 — deps-less interpreter: /health unreachable + the dep self-check fails
  // (/usr/bin/false exits 1) → 'deps_missing' with the actionable setup.sh hint.
  {
    _resetEmbedSupervisor();
    const sup = startEmbedSupervisor({ embed: stubClient(new Error('unreachable')), pythonBin: '/usr/bin/false' });
    await settle(250); // allow the async checkDeps spawn to resolve
    const h = getEmbedderHealth();
    rec("S4. deps-less python → status 'deps_missing' + setup.sh hint",
      h.status === 'deps_missing' && /setup\.sh/.test(h.message), JSON.stringify(h));
    sup.stop();
  }

  // S5 — MYCELIUM_PYTHON precedence: a bogus env interpreter (ENOENT) → deps_missing,
  // and the detail names exactly that path → resolvePython honored the env var.
  {
    _resetEmbedSupervisor();
    const prev = process.env.MYCELIUM_PYTHON;
    process.env.MYCELIUM_PYTHON = '/nonexistent/python-xyz';
    const sup = startEmbedSupervisor({ embed: stubClient(new Error('unreachable')) }); // no pythonBin → resolve from env
    await settle(250);
    const h = getEmbedderHealth();
    rec("S5. MYCELIUM_PYTHON honored (ENOENT interpreter → deps_missing naming that path)",
      h.status === 'deps_missing' && /nonexistent\/python-xyz/.test(h.detail || ''), JSON.stringify(h));
    sup.stop();
    if (prev === undefined) delete process.env.MYCELIUM_PYTHON; else process.env.MYCELIUM_PYTHON = prev;
  }

  _resetEmbedSupervisor();
  const allPass = ledger.every(Boolean);
  console.log('\n' + '='.repeat(64));
  console.log(`VERDICT: ${allPass
    ? 'GO — embed supervisor health state machine correct: ok/loading/error mapped, deps-less interpreter yields an ACTIONABLE deps_missing (setup.sh) instead of a silent dead process, MYCELIUM_PYTHON precedence honored, route-safe before start'
    : 'NO-GO — see FAIL rows'}`);
  console.log('='.repeat(64));
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-embed-supervisor threw:', e); process.exit(1); });
