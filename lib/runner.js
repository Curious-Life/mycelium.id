/**
 * Unified Execution Runner
 *
 * Combines all modules into a single execution pipeline:
 * 1. Enqueue in lane (serialize per agent)
 * 2. Run with timeout (dynamic based on task type)
 * 3. Run with fallback (try multiple models)
 * 4. Classify errors and recover
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getTimeout, TIMEOUTS } from './timeouts.js';
import { classifyError, captureError, getRecoveryAction, sleep } from './error-classifier.js';
import { runWithFallback, getModelArg } from './model-fallback.js';
import { enqueue } from './lanes.js';
import { getAgentPaths, readFile, writeFile } from './paths.js';
import {
  writeCheckpoint,
  updateCheckpoint,
  clearCheckpoint,
  hashPrompt,
  wasRecentlyCompleted,
  markCompleted,
} from './checkpoint.js';
import { generateSessionId, saveSession } from './session-store.js';

// Energy recording (opt-in: if energy.js doesn't exist, recording is a no-op)
let recordEnergy = async () => {};
try { ({ recordEnergy } = await import('./energy.js')); } catch {}

// Full path to Claude Code CLI (required for PM2 environment)
// Common locations: /usr/bin/claude, /home/claude/.local/bin/claude, /usr/local/bin/claude
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/usr/bin/claude';

/**
 * Run a task with timeout
 *
 * @param {Function} taskFn - Async function to execute
 * @param {string} taskType - Type of task (chat, think, research, build)
 * @param {Object} options - Additional options
 * @returns {Promise<*>}
 */
export async function runWithTimeout(taskFn, taskType, options = {}) {
  const timeout = options.timeout || getTimeout(taskType);
  const gracePeriod = options.gracePeriod || TIMEOUTS.gracePeriod;

  return new Promise((resolve, reject) => {
    let completed = false;
    let graceTimeout = null;

    // Main timeout
    const mainTimeout = setTimeout(() => {
      if (completed) return;

      console.log(`[Runner] Task timeout warning (${taskType}: ${timeout / 1000}s), starting grace period...`);

      // Grace period for cleanup
      if (options.onTimeout) {
        options.onTimeout();
      }

      graceTimeout = setTimeout(() => {
        if (completed) return;
        reject(new Error(`Task timed out after ${(timeout + gracePeriod) / 1000}s`));
      }, gracePeriod);
    }, timeout);

    // Execute task
    taskFn()
      .then(result => {
        completed = true;
        clearTimeout(mainTimeout);
        if (graceTimeout) clearTimeout(graceTimeout);
        resolve(result);
      })
      .catch(error => {
        completed = true;
        clearTimeout(mainTimeout);
        if (graceTimeout) clearTimeout(graceTimeout);
        reject(error);
      });
  });
}

/**
 * Check if an error is retryable (transient API errors)
 */
function isRetryableError(error) {
  const msg = error?.message || '';
  // API 500 errors
  if (msg.includes('API Error: 500') || msg.includes('Internal server error')) return true;
  // Rate limits
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('overloaded')) return true;
  // Network errors
  if (msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed')) return true;
  // Service unavailable
  if (msg.includes('503') || msg.includes('502')) return true;
  return false;
}

/**
 * Run Claude Code with proper timeout, process management, retry logic, and checkpoint persistence
 *
 * Returns { result, sessionId } where sessionId is the Claude Code session UUID
 * (needed for subsequent --resume calls).
 *
 * @param {string} prompt - The prompt to send (just the NEW message, not full history)
 * @param {Object} options - Options
 * @param {string} options.model - Model to use (sonnet, haiku, opus)
 * @param {string} options.cwd - Working directory
 * @param {string} options.taskType - Task type for timeout
 * @param {AbortSignal} options.signal - Abort signal (used by spawner for TTL)
 * @param {number} options.maxRetries - Max retry attempts (default: 3)
 * @param {number} options.retryDelay - Initial retry delay ms (default: 2000)
 * @param {string} options.agentRoot - Root directory for checkpoint persistence
 * @param {string} options.agentId - Agent identifier for checkpoint
 * @param {Object} options.deliveryContext - Notification context for recovery
 * @param {string} options.sessionId - Internal session ID for checkpoint (auto-generated if not provided)
 * @param {string} options.resumeSessionId - Claude Code session UUID to --resume
 * @param {string} options.systemPrompt - System prompt for new Claude Code sessions
 * @param {boolean} options.isResume - Whether this is a resumed session
 * @returns {Promise<{ result: string, sessionId: string|null }>} Response text and Claude Code session UUID
 */
