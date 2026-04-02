/**
 * Google Drive ServicePlugin
 *
 * Actions: list, read, upload, mkdir, share, search
 *
 * Uses raw fetch() to Drive API v3. No googleapis dependency.
 * Auth handled by google-auth.js (OAuth or Service Account).
 */

import { createGoogleAuth } from './google-auth.js';
import { registerPlugin } from './service-plugin.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const MAX_BINARY_SIZE = 1_048_576; // 1MB — truncate binary file reads

const auth = createGoogleAuth();

// Google Docs MIME types → export formats
const EXPORT_MAP = {
  'application/vnd.google-apps.document': { mimeType: 'text/plain', ext: 'txt' },
  'application/vnd.google-apps.spreadsheet': { mimeType: 'text/csv', ext: 'csv' },
  'application/vnd.google-apps.presentation': { mimeType: 'text/plain', ext: 'txt' },
  'application/vnd.google-apps.drawing': { mimeType: 'image/png', ext: 'png' },
};

// ─── ServicePlugin contract ─────────────────────────────────────────

export const drivePlugin = {
  id: 'drive',
  name: 'Google Drive',
  actions: ['list', 'read', 'upload', 'mkdir', 'share', 'search'],

  isConfigured() {
    return auth.isConfigured();
  },

  toolSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'read', 'upload', 'mkdir', 'share', 'search'] },
      fileId: { type: 'string', description: 'File ID (for read, share actions)' },
      folderId: { type: 'string', description: 'Folder ID (for list, upload). Default: root' },
      query: { type: 'string', description: 'Search query (for search, list filter)' },
      maxResults: { type: 'number', description: 'Max results (default 20)' },
      filename: { type: 'string', description: 'Filename (for upload)' },
      content: { type: 'string', description: 'File content as text or base64 (for upload)' },
      mimeType: { type: 'string', description: 'MIME type (for upload)' },
      name: { type: 'string', description: 'Folder name (for mkdir)' },
      parentId: { type: 'string', description: 'Parent folder ID (for mkdir). Default: root' },
      email: { type: 'string', description: 'Email to share with (for share)' },
      role: { type: 'string', enum: ['reader', 'writer', 'commenter'], description: 'Share role (default: reader)' },
    },
    required: ['action'],
  },

  async execute(action, params) {
    switch (action) {
      case 'list':   return listFiles(params);
      case 'read':   return readFile(params);
      case 'upload': return uploadFile(params);
      case 'mkdir':  return createFolder(params);
      case 'share':  return shareFile(params);
      case 'search': return searchFiles(params);
      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  },
};

// Register with the plugin system
registerPlugin(drivePlugin);

// ─── Helpers ────────────────────────────────────────────────────────

async function driveFetch(path, options = {}) {
  const token = await auth.getAccessToken();
  const base = options._uploadApi ? UPLOAD_API : DRIVE_API;
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive API ${res.status}: ${text}`);
  }

  // Some endpoints return no content
  if (res.status === 204) return {};

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }

  return res;
}

function formatFile(f) {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size ? parseInt(f.size) : undefined,
    modifiedTime: f.modifiedTime,
    webViewLink: f.webViewLink,
    parents: f.parents,
  };
}

const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink,parents';

// ─── Actions ────────────────────────────────────────────────────────

async function listFiles(params) {
  const { folderId = 'root', query, maxResults = 20 } = params;

  let q = `'${folderId}' in parents and trashed = false`;
  if (query) {
    q += ` and name contains '${query.replace(/'/g, "\\'")}'`;
  }

  const qs = new URLSearchParams({
    q,
    pageSize: String(Math.min(maxResults, 100)),
    fields: `files(${FILE_FIELDS})`,
    orderBy: 'modifiedTime desc',
  });

  const data = await driveFetch(`/files?${qs}`);
  return { success: true, data: (data.files || []).map(formatFile) };
}

