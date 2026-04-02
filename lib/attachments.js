/**
 * Attachment Processing
 *
 * Processes attachments from Discord, Telegram, and Portal:
 * - Images: Vision description (Llama 4 Scout via Workers AI) + R2 storage
 * - Audio/Voice: Whisper transcription (via Workers AI) + R2 storage
 * - PDFs: Text extraction (unpdf, Workers AI vision fallback for scanned) + R2 storage
 * - Documents: Text extraction (mammoth for docx, plain read for others) + R2 storage
 * - Videos: Cloudflare Stream + thumbnail description
 * - Text files: Direct reading
 *
 * All AI processing goes through MYA Worker (Cloudflare Workers AI) — no external API keys needed.
 */

import mammoth from 'mammoth';
import fs from 'node:fs/promises';
import path from 'node:path';

// Configuration — read lazily from process.env so bootstrap-secrets can populate them first.
// DO NOT cache as top-level const — these must be read at call time.
const env = (key) => process.env[key];

// File type detection
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a', '.webm', '.flac'];
const AUDIO_MIMES = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/webm', 'audio/flac'];
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.webm', '.mkv'];
const VIDEO_MIMES = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm', 'video/x-matroska'];
const PDF_MIMES = ['application/pdf'];
// Office/document formats
const DOCUMENT_EXTENSIONS = ['.docx', '.doc', '.odt', '.rtf', '.pages', '.epub'];
const DOCUMENT_MIMES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/msword', // .doc
  'application/vnd.oasis.opendocument.text', // .odt
  'application/rtf', // .rtf
  'text/rtf',
  'application/x-iwork-pages-sffpages', // .pages
  'application/epub+zip', // .epub
];
const TEXT_EXTENSIONS = ['.txt', '.md', '.json', '.js', '.ts', '.py', '.html', '.css', '.yaml', '.yml', '.xml', '.csv', '.log', '.sh', '.bash', '.env', '.conf', '.cfg', '.ini', '.toml'];

// Size limits
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_AUDIO_SIZE = 25 * 1024 * 1024; // 25MB for Whisper
const MAX_PDF_SIZE = 32 * 1024 * 1024; // 32MB
const MAX_DOCUMENT_SIZE = 32 * 1024 * 1024; // 32MB
const MAX_TEXT_INLINE = 100 * 1024; // 100KB — inline in prompt (larger files saved to disk)
const MAX_TEXT_SIZE = 10 * 1024 * 1024; // 10MB — max text file we'll process at all
const MAX_VIDEO_SIZE = 200 * 1024 * 1024; // 200MB for Stream

/**
 * Get file type from filename and mime type
 */
function getFileType(filename, mimeType) {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));

  if (IMAGE_MIMES.includes(mimeType) || IMAGE_EXTENSIONS.includes(ext)) {
    return 'image';
  }
  if (AUDIO_MIMES.includes(mimeType) || AUDIO_EXTENSIONS.includes(ext)) {
    return 'audio';
  }
  if (VIDEO_MIMES.includes(mimeType) || VIDEO_EXTENSIONS.includes(ext)) {
    return 'video';
  }
  if (PDF_MIMES.includes(mimeType) || ext === '.pdf') {
    return 'pdf';
  }
  if (DOCUMENT_MIMES.includes(mimeType) || DOCUMENT_EXTENSIONS.includes(ext)) {
    return 'document';
  }
  if (TEXT_EXTENSIONS.includes(ext)) {
    return 'text';
  }
  return 'unknown';
}

/**
 * Download a Discord attachment
 */
async function downloadAttachment(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status}`);
  }
  return response.arrayBuffer();
}

/**
 * Store file in R2 via MYA Worker
 */
async function storeInR2(data, userId, type, filename, mimeType) {
  if (!env('MYA_WORKER_SECRET')) {
    console.log('[Attachments] R2 storage not configured - MYA_WORKER_SECRET missing');
    return null;
  }

  try {
    const base64 = Buffer.from(data).toString('base64');

    const response = await fetch(`${env('MYA_WORKER_URL')}/api/store-attachment`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env('MYA_WORKER_SECRET')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: base64,
        userId: userId || 'discord-anonymous',
        type: type,
        filename: filename,
        mimeType: mimeType,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Worker storage error: ${response.status} ${error}`);
    }

    const result = await response.json();
    console.log(`[Attachments] Stored in R2: ${result.key}`);
    return result.key;
  } catch (error) {
    console.error('[Attachments] R2 storage failed:', error.message);
    return null;
  }
}

