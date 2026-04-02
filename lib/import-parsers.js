/**
 * Import parsers — ported from MYA 0.2
 *
 * Handles parsing and deduplication for:
 * - Claude exports (conversations, projects, memories, artifact dedup)
 * - OpenAI/ChatGPT exports (tree flattening, canonical path)
 * - Obsidian vaults (markdown files)
 * - LinkedIn exports (connections, messages with participant tracking)
 */

// ── Artifact Deduplication ───────────────────────────────────────────────────

const GENERIC_FILENAMES = new Set([
  'paste.txt', 'paste-2.txt', 'paste-3.txt', 'paste-4.txt', 'paste-5.txt',
  'untitled.txt', 'code.txt', 'snippet.txt',
]);

function generateArtifactIdentifier(filename, content) {
  // Priority 1: Use specific filenames (not generic ones)
  if (filename && !GENERIC_FILENAMES.has(filename.toLowerCase())) {
    return `attachment:${filename}`;
  }
  // Priority 2: Use first meaningful line of content
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 5 && trimmed.length <= 150) {
      return `content:${trimmed}`;
    }
  }
  return null; // No identifier = always keep (no deduplication)
}

function extractArtifacts(text, attachments) {
  const artifacts = [];
  const xmlRegex = /<antArtifact(?:\s+[^>]*)?>[\s\S]*?<\/antArtifact>/g;
  const attrRegex = /(\w+)=["']([^"']*)["']/g;

  let match;
  while ((match = xmlRegex.exec(text)) !== null) {
    const fullTag = match[0];
    const attrs = {};
    let attrMatch;
    while ((attrMatch = attrRegex.exec(fullTag)) !== null) {
      attrs[attrMatch[1]] = attrMatch[2];
    }
    const contentMatch = fullTag.match(/<antArtifact[^>]*>([\s\S]*)<\/antArtifact>/);
    const content = contentMatch ? contentMatch[1].trim() : '';
    const identifier = generateArtifactIdentifier(attrs.title || null, content);
    artifacts.push({ identifier, type: attrs.type || null, title: attrs.title || null, content });
  }

  if (attachments) {
    for (const att of attachments) {
      if (att.extracted_content) {
        const identifier = generateArtifactIdentifier(att.file_name, att.extracted_content);
        artifacts.push({ identifier, type: null, title: att.file_name, content: att.extracted_content });
      }
    }
  }
  return artifacts;
}

function stripArtifactTags(text) {
  return text.replace(/<antArtifact[^>]*>[\s\S]*?<\/antArtifact>/g, '[ARTIFACT]').trim();
}

/**
 * Two-pass artifact deduplication for Claude conversations.
 * Pass 1: Find the latest version of each artifact across all messages.
 * Pass 2: Only include artifact content for the latest version.
 */
export function parseConversationWithDeduplication(messages) {
  // PASS 1: Collect latest version of each artifact
  const latestArtifacts = new Map();

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    const rawText = msg.text || msg.content;
    const text = typeof rawText === 'string' ? rawText : '';
    const artifacts = extractArtifacts(text, msg.attachments);
    for (const artifact of artifacts) {
      if (artifact.identifier) {
        latestArtifacts.set(artifact.identifier, { msgIdx, artifact });
      }
    }
  }

  // Build set of (msgIdx, identifier) pairs for latest versions
  const latestLocations = new Set();
  for (const [identifier, { msgIdx }] of latestArtifacts) {
    latestLocations.add(`${msgIdx}:${identifier}`);
  }

  // PASS 2: Build messages with deduplicated artifact content
  const results = [];

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    const rawText = msg.text || msg.content;
    const text = typeof rawText === 'string' ? rawText : '';
    const textStripped = stripArtifactTags(text);
    const artifacts = extractArtifacts(text, msg.attachments);

    const artifactContents = [];
    let artifactCount = 0;

    for (const artifact of artifacts) {
      const isLatest = artifact.identifier === null ||
        latestLocations.has(`${msgIdx}:${artifact.identifier}`);
      if (isLatest && artifact.content) {
        const label = artifact.title || 'artifact';
        artifactContents.push(`\n[Artifact: ${label}]\n${artifact.content.substring(0, 1000)}`);
        artifactCount++;
      }
    }

    const textWithArtifacts = textStripped + artifactContents.join('\n');
    results.push({ msg, textStripped, textWithArtifacts, artifactCount });
  }

  return results;
}

