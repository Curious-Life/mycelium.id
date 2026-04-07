#!/usr/bin/env node
/**
 * MCP Tools for LevOps (ops-agent)
 *
 * Tools:
 *   checkEmail       — poll Gmail for unread emails with attachments
 *   classifyDocument — AI classification of a document/attachment
 *   uploadToDrive    — upload file to Google Drive shared folder
 *   logExpense       — record an expense/transaction
 *   listRecentFiled  — list recently filed documents
 *
 * Secrets (from D1 via bootstrap):
 *   OPS_GMAIL_CLIENT_ID, OPS_GMAIL_CLIENT_SECRET, OPS_GMAIL_REFRESH_TOKEN
 *   OPS_DRIVE_FOLDER_ID
 *   MYA_WORKER_URL, AGENT_TOKEN (for AI classification)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// ── Google Auth ──────────────────────────────────────────────────────────

async function getAccessToken() {
  const clientId = process.env.OPS_GMAIL_CLIENT_ID;
  const clientSecret = process.env.OPS_GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.OPS_GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Gmail OAuth credentials not configured');
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

// ── Gmail ────────────────────────────────────────────────────────────────

async function listEmails(maxResults = 10, query = '') {
  const token = await getAccessToken();
  const q = query || 'newer_than:1d';
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${maxResults}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Gmail list failed: ${res.status}`);
  const data = await res.json();
  return data.messages || [];
}

async function getEmail(messageId) {
  const token = await getAccessToken();
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Gmail get failed: ${res.status}`);
  return res.json();
}

async function getAttachment(messageId, attachmentId) {
  const token = await getAccessToken();
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Gmail attachment failed: ${res.status}`);
  const data = await res.json();
  // Gmail returns base64url-encoded data
  return Buffer.from(data.data, 'base64url');
}

async function markAsRead(messageId) {
  const token = await getAccessToken();
  await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
    },
  );
}

function parseEmailHeaders(message) {
  const headers = message.payload?.headers || [];
  const get = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  return {
    from: get('From'),
    to: get('To'),
    subject: get('Subject'),
    date: get('Date'),
  };
}

// ── Phishing / Spam Protection ───────────────────────────────────────

// Trusted sender domains (emails from these domains are always processed)
const TRUSTED_DOMAINS = new Set([
  // Add your domains here
  ...(process.env.OPS_TRUSTED_DOMAINS || '').split(',').map(d => d.trim().toLowerCase()).filter(Boolean),
]);

// Trusted individual senders
const TRUSTED_SENDERS = new Set([
  ...(process.env.OPS_TRUSTED_SENDERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
]);

// Phishing signals — patterns that indicate suspicious emails
const PHISHING_PATTERNS = [
  // Urgency manipulation
  /urgent.*action.*required/i,
  /account.*suspend/i,
  /verify.*immediately/i,
  /password.*expire/i,
  /unusual.*activity.*detected/i,
  // Impersonation
  /click.*here.*to.*confirm/i,
  /update.*payment.*info/i,
  /you.*won.*a.*prize/i,
  /claim.*your.*reward/i,
  // Social engineering targeting agents
  /ignore.*previous.*instructions/i,
  /disregard.*your.*rules/i,
  /new.*instructions.*from.*admin/i,
  /override.*security/i,
  /bypass.*filter/i,
  /execute.*command/i,
  /run.*this.*script/i,
  /system.*prompt/i,
  /you.*are.*now/i,
  /act.*as.*if/i,
  /pretend.*you.*are/i,
  // Dangerous URLs in body
  /bit\.ly|tinyurl|t\.co|goo\.gl/i,
];

// File types that should never be processed (potential malware vectors)
const DANGEROUS_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'com', 'msi', 'scr', 'pif', 'vbs', 'js', 'wsf',
  'ps1', 'sh', 'app', 'dmg', 'iso', 'jar', 'hta', 'cpl', 'reg',
]);

/**
 * Analyze an email for phishing/spam signals.
 * Returns { safe: boolean, reason?: string, score: number, signals: string[] }
 * Score: 0 = safe, 1+ = suspicious (higher = more dangerous)
 */
