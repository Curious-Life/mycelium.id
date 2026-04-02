/**
 * Gmail ServicePlugin
 *
 * Actions: search, read, send, unread, draft, mark_read, labels
 *
 * Uses raw fetch() to Gmail API v1. No googleapis dependency.
 * Auth handled by google-auth.js (OAuth or Service Account).
 */

import { createGoogleAuth } from './google-auth.js';
import { registerPlugin } from './service-plugin.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const auth = createGoogleAuth();

// ─── ServicePlugin contract ─────────────────────────────────────────

export const gmailPlugin = {
  id: 'gmail',
  name: 'Gmail',
  actions: ['send', 'search', 'read', 'unread', 'draft', 'mark_read', 'labels'],

  isConfigured() {
    return auth.isConfigured();
  },

  toolSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['search', 'read', 'send', 'unread', 'draft', 'mark_read', 'labels'] },
      query: { type: 'string', description: 'Gmail search query (for search action)' },
      maxResults: { type: 'number', description: 'Max results to return (default 10)' },
      messageId: { type: 'string', description: 'Message ID (for read, mark_read actions)' },
      to: { type: 'string', description: 'Recipient email (for send, draft actions)' },
      subject: { type: 'string', description: 'Email subject (for send, draft actions)' },
      body: { type: 'string', description: 'Email body text (for send, draft actions)' },
      cc: { type: 'string', description: 'CC recipients, comma-separated' },
      bcc: { type: 'string', description: 'BCC recipients, comma-separated' },
      replyToMessageId: { type: 'string', description: 'Message ID to reply to (creates threaded reply)' },
      threadId: { type: 'string', description: 'Thread ID (keeps in same thread)' },
    },
    required: ['action'],
  },

  async execute(action, params) {
    switch (action) {
      case 'search':  return searchMessages(params);
      case 'read':    return readMessage(params);
      case 'send':    return sendMessage(params);
      case 'unread':  return searchMessages({ ...params, query: 'is:unread' });
      case 'draft':   return createDraft(params);
      case 'mark_read': return markRead(params);
      case 'labels':  return listLabels();
      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  },
};

// Register with the plugin system
registerPlugin(gmailPlugin);

// ─── Helpers ────────────────────────────────────────────────────────

async function gmailFetch(path, options = {}) {
  const token = await auth.getAccessToken();
  const res = await fetch(`${GMAIL_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail API ${res.status}: ${text}`);
  }

  return res.json();
}

function getHeader(headers, name) {
  const h = headers?.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

/**
 * Walk MIME tree to find text body.
 * Prefers text/plain, falls back to stripped text/html.
 */
function extractBody(payload) {
  // Simple single-part message
  if (payload.body?.data && payload.mimeType === 'text/plain') {
    return base64urlDecode(payload.body.data);
  }

  // Multipart — recurse
  if (payload.parts) {
    // First pass: look for text/plain
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return base64urlDecode(part.body.data);
      }
    }
    // Second pass: look for text/html and strip tags
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return stripHtml(base64urlDecode(part.body.data));
      }
    }
    // Recurse into nested multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const found = extractBody(part);
        if (found) return found;
      }
    }
  }

  // Fallback: single-part HTML
  if (payload.body?.data && payload.mimeType === 'text/html') {
    return stripHtml(base64urlDecode(payload.body.data));
  }

  return '';
}