/**
 * Count raw artifacts in a conversation (before dedup) for stats.
 */
export function countRawArtifacts(messages) {
  return messages.reduce((sum, m) => {
    const rawT = m.text || m.content;
    const text = typeof rawT === 'string' ? rawT : '';
    const xmlMatches = text.match(/<antArtifact[^>]*>/g) || [];
    const attMatches = (m.attachments || []).filter(a => a.extracted_content);
    return sum + xmlMatches.length + attMatches.length;
  }, 0);
}

// ── OpenAI/ChatGPT Export Parsing ────────────────────────────────────────────

/**
 * Flatten OpenAI conversation tree to linear messages.
 * OpenAI exports use a tree structure with parent/children references.
 * Follows canonical path (last child = most recent generation).
 */
export function flattenOpenAIConversation(conv, includeAllBranches = false) {
  const messages = [];
  const mapping = conv.mapping;
  if (!mapping) return messages;

  // Find root node (parent === null)
  const rootId = Object.keys(mapping).find(id => mapping[id].parent === null);
  if (!rootId) return messages;

  function visit(nodeId) {
    const node = mapping[nodeId];
    if (!node) return;

    // Skip system messages and null messages
    if (node.message && node.message.author?.role !== 'system') {
      const parts = node.message.content?.parts || [];
      const content = parts.filter(p => typeof p === 'string').join('\n');
      if (content.trim()) {
        messages.push({
          uuid: node.id,
          role: node.message.author.role === 'user' ? 'user' : 'assistant',
          content,
          created_at: node.message.create_time
            ? new Date(node.message.create_time * 1000).toISOString()
            : new Date().toISOString(),
        });
      }
    }

    if (includeAllBranches) {
      for (const childId of node.children || []) {
        visit(childId);
      }
    } else {
      // Canonical path: follow only last child (most recent generation)
      const children = node.children || [];
      if (children.length > 0) {
        visit(children[children.length - 1]);
      }
    }
  }

  visit(rootId);
  return messages;
}

/**
 * Detect if data is OpenAI format vs Claude format.
 */
export function isOpenAIFormat(data) {
  if (typeof data !== 'object' || data === null) return false;
  // OpenAI has 'mapping' field with tree structure
  if ('mapping' in data && typeof data.mapping === 'object') return true;
  // Array of conversations — check first item
  if (Array.isArray(data) && data.length > 0 && data[0].mapping) return true;
  return false;
}

/**
 * Detect if data is Claude format.
 */
export function isClaudeFormat(data) {
  if (typeof data !== 'object' || data === null) return false;
  // Claude has chat_messages
  if (Array.isArray(data) && data.length > 0 && (data[0].chat_messages || data[0].sender)) return true;
  if (data.conversations && Array.isArray(data.conversations)) return true;
  return false;
}

// ── Full Import Processors ───────────────────────────────────────────────────

/**
 * Process a Claude export ZIP. Returns detailed stats.
 * Handles conversations (with artifact dedup), projects, and memories.
 */