/**
 * Detect actual image format from magic bytes
 * More reliable than trusting declared mime type from Discord
 */
function detectImageFormat(buffer) {
  const bytes = new Uint8Array(buffer);

  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return 'image/jpeg';
  }
  // GIF: 47 49 46 38
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  // BMP: 42 4D
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) {
    return 'image/bmp';
  }

  return null; // Unknown format
}

/**
 * Describe an image using Claude Vision
 */
async function describeImage(imageData, mimeType) {
  if (!env('MYA_WORKER_SECRET')) {
    return '[Image description unavailable - MYA_WORKER_SECRET not configured]';
  }

  try {
    const base64 = Buffer.from(imageData).toString('base64');
    // Detect actual format from magic bytes (more reliable than declared mime type)
    const detectedFormat = detectImageFormat(imageData);
    const mediaType = detectedFormat || mimeType || 'image/jpeg';

    if (detectedFormat && detectedFormat !== mimeType) {
      console.log(`[Attachments] Image format mismatch: declared ${mimeType}, detected ${detectedFormat}`);
    }

    // Use MYA Worker's /api/describe-image (Llama 4 Scout via Workers AI — free)
    const response = await fetch(`${env('MYA_WORKER_URL')}/api/describe-image`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env('MYA_WORKER_SECRET')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ image: base64, mimeType: mediaType }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Worker describe-image error: ${response.status} ${error}`);
    }

    const result = await response.json();
    return result.description || '[No description generated]';
  } catch (error) {
    console.error('[Attachments] Image description failed:', error.message);
    return `[Image description failed: ${error.message}]`;
  }
}

/**
 * Extract text from PDF using unpdf (fast, free).
 * Falls back to Workers AI vision for scanned/image PDFs.
 */
async function extractPdfText(pdfData, filename) {
  let extractedText = '';

  // Step 1: Try unpdf text extraction (works for vector/text PDFs)
  try {
    const { extractText } = await import('unpdf');
    const result = await extractText(new Uint8Array(pdfData));
    extractedText = Array.isArray(result.text) ? result.text.join('\n\n') : String(result.text);
    extractedText = extractedText.trim();
    console.log(`[Attachments] unpdf extracted ${extractedText.length} chars from ${filename}`);
  } catch (error) {
    console.warn('[Attachments] unpdf extraction failed:', error.message);
  }

  // Step 2: If too little text, it's probably a scanned PDF — try Workers AI vision
  if (extractedText.length < 100 && env('MYA_WORKER_SECRET')) {
    console.log(`[Attachments] PDF text too short (${extractedText.length} chars), trying Workers AI vision...`);
    try {
      // Convert first page to image concept — send as-is and let vision model try
      // For scanned PDFs, we describe what we can see
      const base64 = Buffer.from(pdfData).toString('base64');
      const response = await fetch(`${env('MYA_WORKER_URL')}/api/describe-image`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env('MYA_WORKER_SECRET')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ image: base64, mimeType: 'application/pdf' }),
      });

      if (response.ok) {
        const result = await response.json();
        if (result.description && result.description.length > extractedText.length) {
          extractedText = result.description;
          console.log(`[Attachments] Workers AI vision extracted ${extractedText.length} chars`);
        }
      }
    } catch (error) {
      console.warn('[Attachments] Workers AI vision fallback failed:', error.message);
    }
  }

  if (extractedText.length < 10) {
    return `[PDF document: ${filename}] — scanned/image-based PDF, text extraction was not possible. The file is stored in R2.`;
  }

  return extractedText;
}

/**
 * Extract text from documents:
 * - .docx: mammoth (structured extraction, preserves formatting)
 * - .doc/.odt/.rtf/.pages/.epub: stored in R2, content noted for agent
 */
async function extractDocumentText(docData, filename, mimeType) {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));

  // DOCX — mammoth handles this well
  if (ext === '.docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    try {
      const result = await mammoth.extractRawText({ buffer: Buffer.from(docData) });
      const text = result.value.trim();
      if (text.length > 0) {
        console.log(`[Attachments] mammoth extracted ${text.length} chars from ${filename}`);
        return text;
      }
    } catch (error) {
      console.error('[Attachments] mammoth extraction failed:', error.message);
    }
  }

  // RTF — try to read as text (RTF is text-based markup)
  if (ext === '.rtf' || mimeType === 'application/rtf' || mimeType === 'text/rtf') {
    try {
      const raw = Buffer.from(docData).toString('utf-8');
      // Strip RTF control codes for a rough text extraction
      const text = raw
        .replace(/\{\\[^{}]*\}/g, '')  // Remove groups like {\fonttbl...}
        .replace(/\\[a-z]+\d*\s?/gi, '')  // Remove control words
        .replace(/[{}]/g, '')  // Remove remaining braces
        .replace(/\s+/g, ' ')
        .trim();
      if (text.length > 20) {
        console.log(`[Attachments] RTF text extracted ${text.length} chars from ${filename}`);
        return text;
      }
    } catch (error) {
      console.warn('[Attachments] RTF extraction failed:', error.message);
    }
  }

  // Other formats (.doc, .odt, .pages, .epub) — no free Node library handles these well
  // Store in R2, note the file for the agent
  return `[Document: ${filename}] — ${ext} file received and stored. Text extraction not available for this format.`;
}

/**
 * Transcribe a single audio chunk using MYA Worker (Cloudflare Workers AI Whisper)
 */
async function transcribeAudioChunk(audioData, filename, mimeType) {
  if (!env('MYA_WORKER_SECRET')) {
    return '[Audio transcription unavailable - MYA_WORKER_SECRET not configured]';
  }

  try {
    // Convert to base64 for JSON transport
    const base64 = Buffer.from(audioData).toString('base64');

    const response = await fetch(`${env('MYA_WORKER_URL')}/api/transcribe`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env('MYA_WORKER_SECRET')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ audio: base64 }),
      signal: AbortSignal.timeout(60000), // 60s timeout per chunk
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Worker transcribe error: ${response.status} ${error}`);
    }

    const result = await response.json();
    return result.text || '';
  } catch (error) {
    console.error('[Attachments] Audio transcription failed:', error.message);
    return `[Audio transcription failed: ${error.message}]`;
  }
}

