// Obsidian vault folder import.
//
// Each *.md note becomes BOTH:
//   • a DOCUMENT (saveDocument, upsert on path) placed in a FOLDER tree that
//     mirrors the vault — a root folder named after the vault, with subfolders
//     for each directory (db.folders.ensureSubFolder, idempotent). Canonical,
//     editable, re-syncs cleanly when the note is edited and re-imported; and
//   • a MEMORY (captureMessage, path-stable id) — the ONLY ingestion
//     path that reaches the mindscape (the drainer + clustering sync are
//     messages-only; see docs/DESIGN-import-connectors-2026-06-04.md, Pivot A).
//
// Two input modes (provide exactly one):
//   • { folderPath } — Node walks the directory (Tauri native-picker path);
//     relPaths are vault-relative, vault = the folder's basename.
//   • { files, vaultName } — [{ relPath, content, mtime? }] note bodies
//     (browser <input webkitdirectory>); the frontend sends vault-relative
//     relPaths + the picked dir as vaultName.
//
// Dedup: the memory id is path-stable (obsidian:<vault>/<relpath>, matching the
// document side). captureMessage compares content_hash → an unchanged re-import
// is a no-op; an edited note UPDATES the same memory in place + re-enriches (the
// new content re-flows to the mindscape, no orphaned duplicate). The document
// upserts on path; the folder tree is idempotent (ensureSubFolder find-or-create).
// Pre-0007 vaults keyed memories by content hash (obsidian:<sha256>); for an
// unchanged note that legacy row is redacted here so it stops orphaning a point.

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { captureMessage } from './capture.js';
import { saveDocument } from '../core/document-store.js';
import { parseMarkdownNote } from './markdown.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB per note
const MAX_FILES = 20000;                // total vault cap (logged if hit)
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.smart-env']);

// Legacy (pre-0007) memory id was the content hash. Used only to converge old
// vaults — see the memory block below. NOT used to mint new ids (those are path-stable).
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
 * @returns {Promise<{ scanned, documentsUpserted, memoriesCreated, memoriesDeduped, memoriesUpdated, memoriesMigrated, folders, skipped, truncated, errors }>}
 */