export async function processClaudeExport(zip, userId, db) {
  const stats = {
    conversations: 0,
    messages: 0,
    projects: 0,
    project_docs: 0,
    memories: 0,
    skipped_duplicates: 0,
    artifacts_kept: 0,
    artifacts_deduplicated: 0,
  };

  const zipFiles = Object.keys(zip.files).filter(n => !zip.files[n].dir);
  const jsonFiles = zipFiles.filter(n => n.endsWith('.json'));

  // ── 1. CONVERSATIONS ────────────────────────────────────────────────────
  let conversations = [];

  for (const jf of jsonFiles) {
    if (!jf.toLowerCase().includes('conversations') && !jf.toLowerCase().includes('batch')) {
      // Also try parsing any JSON that contains conversation data
    }
    try {
      const text = await zip.files[jf].async('text');
      const parsed = JSON.parse(text);
      const convs = Array.isArray(parsed) ? parsed : parsed.conversations;
      if (Array.isArray(convs) && convs.length > 0) {
        const sample = convs[0];
        if (sample.chat_messages || sample.sender || sample.messages) {
          conversations.push(...convs);
        }
      }
    } catch { /* not valid conversation data */ }
  }

  if (conversations.length > 0) {
    stats.conversations = conversations.length;

    // Collect all incoming UUIDs for batch dedup check
    const incomingUuids = [];
    for (const conv of conversations) {
      for (const msg of conv.chat_messages || conv.messages || []) {
        if (msg.uuid || msg.id) {
          incomingUuids.push(msg.uuid || msg.id);
        }
      }
    }

    // Batch check existing UUIDs
    const existingIds = incomingUuids.length > 0
      ? await db.messages.getExistingIds(userId, incomingUuids)
      : new Set();

    console.log(`[Import] ${incomingUuids.length} incoming UUIDs, ${existingIds.size} already exist`);

    let totalArtifactsKept = 0;
    let totalArtifactsDeduplicated = 0;
    const messagesToInsert = [];

    for (const conv of conversations) {
      const convName = conv.name || conv.title || 'Untitled';
      const chatMsgs = conv.chat_messages || conv.messages || [];

      // Two-pass parsing with artifact deduplication
      const parsedMessages = parseConversationWithDeduplication(chatMsgs);

      // Count deduplication stats
      const rawArtifactCount = countRawArtifacts(chatMsgs);
      const keptArtifactCount = parsedMessages.reduce((sum, p) => sum + p.artifactCount, 0);
      totalArtifactsKept += keptArtifactCount;
      totalArtifactsDeduplicated += rawArtifactCount - keptArtifactCount;

      for (const { msg, textStripped, textWithArtifacts } of parsedMessages) {
        const msgId = msg.uuid || msg.id;

        // Skip if already imported
        if (msgId && existingIds.has(msgId)) {
          stats.skipped_duplicates++;
          continue;
        }

        // Skip empty messages
        if (!textStripped) continue;

        const role = msg.sender === 'human' || msg.role === 'user' ? 'user' : 'assistant';
        const createdAt = msg.created_at || msg.timestamp || new Date().toISOString();

        messagesToInsert.push({
          id: msgId || crypto.randomUUID(),
          user_id: userId,
          role,
          content: textWithArtifacts,
          message_type: 'text',
          source: 'import_claude',
          scope: 'personal',
          metadata: JSON.stringify({
            source: 'claude_export',
            claude_uuid: msgId,
            conversation_uuid: conv.uuid || conv.id,
            conversation_name: convName,
            original_created_at: createdAt,
          }),
          created_at: createdAt,
        });
      }
    }

    // Batch insert — insertIgnore handles D1 param limits internally
    try {
      const result = await db.messages.insertIgnore(messagesToInsert);
      stats.messages += result.length;
    } catch (err) {
      console.error(`[Import] Batch insert failed:`, err.message);
      // Fallback: insert individually
      for (const msg of messagesToInsert) {
        try {
          await db.messages.insertIgnore([msg]);
          stats.messages++;
        } catch { stats.skipped_duplicates++; }
      }
    }

    stats.artifacts_kept = totalArtifactsKept;
    stats.artifacts_deduplicated = totalArtifactsDeduplicated;
    console.log(`[Import] Claude: ${stats.messages} msgs from ${stats.conversations} convs, artifacts: ${totalArtifactsKept} kept / ${totalArtifactsDeduplicated} deduped`);
  }

  // ── 2. PROJECTS ─────────────────────────────────────────────────────────
  for (const jf of jsonFiles) {
    if (!jf.toLowerCase().includes('projects') || jf.toLowerCase().includes('memories')) continue;
    try {
      const text = await zip.files[jf].async('text');
      const projects = JSON.parse(text);
      if (!Array.isArray(projects)) continue;

      for (const proj of projects) {
        stats.projects++;

        if (proj.prompt_template) {
          const docPath = `claude/projects/${proj.uuid}/prompt`;
          try {
            await db.documents.upsert({
              user_id: userId,
              path: docPath,
              title: `${proj.name} — System Prompt`,
              content: proj.prompt_template,
              summary: proj.prompt_template.substring(0, 200),
              source_type: 'import_claude',
              created_by: 'user',
            });
          } catch (e) {
            console.error(`[Import] Project prompt failed:`, e.message);
          }
        }

        for (const doc of proj.docs || []) {
          const safeName = doc.filename.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_.-]/g, '');
          const docPath = `claude/projects/${proj.uuid}/docs/${safeName}`;
          try {
            await db.documents.upsert({
              user_id: userId,
              path: docPath,
              title: `${proj.name} — ${doc.filename}`,
              content: doc.content,
              summary: doc.content.substring(0, 200),
              source_type: 'import_claude',
              created_by: 'user',
            });
            stats.project_docs++;
          } catch (e) {
            console.error(`[Import] Project doc failed:`, e.message);
          }
        }
      }
      console.log(`[Import] Projects: ${stats.projects} projects, ${stats.project_docs} docs`);
    } catch { /* not a projects file */ }
  }

  // ── 3. MEMORIES ─────────────────────────────────────────────────────────
  for (const jf of jsonFiles) {
    if (!jf.toLowerCase().includes('memories')) continue;
    try {
      const text = await zip.files[jf].async('text');
      const memories = JSON.parse(text);
      if (!Array.isArray(memories)) continue;

      for (const mem of memories) {
        if (mem.conversations_memory) {
          try {
            await db.documents.upsert({
              user_id: userId,
              path: 'claude/memories/global',
              title: 'Claude Global Memory',
              content: mem.conversations_memory,
              summary: mem.conversations_memory.substring(0, 200),
              source_type: 'import_claude',
              created_by: 'user',
            });
            stats.memories++;
          } catch (e) {
            console.error('[Import] Global memory failed:', e.message);
          }
        }

        for (const [projUuid, memoryText] of Object.entries(mem.project_memories || {})) {
          try {
            await db.documents.upsert({
              user_id: userId,
              path: `claude/memories/project_${projUuid}`,
              title: `Claude Project Memory — ${projUuid}`,
              content: memoryText,
              summary: memoryText.substring(0, 200),
              source_type: 'import_claude',
              created_by: 'user',
            });
            stats.memories++;
          } catch (e) {
            console.error(`[Import] Project memory failed:`, e.message);
          }
        }
      }
      console.log(`[Import] Memories: ${stats.memories}`);
    } catch { /* not a memories file */ }
  }

  return stats;
}

