import type { Env } from "../types/env";
import { SupabaseService } from "../services/supabase";
import { WorkersAIService } from "../services/workersai";
import { ClaudeService } from "../services/claude";
import { R2Service } from "../services/r2";
import { StreamService } from "../services/stream";
import { corsOrigin } from "../utils/cors";
import JSZip from "jszip";

interface UploadResult {
  success: boolean;
  type: "attachment" | "document" | "claude_export";
  id?: string;
  error?: string;
  stats?: ClaudeExportStats;
}

interface ClaudeExportStats {
  conversations: number;
  messages: number;
  projects: number;
  project_docs: number;
  memories: number;
  skipped_duplicates: number;
  artifacts_kept: number;
  artifacts_deduplicated: number;
}

interface ClaudeMessage {
  uuid: string;
  sender: "human" | "assistant";
  text: unknown; // Can be string, array, object, or null in Claude exports
  content?: unknown; // Can be string, array, object, or null in Claude exports
  created_at: string;
  attachments?: Array<{ file_name: string; extracted_content?: string }>;
}

interface ClaudeConversation {
  uuid: string;
  name: string;
  summary?: string;
  created_at: string;
  updated_at: string;
  chat_messages: ClaudeMessage[];
}

interface ClaudeProject {
  uuid: string;
  name: string;
  description?: string;
  prompt_template?: string;
  created_at: string;
  docs?: Array<{
    uuid: string;
    filename: string;
    content: string;
    created_at: string;
  }>;
}

interface ClaudeMemory {
  account_uuid: string;
  conversations_memory?: string;
  project_memories?: Record<string, string>;
}

interface ParsedArtifact {
  identifier: string | null; // "attachment:filename" or "content:first_line"
  type: string | null;
  title: string | null;
  content: string;
}

// Generic filenames that shouldn't be used as unique identifiers
const GENERIC_FILENAMES = new Set([
  "paste.txt", "paste-2.txt", "paste-3.txt", "paste-4.txt", "paste-5.txt",
  "untitled.txt", "code.txt", "snippet.txt",
]);

/**
 * Generate a unique identifier for an artifact based on filename or content.
 * Used for deduplication - same identifier = same artifact (keep latest version).
 */
function generateArtifactIdentifier(filename: string | null, content: string): string | null {
  // Priority 1: Use specific filenames (not generic ones)
  if (filename && !GENERIC_FILENAMES.has(filename.toLowerCase())) {
    return `attachment:${filename}`;
  }

  // Priority 2: Use first meaningful line of content
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines and very short ones
    if (trimmed.length > 5 && trimmed.length <= 150) {
      return `content:${trimmed}`;
    }
  }

  return null; // No identifier = always keep (no deduplication)
}

/**
 * Extract artifacts from message text (both XML tags and attachments array)
 */
function extractArtifacts(
  text: string,
  attachments?: Array<{ file_name: string; extracted_content?: string }>
): ParsedArtifact[] {
  const artifacts: ParsedArtifact[] = [];

  // Extract from XML tags: <antArtifact identifier="..." type="..." title="...">content</antArtifact>
  const xmlRegex = /<antArtifact(?:\s+[^>]*)?>[\s\S]*?<\/antArtifact>/g;
  const attrRegex = /(\w+)=["']([^"']*)["']/g;

  let match;
  while ((match = xmlRegex.exec(text)) !== null) {
    const fullTag = match[0];

    // Extract attributes
    const attrs: Record<string, string> = {};
    let attrMatch;
    while ((attrMatch = attrRegex.exec(fullTag)) !== null) {
      attrs[attrMatch[1]] = attrMatch[2];
    }

    // Extract content (between opening and closing tags)
    const contentMatch = fullTag.match(/<antArtifact[^>]*>([\s\S]*)<\/antArtifact>/);
    const content = contentMatch ? contentMatch[1].trim() : "";

    const identifier = generateArtifactIdentifier(attrs.title || null, content);

    artifacts.push({
      identifier,
      type: attrs.type || null,
      title: attrs.title || null,
      content,
    });
  }

  // Extract from attachments array
  if (attachments) {
    for (const att of attachments) {
      if (att.extracted_content) {
        const identifier = generateArtifactIdentifier(att.file_name, att.extracted_content);
        artifacts.push({
          identifier,
          type: null,
          title: att.file_name,
          content: att.extracted_content,
        });
      }
    }
  }

  return artifacts;
}

/**
 * Strip artifact XML tags from text, replacing with [ARTIFACT] placeholder
 */
function stripArtifactTags(text: string): string {
  return text.replace(/<antArtifact[^>]*>[\s\S]*?<\/antArtifact>/g, "[ARTIFACT]").trim();
}

/**
 * Two-pass conversation parsing with artifact deduplication.
 * Pass 1: Find latest version of each artifact per conversation
 * Pass 2: Build messages with only latest artifact content
 */
