#!/usr/bin/env node
/**
 * MYA MCP Tools Server
 *
 * Exposes agent tools to Claude Code CLI via Model Context Protocol.
 * Each user gets their own instance with USER_ID scoping.
 *
 * Tools (17):
 *   Documents:  updateDocument, getDocument, editDocumentContent, createDocument, listDocuments
 *   Messages:   getDailyMessages (paginated chronological review)
 *   Search:     searchMindscape (unified: messages, documents, territories, realms, themes)
 *   Tasks:      createTask
 *   Organize:   listFolders, listCanvases
 *   Internal:   updateInternalModel, flagForDiscussion
 *   Topology:   exploreTerritory, mindscapeStructure
 *   Agents:     delegate_to_agent
 *   Services:   gmail, drive
 *
 * Config (env vars):
 *   USER_ID                    — User UUID (required)
 *   MYA_WORKER_URL             — MYA Cloudflare Worker (required — D1/Vectorize proxy)
 *   MYA_WORKER_SECRET          — Shared auth secret (required)
 *   AGENT_URL                  — Local agent-server URL for delegation (set by agent-server.js)
 *   ORCHESTRATOR_URL           — Orchestrator URL (default: http://localhost:3000)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';
import { generateEmbedding } from '../lib/embed.js';
import { initDb, getDb } from '../lib/db.js';
import { dispatchServiceCall } from '../lib/services/service-plugin.js';
import '../lib/services/gmail-plugin.js';
import '../lib/services/drive-plugin.js';
import '../lib/services/calendar-plugin.js';

// ── Config ──────────────────────────────────────────────────────────────────

const USER_ID = process.env.USER_ID;
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://localhost:3000';
const AGENT_URL = process.env.AGENT_URL; // Local agent-server (e.g., http://localhost:5006)
const AGENT_ROOT = process.env.AGENT_ROOT; // e.g., ~/agents/personal-agent
const MCP_AGENT_ID = process.env.AGENT_ID || (AGENT_ROOT ? path.basename(AGENT_ROOT) : 'unknown-agent');
const MEMORY_SCOPE = process.env.MEMORY_SCOPE || 'all'; // 'all' = personal agent, 'company' = company agent

if (!USER_ID) {
  console.error('Missing required env var: USER_ID');
  process.exit(1);
}

// Initialize database (called before server starts)
let db = null;

// ── Local Mind Files ───────────────────────────────────────────────────────
// Internal model and flagged items live in local files (git-backed) rather
// than Supabase. This keeps them close to the agent, fast, and compactable.

function getMindDir() {
  if (!AGENT_ROOT) return null;
  return path.join(AGENT_ROOT, 'mind');
}

async function ensureMindDir() {
  const dir = getMindDir();
  if (dir) await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function readMindFile(filename) {
  const dir = getMindDir();
  if (!dir) return null;
  try {
    return await fs.readFile(path.join(dir, filename), 'utf-8');
  } catch {
    return null;
  }
}

async function writeMindFile(filename, content) {
  const dir = await ensureMindDir();
  if (!dir) throw new Error('AGENT_ROOT not configured — cannot write mind files');
  await fs.writeFile(path.join(dir, filename), content, 'utf-8');
}

// ── Embedding: uses lib/embed.js (BGE-M3 via MYA Worker) ──────────────────

// ── Database Helpers ────────────────────────────────────────────────────────

async function getDocument(docPath) {
  return db.documents.get(USER_ID, docPath);
}

async function upsertDocument(doc) {
  return db.documents.upsert({ user_id: USER_ID, created_by: doc.created_by || MCP_AGENT_ID, ...doc });
}

async function getAllDocumentSummaries(category) {
  return db.documents.list(USER_ID, { category });
}

// ── Agent Labels (shared by search, getDailyMessages, getTeamStatus) ────────

const AGENT_LABELS = {
  'personal-agent': 'Mya', 'research-agent': 'Ada', 'company-agent': 'Com',
  'commercial-intelligence-agent': 'Rex', 'publishing-agent': 'Noa', 'qa-agent': 'QA',
};

// Company agents only (excludes personal-agent) — used by getTeamStatus
const COMPANY_TEAM = {
  'research-agent':                { name: 'Ada', port: 5002, role: 'Research & Analysis' },
  'commercial-intelligence-agent': { name: 'Rex', port: 5004, role: 'Commercial Intelligence' },
  'publishing-agent':              { name: 'Noa', port: 5006, role: 'Publishing & Content' },
  'qa-agent':                      { name: 'QA',  port: 5008, role: 'Testing & QA' },
};

// ── Search Helpers (shared by searchMindscape) ─────────────────────────────

const isScoped = () => MEMORY_SCOPE === 'company';

async function searchMessages(embedding, limit, agentId) {
  // Over-fetch when filtering (agent or scope) to ensure enough results after post-filtering
  const fetchLimit = (isScoped() || agentId) ? limit * 3 : limit;
  const data = await db.messages.matchMessages(
    embedding, USER_ID, fetchLimit,
  );
  if (!data?.length) return [];

  let messages = data;
  if (agentId) {
    messages = messages.filter(m => m.agent_id === agentId);
  }
  if (isScoped()) {
    messages = messages.filter(m => {
      // Company scope: exclude personal agent messages and personal channels
      if (m.agent_id === 'personal-agent' || m.agent_id === 'mya-personal') return false;
      const source = m.source || m.channel_id || '';
      return !source.startsWith('telegram_') && !source.startsWith('portal_');
    });
  }
  return messages.slice(0, limit).map(m => {
    const date = m.created_at ? new Date(m.created_at).toLocaleDateString() : '';
    const tags = m.tags?.length ? ` [${m.tags.join(', ')}]` : '';
    const src = m.source || m.channel_id ? ` (${m.source || m.channel_id})` : '';
    const agentLabel = m.agent_id ? ` [${AGENT_LABELS[m.agent_id] || m.agent_id}]` : '';
    return `[${date}]${tags}${src}${agentLabel} ${m.role}: ${(m.content || '').slice(0, 300)}`;
  });
}

async function searchDocuments(embedding, limit, scope) {
  const allowInternal = isScoped() ? false : (scope === 'dreams' || scope === 'states');
  const data = await db.messages.matchDocuments(embedding, USER_ID, limit, allowInternal);
  if (!data?.length) return [];

  let filtered = data;
  if (scope === 'dreams') {
    filtered = data.filter(d => d.path?.startsWith('states/dreams'));
  } else if (scope === 'states') {
    filtered = data.filter(d => d.path?.startsWith('states/'));
  }
  if (isScoped()) {
    filtered = filtered.filter(d => {
      const p = d.path || '';
      return !p.startsWith('states/') && !p.startsWith('internal/') && !p.startsWith('personal/');
    });
  }
  return filtered.map(d => `[doc] **${d.path}**: ${d.summary || d.title}`);
}

async function searchTerritories(embedding, limit) {
  const data = await db.search.matchTerritories(embedding, USER_ID, limit);
  if (!data?.length) return { formatted: [], raw: data || [] };
  return {
    formatted: data.map(t =>
      `**${t.name}** (ID: ${t.territory_id}, realm: ${t.realm_id || '?'})${t.essence ? `\n${t.essence}` : ''}\n*${t.message_count || 0} messages, similarity: ${Math.round((t.similarity || 0) * 100)}%*`
    ),
    raw: data,
  };
}

async function searchRealms(embedding, limit) {
  const data = await db.search.matchRealms(embedding, USER_ID, limit);
  if (!data?.length) return [];
  return data.map(r =>
    `**${r.name}** (ID: ${r.realm_id})${r.essence ? `\n${r.essence}` : ''}\n*${r.territory_count || 0} territories, ${r.message_count || 0} messages*`
  );
}

async function searchThemes(embedding, limit) {
  const data = await db.search.matchThemes(embedding, USER_ID, limit);
  if (!data?.length) return [];
  return data.map(t =>
    `**${t.name}** (realm: ${t.realm_id})${t.essence ? `\n${t.essence}` : ''}\n*${t.territory_count || 0} territories, ${t.message_count || 0} messages*`
  );
}

// ── Topology Helpers (shared by exploreTerritory / mindscapeStructure) ─────

async function resolveTerritoryId(nameOrId) {
  // If it's already a number, use directly
  if (typeof nameOrId === 'number') return { id: nameOrId, name: null };
  const asNum = Number(nameOrId);
  if (!isNaN(asNum) && String(asNum) === String(nameOrId)) return { id: asNum, name: null };

  // Try name match via SQL — prioritize territories with active clustering points
  try {
    const results = await db.rawQuery?.(
      `SELECT tp.territory_id, tp.name, COUNT(cp.id) as pts
       FROM territory_profiles tp
       LEFT JOIN clustering_points cp ON cp.territory_id = tp.territory_id AND cp.user_id = tp.user_id
       WHERE tp.user_id = ? AND LOWER(tp.name) LIKE LOWER(?)
       GROUP BY tp.territory_id
       ORDER BY pts DESC LIMIT 1`,
      [USER_ID, `%${nameOrId}%`],
    );
    if (results?.length) return { id: results[0].territory_id, name: results[0].name };
  } catch { /* rawQuery may not exist */ }

  // Fallback: exact name match without point check
  try {
    const results = await db.search.lookupTerritoryByName?.(USER_ID, nameOrId);
    if (results?.length) return { id: results[0].territory_id, name: results[0].name };
  } catch { /* method may not exist in all backends */ }

  // Last resort: semantic search and take top result
  const embedding = await generateEmbedding(nameOrId);
  const data = await db.search.matchTerritories(embedding, USER_ID, 1);
  if (data?.length) return { id: data[0].territory_id, name: data[0].name };

  return { id: null, name: null };
}