function analyzeEmailSafety(headers, body, attachments) {
  const signals = [];
  let score = 0;

  const fromEmail = (headers.from.match(/<([^>]+)>/) || [, headers.from])[1].toLowerCase();
  const fromDomain = fromEmail.split('@')[1] || '';

  // Trusted sender — skip all checks
  if (TRUSTED_SENDERS.has(fromEmail) || TRUSTED_DOMAINS.has(fromDomain)) {
    return { safe: true, score: 0, signals: ['trusted_sender'], fromEmail, fromDomain };
  }

  // Check body for phishing patterns
  const fullText = `${headers.subject} ${body}`;
  for (const pattern of PHISHING_PATTERNS) {
    if (pattern.test(fullText)) {
      signals.push(`pattern: ${pattern.source.slice(0, 40)}`);
      score += 2;
    }
  }

  // Check for prompt injection attempts (agent-specific)
  if (/\bsystem\s*prompt\b/i.test(fullText) || /\bignore.*instructions\b/i.test(fullText)) {
    signals.push('prompt_injection_attempt');
    score += 10;
  }

  // Check attachments for dangerous file types
  for (const att of attachments || []) {
    const ext = (att.filename || '').split('.').pop()?.toLowerCase();
    if (ext && DANGEROUS_EXTENSIONS.has(ext)) {
      signals.push(`dangerous_file: ${att.filename}`);
      score += 5;
    }
  }

  // Unknown sender with attachments — mild suspicion
  if (attachments?.length > 0 && !TRUSTED_DOMAINS.has(fromDomain)) {
    signals.push('unknown_sender_with_attachments');
    score += 1;
  }

  // Reply-to differs from sender (common phishing technique)
  const replyTo = (headers.replyTo || '').toLowerCase();
  if (replyTo && !replyTo.includes(fromDomain)) {
    signals.push('reply_to_mismatch');
    score += 3;
  }

  const safe = score < 3;
  return {
    safe,
    reason: safe ? null : `Suspicious email (score: ${score}): ${signals.join(', ')}`,
    score,
    signals,
    fromEmail,
    fromDomain,
  };
}

// ── Email Reply ──────────────────────────────────────────────────────

async function sendReply(originalMessageId, threadId, to, subject, bodyText) {
  const token = await getAccessToken();

  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
  const raw = [
    `To: ${to}`,
    `Subject: ${replySubject}`,
    `In-Reply-To: ${originalMessageId}`,
    `References: ${originalMessageId}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    bodyText,
  ].join('\r\n');

  const encoded = Buffer.from(raw).toString('base64url');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded, threadId }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error(`[ops-tools] Reply failed: ${res.status} ${err.slice(0, 200)}`);
    return false;
  }
  return true;
}

function buildConfirmationReply(results) {
  const lines = ['Documents received and filed:', ''];
  for (const r of results) {
    const c = r.classification;
    if (c) {
      const parts = [r.attachment || 'document'];
      if (c.vendor) parts[0] = c.vendor;
      if (c.amount && c.currency) parts.push(`${c.currency} ${c.amount}`);
      if (c.document_type) parts.push(c.document_type);
      lines.push(`  - ${parts.join(' | ')} → ${r.drivePath || 'filed'}`);
    } else {
      lines.push(`  - ${r.attachment || 'document'} → ${r.drivePath || 'filed'}`);
    }
  }
  lines.push('', '— LevOps (automated filing)');
  return lines.join('\n');
}

function extractAttachments(message) {
  const attachments = [];
  function walk(parts) {
    for (const part of parts || []) {
      if (part.filename && part.body?.attachmentId) {
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType,
          size: part.body.size,
          attachmentId: part.body.attachmentId,
        });
      }
      if (part.parts) walk(part.parts);
    }
  }
  walk(message.payload?.parts || []);
  // Check top-level body too
  if (message.payload?.filename && message.payload?.body?.attachmentId) {
    attachments.push({
      filename: message.payload.filename,
      mimeType: message.payload.mimeType,
      size: message.payload.body.size,
      attachmentId: message.payload.body.attachmentId,
    });
  }
  return attachments;
}

function extractBody(message) {
  let body = '';
  function walk(parts) {
    for (const part of parts || []) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        body += Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
      if (part.parts) walk(part.parts);
    }
  }
  walk(message.payload?.parts || []);
  if (!body && message.payload?.body?.data) {
    body = Buffer.from(message.payload.body.data, 'base64url').toString('utf-8');
  }
  return body.slice(0, 5000);
}

// ── Google Drive ─────────────────────────────────────────────────────────

const ROOT_FOLDER_ID = process.env.OPS_DRIVE_FOLDER_ID;

async function findOrCreateFolder(name, parentId) {
  const token = await getAccessToken();
  // Search for existing folder (supports shared drives)
  const q = `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const searchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const searchData = await searchRes.json();
  if (searchData.files?.length > 0) return searchData.files[0].id;

  // Create folder (supports shared drives)
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  });
  const created = await createRes.json();
  return created.id;
}

