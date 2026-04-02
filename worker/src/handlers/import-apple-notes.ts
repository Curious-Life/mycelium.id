import type { Env } from "../types/env";
import { SupabaseService } from "../services/supabase";
import { WorkersAIService } from "../services/workersai";
import type { InsertDocument } from "../types/database";
import { corsOrigin } from "../utils/cors";

// ============ Types ============

interface AppleNotesNote {
  identifier: string;
  title: string;
  content: string;
  folderPath: string;
  created: string;
  modified: string;
  parseWarning?: string;
}

interface AppleNotesImportBatch {
  notes: AppleNotesNote[];
  importJobId?: string;
}

interface AnalyzePayload {
  identifiers: string[];
}

interface ImportResult {
  imported: number;
  skipped: number;
  failed: number;
  warnings: number;
  failedNotes: { title: string; error: string }[];
  warningNotes: { title: string; warning: string }[];
  importJobId: string;
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
 * Build path map from existing folders
 */
function buildExistingFolderPaths(
  folders: { id: string; name: string; parent_id: string | null }[]
): Map<string, string> {
  const idToFolder = new Map(folders.map(f => [f.id, f]));
  const pathMap = new Map<string, string>();

  function getPath(folder: { id: string; name: string; parent_id: string | null }): string {
    if (folder.parent_id && idToFolder.has(folder.parent_id)) {
      return getPath(idToFolder.get(folder.parent_id)!) + '/' + folder.name;
    }
    return folder.name;
  }

  for (const folder of folders) {
    pathMap.set(getPath(folder), folder.id);
  }

  return pathMap;
}

/**
 * Create folder hierarchy using batch inserts grouped by depth
 */
async function ensureFolderHierarchyBatched(
  supabase: SupabaseService,
  userId: string,
  notes: AppleNotesNote[]
): Promise<Map<string, string>> {
  // Collect ALL unique path segments first
  const allPaths = new Set<string>();
  for (const note of notes) {
    const parts = note.folderPath.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      allPaths.add(current);
    }
  }

  // Get existing folders
  const { data: existingFolders } = await supabase.getClient()
    .from('folders')
    .select('id, name, parent_id')
    .eq('user_id', userId);

  const existingPathMap = buildExistingFolderPaths(existingFolders || []);
  const pathToId = new Map<string, string>();

  // Copy existing to pathToId
  for (const [path, id] of existingPathMap) {
    pathToId.set(path, id);
  }

  // Collect folders to create, grouped by depth
  const toCreate: { path: string; name: string; parentPath: string | null }[] = [];

  for (const path of allPaths) {
    if (existingPathMap.has(path)) continue;

    const parts = path.split('/');
    const name = parts[parts.length - 1];
    const parentPath = parts.length > 1 ? parts.slice(0, -1).join('/') : null;

    toCreate.push({ path, name, parentPath });
  }

  // Group by depth for true batch insert
  const byDepth = new Map<number, typeof toCreate>();
  for (const item of toCreate) {
    const depth = item.path.split('/').length;
    if (!byDepth.has(depth)) byDepth.set(depth, []);
    byDepth.get(depth)!.push(item);
  }

  // Insert level by level (parents must exist before children)
  const sortedDepths = Array.from(byDepth.keys()).sort((a, b) => a - b);

  for (const depth of sortedDepths) {
    const batch = byDepth.get(depth)!;

    const insertData = batch.map(item => ({
      user_id: userId,
      name: item.name,
      parent_id: item.parentPath ? pathToId.get(item.parentPath) || null : null,
      folder_type: 'user',
      icon: item.name === 'Apple Notes' ? '🍎' : '📁',
      sort_order: 0,
    }));

    const { data: created, error } = await supabase.getClient()
      .from('folders')
      .insert(insertData)
      .select('id, name, parent_id');

    if (!error && created) {
      // Map results back to paths by matching name + parent_id
      for (const folder of created) {
        const matchingItem = batch.find(item => {
          const expectedParentId = item.parentPath ? pathToId.get(item.parentPath) : null;
          return item.name === folder.name && expectedParentId === folder.parent_id;
        });
        if (matchingItem) {
          pathToId.set(matchingItem.path, folder.id);
        }
      }
    } else if (error) {
      console.error('[import-apple-notes] Batch folder insert error:', error);
      // Fall back to sequential inserts for this batch
      for (const item of batch) {
        const parentId = item.parentPath ? pathToId.get(item.parentPath) || null : null;
        const { data: newFolder, error: insertError } = await supabase.getClient()
          .from('folders')
          .insert({
            user_id: userId,
            name: item.name,
            parent_id: parentId,
            folder_type: 'user',
            icon: item.name === 'Apple Notes' ? '🍎' : '📁',
            sort_order: 0,
          })
          .select('id')
          .single();

        if (!insertError && newFolder) {
          pathToId.set(item.path, newFolder.id);
        }
      }
    }
  }

  return pathToId;
}

// ============ Analysis Handler ============

