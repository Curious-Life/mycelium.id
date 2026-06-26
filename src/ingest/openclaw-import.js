// OpenClaw agent import — conversation history + workspace memory documents.
//
// OpenClaw splits storage (schema verified live + against ~/Developer/openclaw
// source, 2026-06-25):
//   ~/.openclaw/agents/main/sessions/<uuid>.jsonl   conversation transcripts
//        one JSON object per line, dispatched on `type`. The turns are
//        {type:'message', id, parentId, message:{role, content, timestamp}}:
//          user      → message.content is a STRING
//          assistant → message.content is a BLOCK ARRAY [{type:'text',text},…]
//        (other line types: session header, model_change, custom — not turns.)
//   ~/.openclaw/workspace/*.md                      the SOURCE memory documents
//        IDENTITY.md / SOUL.md / USER.md / AGENTS.md / … — the human/agent-authored
//        "memory" (the sqlite index under memory/ is just a regenerable view of
//        these, so we import the MARKDOWN, never the chunked index).
//
// captureMessage source 'import-openclaw' (the `import-` prefix bypasses the
// agent-capture consent gate, like 'import-claude-code' — an explicit import is
// intentional ingest). Workspace docs land BOTH as a document (agents/openclaw/…,
// editable, upsert-on-path) AND as a memory (so they reach the mindscape), the
// same dual-write Obsidian notes use.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { captureMessage } from './capture.js';
import { saveDocument } from '../core/document-store.js';
import { recordContentFlow } from '../inference/usage.js';

const MAX_MESSAGES = Number(process.env.MYCELIUM_OPENCLAW_IMPORT_MAX) || 200000;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_DOC_BYTES = 2 * 1024 * 1024;
const SKIP_WORKSPACE = new Set(['.git', '.openclaw', 'node_modules']);

/** Text of an OpenClaw message: string for user, joined text-blocks for assistant. */
function openclawText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    return c.map((b) => (typeof b === 'string' ? b : (typeof b?.text === 'string' ? b.text : ''))).filter(Boolean).join('\n').trim();
  }
  return '';
}

/** Does the assistant block array carry a tool_use (so an empty-text turn is a tool call)? */
function hasToolUse(message) {
  return Array.isArray(message?.content) && message.content.some((b) => b && (b.type === 'tool_use' || b.type === 'tool_call'));
}

/** Classify one parsed JSONL record; null = not a conversational turn. */
function classifyOpenClawLine(d, clean) {
  if (!d || d.type !== 'message' || !d.message) return null;
  const role = d.message.role;
  if (role !== 'user' && role !== 'assistant') return null;
  const text = openclawText(d.message);
  if (role === 'assistant') {
    if (text) return { kind: 'agent-text', role, text, messageType: 'chat' };
    if (hasToolUse(d.message)) return { kind: 'tool-call', role, text: '[tool_use]', messageType: 'tool-call' };
    return null;
  }
  // user: a tool_result block-array carries no human text
  if (Array.isArray(d.message.content) && !text) return { kind: 'tool-result', role, text: '[tool_result]', messageType: 'tool-result' };
  if (text) return { kind: 'human', role, text, messageType: 'chat' };
  return null;
}

