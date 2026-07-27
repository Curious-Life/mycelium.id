// scripts/lib/gate-stdout.mjs — side-effect-only module. Imported FIRST by every
// scripts/verify-*.mjs. Enforced by `npm run verify:gate-stdout-flush`.
//
// THE DEFECT
// ----------
// `process.exit()` does NOT flush a pipe-backed stdout. Per the Node docs, writes to
// process.stdout are "asynchronous ... Pipes (and sockets): synchronous on Windows and
// Linux, asynchronous on macOS". So when a gate console.log()s a ledger larger than the
// pipe buffer (64 KiB) and the reader is not draining fast enough, the still-queued tail
// is DISCARDED by process.exit(): the report truncates mid-line and the trailing
// `VERDICT:` line is swallowed.
//
// Every gate in this repo ends by printing `VERDICT: GO` / `VERDICT: NO-GO` and exiting
// non-zero on failure. A caller that greps stdout for the verdict instead of checking the
// exit status therefore matches NOTHING when the verdict is swallowed — and "no match" can
// read as success. That is the M-001 "green for the wrong reason" class at suite scale.
//
// MEASURED on this platform (Node v22.22.3 / Darwin 25.5.0), a 20k-line (~1.8 MB) gate
// ledger followed by process.exit(), 10 trials per reader shape:
//     | grep -c VERDICT ............... lost  0/10   (grep drains continuously)
//     | tail -1 ....................... lost 10/10
//     | tee f | tail -1 ............... lost 10/10
//     | { sleep .3; cat; } ............ lost 10/10
//     | sort .......................... lost  1/10
//     $(command substitution) ......... lost  2/10   <-- NON-DETERMINISTIC
// With a fully stalled reader the output is hard-capped at 65472 bytes (64 KiB) regardless
// of how much was written. A TTY and a file redirect are synchronous on POSIX and never
// lose output; execFileSync/spawnSync/execSync consumers drain their pipes in the libuv
// loop and never lose output either (18 MB survived intact). The exposure is real pipes
// with a reader that stalls — and it is intermittent, which is worse than deterministic.
//
// THE FIX
// -------
// Clear O_NONBLOCK on the fd so every write completes synchronously as it is issued.
// Nothing is ever left queued, so process.exit() has nothing to drop. This holds on EVERY
// exit path — including an uncaught throw, a signal handler, or a process.exit() buried in
// a callback — which is why it is preferred here over rewriting the 506 `process.exit()`
// call sites across 382 gates to `process.exitCode`. That rewrite is NOT safe mechanically:
//   - ~255 of those sites are nested (inside main(), a .catch(), or an if-block). Converting
//     them would let execution FALL THROUGH — several gates read
//     `if (failed) { console.log('VERDICT: NO-GO'); process.exit(1); }` immediately before an
//     unconditional `console.log('VERDICT: GO')`, so the rewrite would print BOTH verdicts and
//     manufacture a new false green;
//   - many gates spin up servers, sqlite handles, or child processes and rely on
//     process.exit() to terminate. Letting Node exit naturally would HANG them on the open
//     handle and trip the suite watchdog;
//   - `process.exitCode` set early can be silently overwritten by any later assignment.
// Making the writes synchronous fixes the flush without touching a single control path.
//
// ORDERING IS LOAD-BEARING: setBlocking only affects writes issued AFTER it. Verified —
// set at the top of the file: 0/10 loss; set immediately before process.exit(): 10/10 loss.
// Hence the enforcing gate checks POSITION, not merely presence, of this import.
//
// Trade-off, accepted deliberately: with a blocking fd, a gate whose reader stalls forever
// now blocks instead of silently discarding its verdict. Backpressure is the correct
// behaviour — a stuck gate is visible, a gate that quietly drops its VERDICT is not.
//
// The exposed shape is narrow and worth naming: a parent that PIPES a gate and only reads
// after wait()-ing for it. Measured — such a parent leaves the writer STUCK indefinitely
// (>5 s and counting) where before it exited in 115 ms having discarded the tail. Note what
// is NOT exposed: execFileSync/spawnSync/execSync drain their pipes inside the libuv loop,
// and `npm run` uses stdio:'inherit' throughout, so `npm run verify` adds no pipe layer at
// all. Caveat for the unattended autonomous loop: a hung gate has no VERDICT either, so the
// "visible vs invisible" argument only holds while something is watching — a hang there
// costs suite wall-clock until the watchdog fires. That is still preferable to a green build
// resting on a verdict nobody received.
//
// `_handle.setBlocking` is an internal API (this is what the `set-blocking` package, and
// through it npm and yargs, has always done). It is therefore best-effort here, and the
// enforcing gate does NOT trust that this file ran: verify-gate-stdout-flush.mjs spawns a
// real gate-shaped child into a stalled pipe and asserts the VERDICT line actually survives.

for (const stream of [process.stdout, process.stderr]) {
  try {
    const handle = stream?._handle;
    if (handle && typeof handle.setBlocking === 'function') handle.setBlocking(true);
  } catch {
    // Best-effort. If the internal API ever disappears, the behavioural check in
    // verify:gate-stdout-flush REDs — that is the fail-loud layer, not this one.
  }
}
