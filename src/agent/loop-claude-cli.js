// src/agent/loop-claude-cli.js — the Claude Code (cli) agent engine.
//
// A drop-in for the native loop: same `run(args) → { text, toolsUsed, truncated,
// capped, aborted, clientGone, fellBack, lastErr }` contract (src/agent/loop.js:34,173),
// but instead of calling the provider API in-process it spawns the installed `claude`
// CLI in headless stream-json mode and pipes its NDJSON output to our SSE `send`.
//
// SECURITY (load-bearing):
//   - Tools reach the child over the LOOPBACK MCP endpoint only:
//     http://127.0.0.1:<restPort>/internal/mcp — which reuses the app's ALREADY-OPEN
//     vault (no second SQLite opener; no bearer; loopback-gated by isTrustedLoopback).
//   - The child is confined to the vault tools with `--allowedTools "mcp__mycelium__*"`.
//     We do NOT pass `--dangerously-skip-permissions` (canonical does) — that would also
//     grant the child Bash/Write/Read on the user's filesystem. This confinement is the
//     control that makes spawning safe; it MUST be confirmed against the installed CLI
//     (scripts/spike-claude-cli.mjs) before the engine is enabled (CLI_ENGINE_ENABLED).
//   - Credentials: the spawned `claude` authenticates with its OWN login (Keychain /
//     ~/.claude). Mycelium passes no token.
//
// Scoped to the interactive chat (trusted input) only. See
// the harness-CLI design for the stream-json mapping + threat model.
import { spawn as nodeSpawn } from 'node:child_process';
import { registerCrashKillChild } from '../system/crash-reaper.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeSpawnEnv } from '../inference/claude-config-dir.js';
// Auth-validity evidence, surface 'cli': this engine is ALWAYS subscription-backed
// (resolve-harness eligibility = an oauth row exists), but its `claude` child authenticates
// from its OWN store — the isolated dir when seeded, the MACHINE's ~/.claude login when the
// seed fail-softed — so its outcomes are recorded under their own surface, never pooled with
// the native wire's (subscription-auth-signal.js header: "chat works, channels 401" is a real
// state and a single boolean lies about one of them). Timestamps only.
import { recordSubscriptionTurnOutcome } from '../inference/subscription-auth-signal.js';

const DEFAULT_MODEL = 'claude-opus-4-8';
// Agentic-engine budgets. TTFB covers a cold start + MCP handshake before the first token;
// IDLE is the inter-output gap that means "truly hung". These are generous because `claude`
// legitimately goes quiet during in-session AUTO-COMPACTION (summarizing a long conversation)
// — a 60s idle used to SIGKILL it mid-compaction and lose the session. The watchdog also
// resets on EVERY stream-json line (see handle()), so any sign of life keeps a long turn alive;
// active work never trips these. Callers may override via a.ttfbMs / a.idleMs.
const DEFAULT_TTFB_MS = Number(process.env.MYCELIUM_CLI_TTFB_MS) || 120_000;
const DEFAULT_IDLE_MS = Number(process.env.MYCELIUM_CLI_IDLE_MS) || 180_000;
const DEFAULT_MAX_TURNS = Number(process.env.MYCELIUM_MAX_ITERATIONS) || 100;   // operator cap; `claude` still self-limits per turn
const SIGKILL_GRACE_MS = 4_000;    // after SIGTERM, escalate to SIGKILL if the child clings
// Absolute wall-clock cap: run() ALWAYS resolves, even if 'close' never fires. Generous so a
// legitimate 30-60min autonomous task completes; env-overridable. The idle watchdog catches a
// genuine hang far sooner — this is only the last-resort ceiling.
const HARD_TIMEOUT_MS = Number(process.env.MYCELIUM_CLI_HARD_TIMEOUT_MS) || 60 * 60_000;
// claude's session-lifecycle errors (verified live 2026-07-03): --session-id on an
// existing session, or --resume on a missing one. Caught → result.sessionError.
const SESSION_ERR_RE = /already in use|No conversation found with session ID/i;
// claude's auth-failure envelopes. Matched ONLY against stderr and is_error result payloads —
// the SESSION_ERR_RE discipline: never against the model's text stream, so an answer QUOTING
// "not logged in" can't flip the flag. Feeds the 'cli' auth-validity surface (see import).
const AUTH_ERR_RE = /not logged in|invalid api key|authentication[_ ]?error|oauth token .{0,20}(expired|revoked)|please run \/login|\b401\b/i;

