/**
 * Internal-model domain — two tools for the agent's private
 * scratchpad (never shown to user).
 *
 *   - updateInternalModel: append an entry to a section of
 *     `model.md`. Sections are canonical (observations / hypotheses /
 *     questions / contradictions / patterns / uncertainty / notes /
 *     dream_fragments). Unknown section names fall through to a
 *     generic `## <section>` header.
 *   - flagForDiscussion: append a topic + context to `flagged.md`
 *     so it surfaces in the agent's next preload.
 *
 * Both live in per-agent mind files (git-backed, compactable) via
 * writeMindFile. No DB writes.
 *
 * @typedef {object} InternalDeps
 * @property {(filename: string) => Promise<string|null>} readMindFile
 * @property {(filename: string, content: string) => Promise<void>} writeMindFile
 */

export function createInternalDomain(deps) {
  if (!deps) throw new TypeError('createInternalDomain: deps required');
  const { readMindFile, writeMindFile } = deps;
  if (typeof readMindFile !== 'function')  throw new TypeError('createInternalDomain: readMindFile required');
  if (typeof writeMindFile !== 'function') throw new TypeError('createInternalDomain: writeMindFile required');

  const SECTION_HEADERS = {
    observations:    '## Observations',
    hypotheses:      '## Working Hypotheses',
    questions:       '## Open Questions',
    contradictions:  '## Contradictions I\'m Tracking',
    patterns:        '## Patterns',
    uncertainty:     '## Where I Might Be Wrong',
    notes:           '## Notes',
    dream_fragments: '## Dream Fragments',
  };

  const tools = [
    {
      name: 'updateInternalModel',
      description: 'Update your private model (never shown to user). Your space for hypotheses, observations, questions. Capture-mode only — append-only, used during conversations and cycle Phase 3 to record new observations. The integration cycle reconciles via Write + snapshotMindFile in Phase 3.5.\n\nIMPORTANT: do NOT prefix `content` with a date like `[2026-05-07]`. The handler adds today\'s date automatically. Just write the observation. Use the `section` parameter to categorize.',
      inputSchema: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            enum: ['observations', 'hypotheses', 'questions', 'contradictions', 'patterns', 'uncertainty', 'notes', 'dream_fragments'],
            description: 'Section to update',
          },
          content: { type: 'string', description: 'Your private observation or question. Do NOT include a date — handler adds today\'s date automatically.' },
        },
        required: ['section', 'content'],
      },
    },
    {
      name: 'flagForDiscussion',
      description: 'Flag something to bring up in next conversation.',
      inputSchema: {
        type: 'object',
        properties: {
          topic:   { type: 'string', description: 'What you want to discuss' },
          context: { type: 'string', description: 'Why this seems worth exploring' },
        },
        required: ['topic', 'context'],
      },
    },
    {
      name: 'snapshotMindFile',
      description: 'Trail-preservation primitive for mind/ files. Atomically snapshots a mind/ file (e.g., "model.md") to mind/snapshots/<filename>/<YYYY-MM-DD>.md. `writeMindFileWhole` already auto-snapshots before each whole-file rewrite — explicit calls are useful when you want to capture state without modifying anything. Idempotent — once-per-day first-write-wins: if today\'s snapshot already exists (any content), the call is a no-op so the original pre-cycle state stays preserved. Atomic (.tmp+rename), path-traversal safe. Returns JSON: { ok, path, idempotent? } on success or { ok: false, error } on failure.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'Flat mind/ filename (e.g., "model.md", "flagged.md"). No subdirs, no path traversal.',
          },
        },
        required: ['filename'],
      },
    },
    {
      name: 'readMindFile',
      description: 'Read the current decrypted content of a mind/ file (e.g., "model.md"). Use this in Phase 3.5 of the integration cycle to fetch the latest state before consolidating, since your assembled context was loaded at cycle start and may be stale after Phase 3 updates. Plaintext is returned in-memory only — the on-disk file remains encrypted at rest. Returns the content string, or "(file not found)" if absent.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'Mind/ filename (e.g., "model.md", "flagged.md", or a snapshot path like "snapshots/model.md/2026-05-08.md").',
          },
        },
        required: ['filename'],
      },
    },
    {
      name: 'editMindFile',
      description: 'Surgical edit on a mind/ file — same exact-string + uniqueness contract as Claude Code\'s built-in Edit but encryption-aware. Decrypts the file, finds `old_string` (which MUST appear exactly once — uniqueness enforced), replaces with `new_string`, re-encrypts, and atomically writes. Use for one-line changes: status flips, hypothesis renames, typo fixes — when target text is unique. For appends use `updateInternalModel`; for whole-file rewrites use `writeMindFileWhole`. Returns JSON: { ok: true } on success or { ok: false, error: "old-string-not-found" | "old-string-not-unique" | "file-not-found" | "invalid-filename", count? } on failure.',
      inputSchema: {
        type: 'object',
        properties: {
          filename:   { type: 'string', description: 'Mind/ filename (e.g., "model.md").' },
          old_string: { type: 'string', description: 'Exact text to find. Must appear exactly once in the file.' },
          new_string: { type: 'string', description: 'Replacement text. Empty string deletes the old_string.' },
        },
        required: ['filename', 'old_string', 'new_string'],
      },
    },
    {
      name: 'writeMindFileWhole',
      description: 'Atomically write the full decrypted content of a mind/ file (e.g., "model.md"). Encrypts at rest. Auto-snapshots the pre-write state to mind/snapshots/<filename>/<YYYY-MM-DD>.md (idempotent first-write-wins) so the pre-edit version is always recoverable — you don\'t need to call snapshotMindFile separately. Use for Phase 3.5 consolidation or any whole-file rewrite. For surgical edits, use editMindFile instead (cheaper). Returns JSON: { ok: true, snapshotted: boolean } on success or { ok: false, error } on failure.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Mind/ filename (e.g., "model.md").' },
          content:  { type: 'string', description: 'Full new content of the file (replaces existing entirely).' },
        },
        required: ['filename', 'content'],
      },
    },
    {
      name: 'removeFromMind',
      description: 'Remove a block of text from a mind/ file by exact match — for pruning a stale entry during consolidation (clearer intent than editMindFile with an empty replacement). The `block` MUST appear exactly once (uniqueness enforced). Surrounding blank lines are tidied. Encryption-aware; auto-snapshots the pre-removal state so it is recoverable. Returns JSON: { ok: true } or { ok: false, error: "block-not-found" | "block-not-unique" | "file-not-found" | "invalid-filename" | "empty-block", count? }.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Mind/ filename (e.g., "model.md", "self.md").' },
          block:    { type: 'string', description: 'Exact text block to remove. Must appear exactly once.' },
        },
        required: ['filename', 'block'],
      },
    },
  ];

  const handlers = {
    updateInternalModel: async (args) => {
      const timestamp = new Date().toISOString().split('T')[0];
      // Strip any leading [YYYY-MM-DD] prefixes from the agent's content
      // before adding our own. The agent has historically prefixed dates
      // (cargo-cult from flagForDiscussion's output format), which produced
      // 153 double-dated entries during 2026-04-26 to 2026-04-29 before
      // this fix. The regex matches one or more `[YYYY-MM-DD] ` patterns
      // (with optional whitespace, defensive for `[YYYY-MM-DD]  content`
      // and `[YYYY-MM-DD] [YYYY-MM-DD] content`).
      const cleanedContent = String(args.content || '').replace(/^(\[\d{4}-\d{2}-\d{2}\]\s+)+/, '');
      const newEntry = `- [${timestamp}] ${cleanedContent}`;
      const header = SECTION_HEADERS[args.section] || `## ${args.section}`;

      const existing = await readMindFile('model.md');

      if (existing) {
        let content = existing;
        const headerIdx = content.indexOf(header);
        if (headerIdx !== -1) {
          // Insert at end of section (before next ## or EOF).
          const afterHeader = content.slice(headerIdx + header.length);
          const nextSection = afterHeader.search(/\n## /);
          const insertPoint = headerIdx + header.length + (nextSection === -1 ? afterHeader.length : nextSection);
          content = content.slice(0, insertPoint) + '\n' + newEntry + content.slice(insertPoint);
        } else {
          // New section — append with header.
          content += `\n\n${header}\n${newEntry}`;
        }
        await writeMindFile('model.md', content);
      } else {
        await writeMindFile('model.md', `# Internal Model\n\n${header}\n${newEntry}`);
      }
      return `Internal model updated (${args.section}).`;
    },

    flagForDiscussion: async (args) => {
      const timestamp = new Date().toISOString().split('T')[0];
      const entry = `- **${args.topic}** (${timestamp}): ${args.context}`;

      const existing = await readMindFile('flagged.md');
      if (existing) {
        await writeMindFile('flagged.md', existing + '\n' + entry);
      } else {
        await writeMindFile('flagged.md', `# Things to Bring Up\n\n${entry}`);
      }
      return `Flagged for discussion: ${args.topic}`;
    },

    // Snapshot primitive — trail preservation for any mind/ file.
    // Paired with the 03:00 Consolidation discipline (Phase 3.5 in
    // scheduler.js): the cycle prompt instructs the agent to call this
    // as the FIRST action before any modification of model.md, unconditionally.
    //
    // Semantic: once-per-day, first-write-wins. If today's snapshot
    // already exists (any content), the call is a no-op. This preserves
    // the pre-cycle state — if the agent calls snapshotMindFile multiple
    // times during a cycle, only the FIRST call matters; subsequent
    // calls cannot accidentally overwrite the pre-cycle anchor with a
    // mid-cycle state.
    //
    // Forced refresh: not exposed via tool surface. If an operator
    // intentionally wants a fresh snapshot for the day, they delete
    // mind/snapshots/<filename>/<YYYY-MM-DD>.md and call again.
    //
    // editMindFile + writeMindFileWhole BOTH auto-call the same
    // snapshot logic before mutating, so explicit snapshotMindFile
    // calls are redundant in those flows. Kept exposed for the
    // "capture state without modifying" use case (e.g., the Phase 3.5
    // prompt explicitly snapshots first as defense-in-depth).
    snapshotMindFile: async (args) => {
      const filename = String(args?.filename || '').trim();
      if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        return JSON.stringify({ ok: false, error: 'invalid-filename' });
      }
      const result = await captureSnapshot(filename);
      if (result.error === 'source-not-found') {
        return JSON.stringify({ ok: false, error: 'source-not-found', filename });
      }
      return JSON.stringify({
        ok: true,
        path: `mind/${result.path}`,
        ...(result.idempotent ? { idempotent: true } : {}),
      });
    },

    readMindFile: async (args) => {
      const filename = String(args?.filename || '').trim();
      // Allow snapshot subpaths (snapshots/<file>/<date>.md) but reject
      // traversal. Same rule as writeMindFile callers — backslashes and
      // .. are blocked; forward slashes are allowed for subdirs.
      if (!filename || filename.includes('\\') || filename.includes('..')) {
        return JSON.stringify({ ok: false, error: 'invalid-filename' });
      }
      const content = await readMindFile(filename);
      if (content == null) {
        return JSON.stringify({ ok: false, error: 'file-not-found', filename });
      }
      return content;
    },

    editMindFile: async (args) => {
      const filename = String(args?.filename || '').trim();
      if (!filename || filename.includes('\\') || filename.includes('..')) {
        return JSON.stringify({ ok: false, error: 'invalid-filename' });
      }
      const oldStr = String(args?.old_string ?? '');
      const newStr = String(args?.new_string ?? '');

      const content = await readMindFile(filename);
      if (content == null) {
        return JSON.stringify({ ok: false, error: 'file-not-found', filename });
      }

      // Same uniqueness contract as Claude Code's Edit tool: old_string
      // must match exactly once. count via split-length to avoid building
      // a global RegExp on user-controlled text.
      const occurrences = oldStr === '' ? 0 : content.split(oldStr).length - 1;
      if (occurrences === 0) {
        return JSON.stringify({ ok: false, error: 'old-string-not-found' });
      }
      if (occurrences > 1) {
        return JSON.stringify({ ok: false, error: 'old-string-not-unique', count: occurrences });
      }

      // Auto-snapshot pre-edit state — idempotent no-op if today's
      // snapshot already exists. Best-effort: snapshot failures don't
      // block the edit (operator can investigate; the file's prior
      // version still lives in git history if the agent dir is git-backed).
      let snapshotted = false;
      try {
        const snap = await captureSnapshot(filename);
        snapshotted = snap.ok && !snap.idempotent;
      } catch { /* non-fatal */ }

      const newContent = content.replace(oldStr, newStr);
      await writeMindFile(filename, newContent);

      return JSON.stringify({ ok: true, snapshotted });
    },

    writeMindFileWhole: async (args) => {
      const filename = String(args?.filename || '').trim();
      if (!filename || filename.includes('\\') || filename.includes('..')) {
        return JSON.stringify({ ok: false, error: 'invalid-filename' });
      }
      const content = String(args?.content ?? '');

      // Auto-snapshot pre-write state — same first-write-wins semantic
      // as snapshotMindFile, structurally guaranteed regardless of
      // whether the agent remembered Phase 3.5 Step 1. Best-effort:
      // snapshot errors are logged but don't block the write (which
      // would be worse UX — the agent would lose the consolidated
      // content for an operational hiccup).
      let snapshotted = false;
      try {
        const snap = await captureSnapshot(filename);
        snapshotted = snap.ok && !snap.idempotent;
      } catch { /* non-fatal */ }

      await writeMindFile(filename, content);
      return JSON.stringify({ ok: true, snapshotted });
    },

    removeFromMind: async (args) => {
      const filename = String(args?.filename || '').trim();
      if (!filename || filename.includes('\\') || filename.includes('..')) {
        return JSON.stringify({ ok: false, error: 'invalid-filename' });
      }
      const block = String(args?.block ?? '');
      if (!block) return JSON.stringify({ ok: false, error: 'empty-block' });
      const content = await readMindFile(filename);
      if (content == null) return JSON.stringify({ ok: false, error: 'file-not-found' });
      const occurrences = content.split(block).length - 1;
      if (occurrences === 0) return JSON.stringify({ ok: false, error: 'block-not-found' });
      if (occurrences > 1) return JSON.stringify({ ok: false, error: 'block-not-unique', count: occurrences });
      try { await captureSnapshot(filename); } catch { /* non-fatal — recoverable via git/snapshots */ }
      const next = content.replace(block, '').replace(/\n{3,}/g, '\n\n'); // remove + tidy the blank-line gap
      await writeMindFile(filename, next);
      return JSON.stringify({ ok: true });
    },
  };

  // Internal helper — pre-mutation snapshot capture. First-write-wins
  // per UTC day per filename. Returns { ok, path, idempotent? } or
  // { ok: false, error }. Reused by snapshotMindFile + editMindFile +
  // writeMindFileWhole so all three share the same trail-preservation
  // invariant.
  //
  // filename here may be a snapshot path itself (e.g., re-running
  // Phase 3.5 on a snapshot) — the captureSnapshot of a snapshot just
  // stores it under snapshots/<full-path>/<date>.md. Edge case but
  // doesn't break anything.
  async function captureSnapshot(filename) {
    const today = new Date().toISOString().split('T')[0];
    const snapshotRelPath = `snapshots/${filename}/${today}.md`;
    const existing = await readMindFile(snapshotRelPath);
    if (existing != null) {
      return { ok: true, path: snapshotRelPath, idempotent: true };
    }
    const source = await readMindFile(filename);
    if (source == null) {
      return { ok: false, error: 'source-not-found' };
    }
    await writeMindFile(snapshotRelPath, source);
    return { ok: true, path: snapshotRelPath };
  }

  return { tools, handlers };
}