// Threshold above which we split audio into chunks before transcribing
// CF Workers AI Whisper only reliably transcribes short audio per request
const AUDIO_CHUNK_THRESHOLD = 2 * 1024 * 1024; // 2MB — always chunk large files
const AUDIO_CHUNK_DURATION = 60; // 60-second segments (CF Whisper sweet spot)

/**
 * Transcribe audio — automatically chunks long files via ffmpeg
 */
async function transcribeAudio(audioData, filename, mimeType) {
  if (!env('MYA_WORKER_SECRET')) {
    return '[Audio transcription unavailable - MYA_WORKER_SECRET not configured]';
  }

  const dataSize = audioData.byteLength || audioData.length;

  // Small files: transcribe directly
  if (dataSize <= AUDIO_CHUNK_THRESHOLD) {
    return (await transcribeAudioChunk(audioData, filename, mimeType)) || '[No transcription generated]';
  }

  // Large files: split into chunks with ffmpeg, transcribe each
  console.log(`[Attachments] Audio ${filename} is ${Math.round(dataSize / 1024)}KB — chunking for transcription`);

  const { spawn } = await import('child_process');
  const { writeFile, readFile, readdir, mkdtemp, rm } = await import('fs/promises');
  const { join } = await import('path');
  const { tmpdir } = await import('os');
  const dir = await mkdtemp(join(tmpdir(), 'audio-chunk-'));

  try {
    // Determine source extension from mime
    const extMap = { 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/wav': '.wav', 'audio/webm': '.webm', 'audio/flac': '.flac' };
    const srcExt = extMap[mimeType] || '.ogg';
    const srcFile = join(dir, `source${srcExt}`);
    await writeFile(srcFile, Buffer.from(audioData));

    // Split into segments using execFile for simplicity
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const pattern = join(dir, 'chunk_%03d.ogg');
    try {
      await execFileAsync('ffmpeg', [
        '-i', srcFile,
        '-f', 'segment',
        '-segment_time', String(AUDIO_CHUNK_DURATION),
        '-c:a', 'libopus', '-b:a', '48k',
        '-vn',
        pattern,
      ], { timeout: 300000 }); // 5 min timeout for splitting
    } catch (ffmpegErr) {
      // ffmpeg may exit non-zero but still produce chunks — check below
      console.warn(`[Attachments] ffmpeg exited with error: ${ffmpegErr.message?.slice(0, 200)}`);
    }

    const files = (await readdir(dir)).filter(f => f.startsWith('chunk_')).sort();
    if (files.length === 0) throw new Error('ffmpeg produced no chunks');

    console.log(`[Attachments] Split into ${files.length} chunks for transcription`);

    // Transcribe each chunk sequentially
    const transcripts = [];
    for (let i = 0; i < files.length; i++) {
      const chunkData = await readFile(join(dir, files[i]));
      console.log(`[Attachments] Transcribing chunk ${i + 1}/${files.length} (${Math.round(chunkData.length / 1024)}KB)`);
      const text = await transcribeAudioChunk(chunkData, files[i], 'audio/ogg');
      if (text && !text.startsWith('[')) {
        transcripts.push(text.trim());
        console.log(`[Attachments] Chunk ${i + 1} → ${text.trim().length} chars`);
      } else {
        console.log(`[Attachments] Chunk ${i + 1} → empty/failed`);
      }
    }

    const combined = transcripts.join(' ');
    console.log(`[Attachments] Total transcription: ${combined.length} chars from ${transcripts.length}/${files.length} chunks`);
    return combined || '[No transcription generated]';
  } catch (error) {
    console.error('[Attachments] Chunked transcription failed:', error.message);
    // Only fallback to direct for borderline sizes (< 5MB), not huge files
    if (dataSize < 5 * 1024 * 1024) {
      console.log('[Attachments] File small enough for direct transcription fallback');
      return (await transcribeAudioChunk(audioData, filename, mimeType)) || '[No transcription generated]';
    }
    return `[Audio transcription failed: ${error.message}]`;
  } finally {
    const { rm: rmDir } = await import('fs/promises');
    rmDir(dir, { recursive: true }).catch(() => {});
  }
}

/**
 * Upload video to Cloudflare Stream
 */
async function uploadToStream(videoData, filename, mimeType) {
  if (!env('CLOUDFLARE_ACCOUNT_ID') || !env('CLOUDFLARE_STREAM_TOKEN')) {
    console.log('[Attachments] Cloudflare Stream not configured');
    return null;
  }

  try {
    const formData = new FormData();
    const blob = new Blob([videoData], { type: mimeType || 'video/mp4' });
    formData.append('file', blob, filename);
    formData.append('requireSignedURLs', 'true');

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env('CLOUDFLARE_ACCOUNT_ID')}/stream`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env('CLOUDFLARE_STREAM_TOKEN')}`,
        },
        body: formData,
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Stream API error: ${response.status} ${error}`);
    }

    const result = await response.json();
    if (result.success && result.result) {
      console.log(`[Attachments] Uploaded to Stream: ${result.result.uid}`);
      return {
        uid: result.result.uid,
        hlsUrl: result.result.playback?.hls,
        dashUrl: result.result.playback?.dash,
        thumbnailUrl: result.result.thumbnail,
        status: result.result.status?.state,
      };
    }
    return null;
  } catch (error) {
    console.error('[Attachments] Stream upload failed:', error.message);
    return null;
  }
}

/**
 * Process a single Discord attachment
 * Returns: { type, content, r2Key, streamInfo, mimeType, size, filename }
 */
export async function processAttachment(attachment, userId = null) {
  const { name: filename, url, size, contentType } = attachment;
  const fileType = getFileType(filename, contentType);

  console.log(`[Attachments] Processing ${fileType}: ${filename} (${Math.round(size / 1024)}KB)`);

  const result = {
    type: fileType,
    filename,
    sourceUrl: url,
    mimeType: contentType,
    size,
    content: null,
    description: null,
    r2Key: null,
    streamInfo: null,
  };

  try {
    // Download the file
    const data = attachment.data || await downloadAttachment(url);

    switch (fileType) {
      case 'image':
        if (size > MAX_IMAGE_SIZE) {
          result.content = `[Image ${filename} skipped: ${Math.round(size / 1024 / 1024)}MB exceeds 20MB limit]`;
          break;
        }
        // Store in R2
        result.r2Key = await storeInR2(data, userId, 'image', filename, contentType);
        // Describe with Workers AI vision (annotation)
        result.description = await describeImage(data, contentType);
        // Save to agent inbox so Claude Code can Read the image directly (multimodal)
        {
          const inboxDir = path.join(process.env.HOME || '/home/claude', 'agents', process.env.AGENT_ID || 'personal-agent', 'inbox');
          await fs.mkdir(inboxDir, { recursive: true });
          const savedPath = path.join(inboxDir, filename);
          await fs.writeFile(savedPath, Buffer.from(data));
          result.content = `[Image: ${filename} — saved to ${savedPath}] (download: ${url})\nUse the Read tool to view this image directly.\nAI description: ${result.description}`;
        }
        break;

      case 'audio':
        if (size > MAX_AUDIO_SIZE) {
          result.content = `[Audio ${filename} skipped: ${Math.round(size / 1024 / 1024)}MB exceeds 25MB limit]`;
          break;
        }
        // Store in R2
        result.r2Key = await storeInR2(data, userId, 'voice', filename, contentType);
        // Transcribe with Whisper
        const transcription = await transcribeAudio(data, filename, contentType);
        result.description = transcription;
        result.content = `[Audio: ${filename}]\nTranscription: ${transcription}`;
        break;

      case 'video':
        if (size > MAX_VIDEO_SIZE) {
          result.content = `[Video ${filename} skipped: ${Math.round(size / 1024 / 1024)}MB exceeds 200MB limit]`;
          break;
        }
        // Upload to Cloudflare Stream
        result.streamInfo = await uploadToStream(data, filename, contentType);
        if (result.streamInfo) {
          result.content = `[Video: ${filename}] Uploaded to Stream (processing). UID: ${result.streamInfo.uid}`;
        } else {
          // Fallback: store in R2
          result.r2Key = await storeInR2(data, userId, 'video', filename, contentType);
          result.content = `[Video: ${filename}] Stored in R2`;
        }
        break;

      case 'pdf':
        if (size > MAX_PDF_SIZE) {
          result.content = `[PDF ${filename} skipped: ${Math.round(size / 1024 / 1024)}MB exceeds 32MB limit]`;
          break;
        }
        // Store in R2
        result.r2Key = await storeInR2(data, userId, 'file', filename, contentType);
        // Extract text with Claude
        const pdfText = await extractPdfText(data, filename);
        result.description = pdfText;
        result.content = `[PDF: ${filename}] (download: ${url})\n${pdfText.substring(0, 3000)}${pdfText.length > 3000 ? '...[truncated]' : ''}`;
        break;

      case 'document':
        if (size > MAX_DOCUMENT_SIZE) {
          result.content = `[Document ${filename} skipped: ${Math.round(size / 1024 / 1024)}MB exceeds 32MB limit]`;
          break;
        }
        // Store in R2
        result.r2Key = await storeInR2(data, userId, 'file', filename, contentType);
        // Extract text with Claude
        const docText = await extractDocumentText(data, filename, contentType);
        result.description = docText;
        result.content = `[Document: ${filename}] (download: ${url})\n${docText.substring(0, 3000)}${docText.length > 3000 ? '...[truncated]' : ''}`;
        break;

      case 'text':
        if (size > MAX_TEXT_SIZE) {
          result.content = `[File ${filename} skipped: ${Math.round(size / 1024 / 1024)}MB exceeds 10MB limit]`;
          break;
        }
        // Always store to R2 for persistence and retrieval
        result.r2Key = await storeInR2(data, userId, 'file', filename, contentType).catch(() => null);
        {
          const text = new TextDecoder().decode(data);
          result.description = text;
          if (size > MAX_TEXT_INLINE) {
            // Save large text files to disk so agent can read with file tools
            const inboxDir = path.join(process.env.HOME || '/home/claude', 'agents', process.env.AGENT_ID || 'personal-agent', 'inbox');
            await fs.mkdir(inboxDir, { recursive: true });
            const savedPath = path.join(inboxDir, filename);
            await fs.writeFile(savedPath, Buffer.from(data));
            result.content = `[File ${filename} (${Math.round(size / 1024)}KB) saved to ${savedPath} — use the Read tool to view its contents]`;
          } else {
            // Small text files: read directly into context
            result.content = `[File: ${filename}]\n${text}`;
          }
        }
        break;

      default:
        result.content = `[File ${filename} skipped: unsupported type (${contentType || 'unknown'})]`;
    }
  } catch (error) {
    console.error(`[Attachments] Error processing ${filename}:`, error.message);
    result.content = `[Error processing ${filename}: ${error.message}]`;
  }

  return result;
}

/**
 * Process all attachments from a Discord message
 * Accepts either an array of attachments or a Map/Collection
 * Returns combined content string and array of processed results
 */
export async function processAllAttachments(attachments, userId = null) {
  // Handle both arrays and Map/Collection
  const attachmentArray = Array.isArray(attachments)
    ? attachments
    : attachments?.values ? Array.from(attachments.values()) : [];

  if (!attachmentArray || attachmentArray.length === 0) {
    return { content: null, results: [] };
  }

  const results = [];
  const contentParts = [];

  for (const attachment of attachmentArray) {
    const result = await processAttachment(attachment, userId);
    results.push(result);
    if (result.content) {
      contentParts.push(result.content);
    }
  }

  return {
    content: contentParts.length > 0 ? contentParts.join('\n\n') : null,
    results,
  };
}

/**
 * Create attachment record in database.
 * First param is unused (legacy compat) — uses db abstraction.
 */
export async function createAttachmentRecord(_unused, {
  userId,
  messageId,
  type,
  filename,
  mimeType,
  size,
  r2Key,
  streamInfo,
  description,
  transcript,
  discordMetadata,
}) {
  const { tryGetDb } = await import('./db.js');
  const db = tryGetDb();
  if (!db) return null;

  try {
    const attachment = {
      user_id: userId || null,
      file_name: filename || null,
      file_type: type === 'audio' ? 'voice' : type,
      r2_key: r2Key,
      stream_uid: streamInfo?.uid || null,
      description: description?.substring(0, 1000) || null,
      transcript: transcript || null,
      file_size: size || null,
      metadata: JSON.stringify({
        source: discordMetadata?.source || 'discord',
        mime_type: mimeType,
        original_filename: filename,
        ...discordMetadata,
        ...(streamInfo && {
          stream_status: streamInfo.status,
          stream_hls_url: streamInfo.hlsUrl,
        }),
      }),
    };

    if (messageId) attachment.message_id = messageId;

    const data = await db.attachments.insert(attachment);
    console.log(`[Attachments] Created attachment record: ${data.id}`);

    // Auto-create document record for text-based files so they appear in Library
    const textExts = /\.(txt|md|csv|json|xml|html|log|yml|yaml|toml|ini|conf|sh|py|js|ts)$/i;
    const isText = mimeType?.startsWith('text/') || textExts.test(filename || '');
    if (isText && r2Key && userId) {
      try {
        const docPath = `uploads/${filename || 'untitled'}`;
        const docTitle = (filename || 'untitled').replace(/\.[^.]+$/, '');
        const r2Res = await fetch(`${env('MYA_WORKER_URL')}/attachments/${encodeURIComponent(r2Key)}`, {
          headers: { 'Authorization': `Bearer ${env('MYA_WORKER_SECRET')}` },
          signal: AbortSignal.timeout(15000),
        });
        if (r2Res.ok) {
          const content = await r2Res.text();
          await db.documents.upsert({
            user_id: userId,
            path: docPath,
            title: docTitle,
            content: content.substring(0, 50000),
            summary: content.substring(0, 200),
            source_type: 'upload',
            created_by: 'user',
          });
          console.log(`[Attachments] Document created for: ${docPath}`);
        }
      } catch (docErr) {
        console.error(`[Attachments] Auto-document failed:`, docErr.message);
      }
    }

    return data.id;
  } catch (error) {
    console.error('[Attachments] DB error:', error.message);
    return null;
  }
}

/**
 * Extract Google Doc/Sheet/Slide ID from URL
 * Supports various URL formats:
 * - https://docs.google.com/document/d/{ID}/edit
 * - https://docs.google.com/spreadsheets/d/{ID}/edit
 * - https://docs.google.com/presentation/d/{ID}/edit
 * - https://drive.google.com/file/d/{ID}/view
 */
function parseGoogleUrl(url) {
  const patterns = [
    { type: 'doc', regex: /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/ },
    { type: 'sheet', regex: /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/ },
    { type: 'slides', regex: /docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/ },
    { type: 'drive', regex: /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/ },
  ];

  for (const { type, regex } of patterns) {
    const match = url.match(regex);
    if (match) {
      return { type, id: match[1] };
    }
  }
  return null;
}

/**
 * Fetch Google Doc content as plain text
 * Works for publicly shared documents (anyone with link can view)
 */
async function fetchGoogleDocContent(docId, docType) {
  // Export URLs for different Google doc types
  const exportUrls = {
    doc: `https://docs.google.com/document/d/${docId}/export?format=txt`,
    sheet: `https://docs.google.com/spreadsheets/d/${docId}/export?format=csv`,
    slides: `https://docs.google.com/presentation/d/${docId}/export?format=txt`,
  };

  const exportUrl = exportUrls[docType];
  if (!exportUrl) {
    return null;
  }

  try {
    const response = await fetch(exportUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MYA-Bot/1.0)',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return '[Google Doc not accessible - must be shared as "Anyone with the link can view"]';
      }
      console.error(`[Attachments] Google Doc fetch failed: ${response.status}`);
      return null;
    }

    const text = await response.text();

    // Check for Google login page (doc not public)
    if (text.includes('accounts.google.com') || text.includes('Sign in')) {
      return '[Google Doc not accessible - must be shared as "Anyone with the link can view"]';
    }

    return text;
  } catch (error) {
    console.error('[Attachments] Google Doc fetch error:', error.message);
    return null;
  }
}

