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

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { EventEmitter } from 'node:events';
import { startEmbedSupervisor, getEmbedderHealth, getEmbedSupervisor, _resetEmbedSupervisor } from '../src/embed/supervisor.js';

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

// A fake spawn that DISTINGUISHES the two spawns the supervisor makes: the checkDeps probe
// (`python -c "import …"`, which we resolve success) from the SERVICE spawn (`… --serve …`,
// which we count and keep alive). Lets S9 prove the double-spawn latch: concurrent ticks must
// yield AT MOST one live :8091 service, no matter how many retries land in the checkDeps window.
const makeCountingSpawn = () => {
  let serviceSpawns = 0;
  const fn = (_bin, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    if (args[0] === '-c') {
      child.pid = 4242;
      setImmediate(() => child.emit('close', 0)); // deps present
    } else {
      serviceSpawns += 1;
      child.pid = 5000 + serviceSpawns; // a live service: never emits exit
    }
    return child;
  };
  fn.serviceSpawns = () => serviceSpawns;
  return fn;
};

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

  // S7 — the retry route's reach: getEmbedSupervisor() exposes the LIVE instance + a nudge().
  // Before start it is null (route-safe: a null handle is a no-op, never a throw).
  {
    _resetEmbedSupervisor();
    rec('S7a. getEmbedSupervisor() pre-start → null (retry route no-ops, never throws)',
      getEmbedSupervisor() === null, JSON.stringify(getEmbedSupervisor()));
    const sup = startEmbedSupervisor({ embed: stubClient({ status: 'error', loaded: false, load_error: 'boom' }), pythonBin: '/usr/bin/false' });
    await settle(80);
    const handle = getEmbedSupervisor();
    rec('S7b. getEmbedSupervisor() returns the live instance with a nudge() the retry route calls',
      handle !== null && handle === sup && typeof handle.nudge === 'function', typeof handle?.nudge);
    sup.stop();
    rec('S7c. getEmbedSupervisor() → null after stop', getEmbedSupervisor() === null);
  }

  // S8 — nudge() (the /portal/embed/retry resume) forces an IMMEDIATE re-probe: a service that
  // reported 'error' recovers WITHOUT waiting a full 3s tick once nudge fires. The stub flips to
  // healthy; only nudge's synchronous tick can flip health within the 80ms settle (< TICK_MS=3000).
  {
    _resetEmbedSupervisor();
    let mode = 'error';
    const flip = { async health() { return mode === 'ok' ? { status: 'ok', loaded: true, dim: 768 } : { status: 'error', loaded: false, load_error: 'boom' }; } };
    const sup = startEmbedSupervisor({ embed: flip, pythonBin: '/usr/bin/false' });
    await settle(80);
    const before = getEmbedderHealth();
    mode = 'ok';
    getEmbedSupervisor()?.nudge();
    await settle(80); // << TICK_MS (3000): only the nudge-forced tick can recover health this fast
    const after = getEmbedderHealth();
    rec("S8. nudge() forces an immediate re-probe → 'error' recovers to 'ok' faster than a tick (the retry path works)",
      before.status === 'error' && after.status === 'ok', `${before.status} → ${after.status}`);
    sup.stop();
  }

  // S9 — the double-spawn latch: an unreachable :8091 forces tryStart; two extra nudges land during
  // the (async) checkDeps window. Only ONE service must spawn — the latch closes the child==null gap.
  {
    _resetEmbedSupervisor();
    const spawn = makeCountingSpawn();
    const sup = startEmbedSupervisor({ embed: stubClient(new Error('unreachable')), pythonBin: '/usr/bin/python3', spawn });
    sup.nudge(); sup.nudge(); // mash Retry across two surfaces while the first tryStart is mid-checkDeps
    await settle(200);
    rec('S9. concurrent ticks/retries spawn the service AT MOST once (no double :8091 — the in-flight latch)',
      spawn.serviceSpawns() === 1, `serviceSpawns=${spawn.serviceSpawns()}`);
    sup.stop();
  }

  _resetEmbedSupervisor();
  const allPass = ledger.every(Boolean);
  console.log('\n' + '='.repeat(64));
  console.log(`VERDICT: ${allPass
    ? 'GO — embed supervisor health state machine correct: ok/loading/error mapped, deps-less interpreter yields an ACTIONABLE deps_missing (setup.sh) instead of a silent dead process, MYCELIUM_PYTHON precedence honored, route-safe before start; and the retry path is wired — getEmbedSupervisor() exposes the live instance + nudge(), null before start / after stop (route-safe), and nudge() forces an immediate re-probe so /portal/embed/retry actually recovers a failed embedder'
    : 'NO-GO — see FAIL rows'}`);
  console.log('='.repeat(64));
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-embed-supervisor threw:', e); process.exit(1); });
