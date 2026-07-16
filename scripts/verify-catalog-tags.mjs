// verify:catalog-tags — confirm every model in the S6 catalog is a REAL,
// pullable Ollama tag. The catalog is the pull allowlist, so a typo or a
// hallucinated/renamed tag must never ship.
//
// NETWORK GATE. It is wired into `npm run verify` near the END of a 300+ gate
// chain (~position 248 as of 2026-07-16; the chain grows), so it
// is the one gate in the chain whose answer depends on a third party being up.
// That makes its FAILURE MODE the whole design problem:
//
//   2026-07-16, PR #170 (run 29489204001): the ONLY red gate in 300 was
//     FAIL  tag exists: openthinker:7b  manifest=502
//     VERDICT: NO-GO — a catalog tag does not resolve (fix src/hardware/catalog.js)
//   The tag was fine — the same manifest returned 200 on 3/3 probes moments
//   later, and a plain re-run went green. A registry.ollama.ai 502 had
//   discarded ~250 gates of signal and accused a correct catalog.js. That is
//   worse than a missing gate: it teaches people to re-run red CI without
//   reading it, which is exactly the habit that lets a REAL failure through.
//
// So this gate distinguishes THREE outcomes, never two:
//   exists    200 (or 401 — auth-gated, but the tag resolves)  → PASS
//   absent    404 — the registry positively says no such tag   → FAIL, NO-GO
//   degraded  5xx / 429 / 403 / timeout / network error, still
//             true after RETRIES                               → SKIP, DEGRADED
//
// A degraded probe is NOT a pass and NOT a catalog bug. It exits 2 with a
// verdict that names the network as the cause, so the chain still goes red
// (a vacuous green is the failure mode this repo already fights — see
// scripts/verify-chains.mjs) but red points at the right thing. There is no
// skip-env bypass, by design.
//
// Tag-precise check = the Ollama REGISTRY MANIFEST API:
//   https://registry.ollama.ai/v2/<ns>/<model>/manifests/<tag>
// A library *page* (ollama.com/library/<model>) only proves the MODEL exists,
// not the specific :tag — so we check the manifest.
//
// The classification + retry logic here is proven hermetically, against stubbed
// registry responses, by scripts/verify-catalog-tags-selftest.mjs.

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

export const MANIFEST_HOST = 'https://registry.ollama.ai';
export const ATTEMPTS = 3;
export const TIMEOUT_MS = 15_000;

/**
 * Names this gate cannot speak to. `ollama pull hf.co/<user>/<repo>:<quant>` is a
 * legitimate target, but it resolves against HUGGING FACE, not registry.ollama.ai —
 * probing the Ollama manifest API for one returns 404 (verified live), which this
 * gate would report as "the tag does not exist — fix catalog.js" for a correct
 * entry. That is the exact false-accusation class this gate exists to kill, so an
 * unsupported host is `unsupported`, never `absent`. No such entry exists today;
 * if one ever lands, teach this gate the HF API rather than deleting this guard.
 */
export const isUnsupportedName = (name) => /^hf\.co\//i.test(name) || /^huggingface\.co\//i.test(name);

/** registry.ollama.ai manifest URL for an `[<ns>/]<model>[:<tag>]` catalog name. */
export function manifestUrl(name) {
  const [left, tag = 'latest'] = name.split(':');
  // library/<model> for bare names; <ns>/<model> for namespaced (e.g. vanilj/foo).
  const path = left.includes('/') ? left : `library/${left}`;
  return `${MANIFEST_HOST}/v2/${path}/manifests/${tag}`;
}

/**
 * The whole point of this gate: only a 404 means "this tag does not exist".
 * Everything the registry says while it is unhealthy — 5xx, 429, 403, or no
 * answer at all (status 0) — means "we did not learn anything", never "absent".
 */
export function classifyStatus(status) {
  if (status === 200 || status === 401) return 'exists';
  if (status === 404) return 'absent';
  return 'transient';
}

/** Deterministic backoff before attempt n+1 (1 → 500ms, 2 → 1500ms, …). */
export const backoffMs = (attempt) => 500 * 3 ** (attempt - 1);

const nap = (ms) => new Promise((r) => setTimeout(r, ms));

async function probeOnce(url, fetchImpl, timeoutMs) {
  try {
    const r = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: r.status, note: String(r.status) };
  } catch (e) {
    // No answer at all: DNS, reset, TLS, abort-on-timeout. Status 0 → transient.
    return { status: 0, note: e?.name === 'TimeoutError' ? 'timeout' : `neterr:${e?.code || e?.name || 'unknown'}` };
  }
}