async function fetchCoFiring(territoryId, opts = {}) {
  return db.topology.getCoFiring({
    p_user_id: USER_ID,
    p_territory_id: territoryId,
    p_scale: opts.scale || 'daily',
    p_min_strength: opts.min_strength || 2.0,
    p_limit: opts.limit || 10,
  });
}

async function fetchGaps(territoryId, opts = {}) {
  return db.topology.getGaps({
    p_user_id: USER_ID,
    p_territory_id: territoryId,
    p_min_similarity: opts.min_similarity || 0.7,
    p_max_cofire: opts.max_cofire || 0.5,
    p_scale: opts.scale || 'weekly',
    p_limit: opts.limit || 10,
  });
}

async function fetchCluster(territoryId, opts = {}) {
  return db.topology.getCluster({
    p_user_id: USER_ID,
    p_territory_id: territoryId,
    p_depth: opts.depth || 2,
    p_min_strength: opts.min_strength || 0.3,
    p_scale: opts.scale || 'session',
  });
}

async function fetchOrphans(opts = {}) {
  return db.topology.getOrphans({
    p_user_id: USER_ID,
    p_min_messages: opts.min_messages || 50,
    p_max_connections: opts.max_connections || 3,
    p_scale: opts.scale || 'weekly',
    p_limit: opts.limit || 10,
  });
}

async function fetchBridges(opts = {}) {
  return db.topology.getBridges({
    p_user_id: USER_ID,
    p_min_connections: opts.min_connections || 5,
    p_scale: opts.scale || 'weekly',
    p_limit: opts.limit || 10,
  });
}