export async function handleAnalyzeAppleNotes(
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
    const payload: AnalyzePayload = await request.json();

    if (!payload.identifiers || !Array.isArray(payload.identifiers)) {
      return new Response(JSON.stringify({ error: "No identifiers provided" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Get existing Apple Notes by identifier
    const { data: existing } = await supabase.getClient()
      .from('documents')
      .select('metadata')
      .eq('user_id', userId)
      .eq('source_type', 'apple_notes')
      .not('metadata->apple_identifier', 'is', null);

    const existingIds = new Set(
      (existing || []).map(d => d.metadata?.apple_identifier as string).filter(Boolean)
    );

    const newCount = payload.identifiers.filter(id => !existingIds.has(id)).length;
    const existingCount = payload.identifiers.filter(id => existingIds.has(id)).length;

    return new Response(JSON.stringify({
      total: payload.identifiers.length,
      new: newCount,
      existing: existingCount,
    }), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (e) {
    console.error("Apple Notes analysis failed:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Analysis failed" }),
      { status: 500, headers: corsHeaders }
    );
  }
}

// ============ Import Handler ============

export async function handleImportAppleNotes(
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
    const batch: AppleNotesImportBatch = await request.json();

    if (!batch.notes || !Array.isArray(batch.notes)) {
      return new Response(JSON.stringify({ error: "No notes provided" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    console.log(`[import-apple-notes] Received ${batch.notes.length} notes from user ${userId}`);

    // Create or get import job
    let importJobId = batch.importJobId;
    if (!importJobId) {
      const { data: importJob, error: jobError } = await supabase.getClient()
        .from("import_jobs")
        .insert({
          user_id: userId,
          import_type: 'apple_notes',
          status: 'processing',
          total_items: batch.notes.length,
          processed_items: 0,
          stats: {},
          started_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (jobError || !importJob) {
        console.error('Failed to create import job:', jobError);
        throw new Error('Failed to create import job');
      }
      importJobId = importJob.id;
      console.log(`[import-apple-notes] Created import job: ${importJobId}`);
    }

    // Get existing Apple Notes for deduplication
    const { data: existing } = await supabase.getClient()
      .from('documents')
      .select('metadata')
      .eq('user_id', userId)
      .eq('source_type', 'apple_notes');

    const existingIds = new Set(
      (existing || []).map(d => d.metadata?.apple_identifier as string).filter(Boolean)
    );

    // Create folder hierarchy
    console.log(`[import-apple-notes] Creating folder hierarchy...`);
    const folderIdMap = await ensureFolderHierarchyBatched(supabase, userId, batch.notes);
    console.log(`[import-apple-notes] Created/found ${folderIdMap.size} folders`);

    // Filter new notes only
    const newNotes = batch.notes.filter(n => !existingIds.has(n.identifier));
    const skipped = batch.notes.length - newNotes.length;

    const result: ImportResult = {
      imported: 0,
      skipped,
      failed: 0,
      warnings: 0,
      failedNotes: [],
      warningNotes: [],
      importJobId: importJobId as string,
    };

    // Track warnings from parsing
    for (const note of newNotes) {
      if (note.parseWarning) {
        result.warnings++;
        result.warningNotes.push({
          title: note.title,
          warning: note.parseWarning,
        });
      }
    }

    // Prepare documents for insert
    const documentsToInsert: InsertDocument[] = [];

    for (const note of newNotes) {
      try {
        const contentHash = await hashContent(note.content);
        const folderId = folderIdMap.get(note.folderPath) || null;

        // Generate summary (first 200 chars)
        const summary = note.content.slice(0, 200).replace(/\s+/g, ' ').trim();

        const doc: InsertDocument = {
          user_id: userId,
          path: `apple-notes/${note.identifier}`,
          title: note.title,
          content: note.content,
          summary,
          is_internal: false,
          folder_id: folderId,
          tags: null,
          embedding: null,
          source_type: 'apple_notes',
          source_path: note.identifier,
          content_hash: contentHash,
          created_at: note.created,
          updated_at: note.modified,
          metadata: {
            apple_identifier: note.identifier,
            imported_at: new Date().toISOString(),
            import_job_id: importJobId,
            parser_version: '1.0.0',
            parse_method: note.parseWarning ? 'fallback' : 'structured',
          },
        };

        // Generate embedding
        try {
          const textForEmbedding = note.content.slice(0, 8000);
          const embedding = await workersAI.generateEmbedding(textForEmbedding);
          doc.embedding = embedding;
        } catch (embErr) {
          console.warn(`[import-apple-notes] Embedding failed for ${note.title}:`, embErr);
        }

        documentsToInsert.push(doc);
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        result.failed++;
        result.failedNotes.push({
          title: note.title,
          error: err,
        });
      }
    }

    // Batch insert documents
    const BATCH_SIZE = 50;
    for (let i = 0; i < documentsToInsert.length; i += BATCH_SIZE) {
      const insertBatch = documentsToInsert.slice(i, i + BATCH_SIZE);

      const { error } = await supabase.getClient()
        .from('documents')
        .insert(insertBatch);

      if (error) {
        console.error('[import-apple-notes] Batch insert error:', error);
        // Track failures
        for (const doc of insertBatch) {
          result.failed++;
          result.failedNotes.push({
            title: doc.title || 'Untitled',
            error: error.message,
          });
        }
      } else {
        result.imported += insertBatch.length;
      }
    }

    // Update import job status
    await supabase.getClient()
      .from("import_jobs")
      .update({
        status: 'complete',
        processed_items: result.imported + result.skipped + result.failed,
        stats: {
          imported: result.imported,
          skipped: result.skipped,
          failed: result.failed,
          warnings: result.warnings,
          failedNotesCount: result.failedNotes.length,
          warningNotesCount: result.warningNotes.length,
        },
        completed_at: new Date().toISOString(),
      })
      .eq('id', importJobId);

    console.log(`[import-apple-notes] Import complete: ${result.imported} imported, ${result.skipped} skipped, ${result.failed} failed`);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (e) {
    console.error("Apple Notes import failed:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Import failed" }),
      { status: 500, headers: corsHeaders }
    );
  }
}