/**
 * Process an OpenAI/ChatGPT export ZIP or JSON. Returns stats.
 */
export async function processOpenAIExport(conversations, userId, db) {
  const stats = {
    conversations: 0,
    messages: 0,
    skipped_duplicates: 0,
  };

  // Flatten all conversations first (fast, in-memory)
  console.log(`[Import] OpenAI: flattening ${conversations.length} conversations...`);
  const allFlat = [];
  for (const conv of conversations) {
    const flat = flattenOpenAIConversation(conv);
    stats.conversations++;
    for (const msg of flat) {
      allFlat.push({ ...msg, convTitle: conv.title });
    }
  }
  console.log(`[Import] OpenAI: ${allFlat.length} messages to check`);

  // Batch check existing UUIDs
  const incomingUuids = allFlat.map(m => m.uuid);
  const existingIds = incomingUuids.length > 0
    ? await db.messages.getExistingIds(userId, incomingUuids)
    : new Set();
  console.log(`[Import] OpenAI: ${existingIds.size} already exist`);

  const messagesToInsert = [];
  for (const msg of allFlat) {
    if (existingIds.has(msg.uuid)) {
      stats.skipped_duplicates++;
      continue;
    }
    messagesToInsert.push({
      id: msg.uuid || crypto.randomUUID(),
      user_id: userId,
      role: msg.role,
      content: msg.content,
      message_type: 'text',
      source: 'import_chatgpt',
      scope: 'personal',
      metadata: JSON.stringify({
        source: 'openai_export',
        openai_message_id: msg.uuid,
        conversation_title: msg.convTitle,
        original_created_at: msg.created_at,
      }),
      created_at: msg.created_at,
    });
  }

  // Batch insert — insertIgnore handles D1 param limits internally
  console.log(`[Import] OpenAI: inserting ${messagesToInsert.length} new messages...`);
  try {
    const result = await db.messages.insertIgnore(messagesToInsert);
    stats.messages += result.length;
  } catch (err) {
    console.error(`[Import] OpenAI batch insert failed:`, err.message);
    for (const msg of messagesToInsert) {
      try {
        await db.messages.insertIgnore([msg]);
        stats.messages++;
      } catch { stats.skipped_duplicates++; }
    }
  }

  console.log(`[Import] OpenAI: ${stats.messages} msgs from ${stats.conversations} convs, ${stats.skipped_duplicates} dupes`);
  return stats;
}