export async function runClaudeCode(prompt, options = {}) {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelay = options.retryDelay ?? 2000;
  const { agentRoot, agentId, deliveryContext, taskType, model, maxTurns, timeout } = options;
  const skipDedup = options.skipDedup ?? false;
  const isResume = options.isResume ?? false;

  // Internal session ID for checkpoint/crash recovery (not the Claude Code UUID)
  const internalSessionId = options.sessionId || generateSessionId();

  // Deduplication check - skip if same prompt was just completed
  const promptHash = hashPrompt(prompt);
  if (agentRoot && !skipDedup && !isResume) {
    if (await wasRecentlyCompleted(agentRoot, promptHash)) {
      console.log(`[Runner] Skipping duplicate task (session: ${internalSessionId})`);
      return { result: '[Skipped - duplicate task]', sessionId: null };
    }
  }

  // Write checkpoint BEFORE starting (restart sentinel pattern)
  if (agentRoot) {
    try {
      await saveSession(agentRoot, internalSessionId, [
        { role: 'user', content: prompt }
      ], {
        taskType: taskType || 'chat',
        model: model || 'sonnet',
        deliveryContext: deliveryContext || {},
        isResume: isResume || false,
        resumeSessionId: options.resumeSessionId || null,
      });

      const checkpoint = await writeCheckpoint(agentRoot, {
        agentId: agentId || 'unknown',
        taskType: taskType || 'chat',
        sessionId: internalSessionId,
        resumeSessionId: options.resumeSessionId || null,
        state: 'running',
        promptSummary: prompt.slice(0, 500),
        promptHash,
        deliveryContext: deliveryContext || {},
        model: model || 'sonnet',
        maxTurns: maxTurns || 50,
        timeout: timeout || getTimeout(taskType || 'chat'),
      });
      console.log(`[Runner] Checkpoint written: ${checkpoint.id.slice(0, 8)} (session: ${internalSessionId})`);
    } catch (err) {
      console.error('[Runner] Failed to write checkpoint:', err.message);
    }
  }

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const { result, sessionId: claudeSessionId, hitMaxTurns } = await runClaudeCodeOnce(prompt, options);

      // Save response to session and clear checkpoint on success
      if (agentRoot) {
        await markCompleted(agentRoot, promptHash);

        await saveSession(agentRoot, internalSessionId, [
          { role: 'user', content: prompt },
          { role: 'assistant', content: result }
        ], {
          taskType: taskType || 'chat',
          model: model || 'sonnet',
          completedAt: new Date().toISOString(),
          claudeSessionId,
        });

        await clearCheckpoint(agentRoot, internalSessionId);
        console.log(`[Runner] Checkpoint cleared (success, session: ${internalSessionId}, claude: ${claudeSessionId?.slice(0, 8) || 'none'})`);
      }

      return { result, sessionId: claudeSessionId, hitMaxTurns };
    } catch (error) {
      lastError = error;

      if (attempt < maxRetries && isRetryableError(error)) {
        const delay = initialDelay * Math.pow(2, attempt) + Math.random() * 1000;
        console.log(`[Runner] Retryable error (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}`);
        console.log(`[Runner] Retrying in ${Math.round(delay / 1000)}s...`);
        await sleep(delay);
      } else {
        // Enrich error with classification metadata for continuation system
        if (!error.errorReason) {
          error.errorReason = classifyError(error);
        }
        captureError(error, { agentId: agentRoot, taskType: taskType || 'chat' });

        if (agentRoot) {
          await saveSession(agentRoot, internalSessionId, [
            { role: 'user', content: prompt },
            { role: 'error', content: error.message }
          ], {
            taskType: taskType || 'chat',
            model: model || 'sonnet',
            error: error.message,
            failedAt: new Date().toISOString(),
          });

          await updateCheckpoint(agentRoot, internalSessionId, {
            state: 'failed',
            error: error.message,
            completedAt: new Date().toISOString(),
          });
          console.log(`[Runner] Checkpoint updated (failed, session: ${internalSessionId}): ${error.message.slice(0, 50)}`);
        }
        throw error;
      }
    }
  }
  throw lastError;
}

