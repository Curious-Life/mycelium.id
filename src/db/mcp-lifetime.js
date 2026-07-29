// src/db/mcp-lifetime.js — a stdio MCP server must not outlive the client that spawned it.
//
// OBSERVED ON A REAL MACHINE (2026-07-28): a `node src/index.js` MCP server spawned by
// Claude Code, parent pid still `claude`, **running for 2 h 54 m**, holding a vault open
// READ/WRITE. Its session was long gone. `src/index.js` had NO lifetime handling at all —
// no stdin EOF, no signal handlers — so it connected the transport and ran forever.
//
// WHY THAT MATTERS MORE THAN IT LOOKS. The stress harness (2026-07-28) found that ordinary
// concurrent writing does NOT corrupt this vault: 4 processes, mixed INSERT/UPDATE/DELETE
// over the real schema, 12 SIGKILLs mid-transaction, 12 competing checkpoints — all clean.
// So a second writer is not, by itself, the danger. But that harness runs ONE BUILD, and
// therefore cannot model the case these orphans actually represent: a process from a STALE
// WORKTREE, carrying a DIFFERENT MIGRATION LINEAGE, opening the vault and asserting its own
// schema. That is mechanism #1 in the 2026-07-16 root-cause doc — proven in production by
// the `attachments.transcribe_attempts` fingerprint — and it is untested by anything we
// have. This repo currently has 171 worktrees and 12 worktree vaults.
//
// An orphan is also a plain resource leak: it holds a handle, it keeps a WAL alive, and it
// is invisible. Bounding its lifetime shrinks the window for every mechanism at once, which
// is worth more than another guard aimed at one of them.
//
// THE CONTRACT: a stdio server's lifetime IS its stdin. When the client goes away the pipe
// closes; that is the canonical signal, and it is the one nobody was listening for.

/**
 * Bind this process's lifetime to its stdio client.
 *
 * @param {{ close?: Function, label?: string, log?: Function, pollMs?: number }} [o]
 * @returns {() => void} uninstall (tests)
 */
export function bindStdioLifetime({
  close, label = 'mcp', log = (m) => console.error(m), pollMs = 30_000,
  /** Exit after this long with no MCP traffic. 0 disables. Default 90 min. */
  idleMs = Math.max(0, Number(process.env.MYCELIUM_MCP_IDLE_MIN ?? 90) * 60_000),
} = {}) {
  // FAIL LOUDLY ON A MISSING close. The whole point of this helper is releasing the vault
  // handle when the client goes away; bound without one it still exits the process on
  // schedule and looks entirely healthy, while the handle it exists to release is never
  // released — the 3h21m orphan defect, silently restored. The gate that guarded this was
  // `assert.match(body, /close/)`, which matched prose in a nearby comment and survived
  // the call being reduced to `bindStdioLifetime({ label: 'stdio MCP' })`. A required
  // argument is worth more than a check that looks for one. Adversarial review, 2026-07-28.
  if (typeof close !== 'function') {
    throw new TypeError(`bindStdioLifetime(${label}): a close() handle is required — without it the vault handle is never released on shutdown`);
  }
  if (process.env.MYCELIUM_NO_STDIO_LIFETIME === '1') return () => {};
  let done = false;

  const shutdown = (why) => {
    if (done) return;
    done = true;
    log(`[mycelium] ${label}: ${why} — shutting down (a stdio server must not outlive its client)`);
    try { close?.(); } catch (e) { log(`[mycelium] ${label}: close failed (${e?.message || e})`); }
    process.exit(0);
  };

  // 1. THE canonical signal. `end` fires when the client's write end closes — i.e. Claude
  //    Code exited, crashed, or dropped the connection.
  process.stdin.on('end', () => shutdown('stdin closed'));
  process.stdin.on('close', () => shutdown('stdin closed'));
  // A read error on the pipe means the same thing in practice.
  process.stdin.on('error', () => shutdown('stdin error'));
  // DO NOT resume() here. The MCP SDK attaches its own stdin 'data' handler inside
  // StdioServerTransport.start() (node_modules/@modelcontextprotocol/sdk/.../stdio.js:12),
  // which connect() calls. Putting stdin into FLOWING MODE before that point delivers any
  // bytes already in flight to our listener and DISCARDS them — an independent reviewer
  // reproduced the `initialize` request being swallowed, which surfaces as an intermittent
  // handshake hang. Paused stdin buffers instead, which is what we want. This function must
  // therefore be called AFTER server.connect(transport); the transport resumes the stream,
  // and 'end' then reaches us normally. The ppid poll below covers the case where the
  // transport never starts at all.

  // 2. IDLE TIMEOUT — the case stdin EOF does NOT catch, and the one actually observed.
  //    The orphan found on 2026-07-28 had been running 3 h 21 m with its PARENT STILL ALIVE:
  //    `claude` held the pipe open, so from the child's side the client was still there and
  //    `end` never fired. A stdio server that has served no request in hours is not in use;
  //    holding a vault handle open indefinitely for it is pure risk with no benefit.
  //
  //    Activity = bytes on stdin, which is exactly what an MCP request is. No SDK internals
  //    needed, and it cannot drift from what the transport actually sees.
  //
  //    Exiting is safe for the client: MCP servers are respawned on demand. Doing nothing is
  //    not safe for the vault.
  let lastActivity = Date.now();
  process.stdin.on('data', () => { lastActivity = Date.now(); });
  if (idleMs > 0) {
    const idle = setInterval(() => {
      if (Date.now() - lastActivity >= idleMs) {
        shutdown(`idle for ${Math.round((Date.now() - lastActivity) / 60000)} min`);
      }
    }, Math.min(idleMs, 60_000));
    idle.unref?.();
  }

  // 3. Belt and braces: if the parent is SIGKILLed, some platforms leave the pipe open in
  //    another process and `end` never arrives. Re-parenting to pid 1 is unambiguous.
  const initialPpid = process.ppid;
  const poll = setInterval(() => {
    const now = process.ppid;
    if (now !== initialPpid && (now === 1 || now === 0)) shutdown(`parent ${initialPpid} exited`);
  }, pollMs);
  poll.unref?.();

  // 4. Ordinary termination still gets a clean close, so the handle is released and the WAL
  //    folded away rather than left for the next boot to replay.
  const onSig = (s) => () => shutdown(`received ${s}`);
  const onTerm = onSig('SIGTERM');
  const onInt = onSig('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);

  return () => {
    clearInterval(poll);
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    done = true;
  };
}

export default bindStdioLifetime;