function extractAttachments(payload) {
  const attachments = [];

  function walk(parts) {
    if (!parts) return;
    for (const part of parts) {
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

  walk(payload.parts);
  return attachments;
}

function base64urlDecode(data) {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function base64urlEncode(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Build RFC 2822 message string.
 */
function buildRfc2822({ to, from, subject, body, cc, bcc, inReplyTo, references }) {
  const lines = [];
  lines.push(`To: ${to}`);
  if (from) lines.push(`From: ${from}`);
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(`Subject: ${subject || '(no subject)'}`);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
    lines.push(`References: ${references || inReplyTo}`);
  }
  lines.push('');
  lines.push(body || '');
  return lines.join('\r\n');
}

// ─── Actions ────────────────────────────────────────────────────────

async function searchMessages(params) {
  const { query, maxResults = 10 } = params;

  if (!query) {
    return { success: false, error: "Missing 'query' parameter. Example: query: 'from:someone@example.com'" };
  }

  const qs = new URLSearchParams({ q: query, maxResults: String(maxResults) });
  const data = await gmailFetch(`/messages?${qs}`);

  if (!data.messages?.length) {
    return { success: true, data: [] };
  }

  // Batch-fetch metadata for each message
  const messages = await Promise.all(
    data.messages.map(async ({ id }) => {
      const msg = await gmailFetch(`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
      return {
        id: msg.id,
        threadId: msg.threadId,
        from: getHeader(msg.payload?.headers, 'From'),
        to: getHeader(msg.payload?.headers, 'To'),
        subject: getHeader(msg.payload?.headers, 'Subject'),
        date: getHeader(msg.payload?.headers, 'Date'),
        snippet: msg.snippet,
        labelIds: msg.labelIds,
      };
    })
  );

  return { success: true, data: messages };
}

async function readMessage(params) {
  const { messageId } = params;

  if (!messageId) {
    return { success: false, error: "Missing 'messageId' parameter. Use search or unread to find message IDs first." };
  }

  const msg = await gmailFetch(`/messages/${messageId}?format=full`);
  const headers = msg.payload?.headers || [];

  return {
    success: true,
    data: {
      id: msg.id,
      threadId: msg.threadId,
      from: getHeader(headers, 'From'),
      to: getHeader(headers, 'To'),
      cc: getHeader(headers, 'Cc'),
      subject: getHeader(headers, 'Subject'),
      date: getHeader(headers, 'Date'),
      messageIdHeader: getHeader(headers, 'Message-ID'),
      body: extractBody(msg.payload),
      labels: msg.labelIds,
      attachments: extractAttachments(msg.payload),
    },
  };
}

async function sendMessage(params) {
  const { to, subject, body, cc, bcc, replyToMessageId, threadId } = params;

  if (!to) {
    return { success: false, error: "Missing 'to' parameter. Provide a recipient email address." };
  }
  if (!body) {
    return { success: false, error: "Missing 'body' parameter. Provide the email body text." };
  }

  const messageOpts = { to, subject, body, cc, bcc };

  // If replying, fetch original message for threading headers
  if (replyToMessageId) {
    const original = await gmailFetch(`/messages/${replyToMessageId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`);
    const origHeaders = original.payload?.headers || [];
    const origMessageId = getHeader(origHeaders, 'Message-ID');
    const origReferences = getHeader(origHeaders, 'References');

    messageOpts.inReplyTo = origMessageId;
    messageOpts.references = origReferences
      ? `${origReferences} ${origMessageId}`
      : origMessageId;

    // Use original subject with Re: if no subject provided
    if (!subject) {
      const origSubject = getHeader(origHeaders, 'Subject');
      messageOpts.subject = origSubject.startsWith('Re:') ? origSubject : `Re: ${origSubject}`;
    }
  }

  const raw = base64urlEncode(buildRfc2822(messageOpts));
  const payload = { raw };
  if (threadId || replyToMessageId) {
    // Use provided threadId, or fetch from original message
    if (threadId) {
      payload.threadId = threadId;
    } else if (replyToMessageId) {
      const orig = await gmailFetch(`/messages/${replyToMessageId}?format=minimal`);
      payload.threadId = orig.threadId;
    }
  }

  const token = await auth.getAccessToken();
  const res = await fetch(`${GMAIL_API}/messages/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail send failed (${res.status}): ${text}`);
  }

  const result = await res.json();
  return {
    success: true,
    data: { id: result.id, threadId: result.threadId },
  };
}

async function createDraft(params) {
  const { to, subject, body, cc, bcc } = params;

  if (!to) {
    return { success: false, error: "Missing 'to' parameter. Provide a recipient email address." };
  }
  if (!body) {
    return { success: false, error: "Missing 'body' parameter. Provide the email body text." };
  }

  const raw = base64urlEncode(buildRfc2822({ to, subject, body, cc, bcc }));

  const token = await auth.getAccessToken();
  const res = await fetch(`${GMAIL_API}/drafts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: { raw } }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail draft failed (${res.status}): ${text}`);
  }

  const result = await res.json();
  return {
    success: true,
    data: { draftId: result.id, messageId: result.message?.id },
  };
}

async function markRead(params) {
  const { messageId } = params;

  if (!messageId) {
    return { success: false, error: "Missing 'messageId' parameter." };
  }

  const token = await auth.getAccessToken();
  const res = await fetch(`${GMAIL_API}/messages/${messageId}/modify`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail mark_read failed (${res.status}): ${text}`);
  }

  return { success: true, data: { messageId } };
}

async function listLabels() {
  const data = await gmailFetch('/labels');
  const labels = (data.labels || []).map(l => ({
    id: l.id,
    name: l.name,
    type: l.type,
  }));
  return { success: true, data: labels };
}