function formatCoFiring(data) {
  if (!data?.length) return null;
  const maxS = Math.max(...data.map(t => t.cofire_strength || 0));
  return data.map(t => {
    const rel = maxS > 0 ? Math.round((t.cofire_strength / maxS) * 100) : 0;
    return `**${t.name}** (ID: ${t.territory_id}) — strength: ${rel}%${t.semantic_similarity ? `, semantic: ${Math.round(t.semantic_similarity * 100)}%` : ''}\n*${t.message_count} messages*`;
  }).join('\n\n');
}

function formatGaps(data) {
  if (!data?.length) return null;
  return data.map(t =>
    `**${t.name}** (ID: ${t.territory_id})\nSemantic: ${Math.round(t.semantic_similarity * 100)}%, Cofire: ${Math.round(t.cofire_strength * 100)}%, Gap: ${t.gap_score.toFixed(2)}\n*${t.message_count} messages*`
  ).join('\n\n');
}

function formatCluster(data) {
  if (!data?.length) return null;
  const maxS = Math.max(...data.map(t => t.path_strength || 0));
  return data.map(t => {
    const rel = maxS > 0 ? Math.round((t.path_strength / maxS) * 100) : 0;
    return `${'  '.repeat(t.depth - 1)}↳ **${t.name}** (depth ${t.depth}, strength: ${rel}%)`;
  }).join('\n');
}

function formatOrphans(data) {
  if (!data?.length) return null;
  return data.map(t =>
    `**${t.name}** (ID: ${t.territory_id})\n*${t.message_count} messages, ${t.connection_count} connections*${t.essence ? `\n${t.essence}` : ''}`
  ).join('\n\n');
}

function formatBridges(data) {
  if (!data?.length) return null;
  return data.map(t =>
    `**${t.name}** (ID: ${t.territory_id})\n*Connects ${t.connected_realms} realms, ${t.connection_count} connections*`
  ).join('\n\n');
}

// ── Tool Definitions ────────────────────────────────────────────────────────