/**
 * Process an Obsidian vault ZIP. Returns stats.
 */
export async function processObsidianExport(zip, userId, db) {
  const stats = { imported: 0, skipped: 0 };
  const zipFiles = Object.keys(zip.files).filter(n => !zip.files[n].dir);
  const mdFiles = zipFiles.filter(n => n.endsWith('.md'));
  const skipPatterns = ['.obsidian/', '.trash/', '.git/', '.DS_Store', 'Templates/'];

  for (const mdFile of mdFiles) {
    if (skipPatterns.some(p => mdFile.includes(p))) { stats.skipped++; continue; }
    try {
      const content = await zip.files[mdFile].async('text');
      if (!content.trim()) { stats.skipped++; continue; }
      const cleanName = mdFile.replace(/^[^/]+\//, '');
      const title = cleanName.replace(/\.md$/, '').split('/').pop() || cleanName;
      await db.documents.upsert({
        user_id: userId,
        path: `import/obsidian/${cleanName.replace(/\.md$/, '')}`,
        title,
        content,
        source_type: 'import_obsidian',
        created_by: 'user',
      });
      stats.imported++;
    } catch { stats.skipped++; }
  }

  console.log(`[Import] Obsidian: ${stats.imported} imported, ${stats.skipped} skipped`);
  return stats;
}

// ── LinkedIn Export ─────────────────────────────────────────────────────────

/**
 * Parse a CSV string handling quoted fields with commas and newlines.
 */
function parseCSV(text) {
  const rows = [];
  let current = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { field += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { current.push(field.trim()); field = ''; }
      else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
        current.push(field.trim()); field = '';
        if (current.length > 1) rows.push(current);
        current = [];
        if (ch === '\r') i++;
      } else { field += ch; }
    }
  }
  if (field || current.length) { current.push(field.trim()); if (current.length > 1) rows.push(current); }
  return rows;
}

function csvToObjects(text) {
  const rows = parseCSV(text);
  if (rows.length < 1) return [];
  const headers = rows[0];
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] || ''; });
    return obj;
  });
}

/**
 * Process a LinkedIn export ZIP. Returns stats.
 *
 * Imports:
 * - Connections → people table (with dedup via user_id+name unique index)
 * - Messages → messages table (only conversations where the owner replied)
 *   - Each message has contact_id, conversation_id, full participant metadata
 *   - Dedup via conversation_id + created_at composite check
 *
 * @param {object} zip - JSZip instance
 * @param {string} userId - user ID for DB records
 * @param {object} db - database helper
 * @param {string} ownerName - the export owner's name (for identifying their messages)
 * @returns {Promise<object>} stats
 */