// Build the mcp-config the child reads (`--mcp-config`). Points at the loopback
// /internal/mcp; server key `mycelium` ⇒ the CLI namespaces the tools as
// `mcp__mycelium__*` (matching --allowedTools). No bearer (loopback trust).
export function buildMcpConfig(restPort) {
  return { mcpServers: { mycelium: { type: 'http', url: `http://127.0.0.1:${restPort}/internal/mcp` } } };
}

/**
 * @param {object} deps
 * @param {string} deps.claudeBin              absolute path to `claude`
 * @param {number} deps.restPort               loopback REST port hosting /internal/mcp
 * @param {string} [deps.model]                model to run (the subscription's pref; falls back to opus)
 * @param {(m:string)=>void} [deps.logger]
 * @param {Function} [deps.spawnImpl]          test seam (defaults to node:child_process spawn)
 * @param {Function} [deps.writeConfigImpl]    test seam: (path, json) => void
 * @param {Function} [deps.cleanupImpl]        test seam: (path) => void
 * @param {string} [deps.tmpDir]               test seam: dir for the temp mcp-config
 * @returns {{ run: (a:object)=>Promise<object> }}
 */
export function createClaudeCliLoop({ claudeBin, restPort, model, configDir, logger = () => {}, spawnImpl = nodeSpawn, writeConfigImpl, cleanupImpl, tmpDir = tmpdir() }) {
  if (!claudeBin) throw new Error('createClaudeCliLoop: claudeBin required');
  if (!(Number(restPort) > 0)) throw new Error('createClaudeCliLoop: restPort required');

  async function run(a) {
    const send = typeof a.send === 'function' ? a.send : () => {};
    const ttfbMs = Number(a.ttfbMs) > 0 ? Number(a.ttfbMs) : DEFAULT_TTFB_MS;
    const idleMs = Number(a.idleMs) > 0 ? Number(a.idleMs) : DEFAULT_IDLE_MS;
    const runModel = model || a.provider?.cloudModel || DEFAULT_MODEL;

    // Write the per-run mcp-config (0600, carries no secret). A UNIQUE mkdtemp dir per
    // run avoids the collidable pid+model path (two concurrent same-model turns must not
    // share a file — one's cleanup would unlink the other's config mid-read). Tests
    // inject writeConfigImpl and don't touch real fs.
    let cfgDir = null;
    let cfgPath;
    const cfg = JSON.stringify(buildMcpConfig(restPort));
    try {
      if (writeConfigImpl) { cfgPath = join(tmpDir, 'mycelium-mcp.json'); writeConfigImpl(cfgPath, cfg); }
      else { cfgDir = mkdtempSync(join(tmpDir, 'mycelium-mcp-')); cfgPath = join(cfgDir, 'config.json'); writeFileSync(cfgPath, cfg, { mode: 0o600 }); }
    } catch (e) { return { text: '', toolsUsed: [], truncated: false, capped: false, aborted: false, clientGone: !!a.signal?.aborted, fellBack: false, lastErr: e }; }

    // Owner-only web access (agent/web-search.js): when enabled, WIDEN the confined toolset
    // to also allow the CLI's built-in `WebSearch` (Anthropic-run search — read-only, no URL
    // fetch). The CLI engine only ever runs portal chat (the owner), so this is owner-scoped by
    // construction. Bash/Edit/Write/Read stay excluded — we add ONE named built-in, not `*`.
    const cliTools = a.webSearch ? 'mcp__mycelium__* WebSearch WebFetch' : 'mcp__mycelium__*';
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', runModel,
      '--append-system-prompt', a.system || '',
      '--mcp-config', cfgPath,
      // CONFINEMENT — two independent layers (both verified live by
      // scripts/spike-claude-cli.mjs, 2026-07-02, claude 2.1.198):
      //  1. `--strict-mcp-config` — use ONLY our loopback MCP server, IGNORING the
      //     operator's Claude *account* connectors (Gmail/GDrive/Figma/…). Without it,
      //     `--mcp-config` merely ADDS to those connectors and the child inherits them
      //     (kept out only by the name-glob — a single fragile layer).
      //  2. `--tools "mcp__mycelium__*"` — restrict the AVAILABLE toolset to the vault
      //     tools only; this removes Bash/Edit/Write/Read (proven: with only
      //     `--allowedTools` the child still had + RAN Bash — `--allowedTools` is an
      //     auto-approve list, NOT a restriction).
      // `--allowedTools` then auto-approves the vault tools so `--print` doesn't hang on
      // a permission prompt. Spike S4 asserts init toolset == mcp__mycelium__* only.
      '--strict-mcp-config',
      '--tools', cliTools,
      '--allowedTools', cliTools,
      '--max-turns', String(DEFAULT_MAX_TURNS),
    ];
    // Session continuity (fix: a fresh `claude` session every turn lost context + never
    // auto-compacted). `--resume <id>` continues the conversation's existing session
    // (claude owns the memory + auto-compacts IN-session); `--session-id <id>` CREATES a
    // session with OUR id on the first turn. Reusing --session-id on an existing session
    // errors ("already in use"); resuming a missing one fails soft ("No conversation
    // found") — both are surfaced as result.sessionError so the caller can
    // persist-on-create / clear-on-resume-failure (self-heal). No id → legacy one-shot.
    const sid = (typeof a.sessionId === 'string' && a.sessionId) ? a.sessionId : null;
    if (sid) args.push(a.resume ? '--resume' : '--session-id', sid);

    return await new Promise((resolve) => {
      let text = '';
      const toolsUsed = [];
      let currentTool = null;
      let streaming = false;
      let truncated = false;
      let aborted = false;
      let lastErr = null;
      let sessionError = false;   // set on "already in use" / "No conversation found"
      let authError = false;      // set on an AUTH_ERR_RE envelope (stderr / is_error result only)
      let settled = false;
      let buffer = '';
      let lastActivity = Date.now();

      let killTimer = null;

      // CLAUDE_CONFIG_DIR points claude at the app's ISOLATED credential store (seeded from the
      // CONNECTED subscription) instead of the machine's ~/.claude / Keychain login — so the
      // agent runs as the account the user connected in the app, not whatever the machine is
      // signed into. claudeSpawnEnv ALSO injects USER/LOGNAME (a Finder/Dock-launched .app has no
      // USER → `claude` can't find its macOS Keychain login → "Not logged in" → the turn falls back
      // to a local model) + strips SDK-delegation vars for a deterministic standalone child. When
      // configDir is null CLAUDE_CONFIG_DIR is left at the machine default. See claude-config-dir.js.
      const childEnv = claudeSpawnEnv({ env: process.env, configDir: configDir || null });
      // NUL-STRIP (2026-07-15, live bug): node's spawn REJECTS any argv entry containing a
      // NUL byte — "The argument 'args[8]' must be a string without null bytes" — and args[8]
      // is `--append-system-prompt`, assembled from vault content. A vault that has suffered
      // page-level corruption carries stray NULs in text columns (observed: 27 rows whose
      // `scope` was 8 NUL bytes, plus JSON fragments), so ONE damaged row poisoned the prompt
      // and EVERY chat turn died before the model was even reached. Sanitize at the boundary
      // where the constraint actually lives, so no upstream assembler can reintroduce it.
      // NULs carry no meaning in these prompts — dropping them is lossless for real text.
      let _nulHits = 0;
      const safeArgs = args.map((v) => {
        if (typeof v !== 'string' || !v.includes('\u0000')) return v;
        _nulHits++;
        return v.replace(/\u0000/g, '');
      });
      if (_nulHits) {
        // Content-free (a count, never the text — CLAUDE.md §1). Strip is the fail-SAFE;
        // it must not be the only thing that happens, or the damage stays invisible.
        logger(`[cli] stripped NUL byte(s) from ${_nulHits} argv entr${_nulHits === 1 ? 'y' : 'ies'} — vault text is damaged (corruption artifact); the turn proceeds, but the vault needs a repair pass`);
      }
      const child = spawnImpl(claudeBin, safeArgs, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      registerCrashKillChild(child, 'claude-cli-turn'); // D-136

      const cleanup = () => {
        clearInterval(watch);
        clearTimeout(hardTimer);
        if (killTimer) clearTimeout(killTimer);
        if (onAbort && a.signal) { try { a.signal.removeEventListener('abort', onAbort); } catch { /* noop */ } }
        try {
          if (cleanupImpl) cleanupImpl(cfgPath);
          else if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
        } catch { /* best-effort */ }
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        // 'cli'-surface auth evidence. Only unambiguous outcomes are recorded: an auth
        // envelope is negative; a produced answer with no auth envelope is positive. A
        // stall/timeout/spawn-error says nothing about the CREDENTIAL and records nothing —
        // smearing 'needs_reconnect' from a wedged child is its own dishonesty.
        try {
          if (authError) recordSubscriptionTurnOutcome(false, { surface: 'cli' });
          else if (text && !lastErr && !sessionError) recordSubscriptionTurnOutcome(true, { surface: 'cli' });
        } catch { /* evidence is best-effort; never break the turn */ }
        resolve({ text, toolsUsed, truncated, capped: false, aborted, clientGone: !!a.signal?.aborted, fellBack: false, lastErr, sessionId: sid, sessionError });
      };
      // Terminate the child: SIGTERM, then SIGKILL after a grace window if it clings
      // (a child ignoring SIGTERM must never hang run() — the escalation guarantees the
      // 'close' that resolves us). Idempotent-ish: only arms the escalation once.
      const killChild = () => {
        try { child.kill('SIGTERM'); } catch { /* noop */ }
        if (!killTimer) killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, SIGKILL_GRACE_MS);
      };

      // Absolute cap: even if 'close'/'error' NEVER fire (wedged child, lost pipe),
      // run() always resolves and every timer is cleared — no hang, no interval leak.
      const hardTimer = setTimeout(() => { aborted = true; if (!lastErr) lastErr = new Error('claude cli hard timeout'); killChild(); finish(); }, HARD_TIMEOUT_MS);

      // Watchdog: mirror the native loop (TTFB before first token, IDLE after). On a
      // breach, onStall() + terminate the child; otherwise onHeartbeat while healthy.
      const watchTick = Math.max(500, Math.min(4000, Math.floor(ttfbMs / 4)));
      const watch = setInterval(() => {
        const limit = streaming ? idleMs : ttfbMs;
        if (Date.now() - lastActivity > limit) {
          aborted = true;
          try { a.onStall?.(); } catch { /* noop */ }
          killChild();
        } else if (!a.signal?.aborted) {
          try { a.onHeartbeat?.(); } catch { /* noop */ }
        }
      }, watchTick);

      const onAbort = () => { aborted = true; killChild(); };
      if (a.signal) {
        if (a.signal.aborted) onAbort();
        else a.signal.addEventListener('abort', onAbort, { once: true });
      }

      const handle = (data) => {
        // ANY line from the child = a sign of life → reset the idle watchdog. This is what
        // keeps a long AUTO-COMPACTION (which emits system/compact_boundary lines but no
        // content deltas) from being killed mid-summarize and losing the session. Content
        // deltas below ALSO reset it (redundant but explicit for the streaming-flag logic).
        lastActivity = Date.now();
        // stream-json event envelope — see canonical runner.js:388-424 + the mapping
        // table in the harness-CLI design.
        if (data?.type === 'stream_event' && data.event) {
          const ev = data.event;
          if (ev.type === 'content_block_start') {
            const cb = ev.content_block;
            if (cb?.type === 'tool_use') {
              currentTool = cb.name || 'tool';
              toolsUsed.push(currentTool);
              send({ type: 'tool_start', name: currentTool });
              lastActivity = Date.now();
            } else if (cb?.type === 'thinking') {
              send({ type: 'thinking_start' });
            }
          } else if (ev.type === 'content_block_delta') {
            const d = ev.delta;
            if (d?.type === 'text_delta' && d.text) {
              text += d.text;
              if (!streaming) { streaming = true; send({ type: 'responding' }); }
              send({ type: 'text_delta', content: d.text });
              lastActivity = Date.now();
            } else if (d?.type === 'thinking_delta' && d.text) {
              if (!streaming) { streaming = true; send({ type: 'responding' }); }
              send({ type: 'thinking_delta', content: d.text });
              lastActivity = Date.now();
            }
          } else if (ev.type === 'content_block_stop') {
            if (currentTool) { send({ type: 'tool_complete', name: currentTool }); currentTool = null; lastActivity = Date.now(); }
          }
        } else if (data?.type === 'result') {
          if (typeof data.result === 'string' && data.result) text = data.result;   // final overwrites accumulated
          if (data.subtype === 'error_max_turns') truncated = true;
          // Session-lifecycle failure surfaces ONLY as an is_error result (verified live in
          // stream-json: subtype 'error_during_execution' + errors:['No conversation found
          // with session ID …']). Match it HERE — never against the model's text stream —
          // so a benign answer quoting "already in use" can't spuriously flip the flag.
          if (data.is_error === true && SESSION_ERR_RE.test(JSON.stringify(data.errors || data.result || data.subtype || ''))) sessionError = true;
          // Auth failure surfaces the same way (is_error envelope) — same never-the-text-stream rule.
          if (data.is_error === true && AUTH_ERR_RE.test(JSON.stringify(data.errors || data.result || data.subtype || ''))) authError = true;
          if (data.usage) send({ type: 'usage', inputTokens: data.usage.input_tokens || 0, outputTokens: data.usage.output_tokens || 0 });
        }
      };

      child.stdout?.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const s = line.trim();
          if (!s) continue;
          try { handle(JSON.parse(s)); } catch { /* skip non-JSON lines */ }
        }
      });
      // stderr also carries the plain session error (belt-and-suspenders; it is stderr,
      // never the model's answer, so no false-positive risk).
      child.stderr?.on('data', (chunk) => { const s = chunk.toString().trim(); if (s) { if (SESSION_ERR_RE.test(s)) sessionError = true; if (AUTH_ERR_RE.test(s)) authError = true; logger(`claude stderr: ${s.slice(0, 200)}`); } });
      child.on('error', (err) => { lastErr = err; logger(`claude spawn error: ${err.message}`); finish(); });
      child.on('close', () => {
        if (buffer.trim()) { try { handle(JSON.parse(buffer.trim())); } catch { /* ignore trailing */ } }
        finish();
      });

      // Prompt via stdin (raw UTF-8; history is in --append-system-prompt).
      try { child.stdin?.write(a.userMessage || ''); child.stdin?.end(); }
      catch (e) { lastErr = e; try { child.kill('SIGTERM'); } catch { /* noop */ } finish(); }
    });
  }

  return { run };
}
