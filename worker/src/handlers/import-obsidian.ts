import type { Env } from "../types/env";
import { SupabaseService } from "../services/supabase";
import { WorkersAIService } from "../services/workersai";
import { R2Service } from "../services/r2";
import { StreamService } from "../services/stream";
import type { InsertDocument } from "../types/database";
import { corsOrigin } from "../utils/cors";
import { parseFrontmatter, extractTitle } from "../parsers/frontmatter";
import { extractWikiLinks } from "../parsers/wikilinks";
import { extractInlineTags, mergeTags } from "../parsers/inline-tags";
import { extractDataviewFieldsAsObject } from "../parsers/dataview";
import { parseCanvas, canvasToSearchableText, canvasStats } from "../parsers/canvas";

// ============ Types ============

interface ObsidianNote {
  path: string;           // Original path in vault
  content: string;        // File content
  isCanvas?: boolean;
  contentHash?: string;   // SHA-256 for dedup
  lastModified?: number;  // File modification timestamp (ms since epoch)
}

interface ObsidianImportBatch {
  notes: ObsidianNote[];
  vaultName?: string;
  importJobId?: string;  // Optional: reuse existing import job
  skipEmbeddings?: boolean; // Skip embedding generation for large imports (faster)
}

interface ObsidianAttachmentUpload {
  importJobId: string;
  vaultName: string;
  originalPath: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  // File data is sent as base64 in the body
  data: string;
}

interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

interface AnalysisResult {
  total: number;
  new: number;
  existing: number;
  canvases: number;
  attachmentPaths: string[];
}

// ============ Utilities ============

/**
 * Generate SHA-256 hash of content
 */
async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert Obsidian path to MYA document path
 */
function toMayPath(obsidianPath: string, vaultName?: string): string {
  // Remove .md extension if present
  let path = obsidianPath.replace(/\.md$/, '');

  // Prefix with vault name or 'obsidian'
  const prefix = vaultName ? `obsidian/${vaultName}` : 'obsidian';

  return `${prefix}/${path}`;
}

/**
 * Check if a path should be skipped
 */
function shouldSkipPath(path: string): boolean {
  const skipPatterns = [
    /^\.obsidian\//,
    /^\.trash\//,
    /^\.git\//,
    /\/\.DS_Store$/,
    /^Templates\//i,
  ];

  return skipPatterns.some(pattern => pattern.test(path));
}

/**
 * Check if a path is an attachment (not a note)
 */
function isAttachmentPath(path: string): boolean {
  const attachmentExtensions = [
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
    '.mp3', '.wav', '.m4a', '.ogg',
    '.mp4', '.mov', '.webm',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  ];

  const lower = path.toLowerCase();
  return attachmentExtensions.some(ext => lower.endsWith(ext));
}

/**
 * Extract folder path from a note path (everything except the filename)
 */
function getFolderPath(notePath: string): string {
  const parts = notePath.split('/');
  parts.pop(); // Remove filename
  return parts.join('/');
}

/**
 * Create folder hierarchy for an Obsidian vault import
 * Returns a map of folderPath -> folderId
 */