export async function importObsidianVault(db, { userId, folderPath, files, vaultName, enqueueEnrichment } = {}) {
  if (!db?.messages || !db?.documents) throw new TypeError('importObsidianVault: db.messages + db.documents required');
  if (typeof userId !== 'string' || !userId) throw new Error('importObsidianVault: userId required');
  if (!folderPath && !Array.isArray(files)) throw new Error('importObsidianVault: folderPath or files required');

  const summary = {
    scanned: 0, documentsUpserted: 0, memoriesCreated: 0, memoriesDeduped: 0,
    memoriesUpdated: 0, memoriesMigrated: 0, folders: 0, skipped: 0, truncated: false, errors: [],
  };

  // ── Build the raw note list + resolve the vault name ──
  let raw = [];
  let vault = (typeof vaultName === 'string' && vaultName.trim()) ? vaultName.trim() : null;
  if (folderPath) {
    const root = path.resolve(folderPath);
    const st = await fs.stat(root).catch(() => null);
    if (!st || !st.isDirectory()) throw new Error('importObsidianVault: folderPath is not a directory');
    vault = vault || path.basename(root.replace(/[/\\]+$/, '')) || 'vault';
    const { files: found, truncated } = await walkMarkdown(root);
    summary.truncated = truncated;
    for (const f of found) {
      try {
        const s = await fs.stat(f.abs);
        if (s.size > MAX_FILE_BYTES) { summary.skipped += 1; continue; }
        raw.push({ relPath: f.relPath, content: await fs.readFile(f.abs, 'utf8'), mtime: s.mtime?.toISOString?.() });
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
      raw.push({ relPath: f.relPath, content: f.content, mtime: typeof f.mtime === 'string' ? f.mtime : undefined });
    }
    if (raw.length > MAX_FILES) { raw = raw.slice(0, MAX_FILES); summary.truncated = true; }
    // Fallback if the client didn't send vaultName: use the common leading
    // segment of webkitRelativePath (the picked dir), else 'vault'.
    if (!vault) {
      const first = raw.find((r) => r.relPath.includes('/'));
      vault = (first ? first.relPath.split('/')[0] : null) || 'vault';
    }
  }

  if (summary.truncated) {
    console.warn(`[obsidian-import] vault exceeds ${MAX_FILES} notes — importing the first ${MAX_FILES} (rest skipped)`);
  }

  // Normalize to vault-relative paths. The frontend sends vault-relative paths
  // already; this defensively strips a leading "<vault>/" if a client left it on.
  const vaultPrefix = `${vault}/`;
  const work = raw.map((r) => {
    let rel = r.relPath.replace(/^\/+/, '');
    if (rel.startsWith(vaultPrefix)) rel = rel.slice(vaultPrefix.length);
    return { ...r, vaultRel: rel };
  });
  summary.scanned = work.length;

  // ── Folder tree: a root folder named after the vault + a subfolder per dir ──
  // `folders.name` is ENCRYPTED at rest (non-deterministic AES-GCM), so an
  // equality WHERE can't match — db.folders.ensureSubFolder is NOT idempotent
  // for encrypted names (it would create a duplicate on every re-import). We
  // load the user's folders once (the db layer decrypts names) and find-or-
  // create against an in-memory (parent_id, name) index, mirroring the secrets
  // namespace's select-all+filter pattern. Idempotent across re-imports.
  const foldersSupported = Boolean(db.folders?.list && db.folders?.create);
  const fkey = (parentId, name) => `${parentId ?? '∅'}\0${name}`;
  const folderIndex = new Map();
  const touchedFolders = new Set();
  if (foldersSupported) {
    try { for (const f of await db.folders.list(userId)) folderIndex.set(fkey(f.parent_id ?? null, f.name), f.id); }
    catch { /* folders optional — degrade to library root */ }
  }
  async function ensureFolder(parentId, name) {
    const k = fkey(parentId ?? null, name);
    let id = folderIndex.get(k);
    if (!id) { id = (await db.folders.create(userId, name, parentId ?? null)).id; folderIndex.set(k, id); }
    touchedFolders.add(id);
    return id;
  }
  let rootFolderId = null;
  if (foldersSupported) {
    try { rootFolderId = await ensureFolder(null, vault); }
    catch { rootFolderId = null; /* degrade to library root */ }
  }
  async function folderForDir(dirSegments) {
    if (rootFolderId == null) return null;
    let parentId = rootFolderId;
    for (const name of dirSegments) parentId = await ensureFolder(parentId, name);
    return parentId;
  }

  // ── Ingest each note: document (in its folder) + memory ──
  for (const note of work) {
    try {
      const parsed = parseMarkdownNote(note.content, note.vaultRel);
      const cleanRel = note.vaultRel.replace(/\.md$/i, '');
      // Reject traversal BEFORE touching folders or the document write.
      const segs = cleanRel.split('/');
      if (!cleanRel || segs.some((s) => s === '' || s === '.' || s === '..')) {
        summary.skipped += 1;
        summary.errors.push({ relPath: note.vaultRel, error: 'unsafe_path' });
        continue;
      }
      const dirSegments = segs.slice(0, -1);
      const folderId = await folderForDir(dirSegments);

      // Document — canonical/editable; upsert on (user_id, path) = clean re-sync.
      // Path carries the vault name so two vaults can't collide at the same name.
      await saveDocument({ db }, {
        userId,
        source: 'import-obsidian',
        sourceType: 'import_obsidian',
        createdBy: 'import',
        scope: 'personal',
        pathArgs: { name: `${vault}/${cleanRel}` },
        content: parsed.body,
        title: parsed.title,
        folderId: folderId ?? undefined,
        metadata: { vault, relPath: note.vaultRel, tags: parsed.tags, frontmatter: parsed.frontmatter },
        createdAt: note.mtime,
        updatedAt: note.mtime,
      });
      summary.documentsUpserted += 1;

      // Memory — reaches the mindscape via captureMessage. Path-stable id (NOT
      // content-addressed) so an edited note UPDATES the same memory in place via
      // content_hash change-detection, instead of orphaning a duplicate. Mirrors
      // the document's upsert-on-path; the id carries the vault name.
      const memContent = parsed.title ? `# ${parsed.title}\n\n${parsed.body}` : parsed.body;
      if (memContent.trim()) {
        const memId = `obsidian:${vault}/${cleanRel}`;
        const { deduped, updated } = await captureMessage(db, {
          userId,
          content: memContent,
          source: 'obsidian',
          messageType: 'note',
          id: memId,
          metadata: { vault, relPath: note.vaultRel, title: parsed.title, tags: parsed.tags },
          createdAt: note.mtime,
        }, enqueueEnrichment);
        if (updated) summary.memoriesUpdated += 1;
        else if (deduped) summary.memoriesDeduped += 1;
        else summary.memoriesCreated += 1;

        // One-time convergence for pre-0007 vaults: those imports keyed the memory
        // by content hash (obsidian:<sha256(content)>). For an UNCHANGED note that
        // legacy row duplicates the new path-stable memory and orphans a stale
        // mindscape point — redact it. (A note edited since the legacy import can't
        // be matched by content and is left as-is.)
        const legacyId = `obsidian:${sha256(memContent)}`;
        if (legacyId !== memId && typeof db.messages.redact === 'function') {
          try {
            const r = await db.messages.redact(legacyId, userId);
            if (r?.found && !r.alreadyForgotten) summary.memoriesMigrated += 1;
          } catch { /* best-effort convergence */ }
        }
      }
    } catch (e) {
      summary.errors.push({ relPath: note.vaultRel, error: String(e?.message || e).slice(0, 200) });
    }
  }

  // Distinct folders this import touched (root + each subfolder it placed notes in).
  summary.folders = touchedFolders.size;
  return summary;
}
