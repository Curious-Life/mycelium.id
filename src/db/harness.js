// src/db/harness.js — the native agent harness state layer (Phase 5, Step 2).
// Backs the native-agent harness spec §5.4/§5.6/§6 + migration 0019.
//
// Three concerns over three tables:
//   • scheduled_tasks       — autonomous wake-cycles (the executor D5 dropped). Encrypted
//                             `prompt`; structural schedule/status/next_run the scheduler queries.
//   • harness_runs          — per-turn lifecycle (queued→running→done/failed/aborted/skipped),
//                             the restart-sentinel (running→aborted on boot), the dedup window
//                             (wasRecentlyCompleted), and token COUNTS (never content).
//   • conversation_summaries — auto-compaction summaries keyed on messages.conversation_id.
//
// SECURITY (§1/§8): `prompt` + `summary` are content → ENCRYPTED via the registry on the
// encrypting d1Query path. EVERY value in their INSERTs is a bound `?` (id + timestamps
// computed here in JS) so the auto-encrypt INSERT parser never sees a `)` literal (0008/0015
// caveat). harness_runs is content-free operational state → d1QueryAdmin (no encryption),
// errors are CODES only. Reads unwrap `{results}` like the other admin namespaces.

const DEDUP_MS = 30_000;      // a same-hash turn completed within this window is a duplicate
const OVERDUE_BUMP_MS = 60_000; // push overdue next_run forward this much on boot (anti-thundering-herd)

const rows = (r) => (Array.isArray(r) ? r : r?.results) || [];
const parseTools = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };

export function createHarnessNamespace({ d1Query, d1QueryAdmin, randomUUID, now }) {
  if (typeof d1Query !== 'function') throw new TypeError('createHarnessNamespace: d1Query required');
  if (typeof d1QueryAdmin !== 'function') throw new TypeError('createHarnessNamespace: d1QueryAdmin required');
  const uuid = randomUUID || (() => `h-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  // Always bind an ISO-8601 STRING (sortable, matches messages.created_at). The injected
  // `now` returns a Date in this codebase, so coerce — never bind a Date to SQLite.
  const nowFn = typeof now === 'function' ? now : () => new Date();
  const iso = () => { const v = nowFn(); return v instanceof Date ? v.toISOString() : (typeof v === 'number' ? new Date(v).toISOString() : String(v)); };

  // Mutable fields the agent / portal may patch (id, created_by and tool_provenance are
  // immutable — tool_provenance decides the fire-time WRITE grant, so no patch path may RAISE
  // it; updateTask below may only CLEAR it, which is a demotion).
  const TASK_PATCH = new Set(['name', 'prompt', 'schedule', 'scheduled_at', 'tz', 'status',
    'next_run', 'then_task_id', 'output_target', 'enabled_tools', 'essential', 'max_turns', 'notifications_enabled']);

  const mapTask = (t) => t && ({ ...t, enabled_tools: parseTools(t.enabled_tools), essential: !!t.essential, notifications_enabled: t.notifications_enabled == null ? true : !!t.notifications_enabled });

  return {
    // ── scheduled_tasks ──────────────────────────────────────────────────────
    /** Create a scheduled task. `prompt` is encrypted at rest. Returns the id. */
    async createTask(userId, t = {}) {
      const id = uuid();
      const ts = iso();
      await d1Query(
        `INSERT INTO scheduled_tasks
           (id, user_id, name, prompt, schedule, scheduled_at, tz, status, trigger_type, next_run,
            then_task_id, output_target, enabled_tools, essential, max_turns, notifications_enabled,
            created_by, tool_provenance, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id, userId, t.name ?? null, t.prompt ?? null, t.schedule ?? null, t.scheduledAt ?? null, t.tz ?? null,
          t.status || 'active', t.triggerType || 'schedule', t.nextRun ?? null,
          t.thenTaskId ?? null, t.outputTarget || 'none',
          t.enabledTools != null ? JSON.stringify(t.enabledTools) : null,
          t.essential ? 1 : 0, Number.isFinite(t.maxTurns) ? t.maxTurns : 8,
          t.notificationsEnabled === false ? 0 : 1,
          // tool_provenance: WHICH CODE supplied enabled_tools, not who asked. Only a caller
          // whose list comes from an in-repo constant may pass 'engine' (agent/seed-cycles.js);
          // every model-reachable writer omits it and gets NULL = untrusted. Fail-closed: an
          // unrecognised value is simply not in WRITE_TRUSTED_PROVENANCE.
          t.createdBy || 'user', typeof t.toolProvenance === 'string' ? t.toolProvenance : null, ts, ts,
        ],
      );
      return id;
    },

    /** One task (prompt decrypted). */
    async getTask(userId, id) {
      const r = await d1Query(`SELECT * FROM scheduled_tasks WHERE id = ? AND user_id = ?`, [id, userId]);
      return mapTask(rows(r)[0] || null);
    },

    /** All of a user's tasks (optionally by status). */
    async listTasks(userId, { status } = {}) {
      const sql = status
        ? `SELECT * FROM scheduled_tasks WHERE user_id = ? AND status = ? ORDER BY created_at DESC`
        : `SELECT * FROM scheduled_tasks WHERE user_id = ? ORDER BY created_at DESC`;
      const r = await d1Query(sql, status ? [userId, status] : [userId]);
      return rows(r).map(mapTask);
    },

    /**
     * Patch allowed fields (UPDATE path handles encryption + paren-safe literals).
     *
     * PROVENANCE DEMOTION (§4.3 of the trust-provenance design). A task's WRITE grant is trust in
     * its INSTRUCTIONS, not in its row — so rewriting `prompt` CLEARS `tool_provenance` unless the
     * patch comes from the authenticated-owner HTTP path. Without this, a trusted row is
     * repurposable rather than mintable: `updateCycle` (tools/cycles.js) is a CHAT tool that finds
     * a seeded cycle by created_by and patches its prompt, so an injection could rewrite the
     * integration cycle's instructions and keep its editMindFile/writeMindFileWhole grant.
     * The two callers are already distinct trust paths — tools/cycles.js is a model tool,
     * portal-reflection.js sits behind portalOwnerGate, and a model turn has no tool that issues
     * a portal HTTP request.
     *
     * Only ever a DEMOTION: `tool_provenance` is outside TASK_PATCH, so no caller can raise it.
     * @param {{authorTrust?: 'model'|'owner'}} [opts]  'owner' ⇒ an authenticated owner request
     */
    async updateTask(userId, id, fields = {}, { authorTrust = 'model' } = {}) {
      const sets = []; const params = [];
      for (const [k, v] of Object.entries(fields)) {
        if (!TASK_PATCH.has(k)) continue;
        if (k === 'enabled_tools') { sets.push('enabled_tools = ?'); params.push(v != null ? JSON.stringify(v) : null); }
        else if (k === 'essential' || k === 'notifications_enabled') { sets.push(`${k} = ?`); params.push(v ? 1 : 0); }
        else { sets.push(`${k} = ?`); params.push(v); }
      }
      if (!sets.length) return { changed: false };
      // Fail-closed: anything that is not an explicit owner-authenticated edit demotes.
      // `enabled_tools` demotes too — patching the tool list on a trusted row is the SAME
      // escalation as patching its prompt, just through the other field. No caller does it today
      // (it stays in TASK_PATCH pending its own caller audit), so this is the guard that keeps a
      // future one from silently handing itself the write tier.
      if ((Object.hasOwn(fields, 'prompt') || Object.hasOwn(fields, 'enabled_tools')) && authorTrust !== 'owner') sets.push('tool_provenance = NULL');
      sets.push("updated_at = datetime('now')");
      params.push(id, userId);
      await d1Query(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, params);
      return { changed: true };
    },

    /**
     * Stamp write-trust provenance on a REFLECTION-CYCLE row. Deliberately NOT a general patch:
     * `tool_provenance` is outside TASK_PATCH precisely so nothing can raise it, and this is the
     * one narrow, auditable exception. Guarded in SQL as well as by its callers — the
     * `created_by = 'reflection-cycle'` predicate means an ordinary task row can never be promoted
     * even if a future caller passes its id by mistake (defense in depth, §2).
     *
     * Two legitimate callers, both of which can justify the trust:
     *   • agent/seed-cycles.js — the row's prompt still equals the in-repo CYCLES body.
     *   • portal-reflection.js — an authenticated owner deliberately saved this cycle.
     */
    async setCycleProvenance(userId, id, provenance) {
      const v = typeof provenance === 'string' ? provenance : null;
      await d1Query(
        `UPDATE scheduled_tasks SET tool_provenance = ?, updated_at = datetime('now')
          WHERE id = ? AND user_id = ? AND created_by = 'reflection-cycle'`,
        [v, id, userId],
      );
    },

    async setTaskStatus(userId, id, status) {
      await d1Query(`UPDATE scheduled_tasks SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`, [status, id, userId]);
    },

    /** Record a run's outcome on the task: last_run/last_status/last_error, bump run_count, set next_run. */
    async markTaskRun(userId, id, { nextRun = null, lastStatus = null, lastError = null } = {}) {
      await d1Query(
        `UPDATE scheduled_tasks
           SET last_run = ?, last_status = ?, last_error = ?, run_count = run_count + 1,
               next_run = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
        [iso(), lastStatus, lastError, nextRun, iso(), id, userId],
      );
    },

    /** Due tasks: active, with a next_run at or before `nowIso`. Prompt decrypted (needed to run). */
    async dueTasks(nowIso) {
      const r = await d1Query(
        `SELECT * FROM scheduled_tasks
         WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
         ORDER BY next_run ASC`,
        [nowIso || iso()],
      );
      return rows(r).map(mapTask);
    },

    /** After downtime, push overdue active tasks forward so they don't all fire at once. */
    async advanceOverdue(nowIso) {
      const cutoff = nowIso || iso();
      const bumped = new Date(Date.now() + OVERDUE_BUMP_MS).toISOString();
      const r = await d1Query(
        `UPDATE scheduled_tasks SET next_run = ?, updated_at = ?
         WHERE status = 'active' AND next_run IS NOT NULL AND next_run < ?`,
        [bumped, iso(), cutoff],
      );
      return r?.meta?.changes ?? 0;
    },

    // ── harness_runs (content-free; d1QueryAdmin) ────────────────────────────
    /** Open a run as 'running' (the restart sentinel). Returns the run id. */
    async openRun({ userId, trigger, conversationId = null, taskId = null, promptHash = null }) {
      const id = uuid();
      await d1QueryAdmin(
        `INSERT INTO harness_runs (id, user_id, trigger, conversation_id, task_id, status, prompt_hash, started_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
        [id, userId, trigger, conversationId, taskId, promptHash, iso()],
      ).catch(() => {});
      return id;
    },

    /** Terminal transition + token counts (counts only, never content). */
    async finishRun(id, { status = 'done', error = null, inputTokens = null, outputTokens = null } = {}) {
      await d1QueryAdmin(
        `UPDATE harness_runs SET status = ?, error = ?, input_tokens = ?, output_tokens = ?, finished_at = ?
         WHERE id = ?`,
        [status, error, inputTokens, outputTokens, iso(), id],
      ).catch(() => {});
    },

    /** Dedup: did an identical prompt_hash complete within the window? (channel webhook resends.) */
    async wasRecentlyCompleted(promptHash, windowMs = DEDUP_MS) {
      if (!promptHash) return false;
      const cutoff = new Date(Date.now() - windowMs).toISOString();
      const r = await d1QueryAdmin(
        `SELECT 1 FROM harness_runs WHERE prompt_hash = ? AND status = 'done' AND finished_at >= ? LIMIT 1`,
        [promptHash, cutoff],
      ).catch(() => null);
      return rows(r).length > 0;
    },

    /** Boot recovery: a process restart leaves in-flight runs orphaned — flip them aborted
     *  (in-process turns can't resume a half-streamed LLM call). Returns count. */
    async reconcileOnBoot() {
      const r = await d1QueryAdmin(
        `UPDATE harness_runs SET status = 'aborted', error = 'server-restart', finished_at = ?
         WHERE status IN ('queued', 'running')`,
        [iso()],
      ).catch(() => null);
      return r?.meta?.changes ?? 0;
    },

    /** Recent runs for inspection (content-free). */
    async recentRuns(userId, limit = 20) {
      const r = await d1QueryAdmin(
        `SELECT id, trigger, conversation_id, task_id, status, input_tokens, output_tokens, error, started_at, finished_at
         FROM harness_runs WHERE user_id = ? ORDER BY COALESCE(finished_at, started_at) DESC LIMIT ?`,
        [userId, Number(limit) || 20],
      ).catch(() => null);
      return rows(r);
    },

    /** Runs for the activity timeline — paginated by a time cursor (content-free). The
     *  spine of the Agents activity page: every chat/channel/scheduler turn is one row. */
    async listRuns(userId, { limit = 50, before = null } = {}) {
      const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const params = [userId];
      let where = 'user_id = ?';
      if (before) { where += ' AND COALESCE(finished_at, started_at) < ?'; params.push(before); }
      params.push(lim);
      const r = await d1QueryAdmin(
        `SELECT id, trigger, conversation_id, task_id, status, input_tokens, output_tokens, error, started_at, finished_at
         FROM harness_runs WHERE ${where} ORDER BY COALESCE(finished_at, started_at) DESC LIMIT ?`,
        params,
      ).catch(() => null);
      return rows(r);
    },

    /** One run by id (for the activity inspect drill-down) — content-free row. */
    async getRun(userId, id) {
      const r = await d1QueryAdmin(
        `SELECT id, trigger, conversation_id, task_id, status, input_tokens, output_tokens, error, started_at, finished_at
         FROM harness_runs WHERE user_id = ? AND id = ? LIMIT 1`,
        [userId, id],
      ).catch(() => null);
      return rows(r)[0] || null;
    },

    // ── conversation_summaries (compaction; encrypted summary) ────────────────
    /** Latest compaction summary for a conversation (summary decrypted). */
    async getSummary(userId, conversationId) {
      const r = await d1Query(
        `SELECT id, summary, through_message_id, tokens_before, compaction_count, created_at
         FROM conversation_summaries WHERE user_id = ? AND conversation_id = ?
         ORDER BY created_at DESC LIMIT 1`,
        [userId, conversationId],
      );
      return rows(r)[0] || null;
    },

    /** Store a compaction summary (encrypted). Returns the id. */
    async putSummary({ userId, conversationId, summary, throughMessageId = null, tokensBefore = null, compactionCount = 1 }) {
      const id = uuid();
      await d1Query(
        `INSERT INTO conversation_summaries
           (id, user_id, conversation_id, summary, through_message_id, tokens_before, compaction_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, userId, conversationId, summary ?? null, throughMessageId, tokensBefore, compactionCount, iso()],
      );
      return id;
    },

    // ── channel_write_audit (red-team RT2-H2): autonomous/channel vault writes ─────────
    /** Record a vault WRITE by an autonomous turn — structural + hash only, NEVER plaintext. */
    async recordWrite({ userId, conversationId = null, trigger = 'channel', tool, argHash = null }) {
      await d1Query(
        `INSERT INTO channel_write_audit (id, user_id, conversation_id, trigger, tool, arg_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), userId, conversationId, trigger, String(tool || ''), argHash, iso()],
      );
    },

    /** Recent autonomous vault writes for the owner ("what did my assistant write?"). */
    async listWrites(userId, limit = 50) {
      const r = await d1Query(
        `SELECT id, conversation_id, trigger, tool, arg_hash, created_at
         FROM channel_write_audit WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
        [userId, Number(limit) || 50],
      );
      return rows(r);
    },

    // ── claude_sessions: ONE Claude Code CLI session per conversation ───────────────
    // Content-free operational state (opaque UUID handle) → d1QueryAdmin (no encryption),
    // like harness_runs. Lets the `claude` engine `--resume` the same session each turn.
    /** The stored claude session id for a conversation, or null. */
    async getClaudeSessionId(userId, conversationId) {
      if (!userId || !conversationId) return null;
      const r = await d1QueryAdmin(
        `SELECT session_id FROM claude_sessions WHERE user_id = ? AND conversation_id = ?`,
        [userId, conversationId],
      ).catch(() => null);
      const rr = Array.isArray(r) ? r : r?.results;
      return rr?.[0]?.session_id || null;
    },
    /** Persist (create/replace) the claude session id for a conversation. */
    async setClaudeSessionId(userId, conversationId, sessionId) {
      if (!userId || !conversationId || !sessionId) return;
      await d1QueryAdmin(
        `INSERT INTO claude_sessions (user_id, conversation_id, session_id, created_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(user_id, conversation_id) DO UPDATE SET session_id = excluded.session_id, created_at = datetime('now')`,
        [userId, conversationId, sessionId],
      ).catch(() => {});
    },
    /** Forget a conversation's claude session (self-heal after a failed --resume). */
    async clearClaudeSessionId(userId, conversationId) {
      if (!userId || !conversationId) return;
      await d1QueryAdmin(
        `DELETE FROM claude_sessions WHERE user_id = ? AND conversation_id = ?`,
        [userId, conversationId],
      ).catch(() => {});
    },
  };
}

export default createHarnessNamespace;