/**
 * Probe one tag, retrying only what is retryable.
 * → { name, url, verdict: 'exists'|'absent'|'degraded', status, tries, seen[] }
 */
export async function probeTag(name, opts = {}) {
  const {
    fetchImpl = fetch,
    attempts = ATTEMPTS,
    sleep = nap,
    timeoutMs = TIMEOUT_MS,
  } = opts;
  if (isUnsupportedName(name)) {
    return { name, url: null, verdict: 'unsupported', status: 0, tries: 0, seen: ['not-an-ollama-registry-name'] };
  }
  const url = manifestUrl(name);
  const seen = [];
  let status = 0;

  for (let i = 1; i <= attempts; i++) {
    const r = await probeOnce(url, fetchImpl, timeoutMs);
    status = r.status;
    seen.push(r.note);
    const verdict = classifyStatus(status);
    if (verdict !== 'transient') return { name, url, verdict, status, tries: i, seen };
    if (i < attempts) await sleep(backoffMs(i));
  }
  // Still nothing definitive after every attempt — degraded, NOT absent.
  return { name, url, verdict: 'degraded', status, tries: attempts, seen };
}

/**
 * Run the gate. Prints the ledger + verdict, returns the exit code.
 *   0 = GO        every tag resolves
 *   1 = NO-GO     at least one tag is genuinely absent (404) — fix catalog.js
 *   2 = DEGRADED  no 404s, but the registry never answered for some tags
 */
export async function run({ catalog, log = console.log, ...opts } = {}) {
  // An empty catalog would sail through the loop below and print
  // "GO — all 0 catalog tags resolve": a gate asserting nothing, reading as
  // coverage. Unreachable today (CATALOG is a committed 302-entry array), but
  // this is precisely the failure class verify-chains.mjs exists to prevent, so
  // the floor is explicit rather than inherited from the data.
  if (!catalog?.length) {
    log('\n' + '='.repeat(64));
    log('VERDICT: NO-GO — the catalog is EMPTY, so this gate verified nothing. '
      + 'A zero-tag pass is vacuous, not green. Check src/hardware/catalog.json loaded.');
    log('='.repeat(64));
    return 1;
  }

  const results = [];
  for (const m of catalog) {
    const r = await probeTag(m.name, opts);
    const mark = { exists: 'PASS', absent: 'FAIL', degraded: 'SKIP', unsupported: 'SKIP' }[r.verdict];
    log(`${mark}  tag exists: ${r.name}  manifest=${r.seen.join(',')}`);
    results.push(r);
  }

  const absent = results.filter((r) => r.verdict === 'absent');
  // `unsupported` rides with degraded: both mean UNVERIFIED, and neither is a
  // catalog bug — so neither may pass, and neither may accuse catalog.js.
  const degraded = results.filter((r) => r.verdict === 'degraded' || r.verdict === 'unsupported');

  let code;
  let verdict;
  if (absent.length) {
    code = 1;
    verdict = `NO-GO — ${absent.length} catalog tag(s) do NOT exist upstream (registry answered 404): `
      + `${absent.map((r) => r.name).join(', ')}. Fix src/hardware/catalog.js.`;
  } else if (degraded.length) {
    code = 2;
    const why = [...new Set(degraded.flatMap((r) => r.seen))].join(', ');
    verdict = `DEGRADED (SKIPPED, not GO) — ${degraded.length}/${catalog.length} tag(s) UNVERIFIED `
      + `(up to ${opts.attempts ?? ATTEMPTS} attempts each) [saw: ${why}]. No definitive answer came back `
      + `for these, so NOTHING here says a tag is bad and src/hardware/catalog.js is NOT implicated — `
      + `look at the network/registry. Coverage is incomplete, so this is not a pass: `
      + `${degraded.map((r) => r.name).join(', ')}`;
  } else {
    code = 0;
    verdict = `GO — all ${catalog.length} catalog tags resolve on the Ollama registry`;
  }

  log('\n' + '='.repeat(64));
  log(`VERDICT: ${verdict}`);
  log('='.repeat(64));
  return code;
}

// ── main ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { CATALOG } = await import('../src/hardware/catalog.js');
  process.exit(await run({ catalog: CATALOG }));
}