function parseConversationWithDeduplication(
  messages: ClaudeMessage[]
): Array<{ msg: ClaudeMessage; textStripped: string; textWithArtifacts: string; artifactCount: number }> {
  // PASS 1: Collect latest version of each artifact
  const latestArtifacts = new Map<string, { msgIdx: number; artifact: ParsedArtifact }>();

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    const rawText1 = msg.text || msg.content;
    const text = typeof rawText1 === 'string' ? rawText1 : '';
    const artifacts = extractArtifacts(text, msg.attachments);

    for (const artifact of artifacts) {
      if (artifact.identifier) {
        // Later messages overwrite earlier ones (keeps latest)
        latestArtifacts.set(artifact.identifier, { msgIdx, artifact });
      }
    }
  }

  // Build set of (msgIdx, identifier) pairs for latest versions
  const latestLocations = new Set<string>();
  for (const [identifier, { msgIdx }] of latestArtifacts) {
    latestLocations.add(`${msgIdx}:${identifier}`);
  }

  // PASS 2: Build messages with deduplicated artifact content
  const results: Array<{ msg: ClaudeMessage; textStripped: string; textWithArtifacts: string; artifactCount: number }> = [];

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    const rawText2 = msg.text || msg.content;
    const text = typeof rawText2 === 'string' ? rawText2 : '';
    const artifacts = extractArtifacts(text, msg.attachments);

    const textStripped = stripArtifactTags(text);

    // Only include artifact content if it's the latest version
    const artifactContents: string[] = [];
    let artifactCount = 0;

    for (const artifact of artifacts) {
      const isLatest =
        artifact.identifier === null || // No ID = always include
        latestLocations.has(`${msgIdx}:${artifact.identifier}`);

      if (isLatest && artifact.content) {
        const label = artifact.title || "artifact";
        artifactContents.push(`\n[Artifact: ${label}]\n${artifact.content.substring(0, 1000)}`);
        artifactCount++;
      }
    }

    const textWithArtifacts = textStripped + artifactContents.join("\n");

    results.push({ msg, textStripped, textWithArtifacts, artifactCount });
  }

  return results;
}

/**
 * Handle file uploads from the portal
 * Processes files through the AI pipeline (same as Telegram)
 */