export async function processLinkedInExport(zip, userId, db, ownerName = process.env.OWNER_NAME || 'Owner') {
  const stats = {
    connections: 0,
    connections_skipped: 0,
    noise_filtered: 0,
    messages: 0,
    conversations: 0,
    group_chats: 0,
    skipped_duplicates: 0,
    contacts_with_messages: 0,
  };

  // ── Parse Connections.csv ──
  const connFile = Object.keys(zip.files).find(n => n.endsWith('Connections.csv'));
  if (!connFile) throw new Error('No Connections.csv found in LinkedIn export');

  let connText = await zip.files[connFile].async('text');
  // LinkedIn prepends a notes paragraph before the CSV header — skip it
  const headerIdx = connText.indexOf('First Name,');
  if (headerIdx > 0) connText = connText.substring(headerIdx);
  const connections = csvToObjects(connText);

  // ── Parse messages.csv ──
  const msgFile = Object.keys(zip.files).find(n => n.endsWith('messages.csv'));
  const rawMessages = msgFile ? csvToObjects(await zip.files[msgFile].async('text')) : [];

  // Group messages by conversation, collect participants
  const convos = new Map();
  for (const msg of rawMessages) {
    const convId = msg['CONVERSATION ID'];
    if (!convId) continue;
    if (!convos.has(convId)) {
      convos.set(convId, { ownerReplied: false, participants: new Map(), messages: [] });
    }
    const conv = convos.get(convId);
    const from = msg['FROM'] || '';
    const senderUrl = msg['SENDER PROFILE URL'] || '';
    const date = msg['DATE'] || '';

    if (from === ownerName) {
      conv.ownerReplied = true;
    } else if (from && senderUrl) {
      conv.participants.set(senderUrl, from);
    }
    if (msg['CONTENT']?.trim()) {
      conv.messages.push({ from, senderUrl, date, content: msg['CONTENT'], convId });
    }
  }

  // Build engagement map: linkedin_url → { messageCount, lastDate }
  const engagedUrls = new Map();
  for (const [, conv] of convos) {
    if (!conv.ownerReplied) continue;
    for (const [url, name] of conv.participants) {
      const existing = engagedUrls.get(url) || { messageCount: 0, lastDate: null, name };
      existing.messageCount += conv.messages.length;
      if (!existing.lastDate || conv.messages[conv.messages.length - 1]?.date > existing.lastDate) {
        existing.lastDate = conv.messages[conv.messages.length - 1]?.date;
      }
      engagedUrls.set(url, existing);
    }
  }

  // ── Step 1: Upsert contacts into people table ──
  // Load existing name→id index once for dedup (encryption breaks SQL ON CONFLICT)
  const nameIndex = await db.people.loadNameIndex(userId);
  console.log(`[Import] LinkedIn: ${nameIndex.size} existing contacts in DB`);
  const noisePositions = /recruiter|talent acquisition|staffing|headhunt|business development representative/i;

  for (const conn of connections) {
    const firstName = conn['First Name'] || '';
    const lastName = conn['Last Name'] || '';
    const name = `${firstName} ${lastName}`.trim();
    if (!name) { stats.connections_skipped++; continue; }

    const linkedinUrl = conn['URL'] || '';
    const email = conn['Email Address'] || '';
    const company = conn['Company'] || '';
    const position = conn['Position'] || '';
    const connectedOn = conn['Connected On'] || '';

    let connectedAt = null;
    if (connectedOn) {
      try { connectedAt = new Date(connectedOn).toISOString().split('T')[0]; } catch { /* skip */ }
    }

    const engagement = engagedUrls.get(linkedinUrl);
    const interactionCount = engagement?.messageCount || 0;
    const lastInteraction = engagement?.lastDate || null;

    // Initial status based on what we know at import time.
    // classify-contacts.js refines this using outbound message counts.
    let status = 'connected';
    if (interactionCount === 0 && (!company || noisePositions.test(position))) {
      status = 'noise';
      stats.noise_filtered++;
    } else if (interactionCount > 0) {
      status = 'acknowledged'; // has conversation — classify-contacts.js will promote to engaged/inner
    }

    try {
      await db.people.upsert({
        user_id: userId,
        name,
        source: 'linkedin',
        linkedin_url: linkedinUrl || null,
        email: email || null,
        company: company || null,
        position: position || null,
        connected_at: connectedAt,
        last_interaction_at: lastInteraction,
        interaction_count: interactionCount,
        status,
      }, nameIndex);
      stats.connections++;
    } catch { stats.connections_skipped++; }
  }

  console.log(`[Import] LinkedIn: ${stats.connections} connections, ${stats.noise_filtered} noise`);

  // ── Step 2: Build people lookup for message attribution ──
  const peopleRows = await db.people.getBySource(userId, 'linkedin');
  const urlToPerson = new Map();
  for (const p of peopleRows) {
    if (p.linkedin_url) urlToPerson.set(p.linkedin_url, p);
  }

  // ── Step 3: Dedup — find existing LinkedIn messages ──
  const existingConvIds = await db.messages.getExistingConversationIds(userId, 'linkedin');

  // ── Step 4: Store messages with full attribution ──
  const messagesToInsert = [];
  const contactIdsWithMessages = new Set();

  for (const [convId, conv] of convos) {
    if (!conv.ownerReplied) continue;
    if (existingConvIds.has(convId)) {
      // Count messages in this conversation for skip stats
      stats.skipped_duplicates += conv.messages.length;
      continue;
    }

    stats.conversations++;
    if (conv.participants.size > 1) stats.group_chats++;

    const participantNames = [...conv.participants.values()];
    const participantContactIds = [...conv.participants.entries()]
      .map(([url]) => urlToPerson.get(url)?.id)
      .filter(Boolean);

    for (const msg of conv.messages) {
      const isOwner = msg.from === ownerName;
      const person = isOwner ? null : urlToPerson.get(msg.senderUrl);
      const contactId = person?.id || null;
      if (contactId) contactIdsWithMessages.add(contactId);

      messagesToInsert.push({
        id: undefined, // auto-generated
        user_id: userId,
        role: isOwner ? 'user' : 'assistant',
        content: msg.content,
        message_type: 'chat',
        source: 'linkedin',
        agent_id: 'personal-agent',
        contact_id: contactId,
        conversation_id: convId,
        metadata: JSON.stringify({
          platform: 'linkedin',
          sender_name: msg.from,
          sender_url: msg.senderUrl || null,
          direction: isOwner ? 'outbound' : 'inbound',
          participants: participantNames,
          participant_contact_ids: participantContactIds,
          is_group_chat: conv.participants.size > 1,
        }),
        entities: JSON.stringify({ people: participantNames }),
        scope: 'personal',
        created_at: msg.date || new Date().toISOString(),
      });
    }
  }

  if (messagesToInsert.length > 0) {
    await db.messages.insertIgnore(messagesToInsert);
    stats.messages = messagesToInsert.length;
    stats.contacts_with_messages = contactIdsWithMessages.size;
  }

  console.log(`[Import] LinkedIn: ${stats.messages} messages from ${stats.conversations} conversations (${stats.group_chats} group), ${stats.skipped_duplicates} duplicates skipped`);
  return stats;
}