const TOOLS = [
  // ── Documents ──
  {
    name: 'updateDocument',
    description: 'Update a living document with new observations. Use provisional language.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: "Document path (e.g., 'states/mental', 'business/mya')" },
        entry: { type: 'string', description: 'The observation to add (timestamped, provisional language)' },
        entryType: { type: 'string', enum: ['observation', 'shift', 'note', 'wondering'], description: 'Type of entry' },
        confidence: { type: 'string', enum: ['low', 'medium', 'provisional'], description: 'Confidence level' },
      },
      required: ['path', 'entry', 'entryType', 'confidence'],
    },
  },
  {
    name: 'getDocument',
    description: 'Retrieve full document content by path. Works for any library document — mindscape docs, transcriptions, notes, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Document path to retrieve' },
      },
      required: ['path'],
    },
  },
  {
    name: 'createDocument',
    description: 'Create a new document to track a person, project, concept, or anything worth remembering.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: "Document path (e.g., 'people/sarah', 'business/project-x')" },
        title: { type: 'string', description: 'Human-readable title' },
        initialContent: { type: 'string', description: 'Initial markdown content' },
        folder: { type: 'string', description: 'Optional folder name (defaults to Inbox)' },
        canvas: { type: 'string', description: 'Optional canvas to add document to' },
      },
      required: ['path', 'title', 'initialContent'],
    },
  },
  {
    name: 'editDocumentContent',
    description: 'Replace the full content of an existing document. Use this when you need to rewrite, restructure, or make specific edits to a document (as opposed to updateDocument which appends observation entries). Retrieve the document first with getDocument, make your changes, then save back.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Document path to edit' },
        content: { type: 'string', description: 'The new full content (replaces existing content entirely)' },
        title: { type: 'string', description: 'Optional new title (keeps existing title if omitted)' },
        summary: { type: 'string', description: 'Optional new summary (auto-generated from content if omitted)' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'listDocuments',
    description: 'List all available documents with their paths and summaries.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: "Optional filter (e.g., 'people', 'business', 'states')" },
      },
    },
  },

  // ── Daily Messages (paginated chronological review) ──
  {
    name: 'getDailyMessages',
    description: 'Page through messages for a specific day in chronological order. Returns 30 messages per page. Use this to systematically review what happened — who said what, on which channel, in what order. Call with increasing page numbers to read through the full day. The response includes total count and remaining pages.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date to review (YYYY-MM-DD). Defaults to today.' },
        page: { type: 'number', description: 'Page number (1-based). Default: 1' },
        channel: { type: 'string', description: 'Optional: filter by channel prefix (discord, telegram, portal)' },
        agent: { type: 'string', description: 'Optional: filter by agent ID (e.g., research-agent, company-agent)' },
      },
    },
  },

  // ── Search (unified) ──
  {
    name: 'searchMindscape',
    description: 'Search across the entire mindscape: conversations, documents, territories, realms, and themes — all in one call. Uses a single embedding to query all layers in parallel. Returns results grouped by type.\n\nScopes:\n- "all" (default): search everything\n- "messages": past conversations only\n- "documents": documents only\n- "territories": most specific mindscape level\n- "realms": highest mindscape level\n- "themes": mid-level themes\n\nWith includeTopology: true, matched territories also show their co-firing neighbors.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for — concept, topic, question, or memory' },
        scope: {
          type: 'string',
          enum: ['all', 'messages', 'documents', 'territories', 'realms', 'themes'],
          description: 'What to search (default: all)',
        },
        limit: { type: 'number', description: 'Max results per type (default 5)' },
        includeTopology: { type: 'boolean', description: 'Attach co-firing neighbors for matched territories (default false)' },
        agent: { type: 'string', description: 'Optional: filter message results by agent ID (e.g., research-agent, company-agent). Only applies to message scope.' },
      },
      required: ['query'],
    },
  },

  // ── Tasks ──
  {
    name: 'createTask',
    description: 'Create a task captured from conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'What needs to be done' },
        deadline: { type: 'string', description: 'Optional deadline (ISO date)' },
        priority: { type: 'number', description: 'Priority 1-5 (default 3)' },
        projectPath: { type: 'string', description: 'Related project document path' },
      },
      required: ['content'],
    },
  },

  // ── Organization ──
  {
    name: 'listFolders',
    description: 'List all available folders.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'listCanvases',
    description: 'List all available canvases (workspaces).',
    inputSchema: { type: 'object', properties: {} },
  },

  // ── Internal Model ──
  {
    name: 'updateInternalModel',
    description: 'Update your private model (never shown to user). Your space for hypotheses, observations, questions.',
    inputSchema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['observations', 'hypotheses', 'questions', 'contradictions', 'patterns', 'uncertainty', 'notes', 'dream_fragments'],
          description: 'Section to update',
        },
        content: { type: 'string', description: 'Your private observation or question' },
      },
      required: ['section', 'content'],
    },
  },
  {
    name: 'flagForDiscussion',
    description: 'Flag something to bring up in next conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'What you want to discuss' },
        context: { type: 'string', description: 'Why this seems worth exploring' },
      },
      required: ['topic', 'context'],
    },
  },

  // ── Topology ──
  {
    name: 'exploreTerritory',
    description: 'Explore a territory\'s neighborhood in the co-firing graph. Accepts a territory name (string) or ID (number) — names are auto-resolved.\n\nReturns the territory\'s co-firing partners (what gets discussed alongside it), gaps (high semantic similarity but low co-firing — unexplored connections), and optionally a deeper cluster walk.\n\nThis replaces getCoFiring, getGaps, and getCluster with a single, richer call.',
    inputSchema: {
      type: 'object',
      properties: {
        territory: {
          description: 'Territory name (e.g., "inner development") or numeric ID. Names are fuzzy-matched.',
        },
        includeCoFiring: { type: 'boolean', description: 'Show co-firing partners (default true)' },
        includeGaps: { type: 'boolean', description: 'Show unexplored connections (default true)' },
        depth: { type: 'number', description: 'Cluster walk depth. 1 = immediate neighbors only (default). 2+ = deeper graph walk.' },
        scale: { type: 'string', enum: ['immediate', 'session', 'daily', 'weekly'], description: 'Temporal scale for co-firing (default: session)' },
      },
      required: ['territory'],
    },
  },
  {
    name: 'mindscapeStructure',
    description: 'Get a structural overview of the mindscape: orphan territories (high content, low connectivity) and bridge territories (connecting different realms). Useful for understanding the overall topology without starting from a specific territory.\n\nThis replaces getOrphans and getBridges with a single call.',
    inputSchema: {
      type: 'object',
      properties: {
        orphans: { type: 'boolean', description: 'Include orphan territories (default true)' },
        bridges: { type: 'boolean', description: 'Include bridge territories (default true)' },
        scale: { type: 'string', enum: ['immediate', 'session', 'daily', 'weekly'], description: 'Temporal scale (default: weekly)' },
      },
    },
  },

  // ── Multi-Agent ──
  {
    name: 'delegate_to_agent',
    description: 'Delegate a task to another agent. Delegation is async — they work independently and report back.\n\nAgents:\n- research-agent (Ada): Deep research, analysis, web search, literature review\n- commercial-intelligence-agent (Rex): Market analysis, competitor intel, pricing, revenue\n- publishing-agent (Noa): Writing, editing, content creation, publishing\n\nWrite self-contained task descriptions. The receiving agent has NO access to your conversation — they only see what you send in task + context.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          enum: ['research-agent', 'commercial-intelligence-agent', 'publishing-agent'],
          description: 'Target agent ID',
        },
        task: {
          type: 'string',
          description: 'Specific, actionable instructions. Include: what to do, what format to return results in, and any constraints. Bad: "look into competitors". Good: "Research pricing tiers for Notion, Coda, and Obsidian team plans. Return a comparison table with monthly/annual pricing and key differentiators."',
        },
        context: { type: 'string', description: 'Background the agent needs to do the work. Only include what is relevant — not your full conversation.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Priority level. Use high only when a human is actively waiting. Default: normal.' },
      },
      required: ['agent', 'task'],
    },
  },

  // ── Team Visibility ──
  {
    name: 'getTeamStatus',
    description: 'Get a consolidated status dashboard of all company agents (Ada, Rex, Noa, QA). Shows online/offline status, current model, active tasks, messages today, and last message snippet for each agent. Use this as your first step in any operations cycle to understand team state at a glance.',
    inputSchema: {
      type: 'object',
      properties: {
        includeLastMessage: { type: 'boolean', description: 'Include last message snippet for each agent (default: true)' },
      },
    },
  },

  // ── Google Services ──
  {
    name: 'gmail',
    description: 'Read, search, and send emails via Gmail. Actions: search (search inbox), read (full email content), send (compose/reply), unread (check unread), draft (save draft), mark_read (mark as read), labels (list labels).',
    inputSchema: {
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
  },
  {
    name: 'drive',
    description: 'Access Google Drive files. Actions: list (files in folder), read (file content — exports Google Docs as text), upload (upload file), mkdir (create folder), share (share with someone), search (search across Drive).',
    inputSchema: {
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
  },
  {
    name: 'calendar',
    description: 'Manage Google Calendar events. Actions: list (upcoming events), get (event details), create (new event), update (modify event), delete (remove event), search (find events by keyword), calendars (list available calendars).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete', 'search', 'calendars'] },
        calendarId: { type: 'string', description: 'Calendar ID (default: "primary")' },
        eventId: { type: 'string', description: 'Event ID (for get, update, delete)' },
        query: { type: 'string', description: 'Search query (for search action)' },
        summary: { type: 'string', description: 'Event title (for create, update)' },
        description: { type: 'string', description: 'Event description' },
        location: { type: 'string', description: 'Event location' },
        startTime: { type: 'string', description: 'Start time ISO 8601 (e.g. 2026-04-05T10:00:00+03:00)' },
        endTime: { type: 'string', description: 'End time ISO 8601' },
        allDay: { type: 'boolean', description: 'All-day event (use date not dateTime)' },
        timeMin: { type: 'string', description: 'Filter: events after this time' },
        timeMax: { type: 'string', description: 'Filter: events before this time' },
        maxResults: { type: 'number', description: 'Max results (default 10)' },
        attendees: { type: 'string', description: 'Comma-separated emails to invite' },
      },
      required: ['action'],
    },
  },
  // ── Health ──
  {
    name: 'getHealthData',
    description: 'Query Apple Health data (sleep, HRV, resting HR, steps, workouts, mindful minutes). Returns daily summaries with averages, trends, and anomalies. Use to answer questions about physical state, sleep quality, stress patterns, and body-mind correlations.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Number of days to look back (default 7, max 90)' },
        from: { type: 'string', description: 'Start date (YYYY-MM-DD). Overrides days.' },
        to: { type: 'string', description: 'End date (YYYY-MM-DD). Defaults to today.' },
      },
    },
  },
];

