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
import { getWorkerUrl } from './env.js';
import { extractOfficeText, isOfficeExtension } from './office-extract.js';
import { clampDocumentContent } from './document-limits.js';
import { saveDocument, resolveAgentScope, SaveDocumentError } from './document-store.js';

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
 * Best-available auth token for Worker API calls. Owner VPSes use
 * MYA_WORKER_SECRET (shared); customer VPSes use per-agent tokens.
 */
function getWorkerAuthToken() {
  return env('MYA_WORKER_SECRET') || env('AGENT_TOKEN_MYA') || env('AGENT_TOKEN') || null;
}

/**
 * Store file in R2 via MYA Worker
 */
async function storeInR2(data, userId, type, filename, mimeType) {
  // Worker accepts either (a) legacy MYA_WORKER_SECRET shared-secret (owner VPS)
  // or (b) per-agent tokens where body.userId matches the token's tenant
  // (customer VPSes). Prefer the agent-token path since it's what customer
  // VPSes have; fall back to the shared secret for the owner VPS.
  const workerSecret = env('MYA_WORKER_SECRET');
  const agentToken = env('AGENT_TOKEN_MYA') || env('AGENT_TOKEN');
  const authToken = workerSecret || agentToken;
  if (!authToken) {
    console.log('[Attachments] R2 storage not configured — no MYA_WORKER_SECRET or AGENT_TOKEN available');
    return null;
  }

  try {
    const base64 = Buffer.from(data).toString('base64');

    const response = await fetch(`${getWorkerUrl()}/api/store-attachment`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
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
  const authToken = getWorkerAuthToken();
  if (!authToken) {
    return '[Image description unavailable - no worker auth token configured]';
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
    const response = await fetch(`${getWorkerUrl()}/api/describe-image`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
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
  const visionToken = env('MYA_WORKER_SECRET') || env('AGENT_TOKEN_MYA') || env('AGENT_TOKEN');
  if (extractedText.length < 100 && visionToken) {
    console.log(`[Attachments] PDF text too short (${extractedText.length} chars), trying Workers AI vision...`);
    try {
      // Convert first page to image concept — send as-is and let vision model try
      // For scanned PDFs, we describe what we can see
      const base64 = Buffer.from(pdfData).toString('base64');
      const response = await fetch(`${getWorkerUrl()}/api/describe-image`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${visionToken}`,
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

  // Everything else — .pages, .doc, .odt, .key, .numbers, .pptx,
  // .xlsx, .epub — falls through to LibreOffice headless (PR 5.5-A).
  // soffice covers iWork + MS Office + ODF in one dependency. Returns
  // null on any failure (ENOENT / timeout / malformed input); we drop
  // back to the placeholder string so the file stays usable as a
  // download even when extraction is unavailable.
  if (isOfficeExtension(filename)) {
    try {
      const text = await extractOfficeText(Buffer.from(docData), filename);
      if (text && text.length >= 10) {
        console.log(`[Attachments] LibreOffice extracted ${text.length} chars from ${filename}`);
        return text;
      }
    } catch (err) {
      console.warn(`[Attachments] LibreOffice extraction failed for ${filename}: ${err.message}`);
    }
  }

  // No extractor available for this format. The file is still in R2
  // for download; we just can't surface its contents to the agent.
  return `[Document: ${filename}] — ${ext} file received and stored. Text extraction not available (install LibreOffice to enable).`;
}

/**
 * Transcribe a single audio chunk using MYA Worker (Cloudflare Workers AI Whisper)
 */
async function transcribeAudioChunk(audioData, filename, mimeType) {
  const authToken = getWorkerAuthToken();
  if (!authToken) {
    return '[Audio transcription unavailable - no worker auth token configured]';
  }

  try {
    // Convert to base64 for JSON transport
    const base64 = Buffer.from(audioData).toString('base64');

    const response = await fetch(`${getWorkerUrl()}/api/transcribe`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
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

// Shutdown flag — set by SIGINT/SIGTERM handlers so in-flight transcription
// can finish the current chunk and save progress instead of losing everything.
let _shuttingDown = false;
export function signalShutdown() { _shuttingDown = true; }

/**
 * Transcribe audio — automatically chunks long files via ffmpeg.
 * Progress is saved to disk after each chunk so SIGINT/restarts don't
 * lose already-completed work.
 */
async function transcribeAudio(audioData, filename, mimeType) {
  if (!getWorkerAuthToken()) {
    return '[Audio transcription unavailable - no worker auth token configured]';
  }

  const dataSize = audioData.byteLength || audioData.length;

  // Small files: transcribe directly
  if (dataSize <= AUDIO_CHUNK_THRESHOLD) {
    return (await transcribeAudioChunk(audioData, filename, mimeType)) || '[No transcription generated]';
  }

  // Large files: split into chunks with ffmpeg, transcribe each
  console.log(`[Attachments] Audio ${filename} is ${Math.round(dataSize / 1024)}KB — chunking for transcription`);

  const { writeFile, readFile, readdir, mkdtemp } = await import('fs/promises');
  const { join } = await import('path');
  const { tmpdir } = await import('os');
  const dir = await mkdtemp(join(tmpdir(), 'audio-chunk-'));
  const progressFile = join(dir, '_progress.json');

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

    // Transcribe each chunk sequentially, saving progress after each
    const transcripts = [];
    let interrupted = false;
    for (let i = 0; i < files.length; i++) {
      // Check shutdown flag between chunks — let current chunk finish but don't start new ones
      if (_shuttingDown) {
        console.log(`[Attachments] Shutdown requested — saving progress at chunk ${i}/${files.length}`);
        interrupted = true;
        break;
      }

      const chunkData = await readFile(join(dir, files[i]));
      console.log(`[Attachments] Transcribing chunk ${i + 1}/${files.length} (${Math.round(chunkData.length / 1024)}KB)`);
      const text = await transcribeAudioChunk(chunkData, files[i], 'audio/ogg');
      if (text && !text.startsWith('[')) {
        transcripts.push(text.trim());
        console.log(`[Attachments] Chunk ${i + 1} → ${text.trim().length} chars`);
      } else {
        console.log(`[Attachments] Chunk ${i + 1} → empty/failed`);
      }

      // Persist progress after each chunk — survives crashes
      await writeFile(progressFile, JSON.stringify({
        filename,
        totalChunks: files.length,
        completedChunks: i + 1,
        transcripts,
        updatedAt: new Date().toISOString(),
      })).catch(err => console.warn('[Attachments] Progress save failed:', err.message));
    }

    const combined = transcripts.join(' ');
    if (interrupted) {
      console.log(`[Attachments] Partial transcription: ${combined.length} chars from ${transcripts.length}/${files.length} chunks (interrupted)`);
    } else {
      console.log(`[Attachments] Total transcription: ${combined.length} chars from ${transcripts.length}/${files.length} chunks`);
    }
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
/**
 * Build the structured `created_by` token + per-document encrypted source
 * block. The token convention (PR 5.10) lets the library UI distinguish
 * "the operator uploaded this" from "someone else in a shared group did,"
 * which the legacy `'user'` literal collapsed to a misleading "You" for
 * everyone.
 *
 * Conventions:
 *   'user' / 'self'   → the operator (UI: "You")
 *   'tg:<userId>'     → non-owner Telegram sender
 *   'wa:<userId>'     → non-owner WhatsApp sender
 *   'discord:<userId>'→ non-owner Discord sender (Phase 2 — bots don't
 *                       upload files today, but the convention is reserved)
 *   '<agent-id>'      → agent-written files (PR 5.4 convention; produced
 *                       elsewhere via storeAttachmentRecord, not here)
 *
 * The encrypted `source` block holds the rich provenance: display name at
 * upload time, channel id, group title. The library UI reads it for the
 * author label when `created_by` matches `tg:*` / `wa:*`.
 */
export function buildSourceProvenance({ platform, senderId, senderName, isOwner, channelId, channelTitle, channelKind }) {
  const platformPrefix = { telegram: 'tg', whatsapp: 'wa', discord: 'discord' }[platform] || null;
  // Owner uploads keep the legacy 'user' value for back-compat with ~600
  // existing rows; UI maps both 'user' and 'self' to "You".
  let createdBy = 'user';
  if (!isOwner && platformPrefix && senderId) {
    createdBy = `${platformPrefix}:${senderId}`;
  }
  // Always emit the source block when we know the platform — the encrypted
  // metadata is cheap, and even owner uploads benefit from "from which
  // channel" provenance (timeline/library context).
  const source = platform ? {
    platform,
    user_id: senderId ? String(senderId) : null,
    user_name: senderName || null,
    channel_id: channelId ? String(channelId) : null,
    channel_title: channelTitle || null,
    channel_kind: channelKind || null,
  } : null;
  return { createdBy, source };
}

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
  // PR 5.10: per-upload sender + channel attribution. All optional; when
  // omitted, behaviour is identical to the pre-PR-5.10 path (created_by
  // defaults to 'user', no source block).
  platform,        // 'telegram' | 'whatsapp' | 'discord' | 'portal'
  senderId,        // platform user id (string or number)
  senderName,      // display name at upload time
  isOwner = true,  // true → operator (created_by='user'); false → others
  channelId,       // platform chat / channel id
  channelTitle,    // group/channel title (falsy for DMs)
  channelKind,     // 'private' | 'group' | 'supergroup' | 'channel' | 'dm'
}) {
  const { tryGetDb } = await import('./db.js');
  const db = tryGetDb();
  if (!db) return null;

  const { createdBy, source } = buildSourceProvenance({
    platform: platform || discordMetadata?.source || null,
    senderId, senderName, isOwner, channelId, channelTitle, channelKind,
  });

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
        source: discordMetadata?.source || platform || 'discord',
        mime_type: mimeType,
        original_filename: filename,
        ...discordMetadata,
        ...(source ? { source_provenance: source } : {}),
        ...(streamInfo && {
          stream_status: streamInfo.status,
          stream_hls_url: streamInfo.hlsUrl,
        }),
      }),
    };

    if (messageId) attachment.message_id = messageId;

    const data = await db.attachments.insert(attachment);
    console.log(`[Attachments] Created attachment record: ${data.id}`);

    // Auto-create document record for text-based files so they appear
    // in Library. PR 11 closed a PR-8a inventory miss: this site was
    // not in the design doc's 23-write-site enumeration but functions
    // as the bot-process equivalent of messages-io.js's
    // storeAttachmentRecord (called from telegram-bot / discord-bot /
    // whatsapp-bot when a user shares a text file).
    //
    // Scope note: bots don't currently set AGENT_SCOPES in their PM2
    // env, so resolveAgentScope() falls back to 'org' — same as the
    // schema default that ran here pre-PR-11. saveDocument's INSERT-
    // only invariant preserves that on subsequent edits. Latent
    // cleanup: setting AGENT_SCOPES=["personal"] in mya-telegram-bot
    // (and matching the agent's primary scope for each bot) would
    // route bot-uploaded docs into personal scope where the user's
    // library actually lives. Out of scope for PR 11.
    const textExts = /\.(txt|md|csv|json|xml|html|log|yml|yaml|toml|ini|conf|sh|py|js|ts)$/i;
    const isText = mimeType?.startsWith('text/') || textExts.test(filename || '');
    if (isText && r2Key && userId) {
      try {
        const docPath = `uploads/${filename || 'untitled'}`;
        const docTitle = (filename || 'untitled').replace(/\.[^.]+$/, '');
        const r2Res = await fetch(`${getWorkerUrl()}/attachments/${encodeURIComponent(r2Key)}`, {
          headers: { 'Authorization': `Bearer ${getWorkerAuthToken()}` },
          signal: AbortSignal.timeout(15000),
        });
        if (r2Res.ok) {
          const content = await r2Res.text();
          await saveDocument({ db }, {
            userId,
            // 'portal-upload' is the closest semantic fit — user
            // uploads a file via a different transport (chat platform
            // instead of portal). The library UI's "Upload" pill maps
            // sourceType='upload' regardless of the source enum.
            source: 'portal-upload',
            sourceType: 'upload',
            scope: resolveAgentScope(),
            createdBy,
            path: docPath,
            title: docTitle,
            content: clampDocumentContent(content),
            summary: content.substring(0, 200),
            ...(source ? { metadata: { source } } : {}),
          });
          console.log(`[Attachments] Document created for: ${docPath} (created_by=${createdBy})`);
        }
      } catch (docErr) {
        if (docErr instanceof SaveDocumentError) {
          console.error(`[Attachments] saveDocument refused (${docErr.code}): ${docErr.message}`);
        } else {
          console.error(`[Attachments] Auto-document failed:`, docErr.message);
        }
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
  const hasAuth = !!getWorkerAuthToken();
  return {
    vision: hasAuth,  // Image description via Workers AI (Llama 4 Scout)
    storage: hasAuth,  // R2 storage goes through worker
    transcription: hasAuth,  // Whisper via Workers AI
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
  signalShutdown,
};