/**
 * Process URLs in message text and extract content from supported sources
 * Currently supports: Google Docs, Sheets, Slides
 * Returns: { processedText, extractedContent[] }
 */
export async function processMessageUrls(messageText) {
  if (!messageText) return { processedText: messageText, extractedContent: [] };

  // Find all URLs in the message
  const urlRegex = /https?:\/\/[^\s<>\"]+/gi;
  const urls = messageText.match(urlRegex) || [];

  const extractedContent = [];

  for (const url of urls) {
    // Check for Google Docs
    const googleInfo = parseGoogleUrl(url);
    if (googleInfo && googleInfo.type !== 'drive') {
      console.log(`[Attachments] Processing Google ${googleInfo.type}: ${googleInfo.id}`);

      const content = await fetchGoogleDocContent(googleInfo.id, googleInfo.type);
      if (content) {
        const typeLabel = { doc: 'Google Doc', sheet: 'Google Sheet', slides: 'Google Slides' }[googleInfo.type];
        const truncated = content.length > 10000
          ? content.substring(0, 10000) + '\n...[truncated, full doc is ' + Math.round(content.length / 1000) + 'KB]'
          : content;

        extractedContent.push({
          type: 'google-' + googleInfo.type,
          url,
          content: `[${typeLabel}]\n${truncated}`,
        });
      }
    }

    // Future: Add support for other URL types here
    // - Notion pages
    // - GitHub gists
    // - Pastebin
    // etc.
  }

  return { processedText: messageText, extractedContent };
}

/**
 * Check if attachment processing is available
 */
export function isConfigured() {
  return {
    vision: !!env('MYA_WORKER_SECRET'),  // Image description via Workers AI (Llama 4 Scout)
    storage: !!env('MYA_WORKER_SECRET'),  // R2 storage goes through worker
    transcription: !!env('MYA_WORKER_SECRET'),  // Whisper via Workers AI
    stream: !!(env('CLOUDFLARE_ACCOUNT_ID') && env('CLOUDFLARE_STREAM_TOKEN')),
    documents: true,  // unpdf for PDFs, mammoth for docx (no external API needed)
    googleDocs: true,  // Always available (for public docs)
  };
}

export default {
  processAttachment,
  processAllAttachments,
  processMessageUrls,
  createAttachmentRecord,
  isConfigured,
};