async function ensureFolderPath(pathParts) {
  let currentId = ROOT_FOLDER_ID;
  for (const part of pathParts) {
    currentId = await findOrCreateFolder(part, currentId);
  }
  return currentId;
}

async function uploadFile(fileName, mimeType, data, folderId) {
  const token = await getAccessToken();
  const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
  const boundary = '-----ops-upload-boundary';

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });

  if (!res.ok) throw new Error(`Drive upload failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── AI Classification ────────────────────────────────────────────────────

async function classifyWithAI(text, filename) {
  const workerUrl = process.env.MYA_WORKER_URL;
  const agentToken = process.env.AGENT_TOKEN;
  if (!workerUrl || !agentToken) return null;

  const prompt = `Classify this document. Return ONLY valid JSON, no other text.

Filename: ${filename || 'unknown'}
Content preview:
${text.slice(0, 3000)}

Return JSON:
{
  "document_type": "invoice|receipt|contract|bank_statement|tax_document|subscription|correspondence|other",
  "vendor": "company or person name",
  "amount": null or number,
  "currency": "EUR|USD|GBP|etc or null",
  "date": "YYYY-MM-DD or null",
  "category": "software|hosting|legal|travel|food|equipment|subscriptions|consulting|marketing|other",
  "summary": "one sentence description",
  "needs_review": true/false,
  "review_reason": "why it needs review or null"
}`;

  const res = await fetch(`${workerUrl}/api/ai/generate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, max_tokens: 500 }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) return null;
  const data = await res.json();
  const text_out = data.result || data.response || '';

  try {
    const jsonMatch = text_out.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch {
    return null;
  }
}

// ── Vision AI (OCR for PDFs and images) ──────────────────────────────────