async function readFile(params) {
  const { fileId } = params;

  if (!fileId) {
    return { success: false, error: "Missing 'fileId' parameter. Use list or search to find file IDs first." };
  }

  // First get file metadata
  const qs = new URLSearchParams({ fields: FILE_FIELDS });
  const meta = await driveFetch(`/files/${fileId}?${qs}`);

  // Check if it's a Google Workspace document that needs exporting
  const exportInfo = EXPORT_MAP[meta.mimeType];

  if (exportInfo) {
    // Export Google Docs/Sheets/Slides
    const token = await auth.getAccessToken();
    const res = await fetch(`${DRIVE_API}/files/${fileId}/export?mimeType=${encodeURIComponent(exportInfo.mimeType)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Drive export failed (${res.status}): ${text}`);
    }

    const content = await res.text();
    return {
      success: true,
      data: {
        id: meta.id,
        name: meta.name,
        mimeType: exportInfo.mimeType,
        exportedFrom: meta.mimeType,
        content,
        size: content.length,
      },
    };
  }

  // Regular file — download content
  const token = await auth.getAccessToken();
  const res = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive download failed (${res.status}): ${text}`);
  }

  const isText = (meta.mimeType || '').startsWith('text/') ||
    ['application/json', 'application/xml', 'application/javascript', 'application/csv'].includes(meta.mimeType);

  if (isText) {
    const content = await res.text();
    return {
      success: true,
      data: {
        id: meta.id,
        name: meta.name,
        mimeType: meta.mimeType,
        content,
        size: content.length,
      },
    };
  }

  // Binary file — return as base64, truncated
  const buffer = Buffer.from(await res.arrayBuffer());
  const truncated = buffer.length > MAX_BINARY_SIZE;
  const slice = truncated ? buffer.subarray(0, MAX_BINARY_SIZE) : buffer;

  return {
    success: true,
    data: {
      id: meta.id,
      name: meta.name,
      mimeType: meta.mimeType,
      content: slice.toString('base64'),
      encoding: 'base64',
      size: buffer.length,
      truncated,
    },
  };
}

async function uploadFile(params) {
  const { filename, content, mimeType = 'text/plain', folderId = 'root' } = params;

  if (!filename) {
    return { success: false, error: "Missing 'filename' parameter." };
  }
  if (!content) {
    return { success: false, error: "Missing 'content' parameter. Provide file content as text or base64." };
  }

  const metadata = {
    name: filename,
    parents: [folderId],
  };

  // Detect if content is base64 encoded
  const isBase64 = /^[A-Za-z0-9+/]+=*$/.test(content) && content.length > 100;
  const fileContent = isBase64 ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf-8');

  // Multipart upload: metadata + content
  const boundary = '------mycelium_upload_boundary';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) + '\r\n' +
      `--${boundary}\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
    ),
    fileContent,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const token = await auth.getAccessToken();
  const res = await fetch(`${UPLOAD_API}/files?uploadType=multipart&fields=${FILE_FIELDS}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive upload failed (${res.status}): ${text}`);
  }

  const result = await res.json();
  return { success: true, data: formatFile(result) };
}

async function createFolder(params) {
  const { name, parentId = 'root' } = params;

  if (!name) {
    return { success: false, error: "Missing 'name' parameter. Provide a folder name." };
  }

  const token = await auth.getAccessToken();
  const res = await fetch(`${DRIVE_API}/files?fields=${FILE_FIELDS}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive mkdir failed (${res.status}): ${text}`);
  }

  const result = await res.json();
  return { success: true, data: formatFile(result) };
}

async function shareFile(params) {
  const { fileId, email, role = 'reader' } = params;

  if (!fileId) {
    return { success: false, error: "Missing 'fileId' parameter." };
  }
  if (!email) {
    return { success: false, error: "Missing 'email' parameter. Provide the email to share with." };
  }

  const token = await auth.getAccessToken();
  const res = await fetch(`${DRIVE_API}/files/${fileId}/permissions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'user',
      role,
      emailAddress: email,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive share failed (${res.status}): ${text}`);
  }

  return { success: true, data: { fileId, sharedWith: email, role } };
}

async function searchFiles(params) {
  const { query, maxResults = 20 } = params;

  if (!query) {
    return { success: false, error: "Missing 'query' parameter. Example: query: 'budget report'" };
  }

  const q = `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`;
  const qs = new URLSearchParams({
    q,
    pageSize: String(Math.min(maxResults, 100)),
    fields: `files(${FILE_FIELDS})`,
    orderBy: 'modifiedTime desc',
  });

  const data = await driveFetch(`/files?${qs}`);
  return { success: true, data: (data.files || []).map(formatFile) };
}