async function createFolderHierarchy(
  supabase: SupabaseService,
  userId: string,
  notes: ObsidianNote[],
  vaultName: string
): Promise<Map<string, string>> {
  const folderMap = new Map<string, string>(); // folderPath -> folderId
  const client = supabase.getClient();

  // Collect all unique folder paths
  const folderPaths = new Set<string>();
  for (const note of notes) {
    if (shouldSkipPath(note.path) || isAttachmentPath(note.path)) continue;

    const folderPath = getFolderPath(note.path);
    if (folderPath) {
      // Add this folder and all parent folders
      const parts = folderPath.split('/');
      let current = '';
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        folderPaths.add(current);
      }
    }
  }

  // Check if vault root folder already exists
  const { data: existingVaultFolder } = await client
    .from('folders')
    .select('id')
    .eq('user_id', userId)
    .eq('name', vaultName)
    .eq('folder_type', 'user')
    .is('parent_id', null)
    .single();

  let vaultFolderId: string;

  if (existingVaultFolder) {
    vaultFolderId = existingVaultFolder.id;
    console.log(`Using existing vault folder: ${vaultName} (${vaultFolderId})`);
  } else {
    // Create the vault root folder
    const { data: newVaultFolder, error: vaultFolderError } = await client
      .from('folders')
      .insert({
        user_id: userId,
        name: vaultName,
        parent_id: null,
        folder_type: 'user',
        icon: '📚', // Obsidian vault icon
        sort_order: 0
      })
      .select('id')
      .single();

    if (vaultFolderError) {
      console.error('Failed to create vault folder:', vaultFolderError);
      throw new Error(`Failed to create vault folder: ${vaultFolderError.message}`);
    }

    vaultFolderId = newVaultFolder.id;
    console.log(`Created vault folder: ${vaultName} (${vaultFolderId})`);
  }

  // Map empty path (root) to vault folder
  folderMap.set('', vaultFolderId);

  // Sort folder paths by depth (shorter paths first)
  const sortedPaths = Array.from(folderPaths).sort((a, b) => {
    const depthA = a.split('/').length;
    const depthB = b.split('/').length;
    return depthA - depthB;
  });

  // Get existing subfolders under the vault folder (to reuse them)
  // Explicit limit to override PostgREST default of 1000
  const { data: existingFolders } = await client
    .from('folders')
    .select('id, name, parent_id')
    .eq('user_id', userId)
    .eq('folder_type', 'user')
    .limit(10000);

  // Build a map of existing folders: "parentId:name" -> folderId
  const existingFoldersByKey = new Map<string, string>();
  for (const f of existingFolders || []) {
    const key = `${f.parent_id || 'root'}:${f.name}`;
    existingFoldersByKey.set(key, f.id);
  }

  // Create folders in order (parents before children)
  for (const folderPath of sortedPaths) {
    const parts = folderPath.split('/');
    const folderName = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join('/');
    const parentId = folderMap.get(parentPath) || vaultFolderId;

    // Check if folder already exists
    const existingKey = `${parentId}:${folderName}`;
    const existingId = existingFoldersByKey.get(existingKey);

    if (existingId) {
      folderMap.set(folderPath, existingId);
      console.log(`Reusing existing folder: ${folderPath} (${existingId})`);
    } else {
      // Create the folder
      const { data: newFolder, error: folderError } = await client
        .from('folders')
        .insert({
          user_id: userId,
          name: folderName,
          parent_id: parentId,
          folder_type: 'user',
          sort_order: 0
        })
        .select('id')
        .single();

      if (folderError) {
        // If duplicate, try to find it
        if (folderError.code === '23505') {
          const { data: found } = await client
            .from('folders')
            .select('id')
            .eq('user_id', userId)
            .eq('name', folderName)
            .eq('parent_id', parentId)
            .single();

          if (found) {
            folderMap.set(folderPath, found.id);
            existingFoldersByKey.set(existingKey, found.id);
            continue;
          }
        }
        console.error(`Failed to create folder ${folderPath}:`, folderError);
        continue;
      }

      folderMap.set(folderPath, newFolder.id);
      existingFoldersByKey.set(existingKey, newFolder.id);
      console.log(`Created folder: ${folderPath} (${newFolder.id})`);
    }
  }

  return folderMap;
}

// ============ Analysis Handler ============