async function describeWithVision(fileData, mimeType, filename) {
  const workerUrl = process.env.MYA_WORKER_URL;
  const agentToken = process.env.AGENT_TOKEN;
  if (!workerUrl || !agentToken) return null;

  try {
    const res = await fetch(`${workerUrl}/api/describe-image`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${agentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image: fileData.toString('base64'),
        mimeType: mimeType || 'application/pdf',
        prompt: `Read this document carefully. Extract ALL text you can see, especially: vendor/company name, amounts, currency, dates, invoice/receipt numbers, and line items. Return the full text content.`,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const description = data.description || data.result || '';
    if (description.length > 20) {
      console.log(`[ops-tools] Vision extracted ${description.length} chars from ${filename}`);
      return `Filename: ${filename}\nExtracted content:\n${description}`;
    }
    return null;
  } catch (err) {
    console.error(`[ops-tools] Vision failed for ${filename}:`, err.message);
    return null;
  }
}

// ── Discord Notification ─────────────────────────────────────────────────

async function notifyDiscord(message) {
  // Send directly through the Discord bot HTTP API (bypasses proactive rate limiter)
  const botUrl = process.env.DISCORD_BOT_URL || 'http://localhost:5019';
  const channelId = process.env.DISCORD_CHANNEL || '1489203476033441862';
  try {
    await fetch(`${botUrl}/discord/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, content: message }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* non-fatal */ }
}

function formatFilingNotification(filename, classification, drivePath, driveLink) {
  const parts = [];
  if (classification?.vendor) parts.push(classification.vendor);
  if (classification?.amount && classification?.currency) {
    parts.push(`${classification.currency} ${classification.amount}`);
  }
  if (classification?.document_type) parts.push(classification.document_type);

  const summary = parts.length > 0 ? parts.join(' · ') : filename;
  const link = driveLink ? ` — [View](${driveLink})` : '';
  return `📁 Filed: **${summary}**\n\`${drivePath}\`${link}`;
}

// ── Drive Path Builder ───────────────────────────────────────────────────

const MONTH_NAMES = ['01-January','02-February','03-March','04-April','05-May','06-June',
  '07-July','08-August','09-September','10-October','11-November','12-December'];

function buildDrivePath(classification) {
  const date = classification.date ? new Date(classification.date) : new Date();
  const year = String(date.getFullYear());
  const month = MONTH_NAMES[date.getMonth()];

  const typeMap = {
    invoice: ['Finance', year, month, 'Invoices'],
    receipt: ['Finance', year, month, 'Receipts'],
    bank_statement: ['Finance', year, month, 'Statements'],
    tax_document: ['Tax', year],
    contract: ['Contracts'],
    subscription: ['Subscriptions'],
    correspondence: ['Finance', year, month],
    other: ['Finance', year, month],
  };

  return typeMap[classification.document_type] || typeMap.other;
}

function buildFileName(classification, originalName) {
  const vendor = classification.vendor ? classification.vendor.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 30) : '';
  const date = classification.date || new Date().toISOString().slice(0, 10);
  const ext = originalName.includes('.') ? '.' + originalName.split('.').pop() : '.pdf';

  if (vendor) return `${vendor}_${date}${ext}`;
  return `${date}_${originalName}`;
}

// ── MCP Server ───────────────────────────────────────────────────────────

const server = new Server(
  { name: 'ops-tools', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'checkEmail',
      description: 'Check Gmail for recent emails (last 24h by default). Returns subject, sender, date, and attachment info.',
      inputSchema: {
        type: 'object',
        properties: {
          maxResults: { type: 'number', default: 10 },
          query: { type: 'string', description: 'Gmail search query (default: newer_than:1d). Examples: "is:unread", "has:attachment newer_than:7d", "from:hetzner"' },
        },
      },
    },
    {
      name: 'processEmail',
      description: 'Process a specific email: download attachments, classify, upload to Drive, mark as read. Returns classification and Drive link.',
      inputSchema: {
        type: 'object',
        properties: { messageId: { type: 'string', description: 'Gmail message ID' } },
        required: ['messageId'],
      },
    },
    {
      name: 'classifyDocument',
      description: 'Classify a document from text content. Returns type, vendor, amount, category.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Document text content' },
          filename: { type: 'string', description: 'Original filename' },
        },
        required: ['text'],
      },
    },
    {
      name: 'uploadToDrive',
      description: 'Upload a file to the shared Google Drive folder. Auto-creates subfolders based on classification.',
      inputSchema: {
        type: 'object',
        properties: {
          fileName: { type: 'string' },
          mimeType: { type: 'string', default: 'application/pdf' },
          base64Data: { type: 'string', description: 'Base64-encoded file content' },
          folderPath: { type: 'array', items: { type: 'string' }, description: 'Folder path like ["Finance", "2026", "04-April", "Invoices"]' },
        },
        required: ['fileName', 'base64Data', 'folderPath'],
      },
    },
    {
      name: 'fileFromUrl',
      description: 'Download a file from a URL (Discord attachment, R2 link, etc.), classify it, and upload to Google Drive. Use this when files are sent via Discord.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to download the file from' },
          filename: { type: 'string', description: 'Original filename' },
          contextText: { type: 'string', description: 'Any context about the file (sender, message text, extracted content)' },
        },
        required: ['url', 'filename'],
      },
    },
    {
      name: 'listDriveFolder',
      description: 'List files and subfolders in a Google Drive folder. Use with no folderId to list the root admin folder. Returns name, type, size, link for each item.',
      inputSchema: {
        type: 'object',
        properties: {
          folderId: { type: 'string', description: 'Drive folder ID. Omit to list root admin folder.' },
          maxResults: { type: 'number', default: 50 },
        },
      },
    },
    {
      name: 'moveDriveFile',
      description: 'Move a file to a different folder in Drive. Use to reorganize filed documents.',
      inputSchema: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: 'Drive file ID to move' },
          newFolderId: { type: 'string', description: 'Destination folder ID' },
        },
        required: ['fileId', 'newFolderId'],
      },
    },
    {
      name: 'listRecentFiled',
      description: 'List recently created files across all subfolders.',
      inputSchema: { type: 'object', properties: { maxResults: { type: 'number', default: 20 } } },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'checkEmail': {
      const messages = await listEmails(args?.maxResults || 10, args?.query);
      if (messages.length === 0) {
        return { content: [{ type: 'text', text: 'No unread emails.' }] };
      }

      const results = [];
      for (const msg of messages.slice(0, 10)) {
        const full = await getEmail(msg.id);
        const headers = parseEmailHeaders(full);
        const body = extractBody(full);
        const attachments = extractAttachments(full);
        const safety = analyzeEmailSafety(headers, body, attachments);
        results.push({
          id: msg.id,
          from: headers.from,
          subject: headers.subject,
          date: headers.date,
          attachments: attachments.map(a => ({ name: a.filename, type: a.mimeType, size: a.size })),
          hasAttachments: attachments.length > 0,
          safe: safety.safe,
          ...(safety.safe ? {} : { warning: safety.reason }),
        });
      }

      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }

    case 'processEmail': {
      const { messageId } = args;
      const message = await getEmail(messageId);
      const headers = parseEmailHeaders(message);
      const body = extractBody(message);
      const attachments = extractAttachments(message);

      // ── Phishing check ──
      const safety = analyzeEmailSafety(headers, body, attachments);
      if (!safety.safe) {
        await markAsRead(messageId);
        await notifyDiscord(`⚠️ **Blocked suspicious email**\nFrom: ${headers.from}\nSubject: ${headers.subject}\nReason: ${safety.reason}`);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              blocked: true,
              email: { from: headers.from, subject: headers.subject },
              safety,
            }, null, 2),
          }],
        };
      }

      const results = [];

      if (attachments.length === 0) {
        // No attachments — classify the email body itself
        const classification = await classifyWithAI(
          `From: ${headers.from}\nSubject: ${headers.subject}\n\n${body}`,
          headers.subject,
        );
        results.push({ type: 'email_body', classification, driveLink: null });
      }

      for (const att of attachments) {
        const data = await getAttachment(messageId, att.attachmentId);

        // Extract text for classification
        let textContent = '';
        if (att.mimeType === 'text/plain' || att.mimeType === 'text/csv') {
          textContent = data.toString('utf-8');
        } else if (att.mimeType === 'application/pdf' || att.mimeType?.startsWith('image/')) {
          // Use vision AI to read PDFs and images (handles scanned/image-based docs)
          textContent = await describeWithVision(data, att.mimeType, att.filename);
          if (!textContent) {
            // Fallback to email context
            textContent = `From: ${headers.from}\nSubject: ${headers.subject}\nAttachment: ${att.filename}\n\n${body}`;
          }
        } else {
          textContent = `From: ${headers.from}\nSubject: ${headers.subject}\nAttachment: ${att.filename}\n\n${body}`;
        }

        const classification = await classifyWithAI(textContent, att.filename);

        if (classification) {
          const folderPath = buildDrivePath(classification);
          const fileName = buildFileName(classification, att.filename);
          const folderId = await ensureFolderPath(folderPath);
          const uploaded = await uploadFile(fileName, att.mimeType, data, folderId);

          results.push({
            attachment: att.filename,
            classification,
            driveLink: uploaded.webViewLink,
            drivePath: folderPath.join('/') + '/' + fileName,
          });
        } else {
          // Fallback: file with original name in current month
          const now = new Date();
          const fallbackPath = ['Finance', String(now.getFullYear()), MONTH_NAMES[now.getMonth()]];
          const folderId = await ensureFolderPath(fallbackPath);
          const uploaded = await uploadFile(att.filename, att.mimeType, data, folderId);

          results.push({
            attachment: att.filename,
            classification: null,
            driveLink: uploaded.webViewLink,
            drivePath: fallbackPath.join('/') + '/' + att.filename,
            note: 'Classification failed — filed with original name',
          });
        }
      }

      // Mark as read
      await markAsRead(messageId);

      // Notify Discord for each filed document
      for (const r of results) {
        if (r.driveLink) {
          await notifyDiscord(formatFilingNotification(
            r.attachment || headers.subject, r.classification, r.drivePath, r.driveLink
          ));
        }
      }

      // Send confirmation reply to sender
      if (results.length > 0) {
        const msgId = message.payload?.headers?.find(h => h.name === 'Message-ID')?.value;
        const threadId = message.threadId;
        const replyBody = buildConfirmationReply(results);
        const replied = await sendReply(msgId, threadId, headers.from, headers.subject, replyBody).catch(() => false);
        if (!replied) console.log('[ops-tools] Confirmation reply skipped (gmail.send scope may be missing)');
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            email: { from: headers.from, subject: headers.subject, date: headers.date },
            processed: results,
            safety,
          }, null, 2),
        }],
      };
    }

    case 'classifyDocument': {
      const classification = await classifyWithAI(args.text, args.filename);
      return { content: [{ type: 'text', text: JSON.stringify(classification, null, 2) }] };
    }

    case 'uploadToDrive': {
      const data = Buffer.from(args.base64Data, 'base64');
      const folderId = await ensureFolderPath(args.folderPath);
      const result = await uploadFile(args.fileName, args.mimeType || 'application/pdf', data, folderId);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'fileFromUrl': {
      const { url, filename, contextText } = args;

      // Download file from URL
      const downloadRes = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!downloadRes.ok) {
        return { content: [{ type: 'text', text: `Failed to download file: ${downloadRes.status}` }], isError: true };
      }
      const fileData = Buffer.from(await downloadRes.arrayBuffer());
      const mimeType = downloadRes.headers.get('content-type') || 'application/octet-stream';

      // Extract text for classification — use vision AI for PDFs and images
      let classificationText = '';
      const isPdfOrImage = mimeType === 'application/pdf' || mimeType?.startsWith('image/') || filename?.match(/\.(pdf|png|jpg|jpeg|webp)$/i);
      if (isPdfOrImage) {
        classificationText = await describeWithVision(fileData, mimeType, filename) || '';
      }
      if (!classificationText) {
        classificationText = contextText
          ? `Filename: ${filename}\nContext: ${contextText}`
          : `Filename: ${filename}`;
      }

      // Classify
      const classification = await classifyWithAI(classificationText, filename);

      // Determine Drive path and file name
      let folderPath, driveFileName;
      if (classification) {
        folderPath = buildDrivePath(classification);
        driveFileName = buildFileName(classification, filename);
      } else {
        const now = new Date();
        folderPath = ['Finance', String(now.getFullYear()), MONTH_NAMES[now.getMonth()]];
        driveFileName = filename;
      }

      // Upload to Drive
      const folderId = await ensureFolderPath(folderPath);
      const uploaded = await uploadFile(driveFileName, mimeType, fileData, folderId);
      const drivePath = folderPath.join('/') + '/' + driveFileName;

      // Notify Discord
      await notifyDiscord(formatFilingNotification(filename, classification, drivePath, uploaded.webViewLink));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            filename,
            classification,
            driveLink: uploaded.webViewLink,
            drivePath,
          }, null, 2),
        }],
      };
    }

    case 'listDriveFolder': {
      const fid = args?.folderId || ROOT_FOLDER_ID;
      const token = await getAccessToken();
      const q = `'${fid}' in parents and trashed=false`;
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&orderBy=name&pageSize=${args?.maxResults || 50}&fields=files(id,name,mimeType,size,createdTime,webViewLink)&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = await res.json();
      const files = (data.files || []).map(f => ({
        id: f.id,
        name: f.name,
        type: f.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file',
        size: f.size ? `${Math.round(f.size / 1024)}KB` : null,
        created: f.createdTime?.slice(0, 10),
        link: f.webViewLink,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(files, null, 2) }] };
    }

    case 'moveDriveFile': {
      const token = await getAccessToken();
      // Get current parents
      const fileRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${args.fileId}?fields=parents&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const fileData = await fileRes.json();
      const oldParents = (fileData.parents || []).join(',');
      // Move
      const moveRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${args.fileId}?addParents=${args.newFolderId}&removeParents=${oldParents}&fields=id,name,parents,webViewLink&supportsAllDrives=true`,
        { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } },
      );
      const result = await moveRes.json();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'listRecentFiled': {
      const token = await getAccessToken();
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files?q='${ROOT_FOLDER_ID}'+in+parents&orderBy=createdTime+desc&pageSize=${args?.maxResults || 20}&fields=files(id,name,mimeType,createdTime,webViewLink,parents)&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(data.files || [], null, 2) }] };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
});

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
