#!/usr/bin/env node
/**
 * Import LinkedIn export ZIP into the social layer.
 *
 * Usage: node scripts/import-linkedin.js <path-to-zip> [--dry-run]
 *
 * What it does:
 * 1. Parses Connections.csv → upserts into people table
 * 2. Parses messages.csv → filters to conversations where you replied
 * 3. Marks connections with no messages + no territory mentions as 'noise'
 * 4. Links contacts to territories via fuzzy name matching against top_entities
 */

import { readFileSync } from 'fs';
import JSZip from 'jszip';

const WORKER_URL = process.env.MYA_WORKER_URL;
// Use ADMIN_SECRET for full-scope access (people data is personal-scope encrypted)
const WORKER_SECRET = process.env.ADMIN_SECRET || process.env.MYA_WORKER_SECRET;
const USER_ID = process.env.DEFAULT_USER_ID || process.env.MYA_USER_ID || 'owner';
const OWNER_NAME = process.env.OWNER_NAME || 'Owner';
const DRY_RUN = process.argv.includes('--dry-run');
const ZIP_PATH = process.argv[2];

if (!ZIP_PATH) {
  console.error('Usage: node scripts/import-linkedin.js <path-to-zip> [--dry-run]');
  process.exit(1);
}
if (!WORKER_URL || !WORKER_SECRET) {
  console.error('Set MYA_WORKER_URL and MYA_WORKER_SECRET');
  process.exit(1);
}

// --- CSV parser (handles quoted fields with commas and newlines) ---
function parseCSV(text) {
  const rows = [];
  let current = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        current.push(field.trim());
        field = '';
      } else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
        current.push(field.trim());
        field = '';
        if (current.length > 1) rows.push(current);
        current = [];
        if (ch === '\r') i++;
      } else {
        field += ch;
      }
    }
  }
  if (field || current.length) {
    current.push(field.trim());
    if (current.length > 1) rows.push(current);
  }
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

