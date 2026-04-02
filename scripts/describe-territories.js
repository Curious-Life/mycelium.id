#!/usr/bin/env node

/**
 * Living Territory Description Generator
 *
 * Gathers context for territories needing description (new, grew, split/merged),
 * computes dynamics (energy, vitality, steward agent), and triggers Mya's
 * Claude instance via /think to generate deep, evolving territory profiles.
 *
 * Replaces describe-clusters.js — no direct LLM calls. Claude generates
 * descriptions through the agent infrastructure.
 *
 * Usage:
 *   node scripts/describe-territories.js
 *   node scripts/describe-territories.js --dry-run
 *   node scripts/describe-territories.js --force          # regenerate all
 *   node scripts/describe-territories.js --version <ver>  # specific cluster version
 *
 * Env vars: MYA_WORKER_URL, AGENT_TOKEN_MYA or ADMIN_SECRET
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
for (const f of ['.env', '.env.discord', '.env.database', '.env.crypto', '.env.agents', '.env.cloudflare']) {
  config({ path: resolve(root, f) });
}

const WORKER_URL = process.env.MYA_WORKER_URL;
const TOKEN = process.env.AGENT_TOKEN_MYA || process.env.ADMIN_SECRET;
const MYA_AGENT_URL = process.env.MYA_AGENT_URL || 'http://localhost:3004';

if (!WORKER_URL || !TOKEN) {
  console.error('Missing MYA_WORKER_URL or auth token');
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const versionIdx = args.indexOf('--version');
const explicitVersion = versionIdx >= 0 ? args[versionIdx + 1] : null;

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${TOKEN}`,
};

// ── D1 Helpers ──────────────────────────────────────────────────────────

async function d1Query(sql, params = []) {
  const res = await fetch(`${WORKER_URL}/api/db/query`, {
    method: 'POST', headers,
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`D1 query failed (${res.status})`);
  return (await res.json()).results || [];
}

async function d1Run(sql, params = []) {
  const res = await fetch(`${WORKER_URL}/api/db/query`, {
    method: 'POST', headers,
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`D1 run failed (${res.status})`);
  return res.json();
}

async function d1Batch(statements) {
  const res = await fetch(`${WORKER_URL}/api/db/batch`, {
    method: 'POST', headers,
    body: JSON.stringify({ statements }),
  });
  if (!res.ok) throw new Error(`D1 batch failed (${res.status})`);
  return res.json();
}

// ── Agent Name Map ──────────────────────────────────────────────────────

const AGENT_NAMES = {
  'personal-agent': { name: 'Mya', role: 'personal assistant' },
  'mya-personal': { name: 'Mya', role: 'personal assistant' },
  'company-agent': { name: 'Com', role: 'company operations' },
  'research-agent': { name: 'Ada', role: 'research & analysis' },
  'commercial-intelligence': { name: 'Rex', role: 'commercial intelligence' },
  'wealth-agent': { name: 'Rob', role: 'wealth management' },
  'publishing-agent': { name: 'Noa', role: 'publishing & content' },
};

// ── Step 1: Identify territories needing description ────────────────────

async function getLatestClusterVersion() {
  if (explicitVersion) return explicitVersion;
  const rows = await d1Query(`
    SELECT DISTINCT cluster_version FROM cluster_events
    ORDER BY created_at DESC LIMIT 1
  `);
  return rows[0]?.cluster_version || null;
}

async function getTerritoriesNeedingDescription(version) {
  if (force) {
    // Force: get all territories with points
    const rows = await d1Query(`
      SELECT territory_id, COUNT(*) as cnt, MIN(realm_id) as realm_id
      FROM clustering_points
      WHERE territory_id IS NOT NULL
      GROUP BY territory_id
      HAVING cnt >= 3
      ORDER BY cnt DESC
    `);
    return rows.map(r => ({
      territory_id: r.territory_id,
      point_count: r.cnt,
      realm_id: r.realm_id,
      reason: 'force',
      point_delta: r.cnt,
    }));
  }

  // Get growth events for this version
  const events = await d1Query(`
    SELECT * FROM cluster_events
    WHERE cluster_version = ? AND level = 'territory'
    ORDER BY point_count DESC
  `, [version]);

  if (!events.length) {
    console.log('  No territory events found for this version');
    return [];
  }

  const needsDescription = [];

  for (const evt of events) {
    if (evt.event_type === 'dissolved') continue;

    if (evt.event_type === 'formed' || evt.event_type === 'split' || evt.event_type === 'merged') {
      needsDescription.push({
        territory_id: evt.cluster_id,
        point_count: evt.point_count,
        point_delta: evt.point_delta,
        reason: evt.event_type,
        realm_id: null, // filled later
      });
      continue;
    }

    if (evt.event_type === 'grew' || evt.event_type === 'stable') {
      // Check if description exists and if growth is significant
      const existing = await d1Query(`
        SELECT point_count_at_description, description_version
        FROM territory_profiles
        WHERE territory_id = ? AND user_id = (SELECT DISTINCT user_id FROM clustering_points LIMIT 1)
      `, [evt.cluster_id]);

      const prev = existing[0];
      if (!prev?.description_version) {
        // Never described
        needsDescription.push({
          territory_id: evt.cluster_id,
          point_count: evt.point_count,
          point_delta: evt.point_delta,
          reason: 'undescribed',
          realm_id: null,
        });
      } else if (evt.event_type === 'grew') {
        const prevCount = prev.point_count_at_description || 0;
        const growthPct = prevCount > 0 ? (evt.point_count - prevCount) / prevCount : 1;
        if (growthPct >= 0.2) {
          needsDescription.push({
            territory_id: evt.cluster_id,
            point_count: evt.point_count,
            point_delta: evt.point_delta,
            reason: `grew ${Math.round(growthPct * 100)}%`,
            realm_id: null,
          });
        }
      }
    }
  }

  // Fill realm_ids
  for (const t of needsDescription) {
    const rows = await d1Query(`
      SELECT realm_id FROM clustering_points
      WHERE territory_id = ? AND realm_id IS NOT NULL LIMIT 1
    `, [t.territory_id]);
    t.realm_id = rows[0]?.realm_id || null;
  }

  return needsDescription;
}

// ── Step 2: Compute dynamics per territory ──────────────────────────────

async function computeDynamics(territories, userId) {
  const totalPoints = await d1Query(`
    SELECT COUNT(*) as cnt FROM clustering_points WHERE territory_id IS NOT NULL
  `);
  const total = totalPoints[0]?.cnt || 1;

  for (const t of territories) {
    // Energy: attention share
    t.energy = t.point_count / total;

    // Steward agent: majority vote
    const agentVotes = await d1Query(`
      SELECT m.agent_id, COUNT(*) as cnt
      FROM clustering_points cp
      JOIN messages m ON m.id = cp.source_id
      WHERE cp.territory_id = ? AND cp.source_type = 'message'
      GROUP BY m.agent_id
      ORDER BY cnt DESC LIMIT 1
    `, [t.territory_id]);
    t.steward_agent_id = agentVotes[0]?.agent_id || 'personal-agent';

    // Growth state from reason
    if (t.reason === 'formed' || t.reason === 'split') {
      t.growth_state = 'growing';
    } else if (t.reason.startsWith('grew')) {
      t.growth_state = 'growing';
    } else {
      t.growth_state = 'steady';
    }

    // Vitality: approximate from tag overlap (fraction of messages with shared tags)
    const tagRows = await d1Query(`
      SELECT m.tags FROM clustering_points cp
      JOIN messages m ON m.id = cp.source_id
      WHERE cp.territory_id = ? AND m.tags IS NOT NULL AND LENGTH(m.tags) > 2
      ORDER BY RANDOM() LIMIT 50
    `, [t.territory_id]);

    if (tagRows.length >= 2) {
      const tagSets = tagRows.map(r => {
        try { return new Set(JSON.parse(r.tags)); } catch { return new Set(); }
      }).filter(s => s.size > 0);

      if (tagSets.length >= 2) {
        let overlapSum = 0;
        let pairs = 0;
        // Sample pairwise jaccard (max 100 pairs)
        for (let i = 0; i < Math.min(tagSets.length, 10); i++) {
          for (let j = i + 1; j < Math.min(tagSets.length, 10); j++) {
            const intersection = [...tagSets[i]].filter(t => tagSets[j].has(t)).length;
            const union = new Set([...tagSets[i], ...tagSets[j]]).size;
            overlapSum += union > 0 ? intersection / union : 0;
            pairs++;
          }
        }
        t.vitality = pairs > 0 ? overlapSum / pairs : 0;
      } else {
        t.vitality = 0;
      }
    } else {
      t.vitality = 0;
    }

    t.velocity = 0; // Will be computed by cluster.py in Phase 2
  }

  return territories;
}

// ── Step 3: Sample content with temporal stratification ──────────────────

async function sampleContent(territoryId, maxSamples = 20) {
  // Fetch messages with source type info
  const messages = await d1Query(`
    SELECT m.content, m.tags, m.entities, m.created_at, m.agent_id, cp.source_type
    FROM clustering_points cp
    JOIN messages m ON m.id = cp.source_id
    WHERE cp.territory_id = ?
      AND m.content IS NOT NULL AND LENGTH(m.content) > 10
    ORDER BY m.created_at ASC
  `, [territoryId]);

  // Also fetch documents in this territory
  const docs = await d1Query(`
    SELECT d.content, d.created_at, 'document' as source_type
    FROM clustering_points cp
    JOIN documents d ON d.id = cp.source_id
    WHERE cp.territory_id = ? AND cp.source_type = 'document'
      AND d.content IS NOT NULL AND LENGTH(d.content) > 10
    ORDER BY d.created_at ASC
  `, [territoryId]);

  // Fetch attachments (transcripts + image descriptions)
  const attachments = await d1Query(`
    SELECT COALESCE(a.transcript, a.description) as content, a.created_at,
           CASE WHEN a.transcript IS NOT NULL THEN 'transcript' ELSE 'image_description' END as source_type
    FROM clustering_points cp
    JOIN attachments a ON a.id = cp.source_id
    WHERE cp.territory_id = ? AND cp.source_type IN ('transcript', 'image_description')
      AND (a.transcript IS NOT NULL OR a.description IS NOT NULL)
    ORDER BY a.created_at ASC
  `, [territoryId]);

  // Combine all content sorted chronologically
  const allContent = [...messages, ...docs, ...attachments]
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));

  if (allContent.length === 0) return { samples: [], topTags: [], topEntities: [], dateRange: null, totalCount: 0, exploredCount: 0 };

  const n = allContent.length;
  const third = Math.max(1, Math.floor(n / 3));

  // Stratified: 20% early, 30% mid, 50% recent
  const periods = [
    { name: 'EARLY', slice: allContent.slice(0, third), target: Math.ceil(maxSamples * 0.2) },
    { name: 'MIDDLE', slice: allContent.slice(third, 2 * third), target: Math.ceil(maxSamples * 0.3) },
    { name: 'RECENT', slice: allContent.slice(2 * third), target: Math.ceil(maxSamples * 0.5) },
  ];

  const samples = [];
  const tagCounter = {};
  const entityCounter = {}; // type → name → count

  // Source type labels (MYA-0.2 style)
  const SOURCE_LABELS = {
    message: '',
    document: '[Document] ',
    transcript: '[Voice] ',
    image_description: '[Image] ',
  };

  for (const { name, slice, target } of periods) {
    const shuffled = [...slice].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, Math.min(target, slice.length));

    for (const m of selected) {
      const content = (m.content || '').slice(0, 400);
      const date = (m.created_at || '').slice(0, 10);
      const label = SOURCE_LABELS[m.source_type] || '';
      samples.push(`[${name}][${date}] ${label}${content}`);
    }
  }

  // Aggregate tags and entities from ALL content (with counts)
  for (const m of allContent) {
    try {
      const tags = typeof m.tags === 'string' ? JSON.parse(m.tags) : m.tags;
      if (Array.isArray(tags)) {
        for (const t of tags) tagCounter[t] = (tagCounter[t] || 0) + 1;
      }
    } catch {}
    try {
      const ent = typeof m.entities === 'string' ? JSON.parse(m.entities) : m.entities;
      if (ent && typeof ent === 'object') {
        for (const [type, arr] of Object.entries(ent)) {
          if (Array.isArray(arr)) {
            for (const e of arr) {
              const key = `${e}|||${type}`;
              entityCounter[key] = (entityCounter[key] || 0) + 1;
            }
          }
        }
      }
    } catch {}
  }

  // Tags with counts
  const topTags = Object.entries(tagCounter)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  // Entities with type + count (MYA-0.2 style)
  const topEntities = Object.entries(entityCounter)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([key, count]) => {
      const [name, type] = key.split('|||');
      return { name, type, count };
    });

  const firstDate = (allContent[0]?.created_at || '').slice(0, 10);
  const lastDate = (allContent[n - 1]?.created_at || '').slice(0, 10);

  return {
    samples,
    topTags,
    topEntities,
    dateRange: { first: firstDate, last: lastDate },
    totalCount: n,
    exploredCount: samples.length,
  };
}

// ── Step 3b: Get neighboring territories ─────────────────────────────────

async function getNeighbors(territoryId, userId) {
  const neighbors = await d1Query(`
    SELECT tn.neighbor_id, tp.name
    FROM territory_neighbors tn
    LEFT JOIN territory_profiles tp ON tp.territory_id = tn.neighbor_id AND tp.user_id = tn.user_id
    WHERE tn.territory_id = ? AND tn.user_id = ?
    ORDER BY tn.distance ASC
    LIMIT 5
  `, [territoryId, userId]);
  return neighbors.filter(n => n.name).map(n => n.name);
}

// ── Step 4: Get existing description (for evolution, not reset) ─────────

async function getExistingProfile(territoryId, userId) {
  const rows = await d1Query(`
    SELECT name, essence, story_birth, story_arc, story_current_chapter,
           signature_patterns, uncertainty_open_questions
    FROM territory_profiles
    WHERE territory_id = ? AND user_id = ? AND name IS NOT NULL
  `, [territoryId, userId]);
  return rows[0] || null;
}

// ── Step 5: Build the description prompt ────────────────────────────────

// Level-specific banned words (from MYA-0.2)
const BANNED_TERRITORY = [
  'consciousness', 'threshold', 'emergence', 'becoming', 'architecture',
  'transformation', 'journey', 'landscape', 'essence', 'being', 'existence',
  'awakening', 'unfolding', 'pattern', 'weaving', 'tapestry', 'midwife',
  'keeper', 'architect', 'sovereign', 'cartography', 'nexus', 'synthesis',
  'odyssey', 'paradigm', 'delve', 'dance', 'resonate', 'craft',
].join(', ');

const BANNED_REALM = [
  'consciousness', 'architecture', 'transformation', 'infrastructure',
  'evolution', 'emergence', 'becoming', 'threshold', 'cartography',
  'journey', 'landscape', 'terrain', 'realm', 'space', 'domain',
  'nexus', 'synthesis', 'integration', 'paradigm', 'odyssey', 'delve',
].join(', ');

function buildDescriptionPrompt(territories, userId) {
  let prompt = `## System Role

You are categorizing a collection of messages, documents, voice transcripts, and images based on their ACTUAL CONTENT.

Look at the entries. What specific topics, activities, or conversations do they contain?

Examples of GOOD names:
- "Work Projects & Deadlines" (if about job tasks, meetings, deliverables)
- "Fitness & Nutrition Tracking" (if about workouts, meals, health data)
- "Side Project: Recipe App" (if about building a specific project)
- "Debugging Auth Issues" (if about fixing login/auth bugs)
- "Family Conversations" (if about conversations with partner/family)
- "AI Tool Experiments" (if about trying AI tools)

Examples of BAD names (too abstract/poetic):
- "The Consciousness Midwife"
- "Sovereignty's Architect"
- "The Threshold Keeper"
- "Emergence Patterns"

Be a librarian, not a poet. What folder would these entries go in?

---

## Territory Description Generation

Generate living territory profiles for the Mycelium knowledge system.
Each territory is a semantic cluster of messages, documents, voice transcripts, and images.
These are LIVING DOCUMENTS that evolve across cycles.

### Rules

BANNED WORDS (do not use): ${BANNED_TERRITORY}

EVIDENCE BINDING (MANDATORY):
1. Every sentence MUST reference specific content from the samples (a tag, entity, or topic)
2. THE SWAP TEST: Would this sentence be true for ANY cluster of messages? If yes, DELETE and rewrite.
3. Ground every claim. "Python debugging" = grounded. "Exploring possibilities" = not.
4. If territory has < 20 entries, note: "[Thin evidence — N entries sampled]"

### Output Format

Return a JSON array of territory objects. Each object must have these fields:
- territory_id (integer)
- name (string, 2-4 words, concrete folder label)
- essence (string, 2-3 sentences describing actual topics discussed)
- archetype_type (string, one word: Work, Health, Projects, Relationships, Hobbies, Learning, etc.)
- archetype_character (string, one sentence — what's the general vibe/focus?)
- story_birth (string, when did this territory start? Look at [EARLY] entries)
- story_arc (string, 2-3 sentences, how evolved from [EARLY] → [MIDDLE] → [RECENT])
- story_current_chapter (string, 1-2 sentences, CRITICAL: base ONLY on [RECENT] entries at the END)
- story_peak_moments (array of 1-2 strings, significant milestones)
- signature_patterns (array of 3 strings, recurring topics/activities)
- uncertainty_open_questions (array of 2-3 strings, unresolved questions or decisions)
- uncertainty_edges (string, what related topics does this connect to? Which neighbors overlap?)
- agent_expertise (string, what knowledge does this territory contain?)
- agent_curious_about (string, what questions remain open?)
- agent_can_help_with (array of 2-3 strings, types of questions this territory could answer)
- agent_would_consult (array of 1-2 strings, which neighbor territory for what topic?)
- top_entities (array of strings, key entities mentioned)
- point_count (integer)

### Temporal Framing

IMPORTANT: Content samples are sorted OLDEST to NEWEST (chronological order).
- [EARLY] = oldest entries (beginning of this territory)
- [MIDDLE] = middle period
- [RECENT] = most recent entries (current activity)

Source labels: [Document] = stored document, [Voice] = voice transcript, [Image] = image description.
Unlabeled entries are chat messages.

### Territories to Describe

`;

  for (const t of territories) {
    const steward = AGENT_NAMES[t.steward_agent_id] || { name: 'Unknown', role: 'agent' };
    const existing = t._existingProfile;

    prompt += `---
#### Territory ${t.territory_id} (${t.reason})${t.is_liminal ? ' [LIMINAL]' : ''}
Points: ${t.point_count} | Energy: ${(t.energy * 100).toFixed(1)}% | Growth: ${t.growth_state}
Vitality: ${t.vitality?.toFixed(2) || '?'} | Steward: ${steward.name} (${steward.role})
Realm: ${t.realm_id || 'unassigned'}
Date range: ${t._samples?.dateRange?.first || '?'} to ${t._samples?.dateRange?.last || '?'}
Total entries: ${t._samples?.totalCount || 0} | Explored: ${t._samples?.exploredCount || 0} of ${t._samples?.totalCount || 0} (${t._samples?.totalCount > 0 ? Math.round((t._samples.exploredCount / t._samples.totalCount) * 100) : 0}%)
`;

    // Liminal territory special instructions
    if (t.is_liminal) {
      prompt += `
NOTE: This is a LIMINAL territory — these items didn't cluster strongly with others.
They may be miscellaneous topics, one-off conversations, or things spanning multiple categories.
Look at what they actually contain. Name should reflect the actual content even if diverse.
Examples: "Miscellaneous & One-offs", "Random Experiments", "Mixed Conversations"
`;
    }

    // Thin evidence warning
    if ((t._samples?.totalCount || 0) < 20) {
      prompt += `[Thin evidence — ${t._samples?.totalCount || 0} entries. Claims should be hedged.]\n`;
    }

    // Tags with counts (MYA-0.2 style)
    if (t._samples?.topTags?.length) {
      prompt += `Top tags: ${t._samples.topTags.map(([tag, cnt]) => `${tag} (${cnt})`).join(', ')}\n`;
    }

    // Entities with type + count (MYA-0.2 style)
    if (t._samples?.topEntities?.length) {
      prompt += `Key entities:\n`;
      for (const e of t._samples.topEntities) {
        prompt += `- ${e.name} (${e.type}): ${e.count} mentions\n`;
      }
    }

    // Neighboring territories
    if (t._neighbors?.length) {
      prompt += `Neighboring territories: ${t._neighbors.join(', ')}\n`;
    }

    if (existing) {
      prompt += `
PREVIOUS DESCRIPTION (evolve, don't reset):
  Name: "${existing.name}"
  Essence: "${existing.essence || ''}"
  Story arc: "${existing.story_arc || ''}"
  Current chapter: "${existing.story_current_chapter || ''}"
  Patterns: ${existing.signature_patterns || '[]'}

This territory ${t.reason === 'formed' ? 'is newly formed' : `has changed (${t.reason}, delta: ${t.point_delta} points)`}.
EVOLVE the description. Update current chapter, note new patterns.
Keep what's still accurate, modify what's shifted.
`;
    }

    if (t._samples?.samples?.length) {
      prompt += `\nContent samples (${t._samples.samples.length} of ${t._samples.totalCount}, sorted oldest → newest):\n`;
      for (const s of t._samples.samples) {
        prompt += `${s}\n`;
      }
    }

    prompt += '\n';
  }

  prompt += `
---

Now generate the JSON array of territory descriptions.
Wrap output in a JSON code block. Example:
\`\`\`json
[{"territory_id": 1, "name": "API Development", ...}]
\`\`\`

After generating descriptions, store each one by calling curl to save to the database.
IMPORTANT: Include raw_llm_output with the FULL text you generated (before parsing), so we can debug parsing issues.

\`\`\`bash
curl -X POST http://localhost:${process.env.PORT || 3004}/territory/describe \\
  -H "Content-Type: application/json" \\
  -d '{"territories": [<your JSON array>], "version": "${territories[0]?._version || ''}", "raw_llm_output": "<your full raw output text>"}'
\`\`\`
`;

  return prompt;
}

// ── Step 6: Build realm rollup prompt ───────────────────────────────────

async function buildRealmPrompt(userId) {
  const realms = await d1Query(`
    SELECT DISTINCT realm_id, COUNT(*) as cnt
    FROM clustering_points WHERE realm_id IS NOT NULL
    GROUP BY realm_id ORDER BY cnt DESC
  `);

  if (!realms.length) return null;

  const profiles = await d1Query(`
    SELECT territory_id, realm_id, name, essence, energy, growth_state, message_count,
           top_entities, signature_patterns
    FROM territory_profiles WHERE user_id = ? AND name IS NOT NULL
    ORDER BY realm_id, energy DESC
  `, [userId]);

  if (!profiles.length) return null;

  // Get neighboring realm info
  const realmNeighbors = await d1Query(`
    SELECT rn.realm_id, rn.neighbor_id, r.name as neighbor_name, r.essence as neighbor_essence
    FROM realm_neighbors rn
    LEFT JOIN realms r ON r.realm_id = rn.neighbor_id AND r.user_id = ?
    WHERE rn.user_id = ?
  `, [userId, userId]);

  let prompt = `## System Role

You are categorizing a collection of territories based on their ACTUAL CONTENT.

Look at the territory names, entities, and descriptions. What specific topics do they discuss?

Examples of GOOD names:
- "Software Engineering & DevOps" (if about coding, deployments, bugs)
- "Family & Parenting" (if about kids, spouse, home life)
- "Startup Strategy & Fundraising" (if about investors, pitch decks, growth)
- "Health & Fitness Tracking" (if about workouts, diet, sleep)
- "Creative Writing Projects" (if about stories, drafts, characters)

Examples of BAD names (too abstract):
- "Consciousness Architecture"
- "Personal Transformation"
- "The Infrastructure of Becoming"

Be a librarian, not a poet. What section of the library would these topics go in?

---

## Realm Description Rollup

Generate realm-level descriptions from their territory profiles.
Realms are the highest level of the knowledge hierarchy.

BANNED WORDS (do not use): ${BANNED_REALM}

EVIDENCE BINDING:
1. Every claim must reference specific territory content
2. THE SWAP TEST: Would this be true for ANY realm? DELETE and rewrite.

Output JSON array. Each object must have:
- realm_id (integer)
- name (string, 2-4 words)
- essence (string, 2-3 sentences unifying the territories)
- archetype_type (string, one word: Work, Health, Relationships, etc.)
- archetype_character (string, 1-2 sentences)
- story_birth (string, when did this realm start?)
- story_arc (string, 2-3 sentences, how it evolved)
- story_current_chapter (string, 2-3 sentences, what's currently active)
- story_peak_moments (array of 2-3 strings)
- signature_patterns (array of 3-4 strings, recurring topics across territories)
- uncertainty_open_questions (array of 3 strings)
- uncertainty_edges (string, related topics and neighboring realms)
- agent_expertise (string, what knowledge this realm contains)
- agent_can_help_with (array of 3-4 strings)
- territory_count (integer)
- message_count (integer)
- top_entities (array of strings)

### Realms

`;

  for (const realm of realms) {
    const realmProfiles = profiles.filter(p => p.realm_id === realm.realm_id);
    const neighbors = realmNeighbors
      .filter(n => n.realm_id === realm.realm_id && n.neighbor_name)
      .map(n => `${n.neighbor_name}: ${(n.neighbor_essence || '').slice(0, 80)}`)
      .slice(0, 5);

    const totalMsgs = realmProfiles.reduce((s, p) => s + (p.message_count || 0), 0);

    prompt += `#### Realm ${realm.realm_id} (${realm.cnt} points, ${totalMsgs} messages, ${realmProfiles.length} territories)\nTerritories:\n`;
    for (const p of realmProfiles.slice(0, 15)) {
      const patterns = (() => { try { return JSON.parse(p.signature_patterns || '[]').slice(0, 2).join(', '); } catch { return ''; } })();
      prompt += `  - "${p.name}" (${p.growth_state || 'steady'}, ${p.message_count} msgs, ${((p.energy || 0) * 100).toFixed(1)}% energy): ${(p.essence || '').slice(0, 120)}${patterns ? ` | Patterns: ${patterns}` : ''}\n`;
    }
    if (realmProfiles.length > 15) {
      prompt += `  - ... and ${realmProfiles.length - 15} more territories\n`;
    }
    if (neighbors.length) {
      prompt += `Neighboring realms:\n`;
      for (const n of neighbors) prompt += `  - ${n}\n`;
    }
    prompt += '\n';
  }

  prompt += `
Store results (include raw_llm_output):
\`\`\`bash
curl -X POST http://localhost:${process.env.PORT || 3004}/realm/describe \\
  -H "Content-Type: application/json" \\
  -d '{"realms": [<JSON array>], "raw_llm_output": "<your full raw output>"}'
\`\`\`
`;

  return prompt;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  Living Territory Description Generator       ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  Dry run: ${dryRun}`);
  console.log(`  Force:   ${force}`);

  // Get user_id
  const users = await d1Query(`SELECT DISTINCT user_id FROM clustering_points WHERE user_id IS NOT NULL LIMIT 1`);
  const userId = users[0]?.user_id || process.env.MYA_USER_ID || 'owner';

  // Get latest cluster version
  const version = await getLatestClusterVersion();
  console.log(`  Cluster version: ${version || 'none'}`);

  if (!version && !force) {
    console.log('  No cluster version found. Run cluster.py first, or use --force.');
    return;
  }

  // Find territories needing description
  let territories = await getTerritoriesNeedingDescription(version);
  console.log(`\n  Territories needing description: ${territories.length}`);

  if (territories.length === 0) {
    console.log('  All territories up to date.');
    // Still try realm rollup
    if (!dryRun) {
      const realmPrompt = await buildRealmPrompt(userId);
      if (realmPrompt) {
        console.log('\n  Triggering realm description rollup...');
        await triggerThink(realmPrompt);
      }
    }
    return;
  }

  // Cap at 30 territories per cycle to avoid overwhelming Claude
  if (territories.length > 30) {
    console.log(`  Capping to 30 territories (${territories.length - 30} deferred to next cycle)`);
    territories = territories.slice(0, 30);
  }

  // Compute dynamics
  console.log('\n  Computing dynamics...');
  territories = await computeDynamics(territories, userId);

  // Write dynamics to D1
  if (!dryRun) {
    console.log('  Writing dynamics to territory_profiles...');
    const statements = territories.map(t => ({
      sql: `INSERT INTO territory_profiles (user_id, territory_id, energy, vitality, velocity,
              growth_state, steward_agent_id, message_count, point_delta, realm_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(territory_id, user_id) DO UPDATE SET
              energy = excluded.energy, vitality = excluded.vitality,
              velocity = excluded.velocity, growth_state = excluded.growth_state,
              steward_agent_id = excluded.steward_agent_id,
              message_count = excluded.message_count, point_delta = excluded.point_delta,
              realm_id = excluded.realm_id, updated_at = datetime('now')`,
      params: [userId, t.territory_id, t.energy, t.vitality, t.velocity,
               t.growth_state, t.steward_agent_id, t.point_count, t.point_delta, t.realm_id],
    }));

    for (let i = 0; i < statements.length; i += 50) {
      await d1Batch(statements.slice(i, i + 50));
    }
  }

  // Check which territories are liminal (noise clusters)
  console.log('  Checking liminal status...');
  for (const t of territories) {
    const liminalRows = await d1Query(`
      SELECT COUNT(*) as cnt FROM clustering_points
      WHERE territory_id = ? AND is_liminal = 1
    `, [t.territory_id]);
    t.is_liminal = (liminalRows[0]?.cnt || 0) > 0;
  }

  // Sample content for each territory (messages, docs, transcripts, images)
  console.log('  Sampling content & fetching neighbors...');
  for (const t of territories) {
    t._samples = await sampleContent(t.territory_id);
    t._existingProfile = await getExistingProfile(t.territory_id, userId);
    t._neighbors = await getNeighbors(t.territory_id, userId);
    t._version = version;

    if (dryRun) {
      const steward = AGENT_NAMES[t.steward_agent_id] || { name: '?', role: '?' };
      const tagStr = (t._samples.topTags || []).slice(0, 5).map(([tag, cnt]) => `${tag}(${cnt})`).join(', ');
      const neighborStr = t._neighbors?.length ? `, neighbors=[${t._neighbors.slice(0, 3).join(', ')}]` : '';
      console.log(`    Territory ${t.territory_id} (${t.reason}): ${t.point_count} pts, ` +
        `${(t.energy * 100).toFixed(1)}% energy, steward=${steward.name}, ` +
        `tags=[${tagStr}]${neighborStr}, ` +
        `${t._existingProfile ? `was "${t._existingProfile.name}"` : 'NEW'}`);
    }
  }

  if (dryRun) {
    console.log('\n  Dry run — not triggering Claude.');
    return;
  }

  // Write exploration tracking (explored_count, explored_percent)
  console.log('  Writing exploration tracking...');
  const explorationStmts = territories
    .filter(t => t._samples?.totalCount > 0)
    .map(t => ({
      sql: `UPDATE territory_profiles SET explored_count = ?, explored_percent = ?
            WHERE territory_id = ? AND user_id = ?`,
      params: [
        t._samples.exploredCount,
        t._samples.totalCount > 0 ? Math.round((t._samples.exploredCount / t._samples.totalCount) * 100) : 0,
        t.territory_id,
        userId,
      ],
    }));
  for (let i = 0; i < explorationStmts.length; i += 50) {
    await d1Batch(explorationStmts.slice(i, i + 50));
  }

  // Build and send the description prompt to Mya
  const prompt = buildDescriptionPrompt(territories, userId);
  console.log(`\n  Description prompt: ${prompt.length} chars for ${territories.length} territories`);

  // Record moments of interest for newly formed territories
  for (const t of territories) {
    if (t.reason === 'formed') {
      const moment = {
        type: 'birth',
        version,
        detail: `Territory formed with ${t.point_count} points`,
        timestamp: new Date().toISOString(),
      };
      try {
        const existing = await d1Query(
          `SELECT moments_of_interest FROM territory_profiles WHERE territory_id = ? AND user_id = ?`,
          [t.territory_id, userId],
        );
        const moments = [];
        try {
          const parsed = JSON.parse(existing[0]?.moments_of_interest || '[]');
          if (Array.isArray(parsed)) moments.push(...parsed);
        } catch {}
        moments.push(moment);
        await d1Run(
          `UPDATE territory_profiles SET moments_of_interest = ? WHERE territory_id = ? AND user_id = ?`,
          [JSON.stringify(moments.slice(-20)), t.territory_id, userId],
        );
      } catch (e) {
        console.warn(`  Failed to record birth moment for territory ${t.territory_id}: ${e.message}`);
      }
    }
  }

  console.log('  Triggering Mya /think for territory descriptions...');
  await triggerThink(prompt);

  console.log('\n  Description generation triggered. Mya will process asynchronously.');
}

async function triggerThink(prompt) {
  try {
    const res = await fetch(`${MYA_AGENT_URL}/think`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        trigger: 'territory-description',
        maxTurns: 80,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.skipped) {
        console.log(`  Mya is busy (${data.reason}). Description will be deferred.`);
      } else {
        console.log('  Think cycle triggered successfully.');
      }
    } else {
      console.error(`  Failed to trigger /think: ${res.status}`);
    }
  } catch (e) {
    console.error(`  Failed to reach Mya at ${MYA_AGENT_URL}: ${e.message}`);
    console.log('  Run manually: curl -X POST http://localhost:3004/think -H "Content-Type: application/json" -d \'{"prompt":"..."}\'');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
