// Obsidian vault folder import.
//
// Each *.md note becomes BOTH:
//   • a DOCUMENT (saveDocument, upsert on path) — canonical, editable, and
//     re-syncs cleanly when the note is edited and re-imported; and
//   • a MEMORY (captureMessage, content-addressed id) — the ONLY ingestion
//     path that reaches the mindscape (the drainer + clustering sync are
//     messages-only; see docs/DESIGN-import-connectors-2026-06-04.md, Pivot A).
//
// Two input modes (provide exactly one):
//   • { folderPath } — Node walks the directory (Tauri native-picker path).
//   • { files }      — [{ relPath, content, mtime? }] already-read note bodies
//                       (browser <input webkitdirectory> fallback / preview).
//
// Dedup: the memory id is sha256(note text). Unchanged note re-import → no-op
// (insertIgnore). Edited note → a new memory whose new content reaches the
// mindscape; the document row stays current via upsert. Append-only memory
// model — lingering-memory GC is a documented follow-on.

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { captureMessage } from './capture.js';
import { saveDocument } from '../core/document-store.js';
import { parseMarkdownNote } from './markdown.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB per note
const MAX_FILES = 20000;                // total vault cap (logged if hit)
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.smart-env']);

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** Recursively collect *.md under root. Skips dotdirs, system dirs, symlinks. */
async function walkMarkdown(root, { maxFiles = MAX_FILES } = {}) {
  const out = [];
  let truncated = false;
  async function walk(dir, rel) {
    if (out.length >= maxFiles) { truncated = true; return; }
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (out.length >= maxFiles) { truncated = true; return; }
      const name = ent.name;
      if (ent.isSymbolicLink()) continue; // never follow symlinks out of the vault
      if (ent.isDirectory()) {
        if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
        await walk(path.join(dir, name), rel ? `${rel}/${name}` : name);
      } else if (ent.isFile() && /\.md$/i.test(name)) {
        out.push({ abs: path.join(dir, name), relPath: rel ? `${rel}/${name}` : name });
      }
    }
  }
  await walk(root, '');
  return { files: out, truncated };
}

/**
 * Import an Obsidian vault.
 * @returns {Promise<{ scanned, documentsUpserted, memoriesCreated, memoriesDeduped, skipped, truncated, errors }>}
 */
export async function importObsidianVault(db, { userId, folderPath, files, vaultName, enqueueEnrichment } = {}) {
  if (!db?.messages || !db?.documents) throw new TypeError('importObsidianVault: db.messages + db.documents required');
  if (typeof userId !== 'string' || !userId) throw new Error('importObsidianVault: userId required');
  if (!folderPath && !Array.isArray(files)) throw new Error('importObsidianVault: folderPath or files required');

  const summary = {
    scanned: 0, documentsUpserted: 0, memoriesCreated: 0,
    memoriesDeduped: 0, skipped: 0, truncated: false, errors: [],
  };
  const vault = vaultName
    || (folderPath ? path.basename(path.resolve(folderPath).replace(/[/\\]+$/, '')) : 'vault');

  // ── Build the work list of { relPath, content, mtime } ──
  let work = [];
  if (folderPath) {
    const root = path.resolve(folderPath);
    const st = await fs.stat(root).catch(() => null);
    if (!st || !st.isDirectory()) throw new Error('importObsidianVault: folderPath is not a directory');
    const { files: found, truncated } = await walkMarkdown(root);
    summary.truncated = truncated;
    for (const f of found) {
      try {
        const s = await fs.stat(f.abs);
        if (s.size > MAX_FILE_BYTES) { summary.skipped += 1; continue; }
        const content = await fs.readFile(f.abs, 'utf8');
        work.push({ relPath: f.relPath, content, mtime: s.mtime?.toISOString?.() });
      } catch {
        summary.skipped += 1;
        summary.errors.push({ relPath: f.relPath, error: 'read_failed' });
      }
    }
  } else {
    for (const f of files) {
      if (!f || typeof f.relPath !== 'string' || typeof f.content !== 'string') { summary.skipped += 1; continue; }
      if (!/\.md$/i.test(f.relPath)) { summary.skipped += 1; continue; }
      if (Buffer.byteLength(f.content, 'utf8') > MAX_FILE_BYTES) { summary.skipped += 1; continue; }
      work.push({ relPath: f.relPath, content: f.content, mtime: typeof f.mtime === 'string' ? f.mtime : undefined });
    }
    if (work.length > MAX_FILES) { work = work.slice(0, MAX_FILES); summary.truncated = true; }
  }

  if (summary.truncated) {
    console.warn(`[obsidian-import] vault exceeds ${MAX_FILES} notes — importing the first ${MAX_FILES} (rest skipped)`);
  }
  summary.scanned = work.length;

  // ── Ingest each note as a document + a memory ──
  for (const note of work) {
    try {
      const parsed = parseMarkdownNote(note.content, note.relPath);
      // Strip the .md extension and any leading slash for the canonical doc path.
      const cleanName = note.relPath.replace(/\.md$/i, '').replace(/^\/+/, '');

      // Document — canonical/editable; upsert on (user_id, path) = clean re-sync.
      await saveDocument({ db }, {
        userId,
        source: 'import-obsidian',
        sourceType: 'import_obsidian',
        createdBy: 'import',
        scope: 'personal',
        pathArgs: { name: cleanName },
        content: parsed.body,
        title: parsed.title,
        metadata: { vault, relPath: note.relPath, tags: parsed.tags, frontmatter: parsed.frontmatter },
        createdAt: note.mtime,
        updatedAt: note.mtime,
      });
      summary.documentsUpserted += 1;

      // Memory — content-addressed → reaches the mindscape via captureMessage.
      const memContent = parsed.title ? `# ${parsed.title}\n\n${parsed.body}` : parsed.body;
      if (memContent.trim()) {
        const { deduped } = await captureMessage(db, {
          userId,
          content: memContent,
          source: 'obsidian',
          messageType: 'note',
          id: `obsidian:${sha256(memContent)}`,
          metadata: { vault, relPath: note.relPath, title: parsed.title, tags: parsed.tags },
          createdAt: note.mtime,
        }, enqueueEnrichment);
        if (deduped) summary.memoriesDeduped += 1; else summary.memoriesCreated += 1;
      }
    } catch (e) {
      summary.errors.push({ relPath: note.relPath, error: String(e?.message || e).slice(0, 200) });
    }
  }

  return summary;
}
