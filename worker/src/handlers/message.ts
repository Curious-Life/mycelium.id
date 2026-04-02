import type { Env } from "../types/env";
import type { BotContext } from "../services/telegram";
import { TelegramService } from "../services/telegram";
import { SupabaseService } from "../services/supabase";
import { WorkersAIService } from "../services/workersai";
import { ClaudeService, type ConversationContext, type ToolCall, type ClaudeUsage } from "../services/claude";
import { DocumentManager } from "../documents/manager";
import { ToolExecutor } from "../tools/executor";
import { R2Service } from "../services/r2";
import { StreamService } from "../services/stream";
import type { AgentId, MemoryScope } from "../config/mya-agents";

// Telegram splits messages at ~4096 chars
const TELEGRAM_SPLIT_THRESHOLD = 4000;

// Pricing per million tokens (Sonnet 4.5)
const PRICING = {
  input: 3,   // $3 / MTok
  output: 15  // $15 / MTok
};

/**
 * Extract rich context from tool calls for analytics
 * Returns structured metadata about what was searched, read, edited, created
 */
function extractToolContext(toolCalls: ToolCall[]): {
  tool_calls: string[];
  searches?: { tool: string; query: string }[];
  documents_read?: string[];
  documents_edited?: string[];
  documents_created?: string[];
  territories_searched?: string[];
  realms_searched?: string[];
} {
  const context: ReturnType<typeof extractToolContext> = {
    tool_calls: toolCalls.map(t => t.name),
  };

  const searches: { tool: string; query: string }[] = [];
  const documentsRead: string[] = [];
  const documentsEdited: string[] = [];
  const documentsCreated: string[] = [];
  const territoriesSearched: string[] = [];
  const realmsSearched: string[] = [];

  for (const tool of toolCalls) {
    const input = tool.input as Record<string, unknown>;

    switch (tool.name) {
      case "searchHistory":
        if (input.query) searches.push({ tool: "history", query: String(input.query) });
        break;
      case "searchTerritories":
        if (input.query) {
          searches.push({ tool: "territories", query: String(input.query) });
          territoriesSearched.push(String(input.query));
        }
        break;
      case "searchRealms":
        if (input.query) {
          searches.push({ tool: "realms", query: String(input.query) });
          realmsSearched.push(String(input.query));
        }
        break;
      case "searchThemes":
        if (input.query) searches.push({ tool: "themes", query: String(input.query) });
        break;
      case "getDocument":
        if (input.path) documentsRead.push(String(input.path));
        break;
      case "updateDocument":
        if (input.path) documentsEdited.push(String(input.path));
        break;
      case "createDocument":
        if (input.path) documentsCreated.push(String(input.path));
        break;
      case "getTerritoryDetail":
        if (input.territory_id) territoriesSearched.push(String(input.territory_id));
        break;
      case "getRealmDetail":
        if (input.realm_id) realmsSearched.push(String(input.realm_id));
        break;
    }
  }

  // Only include non-empty arrays
  if (searches.length > 0) context.searches = searches;
  if (documentsRead.length > 0) context.documents_read = documentsRead;
  if (documentsEdited.length > 0) context.documents_edited = documentsEdited;
  if (documentsCreated.length > 0) context.documents_created = documentsCreated;
  if (territoriesSearched.length > 0) context.territories_searched = territoriesSearched;
  if (realmsSearched.length > 0) context.realms_searched = realmsSearched;

  return context;
}

