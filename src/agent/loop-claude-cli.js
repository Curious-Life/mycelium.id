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
// docs/HARNESS-CLI-DESIGN-2026-07-02.md for the stream-json mapping + threat model.
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_MODEL = 'claude-opus-4-8';
const DEFAULT_TTFB_MS = 45_000;
const DEFAULT_IDLE_MS = 60_000;
const DEFAULT_MAX_TURNS = 24;
const SIGKILL_GRACE_MS = 4_000;    // after SIGTERM, escalate to SIGKILL if the child clings
const HARD_TIMEOUT_MS = 10 * 60_000;   // absolute cap: run() ALWAYS resolves, even if 'close' never fires

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
export function createClaudeCliLoop({ claudeBin, restPort, model, logger = () => {}, spawnImpl = nodeSpawn, writeConfigImpl, cleanupImpl, tmpDir = tmpdir() }) {
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
      '--tools', 'mcp__mycelium__*',
      '--allowedTools', 'mcp__mycelium__*',
      '--max-turns', String(DEFAULT_MAX_TURNS),
    ];

    return await new Promise((resolve) => {
      let text = '';
      const toolsUsed = [];
      let currentTool = null;
      let streaming = false;
      let truncated = false;
      let aborted = false;
      let lastErr = null;
      let settled = false;
      let buffer = '';
      let lastActivity = Date.now();

      let killTimer = null;

      const child = spawnImpl(claudeBin, args, { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });

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
        resolve({ text, toolsUsed, truncated, capped: false, aborted, clientGone: !!a.signal?.aborted, fellBack: false, lastErr });
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
        // stream-json event envelope — see canonical runner.js:388-424 + the mapping
        // table in docs/HARNESS-CLI-DESIGN-2026-07-02.md.
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
      child.stderr?.on('data', (chunk) => { const s = chunk.toString().trim(); if (s) logger(`claude stderr: ${s.slice(0, 200)}`); });
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