// --- Worker DB helper ---
async function dbQuery(sql, params = []) {
  if (DRY_RUN) { console.log('[DRY] SQL:', sql.substring(0, 120), params.slice(0, 3)); return { results: [] }; }
  const res = await fetch(`${WORKER_URL}/api/db/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WORKER_SECRET}` },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`DB query failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data;
}

// --- Main ---
async function main() {
  console.log(`\nImporting LinkedIn data from: ${ZIP_PATH}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  const zip = await JSZip.loadAsync(readFileSync(ZIP_PATH));

  // ── Step 1: Parse connections ──
  const connEntry = zip.file('Connections.csv');
  if (!connEntry) throw new Error('No Connections.csv found in ZIP');

  let connText = await connEntry.async('text');
  // LinkedIn prepends a notes paragraph before the CSV header — skip it
  const headerIdx = connText.indexOf('First Name,');
  if (headerIdx > 0) connText = connText.substring(headerIdx);

  const connections = csvToObjects(connText);
  console.log(`Found ${connections.length} connections`);

  // ── Step 2: Parse messages — find conversations where the owner replied ──
  const msgEntry = zip.file('messages.csv');
  if (!msgEntry) throw new Error('No messages.csv found in ZIP');

  const messages = csvToObjects(await msgEntry.async('text'));
  console.log(`Found ${messages.length} messages`);

  // Group by conversation, find ones where the owner sent at least one message
  const convos = new Map(); // conversationId → { ownerSent: bool, participants: Set, lastDate, messageCount }
  for (const msg of messages) {
    const convId = msg['CONVERSATION ID'];
    if (!convId) continue;

    if (!convos.has(convId)) {
      convos.set(convId, { ownerSent: false, participants: new Map(), lastDate: null, messageCount: 0 });
    }
    const conv = convos.get(convId);
    conv.messageCount++;

    const from = msg['FROM'] || '';
    const date = msg['DATE'] || '';
    if (!conv.lastDate || date > conv.lastDate) conv.lastDate = date;

    if (from === '${OWNER_NAME}') {
      conv.ownerSent = true;
    } else if (from) {
      // Track other participants with their profile URLs
      const url = msg['SENDER PROFILE URL'] || '';
      if (!conv.participants.has(from)) {
        conv.participants.set(from, url);
      }
    }
  }

  // Build a map: linkedin_url → { messageCount, lastDate }
  const engagedContacts = new Map(); // linkedin_url → stats
  for (const [, conv] of convos) {
    if (!conv.ownerSent) continue; // Skip — owner never replied
    for (const [name, url] of conv.participants) {
      const key = url || name;
      const existing = engagedContacts.get(key) || { messageCount: 0, lastDate: null, name };
      existing.messageCount += conv.messageCount;
      if (!existing.lastDate || conv.lastDate > existing.lastDate) existing.lastDate = conv.lastDate;
      engagedContacts.set(key, existing);
    }
  }

  const totalConvos = convos.size;
  const repliedConvos = [...convos.values()].filter(c => c.ownerSent).length;
  console.log(`Conversations: ${totalConvos} total, ${repliedConvos} where you replied`);
  console.log(`Engaged contacts (from messages): ${engagedContacts.size}\n`);

  // ── Step 3: Import connections ──
  let imported = 0, skipped = 0, noise = 0;

  for (const conn of connections) {
    const firstName = conn['First Name'] || '';
    const lastName = conn['Last Name'] || '';
    const name = `${firstName} ${lastName}`.trim();
    if (!name) { skipped++; continue; }

    const linkedinUrl = conn['URL'] || '';
    const email = conn['Email Address'] || '';
    const company = conn['Company'] || '';
    const position = conn['Position'] || '';
    const connectedOn = conn['Connected On'] || '';

    // Parse "28 Mar 2026" → ISO date
    let connectedAt = null;
    if (connectedOn) {
      try {
        connectedAt = new Date(connectedOn).toISOString().split('T')[0];
      } catch { /* skip */ }
    }

    // Check if this person had real engagement
    const engagement = engagedContacts.get(linkedinUrl) || engagedContacts.get(name);
    const interactionCount = engagement?.messageCount || 0;
    const lastInteraction = engagement?.lastDate || null;

    // Noise filter: no messages exchanged, generic sales/recruiter positions
    const noisePositions = /recruiter|talent acquisition|staffing|headhunt|business development representative/i;
    const isNoise = interactionCount === 0 && (!company || noisePositions.test(position));
    const status = isNoise ? 'noise' : 'active';
    if (isNoise) noise++;

    await dbQuery(
      `INSERT INTO people (id, user_id, name, source, linkedin_url, email, company, position, connected_at, last_interaction_at, interaction_count, status)
       VALUES (lower(hex(randomblob(16))), ?, ?, 'linkedin', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, name) DO UPDATE SET
         linkedin_url = COALESCE(excluded.linkedin_url, people.linkedin_url),
         email = COALESCE(NULLIF(excluded.email, ''), people.email),
         company = COALESCE(NULLIF(excluded.company, ''), people.company),
         position = COALESCE(NULLIF(excluded.position, ''), people.position),
         connected_at = COALESCE(excluded.connected_at, people.connected_at),
         last_interaction_at = CASE WHEN excluded.last_interaction_at > COALESCE(people.last_interaction_at, '') THEN excluded.last_interaction_at ELSE people.last_interaction_at END,
         interaction_count = MAX(excluded.interaction_count, people.interaction_count),
         status = CASE WHEN people.source != 'linkedin' THEN people.status ELSE excluded.status END,
         source = CASE WHEN people.source = 'manual' THEN 'linkedin' ELSE people.source END`,
      [USER_ID, name, linkedinUrl || null, email || null, company || null, position || null, connectedAt, lastInteraction, interactionCount, status]
    );
    imported++;

    if (imported % 100 === 0) process.stdout.write(`  Imported ${imported}/${connections.length}\r`);
  }

  console.log(`\nImported: ${imported}, Skipped: ${skipped}, Marked as noise: ${noise}`);

  // ── Step 4: Store LinkedIn messages with contact attribution ──
  console.log('\nStoring LinkedIn messages...');

  // Build linkedin_url → people.id lookup
  const peopleRows = (await dbQuery(
    `SELECT id, name, linkedin_url FROM people WHERE user_id = ? AND linkedin_url IS NOT NULL`,
    [USER_ID]
  )).results || [];
  const urlToPersonId = new Map();
  const urlToPersonName = new Map();
  for (const p of peopleRows) {
    if (p.linkedin_url) {
      urlToPersonId.set(p.linkedin_url, p.id);
      urlToPersonName.set(p.linkedin_url, p.name);
    }
  }

  // Check how many LinkedIn messages already exist (skip if re-running)
  const existingCount = (await dbQuery(
    `SELECT COUNT(*) as c FROM messages WHERE source = 'linkedin'`
  )).results?.[0]?.c || 0;

  if (existingCount > 0) {
    console.log(`  ${existingCount} LinkedIn messages already in DB — skipping (delete first to re-import)`);
  } else {
    // Group messages by conversation, collect participants per conversation
    const convMessages = new Map(); // convId → { ownerReplied, participants: Map<url, name>, messages: [] }
    for (const msg of messages) {
      const convId = msg['CONVERSATION ID'];
      if (!convId) continue;

      if (!convMessages.has(convId)) {
        convMessages.set(convId, { ownerReplied: false, participants: new Map(), messages: [] });
      }
      const conv = convMessages.get(convId);

      const from = msg['FROM'] || '';
      const senderUrl = msg['SENDER PROFILE URL'] || '';
      const date = msg['DATE'] || '';

      if (from === '${OWNER_NAME}') {
        conv.ownerReplied = true;
      } else if (from && senderUrl) {
        conv.participants.set(senderUrl, from);
      }

      if (msg['CONTENT']?.trim()) {
        conv.messages.push({ from, senderUrl, date, content: msg['CONTENT'], convId });
      }
    }

    let stored = 0;
    let groupChats = 0;
    for (const [convId, conv] of convMessages) {
      if (!conv.ownerReplied) continue;
      if (conv.participants.size > 1) groupChats++;

      // Build participant list for this conversation (all non-owner people)
      const participantNames = [...conv.participants.values()];
      const participantContactIds = [...conv.participants.entries()]
        .map(([url]) => urlToPersonId.get(url))
        .filter(Boolean);

      for (const msg of conv.messages) {
        const isOwner = msg.from === '${OWNER_NAME}';
        const contactId = isOwner ? null : urlToPersonId.get(msg.senderUrl);
        const contactName = isOwner ? null : (urlToPersonName.get(msg.senderUrl) || msg.from);

        // metadata: full attribution with all participants
        const metadata = JSON.stringify({
          platform: 'linkedin',
          sender_name: msg.from,
          sender_url: msg.senderUrl || null,
          direction: isOwner ? 'outbound' : 'inbound',
          participants: participantNames,
          participant_contact_ids: participantContactIds,
          is_group_chat: conv.participants.size > 1,
        });

        // entities: all people in this conversation (not just the sender)
        const entities = JSON.stringify({
          people: participantNames,
        });

        await dbQuery(
          `INSERT INTO messages (id, user_id, role, content, message_type, source, agent_id, contact_id, conversation_id, metadata, entities, scope, created_at)
           VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'chat', 'linkedin', 'personal-agent', ?, ?, ?, ?, 'personal', ?)`,
          [
            USER_ID,
            isOwner ? 'user' : 'assistant',  // user=owner, assistant=contact (for existing role enum)
            msg.content,
            contactId,                         // who sent THIS message
            convId,
            metadata,
            entities,
            msg.date || new Date().toISOString(),
          ]
        );
        stored++;
        if (stored % 200 === 0) process.stdout.write(`  Stored ${stored} messages\r`);
      }
    }
    console.log(`  Stored ${stored} LinkedIn messages (${groupChats} group chats)`);
  }

  // ── Summary ──
  const activeCount = (await dbQuery(
    `SELECT COUNT(*) as c FROM people WHERE user_id = ? AND status = 'active'`, [USER_ID]
  )).results?.[0]?.c || 0;

  const msgCount = (await dbQuery(
    `SELECT COUNT(*) as c FROM messages WHERE source = 'linkedin'`
  )).results?.[0]?.c || 0;

  const withContactCount = (await dbQuery(
    `SELECT COUNT(DISTINCT contact_id) as c FROM messages WHERE source = 'linkedin' AND contact_id IS NOT NULL`
  )).results?.[0]?.c || 0;

  console.log('\n── Summary ──');
  console.log(`Active contacts: ${activeCount}`);
  console.log(`Noise filtered:  ${noise}`);
  console.log(`LinkedIn messages stored: ${msgCount}`);
  console.log(`Contacts with messages: ${withContactCount}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