// ── Tool Handlers ───────────────────────────────────────────────────────────

async function handleTool(name, args) {
  switch (name) {
    // ── Documents ──

    case 'updateDocument': {
      const doc = await getDocument(args.path);
      const timestamp = new Date().toISOString().split('T')[0];
      const prefix = `[${timestamp}] [${args.entryType}] [${args.confidence}]`;
      const newEntry = `${prefix} ${args.entry}`;

      let finalContent;
      if (doc) {
        finalContent = doc.content + '\n\n' + newEntry;
        await upsertDocument({ path: args.path, title: doc.title, content: finalContent, summary: doc.summary });
      } else {
        finalContent = newEntry;
        await upsertDocument({
          path: args.path,
          title: args.path.split('/').pop(),
          content: finalContent,
          summary: `Created from ${args.entryType} entry`,
        });
      }

      // Mirror key documents to local mind files for context pre-loading
      const MIND_MIRRORS = {
        'states/dreams': 'dreams.md',
        'internal/reflection_log': 'reflections.md',
        'internal/topology_notes': 'topology-notes.md',
        'phenomena/synchronicities': 'synchronicities.md',
      };
      const mirrorFile = MIND_MIRRORS[args.path];
      if (mirrorFile) {
        try { await writeMindFile(mirrorFile, finalContent); } catch { /* non-fatal */ }
      }

      return doc
        ? `Updated ${args.path} with ${args.entryType} entry.`
        : `Created new document ${args.path} with ${args.entryType} entry.`;
    }

    case 'getDocument': {
      const doc = await getDocument(args.path);
      if (!doc) return `Document not found: ${args.path}`;
      return `# ${doc.title || args.path}\n\n${doc.content}`;
    }

    case 'editDocumentContent': {
      const doc = await getDocument(args.path);
      if (!doc) return `Document not found: ${args.path}. Use createDocument to create it first.`;

      const docData = {
        path: args.path,
        content: args.content,
        title: args.title || doc.title,
        summary: args.summary || args.content.slice(0, 200),
      };
      await upsertDocument(docData);

      // Mirror key documents to local mind files
      const MIND_MIRRORS = {
        'states/dreams': 'dreams.md',
        'internal/reflection_log': 'reflections.md',
        'internal/topology_notes': 'topology-notes.md',
        'phenomena/synchronicities': 'synchronicities.md',
      };
      const mirrorFile = MIND_MIRRORS[args.path];
      if (mirrorFile) {
        try { await writeMindFile(mirrorFile, args.content); } catch { /* non-fatal */ }
      }

      return `Updated content of ${args.path}${args.title ? ` (title: ${args.title})` : ''}.`;
    }

    case 'createDocument': {
      const existing = await getDocument(args.path);
      if (existing) return `Document already exists at ${args.path}. Use updateDocument to modify.`;

      const docData = {
        path: args.path,
        title: args.title,
        content: args.initialContent,
        summary: args.initialContent.slice(0, 200),
      };
      if (args.folder) docData.folder = args.folder;

      await upsertDocument(docData);

      // Add to canvas if specified
      if (args.canvas) {
        try {
          await db.canvases.addDocument(USER_ID, args.canvas, args.path);
        } catch { /* canvas assignment is optional */ }
      }

      return `Created document: ${args.path} (${args.title})${args.folder ? ` in folder ${args.folder}` : ''}${args.canvas ? ` on canvas ${args.canvas}` : ''}`;
    }

    case 'listDocuments': {
      const docs = await getAllDocumentSummaries(args.category);
      if (docs.length === 0) return args.category ? `No documents in category: ${args.category}` : 'No documents found.';
      return docs.map(d => {
        const folder = d.folder ? ` (${d.folder})` : '';
        return `- **${d.path}**${folder}: ${d.summary || 'No summary'}`;
      }).join('\n');
    }

    // ── Daily Messages (paginated) ──

    case 'getDailyMessages': {
      const date = args.date || new Date().toISOString().split('T')[0];
      const page = Math.max(1, args.page || 1);
      const pageSize = 30;
      const offset = (page - 1) * pageSize;

      // Date range: midnight to midnight UTC
      const since = `${date}T00:00:00.000Z`;
      const nextDay = new Date(new Date(`${date}T00:00:00Z`).getTime() + 86400000);
      const until = nextDay.toISOString();

      const result = await db.messages.selectPaginated(USER_ID, {
        since, until, offset, limit: pageSize,
        channel: args.channel || undefined,
        agentId: args.agent || undefined,
        // Company-scoped agents see all agents except personal-agent
        excludeAgentId: (isScoped() && !args.agent) ? ['personal-agent', 'mya-personal'] : undefined,
      });

      if (result.total === 0) {
        return `No messages found for ${date}.` +
          (args.channel ? ` (filtered by channel: ${args.channel})` : '') +
          (args.agent ? ` (filtered by agent: ${args.agent})` : '');
      }

      const totalPages = Math.ceil(result.total / pageSize);
      const formatted = result.messages.map(m => {
        const time = m.created_at
          ? new Date(m.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
          : '??:??';
        const src = m.source || 'unknown';
        const label = m.role === 'user' ? 'Human' : (AGENT_LABELS[m.agent_id] || m.agent_id || 'Assistant');
        return `[${time}] (${src}) ${label}: ${m.content}`;
      }).join('\n\n');

      const remaining = result.total - offset - result.messages.length;
      let header = `# Messages for ${date} — Page ${page}/${totalPages} (${result.total} total)`;
      if (args.channel) header += `\nFiltered by channel: ${args.channel}`;
      if (args.agent) header += `\nFiltered by agent: ${args.agent}`;

      const footer = result.hasMore
        ? `\n\n--- ${remaining} more messages. Call getDailyMessages with page: ${page + 1} to continue.`
        : '\n\n--- End of messages for this day.';

      return `${header}\n\n${formatted}${footer}`;
    }

    // ── Unified Search ──

    case 'searchMindscape': {
      const embedding = await generateEmbedding(args.query);
      const limit = args.limit || 5;
      const scope = args.scope || 'all';
      const sections = [];

      // Determine which searches to run
      const searchAll = scope === 'all';
      const promises = {};

      if (searchAll || scope === 'messages') {
        promises.messages = searchMessages(embedding, limit, args.agent);
      }
      if (searchAll || scope === 'documents' || scope === 'messages') {
        // messages scope includes documents (like the old searchHistory)
        promises.documents = searchDocuments(embedding, limit, scope);
      }
      if (searchAll || scope === 'territories') {
        promises.territories = searchTerritories(embedding, limit);
      }
      if (searchAll || scope === 'realms') {
        promises.realms = searchRealms(embedding, limit);
      }
      if (searchAll || scope === 'themes') {
        promises.themes = searchThemes(embedding, limit);
      }

      // Run all searches in parallel
      const keys = Object.keys(promises);
      const results = await Promise.all(Object.values(promises));
      const resolved = {};
      keys.forEach((k, i) => { resolved[k] = results[i]; });

      // Build grouped output
      if (resolved.messages?.length) {
        sections.push(`## Messages (${resolved.messages.length})\n${resolved.messages.join('\n\n')}`);
      }
      if (resolved.documents?.length) {
        sections.push(`## Documents (${resolved.documents.length})\n${resolved.documents.join('\n')}`);
      }

      const territories = resolved.territories;
      if (territories?.formatted?.length) {
        sections.push(`## Territories (${territories.formatted.length})\n${territories.formatted.join('\n\n')}`);

        // If includeTopology, fetch co-firing for top matched territories
        if (args.includeTopology && territories.raw?.length) {
          const topIds = territories.raw.slice(0, 3);
          const topoResults = await Promise.all(
            topIds.map(t => fetchCoFiring(t.territory_id, { scale: 'session', limit: 5 })),
          );
          const topoSections = topIds.map((t, i) => {
            const formatted = formatCoFiring(topoResults[i]);
            return formatted ? `### Co-firing with "${t.name}"\n${formatted}` : null;
          }).filter(Boolean);
          if (topoSections.length) {
            sections.push(`## Topology Context\n${topoSections.join('\n\n')}`);
          }
        }
      }

      if (resolved.realms?.length) {
        sections.push(`## Realms (${resolved.realms.length})\n${resolved.realms.join('\n\n')}`);
      }
      if (resolved.themes?.length) {
        sections.push(`## Themes (${resolved.themes.length})\n${resolved.themes.join('\n\n')}`);
      }

      if (sections.length === 0) return `No results for: ${args.query}`;
      return sections.join('\n\n');
    }

    // ── Tasks ──

    case 'createTask': {
      await db.tasks.create({
        user_id: USER_ID,
        content: args.content,
        deadline: args.deadline || null,
        priority: args.priority || 3,
        project_path: args.projectPath || null,
        status: 'pending',
      });
      return `Task created: "${args.content}"${args.deadline ? ` (deadline: ${args.deadline})` : ''}`;
    }

    // ── Organization ──

    case 'listFolders': {
      const data = await db.folders.list(USER_ID);
      if (!data?.length) return 'No folders found.';
      return data.map(f => `- **${f.name}**${f.description ? `: ${f.description}` : ''} (${f.document_count || 0} docs)`).join('\n');
    }

    case 'listCanvases': {
      const data = await db.canvases.list(USER_ID);
      if (!data?.length) return 'No canvases found.';
      return data.map(c => `- **${c.name}**${c.description ? `: ${c.description}` : ''}`).join('\n');
    }

    // ── Internal Model ──

    case 'updateInternalModel': {
      const timestamp = new Date().toISOString().split('T')[0];
      const newEntry = `- [${timestamp}] ${args.content}`;

      // Section header mapping
      const sectionHeaders = {
        observations: '## Observations',
        hypotheses: '## Working Hypotheses',
        questions: '## Open Questions',
        contradictions: '## Contradictions I\'m Tracking',
        patterns: '## Patterns',
        uncertainty: '## Where I Might Be Wrong',
        notes: '## Notes',
        dream_fragments: '## Dream Fragments',
      };
      const header = sectionHeaders[args.section] || `## ${args.section}`;

      // Write to local mind file (git-backed, compactable)
      const existing = await readMindFile('model.md');

      if (existing) {
        let content = existing;
        const headerIdx = content.indexOf(header);
        if (headerIdx !== -1) {
          const afterHeader = content.slice(headerIdx + header.length);
          const nextSection = afterHeader.search(/\n## /);
          const insertPoint = headerIdx + header.length + (nextSection === -1 ? afterHeader.length : nextSection);
          content = content.slice(0, insertPoint) + '\n' + newEntry + content.slice(insertPoint);
        } else {
          content += `\n\n${header}\n${newEntry}`;
        }
        await writeMindFile('model.md', content);
      } else {
        await writeMindFile('model.md', `# Internal Model\n\n${header}\n${newEntry}`);
      }
      return `Internal model updated (${args.section}).`;
    }

    case 'flagForDiscussion': {
      const timestamp = new Date().toISOString().split('T')[0];
      const entry = `- **${args.topic}** (${timestamp}): ${args.context}`;

      // Write to local mind file (git-backed)
      const existing = await readMindFile('flagged.md');

      if (existing) {
        await writeMindFile('flagged.md', existing + '\n' + entry);
      } else {
        await writeMindFile('flagged.md', `# Things to Bring Up\n\n${entry}`);
      }
      return `Flagged for discussion: ${args.topic}`;
    }

    // ── Topology ──

    case 'exploreTerritory': {
      const { id: territoryId, name: resolvedName } = await resolveTerritoryId(args.territory);
      if (territoryId === null) {
        return `Could not find territory: "${args.territory}". Try searchMindscape to find the right name.`;
      }

      const scale = args.scale || 'session';
      const includeCoFiring = args.includeCoFiring !== false; // default true
      const includeGaps = args.includeGaps !== false; // default true
      const depth = args.depth || 1;

      // Fetch in parallel
      const fetches = {};
      if (includeCoFiring) fetches.coFiring = fetchCoFiring(territoryId, { scale, limit: 10 });
      if (includeGaps) fetches.gaps = fetchGaps(territoryId, { scale });
      if (depth > 1) fetches.cluster = fetchCluster(territoryId, { depth, scale });

      const keys = Object.keys(fetches);
      const results = await Promise.all(Object.values(fetches));
      const data = {};
      keys.forEach((k, i) => { data[k] = results[i]; });

      // Build output
      const sections = [];
      const label = resolvedName || `Territory ${territoryId}`;
      sections.push(`# ${label} (ID: ${territoryId})`);

      if (data.coFiring) {
        const formatted = formatCoFiring(data.coFiring);
        sections.push(formatted
          ? `## Co-firing Partners\n${formatted}`
          : '## Co-firing Partners\nNone found at this scale.');
      }

      if (data.gaps) {
        const formatted = formatGaps(data.gaps);
        sections.push(formatted
          ? `## Gaps (unexplored connections)\n${formatted}`
          : '## Gaps\nNo significant gaps found.');
      }

      if (data.cluster) {
        const formatted = formatCluster(data.cluster);
        sections.push(formatted
          ? `## Cluster (depth ${depth})\n${formatted}`
          : '## Cluster\nNo connected cluster found.');
      }

      return sections.join('\n\n');
    }

    case 'mindscapeStructure': {
      const showOrphans = args.orphans !== false; // default true
      const showBridges = args.bridges !== false; // default true
      const scale = args.scale || 'weekly';

      const fetches = {};
      if (showOrphans) fetches.orphans = fetchOrphans({ scale });
      if (showBridges) fetches.bridges = fetchBridges({ scale });

      const keys = Object.keys(fetches);
      const results = await Promise.all(Object.values(fetches));
      const data = {};
      keys.forEach((k, i) => { data[k] = results[i]; });

      const sections = ['# Mindscape Structure'];

      if (data.orphans !== undefined) {
        const formatted = formatOrphans(data.orphans);
        sections.push(formatted
          ? `## Orphan Territories\n*High content, low connectivity — may indicate holding patterns, avoidance, or unintegrated experiences.*\n\n${formatted}`
          : '## Orphan Territories\nNone found.');
      }

      if (data.bridges !== undefined) {
        const formatted = formatBridges(data.bridges);
        sections.push(formatted
          ? `## Bridge Territories\n*Connect different realms — structural integration points.*\n\n${formatted}`
          : '## Bridge Territories\nNone found.');
      }

      return sections.join('\n\n');
    }

    // ── Multi-Agent ──

    case 'delegate_to_agent': {
      if (!AGENT_URL) {
        return 'Delegation unavailable: AGENT_URL not configured. Cannot reach local agent-server.';
      }
      try {
        const res = await fetch(`${AGENT_URL}/delegate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent: args.agent,
            task: args.task,
            context: args.context || '',
            priority: args.priority || 'normal',
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`${res.status}: ${body.slice(0, 200)}`);
        }
        const data = await res.json();
        return data.message || `Delegated to ${args.agent}.`;
      } catch (err) {
        return `Delegation failed (${args.agent}): ${err.message}. The agent may be offline.`;
      }
    }

    // ── Team Visibility ──

    case 'getTeamStatus': {
      const includeLastMessage = args.includeLastMessage !== false;
      const agentIds = Object.keys(COMPANY_TEAM);

      // Fetch health + last messages in parallel
      const [healthResults, lastMessages] = await Promise.all([
        // Health checks (HTTP to each agent, 3s timeout)
        Promise.all(agentIds.map(async (agentId) => {
          const info = COMPANY_TEAM[agentId];
          try {
            const res = await fetch(`http://localhost:${info.port}/health`, {
              signal: AbortSignal.timeout(3000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return { agentId, health: await res.json(), status: 'online' };
          } catch (err) {
            return { agentId, health: null, status: 'offline', error: err.message };
          }
        })),

        // Last message per agent (parallel DB queries)
        includeLastMessage ? Promise.all(agentIds.map(async (agentId) => {
          try {
            const msgs = await db.messages.selectRecent(USER_ID, { limit: 1, agentId });
            return msgs[0] ? { ...msgs[0], agent_id: agentId } : null;
          } catch { return null; }
        })) : [],
      ]);

      // Build lookup maps
      const lastMsgMap = new Map();
      for (const m of lastMessages) {
        if (m?.agent_id) lastMsgMap.set(m.agent_id, m);
      }

      // Format dashboard
      const lines = ['# Team Status Dashboard\n'];

      for (const { agentId, health, status, error } of healthResults) {
        const info = COMPANY_TEAM[agentId];
        const statusLabel = status === 'online' ? 'ONLINE' : 'OFFLINE';

        lines.push(`## ${info.name} (${agentId}) — ${statusLabel}`);
        lines.push(`- Role: ${info.role}`);

        if (status === 'online') {
          const model = health?.lastModelUsed || health?.model || '?';
          const activeTasks = health?.state?.activeTasks || 0;
          const msgCount = health?.state?.messagesToday || 0;
          lines.push(`- Model: ${model}`);
          lines.push(`- Active tasks: ${activeTasks}`);
          lines.push(`- Messages today: ${msgCount}`);
        } else {
          lines.push(`- Error: ${error || 'unreachable'}`);
        }

        const lastMsg = lastMsgMap.get(agentId);
        if (lastMsg) {
          const time = lastMsg.created_at
            ? new Date(lastMsg.created_at).toISOString().replace('T', ' ').slice(0, 19)
            : '?';
          const snippet = (lastMsg.content || '').slice(0, 150);
          const src = lastMsg.source || '?';
          lines.push(`- Last activity: ${time} (${src})`);
          lines.push(`  > ${snippet}${(lastMsg.content?.length || 0) > 150 ? '...' : ''}`);
        } else {
          lines.push(`- Last activity: no recent messages`);
        }

        lines.push('');
      }

      return lines.join('\n');
    }

    // ── Google Services ──

    case 'gmail':
    case 'drive':
    case 'calendar':
      return JSON.stringify(await dispatchServiceCall(name, args));

    // ── Health ──

    case 'getHealthData': {
      const db = getDb();
      if (!db?.health) return 'Health data not available (database not configured).';
      const to = args.to || new Date().toISOString().split('T')[0];
      const days = Math.min(args.days || 7, 90);
      const from = args.from || new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

      const [range, summary] = await Promise.all([
        db.health.getRange(USER_ID, from, to),
        db.health.getSummary(USER_ID, days),
      ]);

      if (!range.length) return `No health data found between ${from} and ${to}.`;

      let result = `## Health Data: ${from} → ${to} (${range.length} days)\n\n`;

      // Summary
      if (summary.averages) {
        const a = summary.averages;
        result += `**Averages:** `;
        const parts = [];
        if (a.sleep_duration_min != null) parts.push(`Sleep ${Math.floor(a.sleep_duration_min / 60)}h${Math.round(a.sleep_duration_min % 60)}m`);
        if (a.hrv_avg != null) parts.push(`HRV ${Math.round(a.hrv_avg)}ms`);
        if (a.resting_hr != null) parts.push(`RHR ${Math.round(a.resting_hr)}bpm`);
        if (a.steps != null) parts.push(`Steps ${Math.round(a.steps).toLocaleString()}`);
        result += parts.join(' | ') + '\n';
      }
      if (summary.trends) {
        const arrows = { improving: '↑', declining: '↓', stable: '→' };
        const tParts = [];
        for (const [k, v] of Object.entries(summary.trends)) {
          if (v !== 'insufficient') tParts.push(`${k}: ${arrows[v] || '→'} ${v}`);
        }
        if (tParts.length) result += `**Trends:** ${tParts.join(' | ')}\n`;
      }
      if (summary.anomalies?.length) {
        result += `**Anomalies:** ${summary.anomalies.map(a => `${a.date} ${a.metric}=${a.value} (baseline ${a.baseline})`).join('; ')}\n`;
      }

      // Daily breakdown
      result += `\n### Daily\n`;
      for (const d of range) {
        const parts = [];
        if (d.sleep_duration_min != null) parts.push(`Sleep ${Math.floor(d.sleep_duration_min / 60)}h${Math.round(d.sleep_duration_min % 60)}m`);
        if (d.hrv_avg != null) parts.push(`HRV ${Math.round(d.hrv_avg)}`);
        if (d.resting_hr != null) parts.push(`RHR ${Math.round(d.resting_hr)}`);
        if (d.steps != null) parts.push(`${d.steps} steps`);
        if (d.workout_minutes > 0) parts.push(`${Math.round(d.workout_minutes)}m workout`);
        result += `**${d.date}:** ${parts.join(' | ')}\n`;
      }

      return result;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP Server Setup ────────────────────────────────────────────────────────

const server = new Server(
  { name: 'mya-tools', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleTool(name, args || {});
    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error in ${name}: ${err.message}` }],
      isError: true,
    };
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

// Initialize database before connecting MCP server
db = await initDb();

const transport = new StdioServerTransport();
await server.connect(transport);