/**
 * Auto-detect export type from a ZIP file.
 * Returns { type, conversations, zip } or null if not an export.
 */
export async function detectExportType(zip) {
  const zipFiles = Object.keys(zip.files).filter(n => !zip.files[n].dir);
  const csvFiles = zipFiles.filter(n => n.endsWith('.csv'));
  const jsonFiles = zipFiles.filter(n => n.endsWith('.json'));
  const mdFiles = zipFiles.filter(n => n.endsWith('.md'));

  // LinkedIn: has Connections.csv (required) and optionally messages.csv
  const hasConnections = csvFiles.some(n => n.endsWith('Connections.csv'));
  const hasLinkedInMessages = csvFiles.some(n => n === 'messages.csv');
  if (hasConnections && (hasLinkedInMessages || csvFiles.some(n => n.endsWith('Profile.csv')))) {
    return { type: 'linkedin' };
  }

  // Try each JSON file for Claude or OpenAI format
  let claudeConversations = [];
  let openaiConversations = [];
  let hasProjects = false;
  let hasMemories = false;

  for (const jf of jsonFiles) {
    try {
      const text = await zip.files[jf].async('text');
      const data = JSON.parse(text);

      // Check for projects/memories files (Claude-specific)
      if (jf.toLowerCase().includes('projects') && Array.isArray(data)) {
        hasProjects = true;
        continue;
      }
      if (jf.toLowerCase().includes('memories') && Array.isArray(data)) {
        hasMemories = true;
        continue;
      }

      const convs = Array.isArray(data) ? data : data.conversations;
      if (!Array.isArray(convs) || convs.length === 0) continue;

      const sample = convs[0];
      if (sample.chat_messages || sample.sender || sample.messages) {
        claudeConversations.push(...convs);
      } else if (sample.mapping) {
        openaiConversations.push(...convs);
      }
    } catch { /* skip */ }
  }

  if (claudeConversations.length > 0) {
    return { type: 'claude', conversations: claudeConversations, hasProjects, hasMemories };
  }
  if (openaiConversations.length > 0) {
    return { type: 'chatgpt', conversations: openaiConversations };
  }
  // Obsidian: mostly .md files
  if (mdFiles.length > 3 && mdFiles.length > jsonFiles.length) {
    return { type: 'obsidian' };
  }

  return null;
}