/**
 * Single attempt to run Claude Code
 *
 * @param {string} prompt - The prompt to send
 * @param {Object} options
 * @param {string} [options.model] - Model to use
 * @param {string} [options.cwd] - Working directory
 * @param {string} [options.taskType] - Task type for timeout
 * @param {number} [options.maxTurns] - Max tool use cycles
 * @param {number} [options.timeout] - Timeout in ms
 * @param {AbortSignal} [options.signal] - Abort signal
 * @param {string} [options.resumeSessionId] - Claude Code session UUID to --resume
 * @param {string} [options.systemPrompt] - System prompt for new sessions
 * @param {Function} [options.onActivity] - Callback for real-time activity events: (type, data) => void
 * @returns {Promise<{ result: string, sessionId: string|null }>}
 */
function runClaudeCodeOnce(prompt, options = {}) {
  const model = options.model || 'sonnet';
  const cwd = options.cwd || process.cwd();
  const timeout = options.timeout || getTimeout(options.taskType || 'chat');
  const gracePeriod = TIMEOUTS.gracePeriod;
  const maxTurns = options.maxTurns || 50;
  const onActivity = options.onActivity || null;

  return new Promise((resolve, reject) => {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', model,
      '--max-turns', String(maxTurns),
    ];

    // System prompt for new sessions
    if (options.systemPrompt) {
      args.push('--system-prompt', options.systemPrompt);
    }

    // Resume a specific Claude Code session by UUID
    // --resume <sessionId> = specific session; --continue = most recent in cwd (we don't use --continue)
    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
    }

    args.push('--dangerously-skip-permissions');

    // Load MCP servers from project .claude/settings.json if it exists
    const mcpConfigPath = options.mcpConfigPath || path.join(cwd, '.claude', 'settings.json');
    try {
      fs.accessSync(mcpConfigPath);
      args.push('--mcp-config', mcpConfigPath);
    } catch { /* no MCP config */ }

    // NOTE: prompt is passed via stdin, not CLI args (to avoid E2BIG errors with large prompts)

    const resumeInfo = options.resumeSessionId ? ` (resuming ${options.resumeSessionId.slice(0, 8)}...)` : ' (new session)';
    console.log(`[Runner] Spawning Claude Code: ${CLAUDE_BIN} in ${cwd}${resumeInfo}`);
    console.log(`[Runner] Args: --print --output-format stream-json --model ${model} --max-turns ${maxTurns} [prompt ${prompt.length} chars]`);

    const claude = spawn(CLAUDE_BIN, args, {
      cwd,
      env: { ...process.env, HOME: process.env.HOME || '/home/claude' },
      stdio: ['pipe', 'pipe', 'pipe'],  // stdin=pipe (for prompt), stdout=pipe, stderr=pipe
    });

    // Write prompt to stdin (avoids E2BIG error with large prompts)
    claude.stdin.write(prompt);
    claude.stdin.end();

    console.log(`[Runner] Claude process spawned, pid: ${claude.pid}`);

    let fullOutput = '';
    let sessionId = null;
    let resultSubtype = null;
    let buffer = '';
    let stderr = '';
    let killed = false;
    let timedOut = false;
    let currentToolName = null;
    let usageData = null;
    const startTime = Date.now();

    // Timeout handling - use SIGINT for CLI tools (more graceful than SIGTERM)
    const timeoutTimer = setTimeout(() => {
      if (killed) return;
      timedOut = true;
      console.log(`[Runner] Claude Code timeout, sending SIGINT...`);
      claude.kill('SIGINT');

      // Grace period then SIGKILL
      setTimeout(() => {
        if (!killed) {
          console.log(`[Runner] Grace period expired, sending SIGKILL...`);
          claude.kill('SIGKILL');
        }
      }, gracePeriod);
    }, timeout);

    // Handle abort signal (used by spawner for TTL enforcement)
    if (options.signal) {
      const onAbort = () => {
        if (!killed) {
          claude.kill('SIGTERM');
        }
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
      claude.on('close', () => options.signal.removeEventListener('abort', onAbort));
    }

    // Parse stream-json NDJSON output for real-time tool visibility
    claude.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.session_id) sessionId = data.session_id;

          if (data.type === 'stream_event' && data.event) {
            const ev = data.event;
            if (ev.type === 'content_block_start') {
              if (ev.content_block?.type === 'tool_use') {
                currentToolName = ev.content_block.name;
                if (onActivity) onActivity('tool_start', { tool: currentToolName });
              } else if (ev.content_block?.type === 'thinking') {
                if (onActivity) onActivity('thinking_start', {});
              }
            } else if (ev.type === 'content_block_delta') {
              if (ev.delta?.type === 'text_delta') {
                fullOutput += ev.delta.text;
              }
            } else if (ev.type === 'content_block_stop') {
              if (currentToolName) {
                if (onActivity) onActivity('tool_complete', { tool: currentToolName });
                currentToolName = null;
              }
            }
          } else if (data.type === 'result') {
            sessionId = data.session_id || sessionId;
            resultSubtype = data.subtype || resultSubtype;
            if (data.result) fullOutput = data.result;
            // Capture token usage for energy ledger
            if (data.usage) {
              usageData = {
                inputTokens: data.usage.input_tokens || 0,
                outputTokens: data.usage.output_tokens || 0,
                cacheRead: data.usage.cache_read_input_tokens || 0,
                cacheCreation: data.usage.cache_creation_input_tokens || 0,
              };
            }
            if (data.total_cost_usd != null) {
              usageData = usageData || {};
              usageData.costUsd = data.total_cost_usd;
            }
          }
        } catch { /* skip unparseable lines */ }
      }
    });

    claude.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    claude.on('close', (code, signal) => {
      killed = true;
      clearTimeout(timeoutTimer);

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const data = JSON.parse(buffer.trim());
          if (data.session_id) sessionId = data.session_id;
          if (data.type === 'result') {
            if (data.result) fullOutput = data.result;
            resultSubtype = data.subtype || resultSubtype;
          }
        } catch { /* ignore */ }
      }

      if (code === 0 || fullOutput.trim()) {
        if (!fullOutput.trim()) {
          const error = new Error('Claude Code exited with code 0 but produced no output (likely stale session)');
          error.exitCode = code;
          error.emptyOutput = true;
          error.errorReason = 'EMPTY_OUTPUT';
          reject(error);
          return;
        }

        // Record energy consumption (fire-and-forget)
        if (usageData) {
          recordEnergy({
            agent: process.env.AGENT_ID || 'unknown',
            process: options.taskType || 'chat',
            model,
            inputTokens: usageData.inputTokens || 0,
            outputTokens: usageData.outputTokens || 0,
            cacheRead: usageData.cacheRead || 0,
            cacheCreation: usageData.cacheCreation || 0,
            costUsd: usageData.costUsd || null,
            sessionId,
            durationMs: Date.now() - startTime,
            configDir: process.env.CLAUDE_CONFIG_DIR || null,
            trigger: options.trigger || null,
          }).catch(err => console.error(`[Runner] Energy record failed: ${err.message}`));
        }

        resolve({
          result: fullOutput.trim(),
          sessionId,
          hitMaxTurns: resultSubtype === 'error_max_turns',
        });
      } else {
        const errorMsg = timedOut
          ? `Claude Code timed out (signal: ${signal || 'SIGINT'})`
          : (stderr || `Claude Code exited with code ${code}`);
        const error = new Error(errorMsg);
        error.claudeSessionId = sessionId;
        error.stderr = stderr;
        error.signal = signal;
        error.exitCode = code;
        error.isTimeout = timedOut;
        error.errorReason = classifyError(error);
        reject(error);
      }
    });

    claude.on('error', (err) => {
      console.error(`[Runner] Claude spawn error:`, err.message);
      killed = true;
      clearTimeout(timeoutTimer);
      err.errorReason = classifyError(err);
      reject(err);
    });
  });
}