export async function handleUpload(
  request: Request,
  env: Env
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin(request),
    "Content-Type": "application/json",
  };

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        ...corsHeaders,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Session-Token, X-Folder-Id",
      },
    });
  }

  const supabase = new SupabaseService(env);
  const workersAI = new WorkersAIService(env);
  const r2 = new R2Service(env);
  const claude = new ClaudeService(env);

  // Verify session token from header
  const sessionToken = request.headers.get("X-Session-Token");
  if (!sessionToken) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  // Verify session
  const session = await supabase.getSession(sessionToken);
  if (!session || new Date(session.expires_at) < new Date()) {
    return new Response(JSON.stringify({ error: "Session expired" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const userId = session.user_id;

  // Get optional folder ID from header
  const folderId = request.headers.get("X-Folder-Id") || undefined;

  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return new Response(JSON.stringify({ error: "No file provided" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const mimeType = file.type;
    const filename = file.name;
    const fileData = await file.arrayBuffer();

    console.log(`Upload: ${filename} (${mimeType}, ${fileData.byteLength} bytes)${folderId ? ` to folder ${folderId}` : ''}`);

    let result: UploadResult;

    // Route by file type
    if (mimeType.startsWith("image/")) {
      result = await processImage(userId, fileData, mimeType, supabase, workersAI, r2, folderId);
    } else if (mimeType.startsWith("video/")) {
      result = await processVideo(userId, fileData, mimeType, filename, supabase, workersAI, env, folderId);
    } else if (mimeType === "text/markdown" || filename.endsWith(".md")) {
      result = await processMarkdown(userId, fileData, filename, supabase, workersAI, folderId);
    } else if (mimeType === "text/plain" || filename.endsWith(".txt")) {
      result = await processText(userId, fileData, filename, supabase, workersAI, folderId);
    } else if (mimeType === "application/zip" || filename.endsWith(".zip")) {
      // Claude export ZIP file
      result = await processClaudeExport(userId, fileData, supabase, workersAI);
    } else if (mimeType === "application/pdf" || filename.endsWith(".pdf")) {
      result = await processPdf(userId, fileData, filename, supabase, workersAI, r2, claude, folderId);
    } else {
      return new Response(
        JSON.stringify({ error: `Unsupported file type: ${mimeType}` }),
        { status: 400, headers: corsHeaders }
      );
    }

    return new Response(JSON.stringify(result), { headers: corsHeaders });
  } catch (e) {
    console.error("Upload error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: corsHeaders }
    );
  }
}

/**
 * Process image upload
 * - Store in R2
 * - Describe with vision AI
 * - Tag and extract entities
 * - Generate embedding
 * - Create attachment + message records
 */
async function processImage(
  userId: string,
  data: ArrayBuffer,
  mimeType: string,
  supabase: SupabaseService,
  workersAI: WorkersAIService,
  r2: R2Service,
  folderId?: string
): Promise<UploadResult> {
  // Store in R2
  const r2Key = await r2.storeImage(userId, data, mimeType);
  console.log(`Stored image: ${r2Key}`);

  // Describe image with vision AI
  const description = await workersAI.describeImage(data, mimeType);
  console.log(`Image description: ${description.substring(0, 100)}...`);

  // Tag the description
  const taggingResult = await workersAI.tagMessage(description);
  console.log(`Tags: ${taggingResult.tags.join(", ")}`);

  // Generate embedding for semantic search
  const embedding = await workersAI.generateEmbedding(description);

  // Store attachment record
  const { data: attachment, error: attError } = await supabase.insertAttachment({
    user_id: userId,
    attachment_type: "image",
    r2_key: r2Key,
    description,
    tags: taggingResult.tags,
    file_size: data.byteLength,
    mime_type: mimeType,
    folder_id: folderId,
    metadata: {
      entities: taggingResult.entities,
      source: "portal_upload",
    },
  });

  if (attError) throw attError;

  // Create a message record for the upload (so it appears in history)
  await supabase.insertMessage({
    user_id: userId,
    role: "user",
    content: `[Portal Upload] ${description}`,
    message_type: "image",
    tags: taggingResult.tags,
    entities_people: taggingResult.entities.people,
    entities_projects: taggingResult.entities.projects,
    suggested_new_tag: null,
    attachment_id: attachment?.id || null,
    embedding,
    folder_id: folderId || null,
    metadata: {
      source: "portal_upload",
      entities_companies: taggingResult.entities.companies,
      entities_places: taggingResult.entities.places,
    },
  });

  return { success: true, type: "attachment", id: attachment?.id };
}

/**
 * Process video upload
 * - Upload to Cloudflare Stream for iOS-compatible HLS transcoding
 * - Tag based on filename
 * - Generate embedding
 * - Create attachment + message records
 */
async function processVideo(
  userId: string,
  data: ArrayBuffer,
  mimeType: string,
  filename: string,
  supabase: SupabaseService,
  workersAI: WorkersAIService,
  env: Env,
  folderId?: string
): Promise<UploadResult> {
  // Check if Stream is configured
  if (!StreamService.isConfigured(env)) {
    throw new Error("Cloudflare Stream is not configured. Video uploads require Stream for iOS compatibility.");
  }

  // Upload to Cloudflare Stream for iOS-compatible HLS
  const stream = new StreamService(env);
  const streamInfo = await stream.uploadVideo(data, filename, mimeType);
  console.log(`Uploaded video to Stream: ${streamInfo.uid} (status: ${streamInfo.status})`);

  // For video, we use filename as description since we can't extract frames
  const description = `Video upload: ${filename}`;

  // Tag
  const taggingResult = await workersAI.tagMessage(description);
  const embedding = await workersAI.generateEmbedding(description);

  // Store attachment with stream_uid (no r2_key for Stream videos)
  const { data: attachment, error: attError } = await supabase.insertAttachment({
    user_id: userId,
    attachment_type: "video",
    r2_key: undefined, // Not stored in R2 - using Stream
    stream_uid: streamInfo.uid,
    description,
    tags: taggingResult.tags,
    file_size: data.byteLength,
    mime_type: mimeType,
    folder_id: folderId,
    metadata: {
      source: "portal_upload",
      stream_status: streamInfo.status,
      stream_duration: streamInfo.duration,
    },
  });

  if (attError) throw attError;

  // Create message record
  await supabase.insertMessage({
    user_id: userId,
    role: "user",
    content: `[Portal Upload] ${description}`,
    message_type: "video",
    tags: taggingResult.tags,
    entities_people: taggingResult.entities.people,
    entities_projects: taggingResult.entities.projects,
    suggested_new_tag: null,
    attachment_id: attachment?.id || null,
    embedding,
    folder_id: folderId || null,
    metadata: {
      source: "portal_upload",
      entities_companies: taggingResult.entities.companies,
      entities_places: taggingResult.entities.places,
    },
  });

  return { success: true, type: "attachment", id: attachment?.id };
}

/**
 * Process markdown document upload
 * - Parse title from content or filename
 * - Generate path from filename
 * - Tag content
 * - Generate embedding
 * - Create document record
 */
async function processMarkdown(
  userId: string,
  data: ArrayBuffer,
  filename: string,
  supabase: SupabaseService,
  workersAI: WorkersAIService,
  folderId?: string
): Promise<UploadResult> {
  const content = new TextDecoder().decode(data);

  // Extract title from first heading or filename
  let title = filename.replace(/\.md$/, "").replace(/[-_]/g, " ");
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    title = headingMatch[1];
  }

  // Generate path from filename
  const safeName = filename
    .replace(/\.md$/, "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "");
  const path = `uploads/${safeName}`;

  console.log(`Processing markdown: ${title} -> ${path}`);

  // Tag the content (limit to first 2000 chars for tagging)
  const taggingResult = await workersAI.tagMessage(content.substring(0, 2000));

  // Generate embedding (limit to first 8000 chars)
  const embedding = await workersAI.generateEmbedding(content.substring(0, 8000));

  // Create/update document
  const document = await supabase.upsertDocument({
    user_id: userId,
    path,
    title,
    content,
    summary: content.substring(0, 200).replace(/\n/g, " "),
    is_internal: false,
    tags: taggingResult.tags,
    embedding,
    folder_id: folderId || null,
    metadata: {
      source: "portal_upload",
    },
  });

  return { success: true, type: "document", id: document.id };
}

/**
 * Process plain text document upload
 * - Parse title from first line or filename
 * - Generate path from filename
 * - Tag content
 * - Generate embedding
 * - Create document record
 */
async function processText(
  userId: string,
  data: ArrayBuffer,
  filename: string,
  supabase: SupabaseService,
  workersAI: WorkersAIService,
  folderId?: string
): Promise<UploadResult> {
  const content = new TextDecoder().decode(data);

  // Extract title from first non-empty line or filename
  let title = filename.replace(/\.txt$/i, "").replace(/[-_]/g, " ");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length > 0 && lines[0].trim().length < 100) {
    // Use first line as title if it's short enough
    title = lines[0].trim();
  }

  // Generate path from filename
  const safeName = filename
    .replace(/\.txt$/i, "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "");
  const path = `uploads/txt/${safeName}`;

  console.log(`Processing text file: ${title} -> ${path}`);

  // Tag the content (limit to first 2000 chars for tagging)
  const taggingResult = await workersAI.tagMessage(content.substring(0, 2000));

  // Generate embedding (limit to first 8000 chars)
  const embedding = await workersAI.generateEmbedding(content.substring(0, 8000));

  // Create/update document
  const document = await supabase.upsertDocument({
    user_id: userId,
    path,
    title,
    content,
    summary: content.substring(0, 200).replace(/\n/g, " "),
    is_internal: false,
    tags: taggingResult.tags,
    embedding,
    folder_id: folderId || null,
    source_type: "txt",
    metadata: {
      source: "portal_upload",
      original_filename: filename,
    },
  });

  return { success: true, type: "document", id: document.id };
}

/**
 * Process PDF document upload
 * - Store in R2 for archival
 * - Extract text content (unpdf for vector, Claude vision for bitmap/scanned)
 * - Tag content
 * - Generate embedding
 * - Create document record
 */
async function processPdf(
  userId: string,
  data: ArrayBuffer,
  filename: string,
  supabase: SupabaseService,
  workersAI: WorkersAIService,
  r2: R2Service,
  claude: ClaudeService,
  folderId?: string
): Promise<UploadResult> {
  // Store PDF in R2 for archival/viewing
  const r2Key = await r2.storeFile(userId, data, filename, "application/pdf");
  console.log(`Stored PDF: ${r2Key}`);

  // Extract text from PDF - try fast extraction first, fall back to Claude vision for scanned/image PDFs
  let extractedText = "";
  let usedOcr = false;

  // Step 1: Try unpdf text extraction (fast, free, works for vector PDFs)
  try {
    const { extractText } = await import("unpdf");
    const result = await extractText(new Uint8Array(data));
    extractedText = Array.isArray(result.text) ? result.text.join("\n\n") : String(result.text);
    // Clean up whitespace-only extraction
    extractedText = extractedText.trim();
    console.log(`[PDF] unpdf extracted ${extractedText.length} chars`);
  } catch (e) {
    console.warn("[PDF] unpdf extraction failed:", e);
  }

  // Step 2: If extraction yielded too little text, use Claude vision for OCR
  // This handles scanned PDFs, image PDFs, and bitmap PDFs
  const MIN_TEXT_LENGTH = 100; // Minimum meaningful text
  if (extractedText.length < MIN_TEXT_LENGTH) {
    console.log(`[PDF] Text too short (${extractedText.length} chars), using Claude vision for OCR...`);
    try {
      // Check file size (Claude limit: 32MB)
      if (data.byteLength > 32 * 1024 * 1024) {
        console.warn(`[PDF] File too large for Claude OCR (${Math.round(data.byteLength / 1024 / 1024)}MB > 32MB)`);
      } else {
        extractedText = await claude.extractPdfText(data, filename);
        usedOcr = true;
        console.log(`[PDF] Claude OCR extracted ${extractedText.length} chars`);
      }
    } catch (e) {
      console.error("[PDF] Claude OCR failed:", e);
      // Final fallback
      if (extractedText.length < 10) {
        extractedText = `[PDF document: ${filename}]\n\nThis appears to be a scanned or image-based PDF. Text extraction was not possible. The PDF is stored for viewing.`;
      }
    }
  }

  // Generate title from filename
  let title = filename.replace(/\.pdf$/i, "").replace(/[-_]/g, " ");

  // Try to extract title from first line if it looks like a header
  const firstLine = extractedText.split("\n").find((l) => l.trim().length > 5);
  if (firstLine && firstLine.length < 100 && !firstLine.includes("...") && !firstLine.startsWith("[PDF")) {
    title = firstLine.trim();
  }

  // Generate path from filename
  const safeName = filename
    .replace(/\.pdf$/i, "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "");
  const path = `uploads/pdf/${safeName}`;

  console.log(`Processing PDF: ${title} -> ${path}`);

  // Tag the content (limit to first 2000 chars for tagging)
  const taggingResult = await workersAI.tagMessage(extractedText.substring(0, 2000));

  // Generate embedding (limit to first 8000 chars)
  const embedding = await workersAI.generateEmbedding(extractedText.substring(0, 8000));

  // Create/update document
  const document = await supabase.upsertDocument({
    user_id: userId,
    path,
    title,
    content: extractedText,
    summary: extractedText.substring(0, 200).replace(/\n/g, " "),
    is_internal: false,
    tags: taggingResult.tags,
    embedding,
    folder_id: folderId || null,
    source_type: "pdf",
    metadata: {
      source: "portal_upload",
      r2_key: r2Key,
      original_filename: filename,
      file_size: data.byteLength,
      used_ocr: usedOcr,
    },
  });

  return { success: true, type: "document", id: document.id };
}

/**
 * Process Claude export ZIP file
 * Parses conversations.json, projects.json, memories.json
 * Imports all messages into the database for NLP processing
 *
 * Flow:
 * 1. Parse ZIP and extract JSON files
 * 2. Parse conversations → insert as messages (nlp_processed=false)
 * 3. Parse projects → insert prompt_template and docs as documents
 * 4. Parse memories → insert as documents (global context)
 * 5. Return stats for frontend to show progress
 *
 * Then call Modal /batch-import-start to process with parallel GLiNER workers
 */
async function processClaudeExport(
  userId: string,
  data: ArrayBuffer,
  supabase: SupabaseService,
  workersAI: WorkersAIService
): Promise<UploadResult> {
  const stats: ClaudeExportStats = {
    conversations: 0,
    messages: 0,
    projects: 0,
    project_docs: 0,
    memories: 0,
    skipped_duplicates: 0,
    artifacts_kept: 0,
    artifacts_deduplicated: 0,
  };

  // Load ZIP
  const zip = await JSZip.loadAsync(data);
  console.log("ZIP files:", Object.keys(zip.files));

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. PARSE CONVERSATIONS
  // ═══════════════════════════════════════════════════════════════════════════
  const conversationsFile = Object.keys(zip.files).find(
    (f) => f.includes("conversations") && f.endsWith(".json")
  );

  let conversations: ClaudeConversation[] = [];
  if (conversationsFile) {
    console.log(`Parsing conversations from ${conversationsFile}...`);
    const content = await zip.files[conversationsFile].async("string");

    // Handle both array and wrapped object format
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      conversations = parsed;
    } else if (parsed.conversations) {
      conversations = parsed.conversations;
    }

    stats.conversations = conversations.length;

    // Collect all UUIDs from conversations for batched duplicate check
    const incomingUuids: string[] = [];
    for (const conv of conversations) {
      for (const msg of conv.chat_messages || []) {
        if (msg.uuid) {
          incomingUuids.push(msg.uuid);
        }
      }
    }

    // Check which UUIDs already exist (batched, database-side filtering)
    const existingUuids = await supabase.getExistingClaudeUuids(userId, incomingUuids);
    console.log(`Checked ${incomingUuids.length} incoming UUIDs, found ${existingUuids.size} existing`);

    let totalArtifactsKept = 0;
    let totalArtifactsDeduplicated = 0;

    // Collect all messages for batch insert (much faster than individual inserts)
    const messagesToInsert: Array<{
      user_id: string;
      role: "user" | "assistant";
      content: string;
      message_type: "text";
      tags: string[];
      entities_people: string[];
      entities_projects: string[];
      suggested_new_tag: null;
      attachment_id: null;
      folder_id: null;
      embedding: null;
      metadata: Record<string, unknown>;
      created_at: string;
    }> = [];

    for (const conv of conversations) {
      // Two-pass parsing with artifact deduplication
      const parsedMessages = parseConversationWithDeduplication(conv.chat_messages || []);

      // Count deduplication stats for this conversation
      const rawArtifactCount = (conv.chat_messages || []).reduce((sum, m) => {
        const rawT = m.text || m.content;
        const text = typeof rawT === 'string' ? rawT : '';
        const xmlMatches = text.match(/<antArtifact[^>]*>/g) || [];
        const attMatches = (m.attachments || []).filter(a => a.extracted_content);
        return sum + xmlMatches.length + attMatches.length;
      }, 0);
      const keptArtifactCount = parsedMessages.reduce((sum, p) => sum + p.artifactCount, 0);
      totalArtifactsKept += keptArtifactCount;
      totalArtifactsDeduplicated += rawArtifactCount - keptArtifactCount;

      for (const { msg, textStripped, textWithArtifacts } of parsedMessages) {
        // Skip if already imported
        if (existingUuids.has(msg.uuid)) {
          stats.skipped_duplicates++;
          continue;
        }

        // Skip empty messages
        if (!textStripped) continue;

        // Collect message for batch insert
        messagesToInsert.push({
          user_id: userId,
          role: msg.sender === "human" ? "user" : "assistant",
          content: textWithArtifacts, // Includes only latest artifact versions
          message_type: "text",
          tags: [], // Will be populated by Llama tagging
          entities_people: [],
          entities_projects: [],
          suggested_new_tag: null,
          attachment_id: null,
          folder_id: null,
          embedding: null, // Will be generated after NLP
          metadata: {
            source: "claude_export",
            claude_uuid: msg.uuid,
            conversation_uuid: conv.uuid,
            conversation_name: conv.name,
            original_created_at: msg.created_at,
            text_stripped: textStripped, // Store stripped version for reference
          },
          // Override created_at to preserve original timestamp
          created_at: msg.created_at,
        });
      }
    }

    // Batch insert all messages at once (500 per batch)
    console.log(`Batch inserting ${messagesToInsert.length} messages...`);
    stats.messages = await supabase.insertMessagesBatch(messagesToInsert);

    stats.artifacts_kept = totalArtifactsKept;
    stats.artifacts_deduplicated = totalArtifactsDeduplicated;

    console.log(`Imported ${stats.messages} messages from ${stats.conversations} conversations`);
    console.log(`Artifacts: kept ${totalArtifactsKept}, deduplicated ${totalArtifactsDeduplicated}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. PARSE PROJECTS
  // ═══════════════════════════════════════════════════════════════════════════
  const projectsFile = Object.keys(zip.files).find(
    (f) => f.includes("projects") && f.endsWith(".json") && !f.includes("memories")
  );

  if (projectsFile) {
    console.log(`Parsing projects from ${projectsFile}...`);
    const content = await zip.files[projectsFile].async("string");
    const projects: ClaudeProject[] = JSON.parse(content);

    stats.projects = projects.length;

    for (const proj of projects) {
      // Import prompt_template as document
      if (proj.prompt_template) {
        const path = `claude/projects/${proj.uuid}/prompt`;
        try {
          await supabase.upsertDocument({
            user_id: userId,
            path,
            title: `${proj.name} - System Prompt`,
            content: proj.prompt_template,
            summary: proj.prompt_template.substring(0, 200),
            is_internal: false,
            tags: ["claude_export", "project_prompt"],
            embedding: null, // Will be generated
            metadata: {
              source: "claude_export",
              source_type: "project_prompt",
              project_uuid: proj.uuid,
              project_name: proj.name,
            },
          });
        } catch (e) {
          console.error(`Failed to insert project prompt ${proj.uuid}:`, e);
        }
      }

      // Import project docs
      for (const doc of proj.docs || []) {
        const safeName = doc.filename
          .toLowerCase()
          .replace(/\s+/g, "_")
          .replace(/[^a-z0-9_.-]/g, "");
        const path = `claude/projects/${proj.uuid}/docs/${safeName}`;

        try {
          await supabase.upsertDocument({
            user_id: userId,
            path,
            title: `${proj.name} - ${doc.filename}`,
            content: doc.content,
            summary: doc.content.substring(0, 200),
            is_internal: false,
            tags: ["claude_export", "project_doc"],
            embedding: null,
            metadata: {
              source: "claude_export",
              source_type: "project_doc",
              project_uuid: proj.uuid,
              project_name: proj.name,
              doc_uuid: doc.uuid,
              filename: doc.filename,
            },
          });
          stats.project_docs++;
        } catch (e) {
          console.error(`Failed to insert project doc ${doc.uuid}:`, e);
        }
      }
    }

    console.log(`Imported ${stats.projects} projects, ${stats.project_docs} docs`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. PARSE MEMORIES
  // ═══════════════════════════════════════════════════════════════════════════
  const memoriesFile = Object.keys(zip.files).find(
    (f) => f.includes("memories") && f.endsWith(".json")
  );

  if (memoriesFile) {
    console.log(`Parsing memories from ${memoriesFile}...`);
    const content = await zip.files[memoriesFile].async("string");
    const memories: ClaudeMemory[] = JSON.parse(content);

    for (const mem of memories) {
      // Import global memory
      if (mem.conversations_memory) {
        try {
          await supabase.upsertDocument({
            user_id: userId,
            path: `claude/memories/global`,
            title: "Claude Global Memory",
            content: mem.conversations_memory,
            summary: mem.conversations_memory.substring(0, 200),
            is_internal: false,
            tags: ["claude_export", "global_memory"],
            embedding: null,
            metadata: {
              source: "claude_export",
              source_type: "global_memory",
            },
          });
          stats.memories++;
        } catch (e) {
          console.error("Failed to insert global memory:", e);
        }
      }

      // Import project memories
      for (const [projUuid, memoryText] of Object.entries(mem.project_memories || {})) {
        try {
          await supabase.upsertDocument({
            user_id: userId,
            path: `claude/memories/project_${projUuid}`,
            title: `Claude Project Memory - ${projUuid}`,
            content: memoryText,
            summary: memoryText.substring(0, 200),
            is_internal: false,
            tags: ["claude_export", "project_memory"],
            embedding: null,
            metadata: {
              source: "claude_export",
              source_type: "project_memory",
              project_uuid: projUuid,
            },
          });
          stats.memories++;
        } catch (e) {
          console.error(`Failed to insert project memory ${projUuid}:`, e);
        }
      }
    }

    console.log(`Imported ${stats.memories} memories`);
  }

  console.log("Claude export import complete:", stats);

  return {
    success: true,
    type: "claude_export",
    stats,
  };
}


/**
 * Handle pre-parsed Claude export data (JSON, not ZIP)
 * Client parses the ZIP, this receives the extracted conversations
 */
export async function handleImportClaude(
  request: Request,
  env: Env
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin(request),
    "Content-Type": "application/json",
  };

  const supabase = new SupabaseService(env);

  // Verify session token from header
  const sessionToken = request.headers.get("X-Session-Token");
  if (!sessionToken) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  // Verify session
  const session = await supabase.getSession(sessionToken);
  if (!session || new Date(session.expires_at) < new Date()) {
    return new Response(JSON.stringify({ error: "Session expired" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const userId = session.user_id;

  try {
    const body = await request.json() as {
      conversations?: ClaudeConversation[];
      projects?: ClaudeProject[];
      memories?: ClaudeMemory[];
    };

    const stats: ClaudeExportStats = {
      conversations: 0,
      messages: 0,
      projects: 0,
      project_docs: 0,
      memories: 0,
      skipped_duplicates: 0,
      artifacts_kept: 0,
      artifacts_deduplicated: 0,
    };

    // Collect all message UUIDs from incoming data
    const incomingUuids: string[] = [];
    if (body.conversations) {
      for (const conv of body.conversations) {
        for (const msg of conv.chat_messages || []) {
          if (msg.uuid) {
            incomingUuids.push(msg.uuid);
          }
        }
      }
    }

    // Check which UUIDs already exist (batched, database-side filtering)
    const existingUuids = await supabase.getExistingClaudeUuids(userId, incomingUuids);
    console.log(`Checked ${incomingUuids.length} incoming UUIDs, found ${existingUuids.size} existing`);

    // Process conversations
    if (body.conversations) {
      stats.conversations = body.conversations.length;
      let totalArtifactsKept = 0;
      let totalArtifactsDeduplicated = 0;

      const messagesToInsert: Array<{
        user_id: string;
        role: "user" | "assistant";
        content: string;
        message_type: "text";
        tags: string[];
        entities_people: string[];
        entities_projects: string[];
        suggested_new_tag: null;
        attachment_id: null;
        folder_id: null;
        embedding: null;
        metadata: Record<string, unknown>;
        created_at: string;
      }> = [];

      for (const conv of body.conversations) {
        const parsedMessages = parseConversationWithDeduplication(conv.chat_messages || []);

        // Count deduplication stats
        const rawArtifactCount = (conv.chat_messages || []).reduce((sum, m) => {
          const rawT = m.text || m.content;
          const text = typeof rawT === 'string' ? rawT : '';
          const xmlMatches = text.match(/<antArtifact[^>]*>/g) || [];
          const attMatches = (m.attachments || []).filter(a => a.extracted_content);
          return sum + xmlMatches.length + attMatches.length;
        }, 0);
        const keptArtifactCount = parsedMessages.reduce((sum, p) => sum + p.artifactCount, 0);
        totalArtifactsKept += keptArtifactCount;
        totalArtifactsDeduplicated += rawArtifactCount - keptArtifactCount;

        for (const { msg, textStripped, textWithArtifacts } of parsedMessages) {
          if (existingUuids.has(msg.uuid)) {
            stats.skipped_duplicates++;
            continue;
          }

          if (!textStripped) continue;

          messagesToInsert.push({
            user_id: userId,
            role: msg.sender === "human" ? "user" : "assistant",
            content: textWithArtifacts,
            message_type: "text",
            tags: [],
            entities_people: [],
            entities_projects: [],
            suggested_new_tag: null,
            attachment_id: null,
            folder_id: null,
            embedding: null,
            metadata: {
              source: "claude_export",
              claude_uuid: msg.uuid,
              conversation_uuid: conv.uuid,
              conversation_name: conv.name,
              original_created_at: msg.created_at,
              text_stripped: textStripped,
            },
            created_at: msg.created_at,
          });
        }
      }

      console.log(`Batch inserting ${messagesToInsert.length} messages...`);
      stats.messages = await supabase.insertMessagesBatch(messagesToInsert);
      stats.artifacts_kept = totalArtifactsKept;
      stats.artifacts_deduplicated = totalArtifactsDeduplicated;

      console.log(`Imported ${stats.messages} messages from ${stats.conversations} conversations`);
    }

    // Projects and memories can be handled similarly if needed
    // For now, just return the stats

    return new Response(JSON.stringify({
      success: true,
      type: "claude_export",
      stats,
    }), {
      headers: corsHeaders,
    });
  } catch (e) {
    console.error("Import error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: corsHeaders }
    );
  }
}

/**
 * Handle URL upload - fetch web page and extract content
 * Creates a document from the page content
 */
export async function handleUploadUrl(
  request: Request,
  env: Env
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin(request),
    "Content-Type": "application/json",
  };

  const supabase = new SupabaseService(env);
  const workersAI = new WorkersAIService(env);

  // Verify session token from header
  const sessionToken = request.headers.get("X-Session-Token");
  if (!sessionToken) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  // Verify session
  const session = await supabase.getSession(sessionToken);
  if (!session || new Date(session.expires_at) < new Date()) {
    return new Response(JSON.stringify({ error: "Session expired" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const userId = session.user_id;

  // Get optional folder ID from header
  const folderId = request.headers.get("X-Folder-Id") || undefined;

  try {
    const body = await request.json() as { url: string };
    const { url } = body;

    if (!url) {
      return new Response(JSON.stringify({ error: "URL is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    console.log(`Processing URL: ${url}${folderId ? ` to folder ${folderId}` : ''}`);

    // Fetch the page content with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

    let html = "";
    let title = new URL(url).hostname;
    let content = "";
    let og: OpenGraphMeta = {};
    let isBookmarkOnly = false;

    try {
      const pageResponse = await fetch(url, {
        headers: {
          // Use a more browser-like User-Agent to avoid blocking
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!pageResponse.ok) {
        console.warn(`URL fetch failed: ${pageResponse.status} - falling back to bookmark mode`);
        isBookmarkOnly = true;
        title = new URL(url).hostname + " - " + new URL(url).pathname.slice(0, 50);
        content = `Bookmark: ${url}\n\nCould not fetch page content (HTTP ${pageResponse.status})`;
      } else {
        const contentType = pageResponse.headers.get("Content-Type") || "";
        if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
          console.warn(`Non-HTML content type: ${contentType} - falling back to bookmark mode`);
          isBookmarkOnly = true;
          title = new URL(url).hostname;
          content = `Bookmark: ${url}\n\nContent type: ${contentType}`;
        } else {
          html = await pageResponse.text();
          const extracted = extractReadableContent(html, url);
          title = extracted.title;
          content = extracted.content;
          og = extracted.og;

          // If content extraction failed, fall back to bookmark mode
          if (!content || content.trim().length < 50) {
            console.warn(`Content extraction yielded only ${content?.length || 0} chars - falling back to bookmark mode`);
            isBookmarkOnly = true;
            title = extracted.title || new URL(url).hostname;
            content = `Bookmark: ${url}\n\n${og.ogDescription || "No content could be extracted from this page."}`;
          }
        }
      }
    } catch (fetchError) {
      clearTimeout(timeoutId);
      const errMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
      if (errMsg.includes("aborted")) {
        console.warn(`URL fetch timed out - falling back to bookmark mode`);
      } else {
        console.warn(`URL fetch error: ${errMsg} - falling back to bookmark mode`);
      }
      isBookmarkOnly = true;
      title = new URL(url).hostname;
      content = `Bookmark: ${url}\n\nCould not fetch page: ${errMsg}`;
    }

    console.log(`${isBookmarkOnly ? 'Bookmark' : 'Extracted'} "${title}" (${content.length} chars), og:image=${og.ogImage ? 'yes' : 'no'}`);

    // Generate path from URL
    const urlObj = new URL(url);
    const safePath = `${urlObj.hostname}${urlObj.pathname}`
      .toLowerCase()
      .replace(/\//g, "_")
      .replace(/[^a-z0-9_.-]/g, "")
      .slice(0, 100);
    const path = `uploads/links/${safePath}`;

    // Use OG description as summary if available, otherwise extract from content
    const summary = og.ogDescription || content.substring(0, 200).replace(/\n/g, " ");

    // Tag the content (use URL hostname for bookmarks with minimal content)
    const textToTag = isBookmarkOnly ? `${title} ${urlObj.hostname}` : content.substring(0, 2000);
    const taggingResult = await workersAI.tagMessage(textToTag);

    // Generate embedding
    const textToEmbed = isBookmarkOnly ? `${title} ${summary} ${url}` : content.substring(0, 8000);
    const embedding = await workersAI.generateEmbedding(textToEmbed);

    // Create/update document with OG metadata
    const document = await supabase.upsertDocument({
      user_id: userId,
      path,
      title,
      content,
      summary,
      is_internal: false,
      tags: taggingResult.tags,
      embedding,
      folder_id: folderId || null,
      metadata: {
        source: "portal_upload",
        source_type: isBookmarkOnly ? "bookmark" : "url",
        original_url: url,
        fetched_at: new Date().toISOString(),
        is_bookmark_only: isBookmarkOnly,
        // Open Graph metadata for previews
        og_title: og.ogTitle,
        og_description: og.ogDescription,
        og_image: og.ogImage,
        og_site_name: og.ogSiteName,
        og_type: og.ogType,
      },
    });

    return new Response(JSON.stringify({
      success: true,
      type: "document",
      id: document.id,
      title,
      url,
      isBookmark: isBookmarkOnly,
      // Include preview data in response
      preview: {
        description: og.ogDescription || summary,
        image: og.ogImage,
        siteName: og.ogSiteName,
      },
    }), {
      headers: corsHeaders,
    });
  } catch (e) {
    console.error("URL upload error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: corsHeaders }
    );
  }
}

/**
 * Open Graph metadata extracted from a page
 */
interface OpenGraphMeta {
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  ogSiteName?: string;
  ogType?: string;
}

/**
 * Extract Open Graph metadata from HTML
 */
function extractOpenGraph(html: string): OpenGraphMeta {
  const meta: OpenGraphMeta = {};

  // Extract og:title
  const titleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  if (titleMatch) meta.ogTitle = decodeHtmlEntities(titleMatch[1]);

  // Extract og:description
  const descMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["']/i);
  if (descMatch) meta.ogDescription = decodeHtmlEntities(descMatch[1]);

  // Extract og:image
  const imageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  if (imageMatch) meta.ogImage = imageMatch[1];

  // Extract og:site_name
  const siteMatch = html.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i);
  if (siteMatch) meta.ogSiteName = decodeHtmlEntities(siteMatch[1]);

  // Extract og:type
  const typeMatch = html.match(/<meta[^>]*property=["']og:type["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:type["']/i);
  if (typeMatch) meta.ogType = typeMatch[1];

  return meta;
}

/**
 * Extract readable text content from HTML
 * Simple implementation using regex - removes scripts, styles, and HTML tags
 */
function extractReadableContent(html: string, url: string): { title: string; content: string; og: OpenGraphMeta } {
  // Extract Open Graph metadata first
  const og = extractOpenGraph(html);

  // Extract title - prefer OG title, then <title> tag, then hostname
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  let title = og.ogTitle || (titleMatch ? titleMatch[1].trim() : new URL(url).hostname);

  // Decode HTML entities in title
  title = decodeHtmlEntities(title);

  // Remove script and style elements
  let content = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // Try to extract main content area (article, main, or body with ID/class hints)
  const mainContentPatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/gi,
    /<main[^>]*>([\s\S]*?)<\/main>/gi,
    /<div[^>]*(?:class|id)="[^"]*(?:content|article|post|entry|main)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
  ];

  let extractedContent = "";
  for (const pattern of mainContentPatterns) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      extractedContent += match[1] + "\n";
    }
    if (extractedContent.length > 500) break;
  }

  // If no main content found, use body
  if (extractedContent.length < 500) {
    const bodyMatch = content.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    extractedContent = bodyMatch ? bodyMatch[1] : content;
  }

  // Remove remaining HTML tags
  extractedContent = extractedContent
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Decode HTML entities
  extractedContent = decodeHtmlEntities(extractedContent);

  // Clean up whitespace
  extractedContent = extractedContent
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");

  // Limit content length
  if (extractedContent.length > 50000) {
    extractedContent = extractedContent.slice(0, 50000) + "...";
  }

  return { title, content: extractedContent, og };
}

/**
 * Decode common HTML entities
 */
function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&ndash;": "\u2013",
    "&mdash;": "\u2014",
    "&lsquo;": "\u2018",
    "&rsquo;": "\u2019",
    "&ldquo;": "\u201C",
    "&rdquo;": "\u201D",
    "&hellip;": "\u2026",
    "&copy;": "\u00A9",
    "&reg;": "\u00AE",
    "&trade;": "\u2122",
  };

  let decoded = text;
  for (const [entity, char] of Object.entries(entities)) {
    decoded = decoded.replace(new RegExp(entity, "g"), char);
  }

  // Decode numeric entities
  decoded = decoded.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
  decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  return decoded;
}

// =============================================
// CLAUDE EXPORT ANALYSIS (Pre-import preview)
// =============================================

interface ClaudeAnalysisResult {
  total: number;
  new: number;
  existing: number;
  conversations: number;
  projects: number;
  project_docs: number;
}

/**
 * Analyze a Claude export without importing - shows what would be imported vs skipped
 */
export async function handleAnalyzeClaude(
  request: Request,
  env: Env
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin(request),
    "Content-Type": "application/json",
  };

  const supabase = new SupabaseService(env);

  // Verify session token from header
  const sessionToken = request.headers.get("X-Session-Token");
  if (!sessionToken) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  // Verify session
  const session = await supabase.getSession(sessionToken);
  if (!session || new Date(session.expires_at) < new Date()) {
    return new Response(JSON.stringify({ error: "Session expired" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const userId = session.user_id;

  try {
    const body = await request.json() as {
      // Lightweight format: pre-extracted UUIDs from the client
      uuids?: string[];
      // Legacy format: full conversations (backwards compatible)
      conversations?: ClaudeConversation[];
      projects?: ClaudeProject[];
    };

    // Collect UUIDs - prefer pre-extracted UUIDs, fall back to parsing conversations
    let incomingUuids: string[];
    if (body.uuids && Array.isArray(body.uuids)) {
      incomingUuids = body.uuids;
    } else {
      incomingUuids = [];
      if (body.conversations) {
        for (const conv of body.conversations) {
          for (const msg of conv.chat_messages || []) {
            if (msg.uuid) {
              incomingUuids.push(msg.uuid);
            }
          }
        }
      }
    }

    // Check which UUIDs already exist using IN query (much faster than pagination)
    const existingUuids = await supabase.getExistingClaudeUuids(userId, incomingUuids);
    console.log(`Checked ${incomingUuids.length} UUIDs, found ${existingUuids.size} existing`);

    const total = incomingUuids.length;
    const existing = existingUuids.size;

    // Count project docs (only in legacy format)
    let projectDocs = 0;
    if (body.projects) {
      for (const project of body.projects) {
        projectDocs += (project.docs || []).length;
      }
    }

    const result: ClaudeAnalysisResult = {
      total,
      new: total - existing,
      existing,
      conversations: body.conversations?.length || 0,
      projects: body.projects?.length || 0,
      project_docs: projectDocs,
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (e) {
    console.error("Claude analysis failed:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Analysis failed" }),
      { status: 500, headers: corsHeaders }
    );
  }
}