export async function handleMessage(
  ctx: BotContext,
  env: Env
): Promise<void> {
  const telegram = new TelegramService(env);
  const supabase = new SupabaseService(env);
  const workersAI = new WorkersAIService(env);
  const claude = new ClaudeService(env);
  const docManager = new DocumentManager(env);
  const r2 = new R2Service(env);

  // Get user info
  const userInfo = telegram.getUserInfo(ctx);
  if (!userInfo) {
    console.error("No user info available");
    return;
  }

  // ============ RESPONSE TRACKING ============
  // Track if we've sent a response to ensure user always gets something
  let responseSent = false;
  const markResponseSent = () => { responseSent = true; };

  // ============ TYPING INDICATOR KEEPALIVE ============
  // Telegram typing indicator expires after ~5 seconds
  // Keep it alive during long operations
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  const startTypingKeepalive = () => {
    if (typingInterval) return;
    typingInterval = setInterval(async () => {
      try {
        await telegram.sendTyping(ctx);
      } catch {
        // Ignore typing errors
      }
    }, 4000);
  };
  const stopTypingKeepalive = () => {
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = null;
    }
  };

  // ============ SAFETY NET ============
  // Ensure user gets a response even if everything fails
  const ensureResponse = async (errorContext?: string) => {
    if (responseSent) return;
    try {
      const message = errorContext
        ? `Sorry, I encountered an issue while processing your message. (${errorContext.substring(0, 100)})`
        : "Sorry, something went wrong. Please try again.";
      await telegram.reply(ctx, message);
      markResponseSent();
    } catch (e) {
      console.error("Safety net reply failed:", e);
    }
  };

  try {
    // Start typing keepalive for the entire message processing
    startTypingKeepalive();

  // Get chat ID for buffering
  const chatId = ctx.chat?.id;
  if (!chatId) {
    console.error("No chat ID available");
    return;
  }

  // Send typing indicator
  await telegram.sendTyping(ctx);

  // Check if user is registered
  const user = await supabase.getUserByTelegramId(userInfo.id);
  if (!user) {
    await telegram.reply(
      ctx,
      `Welcome to Mya! To start using the service, you need to register first.\n\nSend /start to begin.`
    );
    markResponseSent();
    return;
  }
  console.log(`[User] Telegram user ${userInfo.id} -> DB user ${user.id} (${user.username || 'no username'})`);

  // ============ BUDGET CHECK ============
  // Check if user has remaining budget before processing
  const budgetCheck = await supabase.checkBudget(user.id);
  if (budgetCheck && !budgetCheck.allowed) {
    const limitDollars = (budgetCheck.budget_limit_cents / 100).toFixed(2);
    await telegram.reply(
      ctx,
      `Monthly budget exceeded ($${limitDollars} limit reached). Budget resets ${budgetCheck.period_end}. Contact support if you need an increase.`
    );
    markResponseSent();
    return;
  }

  // Initialize documents for new users
  const existingDocs = await supabase.getAllDocumentSummaries(user.id);
  if (existingDocs.length === 0) {
    await docManager.initializeDocuments(user.id);
  }

  // Extract message content
  let messageContent = telegram.getMessageContent(ctx);

  // ============ LONG MESSAGE BATCHING (KV-based) ============
  // Handle Telegram's automatic message splitting for long content
  // Telegram splits messages at ~4096 chars
  // Uses KV for fast buffering with time-based chunk detection
  const BUFFER_TIMEOUT_MS = 3000; // Wait 3 seconds for more chunks
  const bufferKey = `msg_buffer:${user.id}:${chatId}`;

  if (messageContent && env.KV) {
    const isLongChunk = messageContent.length >= TELEGRAM_SPLIT_THRESHOLD;
    const now = Date.now();

    // Get existing buffer from KV
    type BufferData = { chunks: string[]; lastUpdate: number };
    let bufferData: BufferData | null = null;
    try {
      bufferData = await env.KV.get<BufferData>(bufferKey, "json");
    } catch (e) {
      console.error("[Buffer] Failed to read KV:", e);
    }

    const hasBuffer = bufferData !== null && bufferData.chunks.length > 0;
    const timeSinceLastChunk = bufferData ? now - bufferData.lastUpdate : Infinity;
    const isRecentBuffer = timeSinceLastChunk < BUFFER_TIMEOUT_MS;

    if (isLongChunk && (!hasBuffer || isRecentBuffer)) {
      // This looks like a split message chunk - buffer it
      const newChunks = bufferData ? [...bufferData.chunks, messageContent] : [messageContent];
      try {
        await env.KV.put(
          bufferKey,
          JSON.stringify({ chunks: newChunks, lastUpdate: now }),
          { expirationTtl: 60 } // Auto-expire after 60 seconds
        );
        console.log(`[Buffer] Stored chunk ${newChunks.length} (${messageContent.length} chars)`);
        return; // Wait for more chunks
      } catch (e) {
        console.error("[Buffer] Failed to write KV, processing immediately:", e);
        // Fall through to process immediately if KV fails
      }
    }

    if (hasBuffer && bufferData) {
      // We have buffered chunks - combine them with current message and process
      // This triggers when:
      // 1. Current message is short (final chunk of split)
      // 2. OR current message is long but buffer is stale (timeout - process what we have)
      const allChunks = [...bufferData.chunks];
      if (messageContent) {
        allChunks.push(messageContent);
      }
      const chunkCount = allChunks.length;

      // Combine all chunks
      messageContent = allChunks.join("");
      console.log(`[Buffer] Combined ${chunkCount} chunks into ${messageContent.length} chars`);

      // Clear the buffer
      try {
        await env.KV.delete(bufferKey);
      } catch (e) {
        console.error("[Buffer] Failed to clear KV:", e);
      }

      await telegram.reply(ctx, `📥 Received ${chunkCount} parts (${messageContent.length} chars). Processing...`);
    }
    // else: normal message (no buffer), process as usual
  }

  // ============ FOLDER ROUTING VIA HASHTAG ============
  // Parse hashtag to route message to a specific folder (e.g., #inbox, #my-project)
  let targetFolderId: string | undefined;
  if (messageContent) {
    const hashtagMatch = messageContent.match(/#([a-zA-Z0-9_-]+)/);
    if (hashtagMatch) {
      const folderName = hashtagMatch[1].replace(/-/g, " "); // Convert dashes to spaces
      console.log(`[Folder Routing] Found hashtag: #${hashtagMatch[1]} -> looking for folder: "${folderName}"`);
      const folder = await supabase.getFolderByName(user.id, folderName);
      if (folder) {
        targetFolderId = folder.id;
        console.log(`[Folder Routing] ✓ Found folder: ${folder.name} (${folder.id})`);
      } else {
        console.log(`[Folder Routing] ✗ No folder found for "${folderName}" (user: ${user.id})`);
      }
    }
  }

  let messageType: "text" | "voice" | "image" | "video" = "text";
  let attachmentId: string | undefined;
  let imageDataForClaude: ArrayBuffer | undefined; // Store image to send to Claude
  let thumbnailDataForClaude: ArrayBuffer | undefined; // Store video thumbnail for Claude

  // Handle voice message
  if (telegram.hasVoice(ctx)) {
    const voiceFileId = telegram.getVoiceFileId(ctx);
    if (voiceFileId) {
      try {
        console.log("[Voice] Starting voice processing...");
        const audioData = await telegram.downloadFile(voiceFileId);
        const audioSizeKB = Math.round(audioData.byteLength / 1024);
        console.log(`[Voice] Downloaded ${audioSizeKB}KB audio file`);

        // Send brief transcribing indicator
        console.log("[Voice] Sending transcribing indicator");
        let transcribingMsg: { message_id: number } | undefined;
        try {
          transcribingMsg = await telegram.sendMessageToCtx(ctx, "Transcribing...");
        } catch {
          // Ignore if indicator fails
        }

        // Store in R2 (async, don't wait)
        const r2Key = await r2.storeVoice(user.id, audioData);
        console.log(`[Voice] Stored in R2: ${r2Key}`);

        // Transcribe
        console.log("[Voice] Starting transcription...");
        const transcriptionStart = Date.now();
        messageContent = await workersAI.transcribeAudio(audioData);
        console.log(`[Voice] Transcription complete in ${Date.now() - transcriptionStart}ms: "${messageContent.substring(0, 100)}..."`);
        messageType = "voice";

        // Delete the transcribing indicator
        if (transcribingMsg) {
          try {
            await telegram.deleteMessage(ctx, transcribingMsg.message_id);
          } catch {
            // Ignore deletion errors
          }
        }

        // Tag the transcript for attachment (non-blocking)
        let voiceTags: string[] = [];
        try {
          const voiceTagging = await workersAI.tagMessage(messageContent);
          voiceTags = voiceTagging.tags;
        } catch (e) {
          console.error("[Voice] Tagging failed (non-fatal):", e);
        }

        // Store attachment record with tags
        const { data } = await supabase.insertAttachment({
          user_id: user.id,
          attachment_type: "voice",
          r2_key: r2Key,
          transcript: messageContent,
          tags: voiceTags,
          file_size: audioData.byteLength,
        });
        attachmentId = data?.id;
        console.log(`[Voice] Attachment stored: ${attachmentId}`);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.error("[Voice] Failed to process voice:", error, e);
        await telegram.reply(ctx, `Sorry, I couldn't process that voice message. (${error})`);
        markResponseSent();
        return;
      }
    }
  }

  // Handle photo
  if (telegram.hasPhoto(ctx)) {
    const photoFileId = telegram.getPhotoFileId(ctx);
    if (photoFileId) {
      try {
        const imageData = await telegram.downloadFile(photoFileId);

        // Store image data for Claude (multimodal)
        imageDataForClaude = imageData;

        // Store in R2
        const r2Key = await r2.storeImage(user.id, imageData, "image/jpeg");

        // Describe image with Workers AI (for tagging and storage)
        const imageDescription = await workersAI.describeImage(imageData, "image/jpeg");
        messageType = "image";

        // Tag the image description for attachment
        const imageTagging = await workersAI.tagMessage(imageDescription);

        // Combine caption with image description (Claude will also see the actual image)
        messageContent = messageContent
          ? `${messageContent}\n\n[AI Vision: ${imageDescription}]`
          : `[AI Vision: ${imageDescription}]`;

        // Store attachment record with tags
        const { data } = await supabase.insertAttachment({
          user_id: user.id,
          attachment_type: "image",
          r2_key: r2Key,
          description: imageDescription,
          tags: imageTagging.tags,
          file_size: imageData.byteLength,
          mime_type: "image/jpeg",
        });
        attachmentId = data?.id;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.error("Failed to process image:", error, e);
        // Don't fail completely - just note we couldn't process the image
        messageContent = messageContent
          ? `${messageContent}\n\n[Image attached but could not be processed: ${error}]`
          : `[Image attached but could not be processed: ${error}]`;
        messageType = "image";
      }
    }
  }

  // Handle video (or video note)
  if (telegram.hasVideo(ctx) || telegram.hasVideoNote(ctx)) {
    const isVideoNote = telegram.hasVideoNote(ctx);
    const videoFileId = isVideoNote
      ? telegram.getVideoNoteFileId(ctx)
      : telegram.getVideoFileId(ctx);
    const thumbnailFileId = isVideoNote
      ? telegram.getVideoNoteThumbnailFileId(ctx)
      : telegram.getVideoThumbnailFileId(ctx);
    const duration = telegram.getVideoDuration(ctx);
    const mimeType = telegram.getVideoMimeType(ctx);

    if (videoFileId) {
      try {
        // Download video
        const videoData = await telegram.downloadFile(videoFileId);

        // Store video - prefer Cloudflare Stream for iOS compatibility, fall back to R2
        let r2Key: string | undefined;
        let streamUid: string | undefined;

        if (StreamService.isConfigured(env)) {
          try {
            const stream = new StreamService(env);
            const filename = `video_${user.id}_${Date.now()}.mp4`;
            const videoInfo = await stream.uploadVideo(videoData, filename, mimeType);
            streamUid = videoInfo.uid;
            console.log(`Video uploaded to Stream: ${streamUid}`);
          } catch (streamErr) {
            console.error("Stream upload failed, falling back to R2:", streamErr);
            r2Key = await r2.storeVideo(user.id, videoData, mimeType, duration);
          }
        } else {
          r2Key = await r2.storeVideo(user.id, videoData, mimeType, duration);
        }

        // Try to get and describe thumbnail
        let thumbnailDescription = "";
        if (thumbnailFileId) {
          try {
            const thumbnailData = await telegram.downloadFile(thumbnailFileId);
            thumbnailDataForClaude = thumbnailData;
            thumbnailDescription = await workersAI.describeImage(thumbnailData, "image/jpeg");
          } catch (thumbErr) {
            console.error("Failed to process thumbnail:", thumbErr);
            thumbnailDescription = "Video thumbnail unavailable";
          }
        }

        messageType = "video";
        const durationStr = duration ? `${duration}s` : "unknown duration";

        // Tag the video description for attachment
        const videoDescription = thumbnailDescription || `Video ${durationStr}`;
        const videoTagging = await workersAI.tagMessage(videoDescription);

        // Combine caption with video info
        messageContent = messageContent
          ? `${messageContent}\n\n[Video: ${durationStr}${thumbnailDescription ? `, Preview: ${thumbnailDescription}` : ""}]`
          : `[Video: ${durationStr}${thumbnailDescription ? `, Preview: ${thumbnailDescription}` : ""}]`;

        // Store attachment record with tags
        const { data } = await supabase.insertAttachment({
          user_id: user.id,
          attachment_type: "video",
          r2_key: r2Key,
          stream_uid: streamUid,
          description: thumbnailDescription || null,
          tags: videoTagging.tags,
          file_size: videoData.byteLength,
          mime_type: mimeType,
          metadata: {
            duration_seconds: duration,
            is_video_note: isVideoNote,
          },
        });
        attachmentId = data?.id;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.error("Failed to process video:", error, e);
        // Don't fail completely - just note we couldn't process the video
        messageContent = messageContent
          ? `${messageContent}\n\n[Video attached but could not be processed: ${error}]`
          : `[Video attached but could not be processed: ${error}]`;
        messageType = "video";
      }
    }
  }

  // Handle document (text file uploads and office documents)
  if (telegram.hasDocument(ctx)) {
    const isTextDoc = telegram.isTextDocument(ctx);
    const isOfficeDoc = telegram.isOfficeDocument(ctx);
    const docMime = telegram.getDocumentMimeType(ctx);
    const docName = telegram.getDocumentFilename(ctx);
    const docSize = telegram.getDocumentFileSize(ctx);
    console.log(`[Document] Received: ${docName} (${docMime}, ${docSize} bytes), isText: ${isTextDoc}, isOffice: ${isOfficeDoc}`);

    if (!isTextDoc && !isOfficeDoc) {
      // Let the user know we can't process this file type
      messageContent = messageContent
        ? `${messageContent}\n\n[Document: ${docName} - file type not supported for processing]`
        : `[Document: ${docName} - file type not supported for processing. Supported: .txt, .md, .json, .csv, .docx, .doc, .odt, .rtf, .pdf]`;
    }
  }
  if (telegram.hasDocument(ctx) && telegram.isTextDocument(ctx)) {
    const docFileId = telegram.getDocumentFileId(ctx);
    const docFilename = telegram.getDocumentFilename(ctx) || "document.txt";
    const docMimeType = telegram.getDocumentMimeType(ctx) || "text/plain";
    const docSize = telegram.getDocumentFileSize(ctx) || 0;

    if (docFileId) {
      // Show processing indicator for larger files (>10KB)
      let processingMessage: { message_id: number } | undefined;
      if (docSize > 10000) {
        console.log(`[Document] Large file (${Math.round(docSize/1024)}KB), sending processing indicator`);
        processingMessage = await telegram.sendMessageToCtx(ctx, `📄 Processing ${docFilename}...`);
      }

      try {
        console.log("[Document] Downloading file...");
        const downloadStart = Date.now();
        const docData = await telegram.downloadFile(docFileId);
        console.log(`[Document] Downloaded ${docData.byteLength} bytes in ${Date.now() - downloadStart}ms`);

        const textContent = new TextDecoder().decode(docData);
        console.log(`[Document] Decoded ${textContent.length} chars`);

        // Use the text file content as the message
        messageContent = messageContent
          ? `${messageContent}\n\n[Document: ${docFilename}]\n${textContent}`
          : `[Document: ${docFilename}]\n${textContent}`;

        // Also create a document record for long-term storage
        const safeName = docFilename
          .replace(/\.(txt|md|markdown|json|csv|log|xml|yaml|yml|toml|ini|cfg|conf)$/i, "")
          .toLowerCase()
          .replace(/\s+/g, "_")
          .replace(/[^a-z0-9_-]/g, "");
        const path = `telegram/${safeName}_${Date.now()}`;

        // Extract title from first line or filename
        const lines = textContent.split("\n").filter((l: string) => l.trim().length > 0);
        const title = lines.length > 0 && lines[0].trim().length < 100
          ? lines[0].trim()
          : docFilename.replace(/\.(txt|md|markdown|json|csv|log|xml|yaml|yml)$/i, "").replace(/[-_]/g, " ");

        // Tag and embed document content (non-fatal if fails)
        let docTags: string[] = [];
        let docEmbedding: number[] = [];
        try {
          console.log("[Document] Generating tags and embedding...");
          const tagEmbedStart = Date.now();
          const [tagResult, embedResult] = await Promise.all([
            workersAI.tagMessage(textContent.substring(0, 2000)),
            workersAI.generateEmbedding(textContent.substring(0, 8000)),
          ]);
          docTags = tagResult.tags;
          docEmbedding = embedResult;
          console.log(`[Document] Tags/embedding done in ${Date.now() - tagEmbedStart}ms`);
        } catch (tagErr) {
          console.error("[Document] Tagging/embedding failed (non-fatal):", tagErr);
        }

        // Create document record
        try {
          await supabase.upsertDocument({
            user_id: user.id,
            path,
            title,
            content: textContent,
            summary: textContent.substring(0, 200).replace(/\n/g, " "),
            is_internal: false,
            tags: docTags,
            embedding: docEmbedding.length > 0 ? docEmbedding : undefined,
            folder_id: targetFolderId || null,
            metadata: {
              source: "telegram",
              source_type: docMimeType.includes("markdown") ? "markdown" : "txt",
              original_filename: docFilename,
              file_size: docData.byteLength,
            },
          });
          console.log(`[Document] Stored: ${docFilename} -> ${path}`);
        } catch (storeErr) {
          console.error("[Document] Storage failed (non-fatal):", storeErr);
        }

      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.error("[Document] Failed to process:", error, e);
        messageContent = messageContent
          ? `${messageContent}\n\n[Document attached but could not be processed: ${error}]`
          : `[Document attached but could not be processed: ${error}]`;
      } finally {
        // Delete processing indicator if sent
        if (processingMessage) {
          try {
            await telegram.deleteMessage(ctx, processingMessage.message_id);
          } catch {
            // Ignore deletion errors
          }
        }
      }
    }
  }

  // Handle office documents (docx, doc, odt, rtf, pdf) - needs Claude processing
  if (telegram.hasDocument(ctx) && telegram.isOfficeDocument(ctx) && !telegram.isTextDocument(ctx)) {
    const docFileId = telegram.getDocumentFileId(ctx);
    const docFilename = telegram.getDocumentFilename(ctx) || "document";
    const docMimeType = telegram.getDocumentMimeType(ctx) || "application/octet-stream";
    const docSize = telegram.getDocumentFileSize(ctx) || 0;

    if (docFileId) {
      // Show processing indicator
      const processingMessage = await telegram.sendMessageToCtx(ctx, `📄 Processing ${docFilename}...`);

      try {
        console.log(`[Document] Processing office document: ${docFilename} (${docMimeType})`);
        const downloadStart = Date.now();
        const docData = await telegram.downloadFile(docFileId);
        console.log(`[Document] Downloaded ${docData.byteLength} bytes in ${Date.now() - downloadStart}ms`);

        // Use Claude to extract text from document
        const base64Data = Buffer.from(docData).toString('base64');
        const extractStart = Date.now();

        const response = await claude.processDocument({
          content: base64Data,
          mimeType: docMimeType,
          filename: docFilename,
          prompt: `Extract ALL text from this document "${docFilename}". Preserve paragraph structure, headings, and formatting. Format tables as markdown. Preserve list formatting.`
        });

        const extractedText = response || '[No text extracted]';
        console.log(`[Document] Extracted ${extractedText.length} chars in ${Date.now() - extractStart}ms`);

        // Truncate if too long
        const truncatedText = extractedText.length > 10000
          ? extractedText.substring(0, 10000) + '\n...[truncated]'
          : extractedText;

        messageContent = messageContent
          ? `${messageContent}\n\n[Document: ${docFilename}]\n${truncatedText}`
          : `[Document: ${docFilename}]\n${truncatedText}`;

      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.error("[Document] Failed to process office document:", error);
        messageContent = messageContent
          ? `${messageContent}\n\n[Document: ${docFilename} - failed to extract text: ${error}]`
          : `[Document: ${docFilename} - failed to extract text: ${error}]`;
      } finally {
        if (processingMessage) {
          try {
            await telegram.deleteMessage(ctx, processingMessage.message_id);
          } catch {
            // Ignore deletion errors
          }
        }
      }
    }
  }

  if (!messageContent) {
    console.log("[handleMessage] No message content to process - sending acknowledgment");
    // Still send a response so user knows we received their message
    await telegram.reply(ctx, "I received your message but couldn't extract any content to process. Try sending text or a voice message.");
    markResponseSent();
    return;
  }

  // ============ TAGGING & EMBEDDING (PARALLEL) ============
  // Run tagging and embedding in parallel for faster response
  // Both are needed before Claude can respond (embedding for semantic search)

  const [taggingResult, embedding] = await Promise.all([
    workersAI.tagMessage(messageContent),
    workersAI.generateEmbedding(messageContent),
  ]);

  // Get agent configuration from environment
  const agentId = (env.AGENT_ID as AgentId) || 'mya-personal';
  const memoryScope = (env.MEMORY_SCOPE as MemoryScope) || 'all';

  // Store user message with tags, entities, embedding, and optional folder routing
  console.log(`[Message] Storing user message for user_id: ${user.id}, agent: ${agentId}, type: ${messageType}, content length: ${messageContent.length}`);
  const userMessage = await supabase.insertMessage({
    user_id: user.id,
    role: "user",
    content: messageContent,
    message_type: messageType,
    tags: taggingResult.tags,
    entities_people: taggingResult.entities.people,
    entities_projects: taggingResult.entities.projects,
    suggested_new_tag: null,
    attachment_id: attachmentId || null,
    folder_id: targetFolderId || null,
    embedding,
    metadata: {
      entities_companies: taggingResult.entities.companies,
      entities_places: taggingResult.entities.places,
    },
    source: "telegram",
    agent_id: agentId,
  });
  console.log(`[Message] User message stored: ${userMessage.id}`);

  // Note: GLiNER entity extraction runs in nightly batch (02:00 UTC)
  // to reduce costs. Messages are processed in bulk by Modal.

  // ============ CONTEXT ASSEMBLY ============

  // Get context data in parallel for faster response
  // NOTE: We no longer passively load semantic matches - Mya uses tools to search when needed
  // The master index already contains the full mindscape overview
  const [recentMessages, masterIndexDoc, internalModelDoc, reflectionLogDoc, todoDoc, commPrefsDoc, pinnedDocs, folders, canvases] = await Promise.all([
    // Get recent messages for conversation history (scoped by agent's memory access)
    supabase.getRecentMessages(user.id, 20, memoryScope),
    // Get master index (contains full mindscape overview)
    supabase.getMasterIndex(user.id),
    // Get internal model (Mya's private hypotheses/questions) - always loaded
    supabase.getInternalModel(user.id),
    // Get reflection log (for flagged items) - always loaded
    supabase.getReflectionLog(user.id),
    // Always-in-context: Todo document (track access for activation scoring)
    supabase.getDocument(user.id, "core/todo", true),
    // Always-in-context: Communication preferences (track access)
    supabase.getDocument(user.id, "core/communication", true),
    // User-pinned documents
    supabase.getPinnedDocumentsWithContent(user.id),
    // Available folders for organization
    supabase.listFolders(user.id),
    // Available canvases for organization
    supabase.listCanvases(user.id),
  ]);

  const masterIndex = masterIndexDoc?.content || null;

  // Parse internal model (Mya's private hypotheses and questions)
  const internalModel = internalModelDoc?.content
    ? supabase.parseInternalModel(internalModelDoc.content)
    : null;

  // Parse flagged items from reflection log
  const flaggedItems = reflectionLogDoc?.content
    ? supabase.parseFlaggedItems(reflectionLogDoc.content)
    : [];

  // Build context (include image or video thumbnail for Claude multimodal)
  // Prefer full image over video thumbnail
  const visualData = imageDataForClaude || thumbnailDataForClaude;
  const context: ConversationContext = {
    masterIndex,
    recentMessages: recentMessages.slice(0, -1), // Exclude current message
    currentTags: taggingResult.tags,
    internalModel,
    flaggedItems,
    todoDoc: todoDoc?.content || null,
    commPrefsDoc: commPrefsDoc?.content || null,
    pinnedDocs: pinnedDocs.map(d => ({ path: d.path, content: d.content })),
    availableFolders: folders.map(f => f.name),
    availableCanvases: canvases.map(c => c.name),
    imageData: visualData,
    imageMimeType: visualData ? "image/jpeg" : undefined,
  };

  // ============ CLAUDE CONVERSATION ============
  // Processing in main handler gives us ~60 seconds (Telegram webhook timeout)

  // Track total usage across all Claude calls
  let totalUsage: ClaudeUsage = { inputTokens: 0, outputTokens: 0 };

  // Check user's thinking preference
  // Default: OFF for Telegram (faster responses)
  const ENABLE_THINKING = user.settings?.thinking_enabled === true;

  const claudeStartTime = Date.now();
  console.log(`[Claude] Calling API (thinking: ${ENABLE_THINKING ? 'ON' : 'OFF'}, message: ${messageContent.length} chars)...`);

  let response;
  try {
    response = ENABLE_THINKING
      ? await claude.chatWithThinking(messageContent, context)
      : await claude.chat(messageContent, context);
  } catch (claudeError) {
    const errorMessage = claudeError instanceof Error ? claudeError.message : String(claudeError);
    console.error("[Claude] API error:", errorMessage);
    await telegram.reply(ctx, "Sorry, I encountered an issue processing your message. Please try again.");
    markResponseSent();
    return;
  }

  console.log(`[Claude] Response in ${Date.now() - claudeStartTime}ms: ${response.content.length} chars, ${response.toolCalls.length} tool calls`);
  totalUsage.inputTokens += response.usage.inputTokens;
  totalUsage.outputTokens += response.usage.outputTokens;

  let allToolCalls: ToolCall[] = [];
  let allThinkingContent = response.thinking || "";
  let totalThinkingTokens = response.thinkingTokens || 0;

  // Execute tool calls and continue conversation until we get a text response
  // Claude should ALWAYS respond with text after using tools
  // Increased from 3 to 8 to allow deeper exploration/search workflows
  const MAX_TOOL_ITERATIONS = 8;
  let iteration = 0;

  while (response.toolCalls.length > 0 && iteration < MAX_TOOL_ITERATIONS) {
    iteration++;

    // Refresh typing indicator - it expires after ~5 seconds
    await telegram.sendTyping(ctx);

    const toolExecutor = new ToolExecutor(env, user.id);
    const toolResults = await toolExecutor.executeAll(response.toolCalls);
    console.log(`Tool iteration ${iteration}:`, response.toolCalls.map(t => t.name));

    // Refresh typing indicator before Claude continuation
    await telegram.sendTyping(ctx);

    // Track all tool calls for metadata
    allToolCalls = [...allToolCalls, ...response.toolCalls];

    // Build messages for continuation
    const continuationMessages = [
      ...context.recentMessages
        .filter((m) => m.content && m.content.trim().length > 0)
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      { role: "user" as const, content: messageContent },
      {
        role: "assistant" as const,
        content: response.toolCalls.map((tc) => ({
          type: "tool_use" as const,
          id: tc.id,
          name: tc.name,
          input: tc.input,
        })),
      },
    ];

    // Continue with tool results - Claude MUST respond to the user
    // Include orientation context to prevent drift during tool chains
    if (ENABLE_THINKING) {
      response = await claude.continueWithToolResultsAndThinking(
        continuationMessages,
        toolResults,
        [], // Thinking blocks - would need to preserve from previous response
        {
          toolCalls: response.toolCalls.map(t => ({ name: t.name, input: t.input })),
          flaggedTopics: context.flaggedItems.map(f => f.topic),
          currentPriority: context.todoDoc?.match(/## Urgent\n([^\n#]+)/)?.[1]?.trim() || undefined,
        }
      );
      // Accumulate thinking across iterations
      if (response.thinking) {
        allThinkingContent += "\n\n" + response.thinking;
      }
      if (response.thinkingTokens) {
        totalThinkingTokens += response.thinkingTokens;
      }
    } else {
      response = await claude.continueWithToolResults(
        continuationMessages,
        toolResults,
        {
          toolCalls: response.toolCalls.map(t => ({ name: t.name, input: t.input })),
          flaggedTopics: context.flaggedItems.map(f => f.topic),
          currentPriority: context.todoDoc?.match(/## Urgent\n([^\n#]+)/)?.[1]?.trim() || undefined,
        }
      );
    }
    totalUsage.inputTokens += response.usage.inputTokens;
    totalUsage.outputTokens += response.usage.outputTokens;
  }

  // If still no text after tools, make a final call without tools to force text response
  let responseContent = response.content.trim();
  if (!responseContent && allToolCalls.length > 0) {
    console.log("No text after tools, forcing text response...");

    // Make a final call without tools to get a text response
    const forceResponse = await claude.forceTextResponse(
      messageContent,
      context,
      allToolCalls.map(t => t.name)
    );
    responseContent = forceResponse.content;
    totalUsage.inputTokens += forceResponse.usage.inputTokens;
    totalUsage.outputTokens += forceResponse.usage.outputTokens;
  }

  // Final fallback (shouldn't happen)
  if (!responseContent) {
    console.log("Warning: Still no text response");
    responseContent = "I've processed that.";
  }

  // ============ BUILD TOOL INDICATOR ============
  // Show minimal tool usage indicator for Telegram (no token counts)
  let toolIndicator = "";
  if (allToolCalls.length > 0) {
    const toolDescriptions = allToolCalls.map(t => {
      const input = t.input as Record<string, unknown>;
      switch (t.name) {
        case "searchHistory": return "searched history";
        case "searchTerritories": return "explored territories";
        case "searchRealms": return "explored realms";
        case "searchThemes": return "searched themes";
        case "getDocument": return `read ${input.path || "document"}`;
        case "updateDocument": return `updated ${input.path || "document"}`;
        case "createDocument": return `created ${input.path || "document"}`;
        case "getTerritoryDetail": return "examined territory";
        case "getRealmDetail": return "examined realm";
        case "flagForDiscussion": return "flagged for later";
        default: return t.name.replace(/([A-Z])/g, " $1").toLowerCase().trim();
      }
    });
    // Deduplicate and join
    const uniqueDescriptions = [...new Set(toolDescriptions)];
    toolIndicator = `· ${uniqueDescriptions.join(", ")}\n\n`;
  }

  // ============ SEND RESPONSE ============
  // Always send Claude's response - this is the real answer
  // (We may have sent an acknowledgment earlier for voice messages, but the full response still needs to be sent)
  const fullResponse = toolIndicator + responseContent;
  console.log(`Sending response (${fullResponse.length} chars) to Telegram...`);
  try {
    await telegram.reply(ctx, fullResponse);
    markResponseSent();
    console.log("Telegram reply sent successfully");
  } catch (telegramError) {
    console.error("Failed to send Telegram reply:", telegramError);
    // Try plain text fallback (in case Markdown parsing fails)
    try {
      await ctx.reply(fullResponse.substring(0, 4000));
      markResponseSent();
      console.log("Fallback plain text reply sent");
    } catch (fallbackError) {
      console.error("Fallback reply also failed:", fallbackError);
      // Only use safety net if we haven't sent ANY response yet
      if (!responseSent) {
        await ensureResponse("Failed to send response");
      }
    }
  }

  // ============ TRACK USAGE ============
  // Calculate cost and persist to user_usage table for budget enforcement
  const costDollars = (totalUsage.inputTokens / 1_000_000) * PRICING.input +
                      (totalUsage.outputTokens / 1_000_000) * PRICING.output;
  const costCents = Math.ceil(costDollars * 100); // Round up to cents

  // Track usage asynchronously (don't block response)
  supabase.trackUsage(user.id, totalUsage.inputTokens, totalUsage.outputTokens, costCents)
    .then((result) => {
      if (result && !result.allowed) {
        console.warn(`User ${user.id} exceeded budget after this request`);
      }
    })
    .catch((err) => {
      console.error("Failed to track usage:", err);
    });

  // ============ POST-RESPONSE PROCESSING (async, user already has response) ============
  // Run embedding and tagging in parallel
  const [responseEmbedding, assistantTaggingResult] = await Promise.all([
    workersAI.generateEmbedding(responseContent),
    workersAI.tagMessage(responseContent),
  ]);

  // Store assistant message with tags, entities, embedding, thinking, and same folder as user message
  // Extract rich tool context for analytics
  const toolContext = allToolCalls.length > 0 ? extractToolContext(allToolCalls) : null;

  console.log(`[Message] Storing assistant message for user_id: ${user.id}, agent: ${agentId}, content length: ${responseContent.length}`);
  const assistantMessage = await supabase.insertMessage({
    user_id: user.id,
    role: "assistant",
    content: responseContent,
    message_type: "text",
    tags: assistantTaggingResult.tags,
    entities_people: assistantTaggingResult.entities.people,
    entities_projects: assistantTaggingResult.entities.projects,
    suggested_new_tag: null,
    attachment_id: null,
    folder_id: targetFolderId || null,
    embedding: responseEmbedding,
    thinking: allThinkingContent.trim() || null, // Store thinking for web portal review
    thinking_enabled: ENABLE_THINKING,
    thinking_tokens: totalThinkingTokens > 0 ? totalThinkingTokens : null,
    metadata: {
      ...toolContext,
      entities_companies: assistantTaggingResult.entities.companies,
      entities_places: assistantTaggingResult.entities.places,
    },
    source: "telegram",
    agent_id: agentId,
  });
  console.log(`[Message] Assistant message stored: ${assistantMessage.id}`);
  // Note: GLiNER entity extraction runs in nightly batch (02:00 UTC)

  } catch (error) {
    // Stop typing keepalive on error
    stopTypingKeepalive();

    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[handleMessage] Unhandled error:", errorMessage, error);

    // Use safety net to ensure user gets a response
    await ensureResponse(errorMessage);
    return;
  } finally {
    // Always stop typing keepalive
    stopTypingKeepalive();

    // Final safety net - if nothing was sent, send an error
    if (!responseSent) {
      console.warn("[handleMessage] No response was sent - triggering safety net");
      try {
        await telegram.reply(ctx, "Sorry, I wasn't able to complete my response. Please try again.");
      } catch (e) {
        console.error("[handleMessage] Final safety net failed:", e);
      }
    }
  }
}