/**
 * Full execution pipeline for an agent task
 *
 * 1. Enqueue in agent's lane (serialize)
 * 2. Run with model fallback
 * 3. Run with timeout
 * 4. Persist checkpoint for recovery
 *
 * @param {Object} options
 * @param {string} options.agentId - Agent identifier
 * @param {string} options.taskType - Task type (chat, think, research, build)
 * @param {string} options.prompt - Prompt to execute
 * @param {Object} options.modelConfig - Model configuration (optional)
 * @param {string} options.cwd - Working directory (optional)
 * @param {Object} options.deliveryContext - Notification context for recovery (optional)
 * @param {string} options.resumeSessionId - Claude Code session UUID to --resume (optional)
 * @param {string} options.systemPrompt - System prompt for new sessions (optional)
 * @returns {Promise<{ result: string, sessionId: string|null, model: Object }>}
 */
export async function runTask({
  agentId,
  taskType,
  prompt,
  modelConfig,
  cwd,
  deliveryContext,
  resumeSessionId,
  systemPrompt,
}) {
  const laneId = `agent:${agentId}`;
  const agentPaths = getAgentPaths(agentId);

  return enqueue(laneId, async () => {
    console.log(`[Runner] Starting ${taskType} task for ${agentId}`);

    try {
      const { result, model, attempts } = await runWithFallback({
        run: async (modelCfg) => {
          return runClaudeCode(prompt, {
            model: getModelArg(modelCfg),
            cwd: cwd || agentPaths.root,
            taskType,
            agentRoot: agentPaths.root,
            agentId,
            deliveryContext,
            resumeSessionId,
            systemPrompt,
          });
        },
        config: modelConfig,
        onFallback: ({ failed, next, error }) => {
          console.log(`[Runner] Falling back from ${failed.model} to ${next.model}: ${error?.message}`);
        },
      });

      // result is now { result: string, sessionId: string|null, hitMaxTurns: boolean } from runClaudeCode
      console.log(`[Runner] Task completed for ${agentId} using ${model.model}`);

      return { result: result.result, sessionId: result.sessionId, hitMaxTurns: result.hitMaxTurns, model, attempts };
    } catch (error) {
      console.error(`[Runner] Task failed for ${agentId}:`, error.message);
      throw error;
    }
  });
}

/**
 * Run a fetch request with timeout
 *
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}, timeout = 60000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Save agent state (helper)
 * @param {string} agentId - Agent ID
 * @param {Object} updates - State updates to merge
 */
export async function updateAgentState(agentId, updates) {
  const paths = getAgentPaths(agentId);
  const current = await readFile(paths.state, {});
  const updated = { ...current, ...updates, updatedAt: new Date().toISOString() };
  await writeFile(paths.state, updated);
  return updated;
}

export default {
  runWithTimeout,
  runClaudeCode,
  runTask,
  fetchWithTimeout,
  updateAgentState,
};