export async function handleAnalyzeObsidian(
  request: Request,
  env: Env
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin(request),
    "Content-Type": "application/json",
  };

  const supabase = new SupabaseService(env);

  // Verify session
  const sessionToken = request.headers.get("X-Session-Token");
  if (!sessionToken) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const session = await supabase.getSession(sessionToken);
  if (!session || new Date(session.expires_at) < new Date()) {
    return new Response(JSON.stringify({ error: "Session expired" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const userId = session.user_id;

  try {
    const batch = await request.json() as ObsidianImportBatch;

    if (!batch.notes || !Array.isArray(batch.notes)) {
      return new Response(JSON.stringify({ error: "No notes provided" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Get existing documents for this user with obsidian source
    const existingDocs = await supabase.getClient()
      .from("documents")
      .select("source_path, content_hash")
      .eq("user_id", userId)
      .eq("source_type", "obsidian")
      .not("source_path", "is", null);

    const existingMap = new Map<string, string>();
    for (const doc of existingDocs.data || []) {
      if (doc.source_path) {
        existingMap.set(doc.source_path, doc.content_hash || '');
      }
    }

    let total = 0;
    let existing = 0;
    let canvases = 0;
    const attachmentPaths: string[] = [];

    for (const note of batch.notes) {
      // Skip system paths
      if (shouldSkipPath(note.path)) continue;

      // Collect attachment paths
      if (isAttachmentPath(note.path)) {
        attachmentPaths.push(note.path);
        continue;
      }

      // Count canvases
      if (note.path.endsWith('.canvas')) {
        canvases++;
      }

      total++;

      // Check if exists with same content
      const existingHash = existingMap.get(note.path);
      if (existingHash) {
        const newHash = note.contentHash || await hashContent(note.content);
        if (existingHash === newHash) {
          existing++;
        }
      }
    }

    const result: AnalysisResult = {
      total,
      new: total - existing,
      existing,
      canvases,
      attachmentPaths,
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (e) {
    console.error("Obsidian analysis failed:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Analysis failed" }),
      { status: 500, headers: corsHeaders }
    );
  }
}

// ============ Import Handler ============

export async function handleImportObsidian(
  request: Request,
  env: Env
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin(request),
    "Content-Type": "application/json",
  };

  const supabase = new SupabaseService(env);
  const workersAI = new WorkersAIService(env);

  // Verify session
  const sessionToken = request.headers.get("X-Session-Token");
  if (!sessionToken) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const session = await supabase.getSession(sessionToken);
  if (!session || new Date(session.expires_at) < new Date()) {
    return new Response(JSON.stringify({ error: "Session expired" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const userId = session.user_id;

  try {
    const batch = await request.json() as ObsidianImportBatch;

    if (!batch.notes || !Array.isArray(batch.notes)) {
      return new Response(JSON.stringify({ error: "No notes provided" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Use vault name or default
    const vaultName = batch.vaultName || 'Obsidian';

    // Create or get import job
    let importJobId = batch.importJobId;
    if (!importJobId) {
      // Create new import job
      const { data: importJob, error: jobError } = await supabase.getClient()
        .from("import_jobs")
        .insert({
          user_id: userId,
          import_type: 'obsidian',
          status: 'processing',
          total_items: batch.notes.length,
          processed_items: 0,
          stats: { vault_name: vaultName },
          started_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (jobError || !importJob) {
        console.error('Failed to create import job:', jobError);
        throw new Error('Failed to create import job');
      }
      importJobId = importJob.id;
      console.log(`Created import job: ${importJobId}`);
    }

    // Create/reuse folder hierarchy for this batch's notes
    // createFolderHierarchy handles dedup internally (checks existing folders first)
    console.log(`Ensuring folder hierarchy for vault: ${vaultName} (${batch.notes.length} notes)`);
    const folderMap = await createFolderHierarchy(supabase, userId, batch.notes, vaultName);
    console.log(`Folder map has ${folderMap.size} entries`);

    // Get existing documents for dedup - only check paths in this batch
    const batchPaths = batch.notes
      .filter(n => !shouldSkipPath(n.path) && !isAttachmentPath(n.path))
      .map(n => n.path);

    const existingMap = new Map<string, { id: string; hash: string }>();

    if (batchPaths.length > 0) {
      const { data: existingDocs } = await supabase.getClient()
        .from("documents")
        .select("id, source_path, content_hash")
        .eq("user_id", userId)
        .eq("source_type", "obsidian")
        .in("source_path", batchPaths);

      for (const doc of existingDocs || []) {
        if (doc.source_path) {
          existingMap.set(doc.source_path, { id: doc.id, hash: doc.content_hash || '' });
        }
      }
    }

    const result: ImportResult = {
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [],
    };

    const documentsToInsert: InsertDocument[] = [];
    const documentsToUpdate: { id: string; data: Partial<InsertDocument> }[] = [];

    for (const note of batch.notes) {
      try {
        // Skip system paths and attachments
        if (shouldSkipPath(note.path)) continue;
        if (isAttachmentPath(note.path)) continue;

        const contentHash = note.contentHash || await hashContent(note.content);
        const existing = existingMap.get(note.path);

        // Skip if unchanged
        if (existing && existing.hash === contentHash) {
          result.skipped++;
          continue;
        }

        // Get folder ID for this note
        const noteFolderPath = getFolderPath(note.path);
        const folderId = folderMap.get(noteFolderPath) || folderMap.get('') || null;

        // Process the note
        let processedDoc: InsertDocument;

        if (note.path.endsWith('.canvas')) {
          processedDoc = await processCanvasNote(note, userId, contentHash, vaultName, folderId);
        } else {
          processedDoc = await processMarkdownNote(note, userId, contentHash, vaultName, folderId);
        }

        // Generate embedding (skip for large imports to avoid timeout)
        if (!batch.skipEmbeddings) {
          try {
            const textForEmbedding = processedDoc.content.slice(0, 8000);
            const embedding = await workersAI.generateEmbedding(textForEmbedding);
            processedDoc.embedding = embedding;
          } catch (embErr) {
            console.warn(`Embedding failed for ${note.path}:`, embErr);
          }
        }

        if (existing) {
          // Update existing
          documentsToUpdate.push({ id: existing.id, data: processedDoc });
        } else {
          // Insert new
          documentsToInsert.push(processedDoc);
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        result.errors.push(`Failed to process ${note.path}: ${err}`);
      }
    }

    // Add import_job_id to all documents' metadata
    for (const doc of documentsToInsert) {
      doc.metadata = {
        ...doc.metadata,
        import_job_id: importJobId,
      };
    }

    // Batch insert new documents
    if (documentsToInsert.length > 0) {
      const inserted = await supabase.insertDocumentsBatch(documentsToInsert);
      result.created = inserted;
    }

    // Update existing documents
    for (const update of documentsToUpdate) {
      try {
        // Add import_job_id to metadata
        update.data.metadata = {
          ...update.data.metadata,
          import_job_id: importJobId,
        };
        await supabase.getClient()
          .from("documents")
          .update(update.data)
          .eq("id", update.id);
        result.updated++;
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        result.errors.push(`Failed to update document: ${err}`);
      }
    }

    // Update import job status
    await supabase.getClient()
      .from("import_jobs")
      .update({
        status: result.errors.length > 0 ? 'complete' : 'complete',
        processed_items: result.created + result.updated + result.skipped,
        stats: {
          vault_name: vaultName,
          created: result.created,
          updated: result.updated,
          skipped: result.skipped,
          errors: result.errors.length,
        },
        completed_at: new Date().toISOString(),
      })
      .eq('id', importJobId);

    return new Response(JSON.stringify({
      stats: result,
      importJobId,
      vaultName,
    }), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (e) {
    console.error("Obsidian import failed:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Import failed" }),
      { status: 500, headers: corsHeaders }
    );
  }
}

// ============ Note Processing ============

async function processMarkdownNote(
  note: ObsidianNote,
  userId: string,
  contentHash: string,
  vaultName: string,
  folderId: string | null
): Promise<InsertDocument> {
  // Parse frontmatter
  const { frontmatter, content, tags: fmTags, aliases, created, modified } = parseFrontmatter(note.content);

  // Extract inline elements
  const inlineTags = extractInlineTags(content);
  const allTags = mergeTags(fmTags, inlineTags);
  const dataviewFields = extractDataviewFieldsAsObject(content);
  const wikiLinks = extractWikiLinks(content);

  // Determine title
  const filename = note.path.split('/').pop() || note.path;
  const title = (frontmatter.title as string) || extractTitle(content, filename);

  // Create summary (first 200 chars of content)
  const summary = content.slice(0, 200).replace(/\s+/g, ' ').trim();

  // Determine creation time: prefer frontmatter created (actual creation date)
  // Don't fall back to lastModified - that's modification time, not creation time
  const createdAt = created ? created : undefined;

  // Determine updated time: prefer frontmatter modified, then file lastModified
  const updatedAt = modified
    ? modified
    : note.lastModified
      ? new Date(note.lastModified).toISOString()
      : undefined;

  return {
    user_id: userId,
    path: toMayPath(note.path, vaultName),
    title,
    content,
    summary,
    is_internal: false,
    tags: allTags.length > 0 ? allTags : null,
    embedding: null, // Will be set later
    folder_id: folderId,
    metadata: {
      source: 'obsidian_import',
      vault_name: vaultName,
      frontmatter,
      dataview: Object.keys(dataviewFields).length > 0 ? dataviewFields : undefined,
      tags: allTags,
      aliases,
      wiki_links: wikiLinks.map(l => ({ target: l.target, anchor: l.anchor, isEmbed: l.isEmbed })),
      imported_at: new Date().toISOString(),
      original_created: created,
      original_modified: modified,
      file_last_modified: note.lastModified ? new Date(note.lastModified).toISOString() : undefined,
    },
    source_type: 'obsidian',
    source_path: note.path,
    content_hash: contentHash,
    created_at: createdAt,
    updated_at: updatedAt,
  } as InsertDocument;
}

async function processCanvasNote(
  note: ObsidianNote,
  userId: string,
  contentHash: string,
  vaultName: string,
  folderId: string | null
): Promise<InsertDocument> {
  // Parse canvas JSON
  const canvas = parseCanvas(note.content);
  const stats = canvasStats(canvas);

  // Extract searchable text for embedding
  const searchableText = canvasToSearchableText(canvas);

  // Determine title from filename
  const filename = note.path.split('/').pop()?.replace(/\.canvas$/, '') || 'Canvas';

  // Create summary
  const summary = `Canvas with ${stats.textNodes} text nodes, ${stats.fileNodes} file references, ${stats.groupNodes} groups, and ${stats.edges} connections.`;

  // Canvas files don't have frontmatter, so use file lastModified for updated_at
  // created_at will default to NOW() (we don't know when canvas was created)
  const updatedAt = note.lastModified
    ? new Date(note.lastModified).toISOString()
    : undefined;

  return {
    user_id: userId,
    path: toMayPath(note.path.replace(/\.canvas$/, ''), vaultName) + ' (canvas)',
    title: filename,
    content: searchableText,
    summary,
    is_internal: false,
    tags: null,
    embedding: null,
    folder_id: folderId,
    metadata: {
      source: 'obsidian_import',
      vault_name: vaultName,
      is_canvas: true,
      canvas_data: canvas, // Full canvas JSON preserved for future viewer
      canvas_stats: stats,
      imported_at: new Date().toISOString(),
      file_last_modified: note.lastModified ? new Date(note.lastModified).toISOString() : undefined,
    },
    source_type: 'obsidian',
    source_path: note.path,
    content_hash: contentHash,
    updated_at: updatedAt,
  } as InsertDocument;
}

// ============ Attachment Upload Handler ============

/**
 * Determine attachment type from MIME type
 */
function getAttachmentType(mimeType: string): "image" | "video" | "voice" | "file" {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'voice';
  return 'file';
}

/**
 * Handle uploading a single Obsidian attachment
 * POST /upload-obsidian-attachment
 */
export async function handleUploadObsidianAttachment(
  request: Request,
  env: Env
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin(request),
    "Content-Type": "application/json",
  };

  const supabase = new SupabaseService(env);
  const r2 = new R2Service(env);

  // Verify session
  const sessionToken = request.headers.get("X-Session-Token");
  if (!sessionToken) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const session = await supabase.getSession(sessionToken);
  if (!session || new Date(session.expires_at) < new Date()) {
    return new Response(JSON.stringify({ error: "Session expired" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const userId = session.user_id;

  try {
    const upload = await request.json() as ObsidianAttachmentUpload;

    if (!upload.importJobId || !upload.originalPath || !upload.data) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Verify import job belongs to user
    const { data: importJob } = await supabase.getClient()
      .from("import_jobs")
      .select("id, user_id")
      .eq("id", upload.importJobId)
      .eq("user_id", userId)
      .single();

    if (!importJob) {
      return new Response(JSON.stringify({ error: "Import job not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    // Decode base64 data
    const binaryData = Uint8Array.from(atob(upload.data), c => c.charCodeAt(0));
    const fileData = binaryData.buffer;

    const attachmentType = getAttachmentType(upload.mimeType);
    let r2Key: string | null = null;
    let streamUid: string | null = null;

    // For videos, upload to Cloudflare Stream
    if (attachmentType === 'video' && StreamService.isConfigured(env)) {
      try {
        const streamService = new StreamService(env);
        const streamResult = await streamService.uploadVideo(fileData, upload.filename, upload.mimeType);
        streamUid = streamResult.uid;
        console.log(`Uploaded video to Stream: ${streamUid}`);
      } catch (streamErr) {
        console.warn('Stream upload failed, falling back to R2:', streamErr);
        // Fall back to R2
        r2Key = await r2.storeObsidianAttachment(
          userId,
          upload.vaultName,
          upload.originalPath,
          fileData,
          upload.mimeType
        );
      }
    } else {
      // Store in R2
      r2Key = await r2.storeObsidianAttachment(
        userId,
        upload.vaultName,
        upload.originalPath,
        fileData,
        upload.mimeType
      );
    }

    // Create attachment record
    const { data: attachment, error: attachError } = await supabase.getClient()
      .from("attachments")
      .insert({
        user_id: userId,
        attachment_type: attachmentType,
        r2_key: r2Key,
        stream_uid: streamUid,
        original_filename: upload.filename,
        mime_type: upload.mimeType,
        file_size: upload.fileSize,
        import_job_id: upload.importJobId,
        source_type: 'obsidian',
        original_path: upload.originalPath,
        metadata: {
          vault_name: upload.vaultName,
          imported_at: new Date().toISOString(),
        },
      })
      .select('id')
      .single();

    if (attachError || !attachment) {
      console.error('Failed to create attachment record:', attachError);
      throw new Error('Failed to create attachment record');
    }

    return new Response(JSON.stringify({
      attachmentId: attachment.id,
      r2Key,
      streamUid,
      originalPath: upload.originalPath,
    }), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (e) {
    console.error("Obsidian attachment upload failed:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Upload failed" }),
      { status: 500, headers: corsHeaders }
    );
  }
}

// ============ Embed Rewriting Handler ============

/**
 * Rewrite wiki link embeds in documents after attachments are uploaded
 * POST /rewrite-obsidian-embeds
 */
export async function handleRewriteObsidianEmbeds(
  request: Request,
  env: Env
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin(request),
    "Content-Type": "application/json",
  };

  const supabase = new SupabaseService(env);

  // Verify session
  const sessionToken = request.headers.get("X-Session-Token");
  if (!sessionToken) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const session = await supabase.getSession(sessionToken);
  if (!session || new Date(session.expires_at) < new Date()) {
    return new Response(JSON.stringify({ error: "Session expired" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const userId = session.user_id;

  try {
    const { importJobId } = await request.json() as { importJobId: string };

    if (!importJobId) {
      return new Response(JSON.stringify({ error: "importJobId required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Verify import job belongs to user
    const { data: importJob } = await supabase.getClient()
      .from("import_jobs")
      .select("id")
      .eq("id", importJobId)
      .eq("user_id", userId)
      .single();

    if (!importJob) {
      return new Response(JSON.stringify({ error: "Import job not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    // Get all attachments for this import
    const { data: attachments } = await supabase.getClient()
      .from("attachments")
      .select("id, r2_key, stream_uid, original_path, original_filename, attachment_type")
      .eq("import_job_id", importJobId)
      .eq("user_id", userId);

    if (!attachments || attachments.length === 0) {
      return new Response(JSON.stringify({
        rewritten: 0,
        message: "No attachments found for this import",
      }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    // Build resolution map: various ways to reference an attachment
    const attachmentMap = new Map<string, { id: string; r2Key: string | null; streamUid: string | null; type: string }>();
    for (const att of attachments) {
      const info = { id: att.id, r2Key: att.r2_key, streamUid: att.stream_uid, type: att.attachment_type };

      // Map by original path
      if (att.original_path) {
        attachmentMap.set(att.original_path, info);
        // Also map by filename only (Obsidian default behavior)
        const filename = att.original_path.split('/').pop();
        if (filename && !attachmentMap.has(filename)) {
          attachmentMap.set(filename, info);
        }
      }
      // Map by original filename
      if (att.original_filename) {
        attachmentMap.set(att.original_filename, info);
      }
    }

    // Get all documents from this import
    const { data: documents } = await supabase.getClient()
      .from("documents")
      .select("id, content, metadata")
      .eq("user_id", userId)
      .eq("source_type", "obsidian")
      .filter("metadata->import_job_id", "eq", importJobId);

    if (!documents || documents.length === 0) {
      return new Response(JSON.stringify({
        rewritten: 0,
        message: "No documents found for this import",
      }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    let totalRewritten = 0;
    const errors: string[] = [];

    // Process each document
    for (const doc of documents) {
      try {
        let content = doc.content;
        let rewrittenCount = 0;

        // Find all embed wiki links: ![[target]]
        const embedPattern = /!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
        let match;

        while ((match = embedPattern.exec(doc.content)) !== null) {
          const target = match[1];
          const fullMatch = match[0];

          // Try to resolve the attachment
          const attachment = attachmentMap.get(target) ||
                            attachmentMap.get(target.split('/').pop() || '');

          if (attachment) {
            // Build replacement URL
            let replacement: string;
            if (attachment.type === 'image') {
              // For images: convert to markdown image with attachment API URL
              const altText = target.split('/').pop() || target;
              const key = attachment.r2Key || attachment.id;
              replacement = `![${altText}](/api/attachments/${encodeURIComponent(key)})`;
            } else if (attachment.type === 'video' && attachment.streamUid) {
              // For Stream videos: embed with stream-video marker
              replacement = `[video:${attachment.streamUid}]`;
            } else {
              // For other files: convert to download link
              const filename = target.split('/').pop() || target;
              const key = attachment.r2Key || attachment.id;
              replacement = `[${filename}](/api/attachments/${encodeURIComponent(key)})`;
            }

            content = content.replace(fullMatch, replacement);
            rewrittenCount++;
          }
        }

        // Update document if changes were made
        if (rewrittenCount > 0) {
          await supabase.getClient()
            .from("documents")
            .update({
              content,
              metadata: {
                ...doc.metadata,
                embeds_rewritten: rewrittenCount,
                embeds_rewritten_at: new Date().toISOString(),
              },
            })
            .eq("id", doc.id);

          totalRewritten += rewrittenCount;
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        errors.push(`Failed to process document ${doc.id}: ${err}`);
      }
    }

    return new Response(JSON.stringify({
      rewritten: totalRewritten,
      documentsProcessed: documents.length,
      attachmentsAvailable: attachments.length,
      errors: errors.length > 0 ? errors : undefined,
    }), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (e) {
    console.error("Obsidian embed rewriting failed:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Rewrite failed" }),
      { status: 500, headers: corsHeaders }
    );
  }
}
