// child-stderr.mjs — surface a spawned pipeline child's stderr when it exits non-zero.
//
// WHY: gates that spawn a pipeline stage asserted on the exit CODE alone, so a failure
// printed as `exit=1 calls=0` — true, but it names no cause. When the vault writer lock
// started refusing these children (a fixture contending for the dev vault's lock file),
// the rows looked like a describe/gating regression; the child's actual error message was
// captured and thrown away. Diagnosing that cost a session. The child's own words are the
// cheapest signal a gate can give, so print them at the failure, not in a debugger.
//
// ⚠️ VERIFY GATES ONLY — never import this from src/. Gate children run against synthetic
// fixtures with throwaway keys, so their stderr is safe to print. A pipeline child of the
// REAL vault is not: an error message can echo its input (a JSON.parse failure quotes the
// text it choked on, and that text is a model narration OF VAULT CONTENT), which would put
// user plaintext in a log — CLAUDE.md rule 1, zero plaintext leakage. src/jobs.js already
// buffers real-vault child stderr; wiring this into it would turn that buffer into a leak.
//
// Deliberately stdout (not stderr) so it interleaves with the PASS/FAIL ledger in order.

// Node's uncaught-exception dump is MESSAGE first, frames after, and a chatty child (ONNX
// warm-up) can bury it. Keep BOTH ends: a tail-only cut drops the one line that names the
// cause (it truncated the lock error to "ibe] Fatal: Error: vault is already open…"), a
// head-only cut drops the throw at the end of a noisy log.
const HEAD = 400;
const TAIL = 400;

function clamp(s) {
  if (s.length <= HEAD + TAIL) return s;
  return `${s.slice(0, HEAD)}\n… ${s.length - HEAD - TAIL} chars elided …\n${s.slice(-TAIL)}`;
}

/**
 * Print a failed child's stderr. No-op on a clean exit.
 * @param {string} what   the script that ran, e.g. 'describe-clusters.js'
 * @param {number} status exit code (-1 by convention for spawn error / kill)
 * @param {string} stderr everything the child wrote to stderr
 */
export function reportChild(what, status, stderr) {
  if (status === 0) return;
  const body = clamp(String(stderr || '').trim());
  console.log(`      ↳ ${what} exit=${status}${body ? `, stderr:\n${body.replace(/^/gm, '        ')}` : ' (no stderr — killed by timeout?)'}`);
}

export default reportChild;