/** Walk one directory (non-recursive) collecting *.jsonl session transcript files. */
async function listSessionFiles(dir) {
  let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents) {
    if (e.isSymbolicLink() || !e.isFile()) continue;
    // The canonical transcript is `<uuid>.jsonl`; skip the `.trajectory.jsonl`
    // telemetry mirror (richer, but redundant for memory import).
    if (/\.jsonl$/i.test(e.name) && !/\.trajectory\.jsonl$/i.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

/** Top-level *.md files in the workspace (the memory documents). */
async function listWorkspaceDocs(dir) {
  let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents) {
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { if (!SKIP_WORKSPACE.has(e.name) && !e.name.startsWith('.')) { /* one level only; OpenClaw keeps memory flat */ } continue; }
    if (e.isFile() && /\.md$/i.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

/**
 * Import an OpenClaw agent.
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} [opts.sessionsDir]  agents/main/sessions (conversation history)
 * @param {string} [opts.workspaceDir] workspace (memory markdown)
 * @param {'clean'|'full'} [opts.mode='clean']
 * @param {(id:string)=>void} [opts.enqueueEnrichment]
 */
export async function importOpenClaw(db, { userId, sessionsDir, workspaceDir, mode = 'clean', enqueueEnrichment } = {}) {
  if (!db?.messages || !db?.documents) throw new TypeError('importOpenClaw: db.messages + db.documents required');
  if (typeof userId !== 'string' || !userId) throw new Error('importOpenClaw: userId required');
  if (!sessionsDir && !workspaceDir) throw new Error('importOpenClaw: sessionsDir or workspaceDir required');
  const clean = mode !== 'full';
  const summary = {
    imported: 0, skipped: 0, failed: 0, sessions: 0, mode: clean ? 'clean' : 'full',
    filtered: { 'tool-call': 0, 'tool-result': 0, meta: 0 },
    docs: { imported: 0, deduped: 0, updated: 0, failed: 0 },
  };
  const contents = [];

  // ── Conversation history ──────────────────────────────────────────────────
  if (sessionsDir) {
    const files = await listSessionFiles(sessionsDir);
    let seen = 0;
    for (const file of files) {
      let body = '';
      try {
        const st = await fs.stat(file);
        if (st.size === 0 || st.size > MAX_SESSION_BYTES) { summary.failed += 1; continue; }
        body = await fs.readFile(file, 'utf8');
      } catch { summary.failed += 1; continue; }
      // The session uuid keys the conversation thread (filename minus .jsonl).
      const sessionId = path.basename(file).replace(/\.jsonl$/i, '');
      let any = false, n = 0;
      for (const line of body.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        if (++seen > MAX_MESSAGES) break;
        let d; try { d = JSON.parse(s); } catch { continue; }
        const turn = classifyOpenClawLine(d, clean);
        if (!turn) continue;
        if (clean && turn.kind !== 'human' && turn.kind !== 'agent-text') { summary.filtered[turn.kind] = (summary.filtered[turn.kind] || 0) + 1; continue; }
        // Stable id: the record's node id when present, else session+sequence.
        const nodeId = (typeof d.id === 'string' && d.id) ? d.id : `${sessionId}-${++n}`;
        const id = `openclaw-${nodeId}`;
        try {
          const { deduped } = await captureMessage(db, {
            userId, id, content: turn.text, role: turn.role, source: 'import-openclaw',
            messageType: turn.messageType, conversationId: `openclaw:${sessionId}`,
            createdAt: d.message?.timestamp || d.timestamp || null,
            metadata: { tool: 'openclaw', sessionId, kind: turn.kind, raw: d },
          }, enqueueEnrichment);
          if (deduped) summary.skipped += 1;
          else { summary.imported += 1; any = true; if (turn.text) contents.push(turn.text); }
        } catch { summary.failed += 1; }
      }
      if (any) summary.sessions += 1;
    }
  }

  // ── Workspace memory documents (IDENTITY/SOUL/USER/…): document + memory ────
  if (workspaceDir) {
    const docs = await listWorkspaceDocs(workspaceDir);
    for (const file of docs) {
      const name = path.basename(file);
      try {
        const st = await fs.stat(file);
        if (st.size === 0 || st.size > MAX_DOC_BYTES) { summary.docs.failed += 1; continue; }
        const content = await fs.readFile(file, 'utf8');
        if (!content.trim()) continue;
        await saveDocument({ db }, {
          userId, source: 'import-openclaw', sourceType: 'import_openclaw', createdBy: 'import', scope: 'personal',
          path: `import/openclaw/workspace/${name}`, title: `OpenClaw — ${name}`, content,
          metadata: { tool: 'openclaw', kind: 'workspace-memory', file: name }, createdAt: st.mtime?.toISOString?.(),
        });
        summary.docs.imported += 1;
        // Reach the mindscape too (path-stable memory id → idempotent re-import).
        const { deduped, updated } = await captureMessage(db, {
          userId, id: `openclaw:workspace/${name}`, content, source: 'import-openclaw',
          messageType: 'note', conversationId: 'openclaw:workspace',
          createdAt: st.mtime?.toISOString?.(),
          metadata: { tool: 'openclaw', kind: 'workspace-memory', file: name },
        }, enqueueEnrichment);
        if (updated) summary.docs.updated += 1; else if (deduped) summary.docs.deduped += 1;
        if (!deduped && !updated && content.trim()) contents.push(content);
      } catch { summary.docs.failed += 1; }
    }
  }

  if (contents.length) recordContentFlow(db, userId, { source: 'ingest', area: 'import', content: contents });
  return summary;
}
