#!/usr/bin/env node

/**
 * Territory Chronicle Generator
 *
 * Generates living territory descriptions using Claude CLI directly.
 * Each territory gets its own Claude call with managed context.
 *
 * Key design principles:
 * - Per-territory calls (not batched) — each territory gets full Claude attention
 * - Tracked cursor — knows which messages have been analyzed, never re-processes
 * - Context budgeting — samples within token limits, tells model what % it sees
 * - Incremental — only describes territories with new unanalyzed content
 * - Evolving — passes previous chronicle so Claude builds on it, not rewrites
 *
 * Usage:
 *   node scripts/describe-chronicles.js                    # incremental (changed territories)
 *   node scripts/describe-chronicles.js --force            # all territories
 *   node scripts/describe-chronicles.js --limit 5          # cap number of territories
 *   node scripts/describe-chronicles.js --territory 1012   # specific territory
 *   node scripts/describe-chronicles.js --dry-run          # preview without calling Claude
 *   node scripts/describe-chronicles.js --model opus       # model override (default: sonnet)
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
for (const f of ['.env', '.env.discord', '.env.database', '.env.crypto', '.env.agents', '.env.cloudflare']) {
  config({ path: resolve(root, f) });
}

const WORKER_URL = process.env.MYA_WORKER_URL;
const TOKEN = process.env.ADMIN_SECRET || process.env.AGENT_TOKEN_MYA;
const OWNER_ID = process.env.MINDSCAPE_OWNER_ID;

if (!WORKER_URL || !TOKEN) {
  console.error('Missing MYA_WORKER_URL or auth token');
  process.exit(1);
}
if (!OWNER_ID) {
  console.error('Missing MINDSCAPE_OWNER_ID — set in .env');
  process.exit(1);
}

// ── CLI Args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const limitIdx = args.indexOf('--limit');
const maxTerritories = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : 20;
const territoryIdx = args.indexOf('--territory');
const singleTerritory = territoryIdx >= 0 ? parseInt(args[territoryIdx + 1]) : null;
const modelIdx = args.indexOf('--model');
const claudeModel = modelIdx >= 0 ? args[modelIdx + 1] : 'haiku';

// Context budget: ~50 messages per territory, ~150 chars avg = ~7500 chars content
// Plus prompt overhead ~3000 chars = ~10K chars total ≈ ~3K tokens. Well within limits.
const MAX_SAMPLES_PER_TERRITORY = 50;
const MAX_CONTENT_CHARS = 300; // truncate individual messages

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
  if (!res.ok) throw new Error(`D1 query failed (${res.status}): ${await res.text()}`);
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

// ── Agent Name Map ──────────────────────────────────────────────────────

const AGENT_NAMES = {
  'personal-agent': 'Mya', 'mya-personal': 'Mya',
  'company-agent': 'Com', 'research-agent': 'Ada',
  'commercial-intelligence': 'Rex', 'wealth-agent': 'Rob',
  'publishing-agent': 'Noa',
};

// ── Step 1: Find territories needing chronicles ─────────────────────────

async function getTerritoriesForChronicle() {
  if (singleTerritory) {
    const rows = await d1Query(`
      SELECT territory_id, realm_id, COUNT(*) as point_count,
             MIN(cp.created_at) as earliest, MAX(cp.created_at) as latest
      FROM clustering_points cp
      WHERE territory_id = ? AND territory_id IS NOT NULL
      GROUP BY territory_id
    `, [singleTerritory]);
    return rows;
  }

  if (force) {
    // All territories with at least 3 points
    return await d1Query(`
      SELECT territory_id, MIN(realm_id) as realm_id, COUNT(*) as point_count,
             MIN(cp.created_at) as earliest, MAX(cp.created_at) as latest
      FROM clustering_points cp
      WHERE territory_id IS NOT NULL AND realm_id IS NOT NULL AND realm_id >= 0
      GROUP BY territory_id
      HAVING point_count >= 3
      ORDER BY point_count DESC
    `);
  }

  // Incremental: territories with new content since last chronicle
  // A territory needs a chronicle update if:
  // 1. It has no chronicle at all (chronicle IS NULL)
  // 2. It has new points since the last chronicle cursor
  const allTerritories = await d1Query(`
    SELECT cp.territory_id, MIN(cp.realm_id) as realm_id, COUNT(*) as point_count,
           MIN(cp.created_at) as earliest, MAX(cp.created_at) as latest,
           tp.chronicle_cursor, tp.chronicle, tp.name
    FROM clustering_points cp
    LEFT JOIN territory_profiles tp ON tp.territory_id = cp.territory_id AND tp.user_id = ?
    WHERE cp.territory_id IS NOT NULL AND cp.realm_id IS NOT NULL AND cp.realm_id >= 0
    GROUP BY cp.territory_id
    HAVING point_count >= 3
    ORDER BY point_count DESC
  `, [OWNER_ID]);

  const needsUpdate = [];
  for (const t of allTerritories) {
    if (!t.chronicle && !t.name) {
      // Never described
      needsUpdate.push({ ...t, reason: 'new' });
      continue;
    }

    if (t.chronicle_cursor) {
      try {
        const cursor = JSON.parse(t.chronicle_cursor);
        // Check if total points grew since last analysis
        if (t.point_count > (cursor.total_at_analysis || 0)) {
          const newCount = t.point_count - (cursor.total_at_analysis || 0);
          needsUpdate.push({ ...t, reason: `+${newCount} new points` });
        }
      } catch {
        needsUpdate.push({ ...t, reason: 'bad cursor' });
      }
    } else if (t.chronicle || t.name) {
      // Has old description but no cursor — needs re-analysis with tracking
      needsUpdate.push({ ...t, reason: 'no cursor' });
    }
  }

  return needsUpdate;
}

// ── Step 2: Sample content for a territory ──────────────────────────────

async function sampleContent(territoryId) {
  // Get ALL content IDs and timestamps for this territory (lightweight query)
  const allPoints = await d1Query(`
    SELECT cp.source_id, cp.source_type, cp.created_at
    FROM clustering_points cp
    WHERE cp.territory_id = ?
    ORDER BY cp.created_at ASC
  `, [territoryId]);

  const total = allPoints.length;
  if (total === 0) return { samples: [], total, sampled: 0 };

  // Stratified sampling: early (25%), middle (25%), recent (50%)
  const earlyEnd = Math.floor(total * 0.25);
  const midEnd = Math.floor(total * 0.5);

  const earlyPool = allPoints.slice(0, earlyEnd);
  const midPool = allPoints.slice(earlyEnd, midEnd);
  const recentPool = allPoints.slice(midEnd);

  const earlyCount = Math.min(Math.floor(MAX_SAMPLES_PER_TERRITORY * 0.25), earlyPool.length);
  const midCount = Math.min(Math.floor(MAX_SAMPLES_PER_TERRITORY * 0.25), midPool.length);
  const recentCount = Math.min(MAX_SAMPLES_PER_TERRITORY - earlyCount - midCount, recentPool.length);

  function pickRandom(pool, n) {
    if (n >= pool.length) return pool;
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n);
  }

  const selected = [
    ...pickRandom(earlyPool, earlyCount).map(p => ({ ...p, period: 'early' })),
    ...pickRandom(midPool, midCount).map(p => ({ ...p, period: 'middle' })),
    ...pickRandom(recentPool, recentCount).map(p => ({ ...p, period: 'recent' })),
  ];

  // Fetch actual content for selected points
  const samples = [];
  for (const point of selected) {
    let content = null;
    let agentId = null;

    if (point.source_type === 'message') {
      const rows = await d1Query(`
        SELECT content, agent_id, tags, entities FROM messages WHERE id = ? LIMIT 1
      `, [point.source_id]);
      if (rows[0]) {
        content = rows[0].content;
        agentId = rows[0].agent_id;
      }
    } else if (point.source_type === 'document') {
      const rows = await d1Query(`
        SELECT content FROM documents WHERE id = ? LIMIT 1
      `, [point.source_id]);
      content = rows[0]?.content;
    } else if (point.source_type === 'transcript' || point.source_type === 'image_description') {
      const rows = await d1Query(`
        SELECT COALESCE(transcript, description) as content FROM attachments WHERE id = ? LIMIT 1
      `, [point.source_id]);
      content = rows[0]?.content;
    }

    if (content && content.length > 10) {
      const truncated = content.length > MAX_CONTENT_CHARS
        ? content.slice(0, MAX_CONTENT_CHARS) + '...'
        : content;

      samples.push({
        period: point.period,
        date: point.created_at?.split('T')[0] || '?',
        type: point.source_type,
        agent: agentId ? (AGENT_NAMES[agentId] || agentId) : null,
        content: truncated,
      });
    }
  }

  // Sort by date within periods
  samples.sort((a, b) => {
    const periodOrder = { early: 0, middle: 1, recent: 2 };
    if (periodOrder[a.period] !== periodOrder[b.period]) return periodOrder[a.period] - periodOrder[b.period];
    return a.date.localeCompare(b.date);
  });

  return { samples, total, sampled: samples.length };
}

// ── Step 3: Get territory context (neighbors, dynamics) ─────────────────

async function getTerritoryContext(territoryId, realmId) {
  // Get existing profile
  const profile = await d1Query(`
    SELECT name, essence, chronicle, story_arc, story_current_chapter,
           energy, vitality, velocity, growth_state, steward_agent_id,
           message_count, chronicle_cursor
    FROM territory_profiles
    WHERE territory_id = ?
    LIMIT 1
  `, [territoryId]);

  // Get sibling territories in same realm (for neighbor context)
  const siblings = await d1Query(`
    SELECT tp.territory_id, tp.name, tp.essence, COUNT(cp.id) as point_count
    FROM territory_profiles tp
    JOIN clustering_points cp ON cp.territory_id = tp.territory_id
    WHERE tp.realm_id = ? AND tp.territory_id != ?
    GROUP BY tp.territory_id
    ORDER BY point_count DESC
    LIMIT 5
  `, [realmId, territoryId]);

  // Get top tags and entities
  const tagRows = await d1Query(`
    SELECT m.tags FROM clustering_points cp
    JOIN messages m ON m.id = cp.source_id
    WHERE cp.territory_id = ? AND m.tags IS NOT NULL AND LENGTH(m.tags) > 2
    ORDER BY RANDOM() LIMIT 100
  `, [territoryId]);

  const tagCounts = {};
  for (const r of tagRows) {
    try {
      for (const tag of JSON.parse(r.tags)) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    } catch { /* skip bad json */ }
  }
  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([tag, count]) => `${tag} (${count})`);

  // Get agent distribution
  const agentDist = await d1Query(`
    SELECT m.agent_id, COUNT(*) as cnt
    FROM clustering_points cp
    JOIN messages m ON m.id = cp.source_id
    WHERE cp.territory_id = ? AND cp.source_type = 'message'
    GROUP BY m.agent_id
    ORDER BY cnt DESC
  `, [territoryId]);

  return {
    existing: profile[0] || null,
    siblings: siblings.map(s => ({
      id: s.territory_id,
      name: s.name || `Territory ${s.territory_id}`,
      essence: s.essence,
      points: s.point_count,
    })),
    topTags,
    agentDistribution: agentDist.map(a => ({
      agent: AGENT_NAMES[a.agent_id] || a.agent_id,
      count: a.cnt,
    })),
  };
}

// ── Step 4: Build prompt for a single territory ─────────────────────────

function buildPrompt(territory, content, context) {
  const { samples, total, sampled } = content;
  const pct = total > 0 ? ((sampled / total) * 100).toFixed(1) : '0';
  const existing = context.existing;

  let prompt = `You are analyzing a territory in a personal knowledge landscape (Mindscape).
This territory is a cluster of semantically related messages, documents, and transcripts from one person's life and work.

## Your Task
Write a chronicle for Territory ${territory.territory_id} (Realm ${territory.realm_id}).
`;

  // Context awareness
  prompt += `
## Coverage
You are seeing ${sampled} of ${total} total data points (${pct}% coverage).
${sampled < total ? `The remaining ${total - sampled} points were not shown to save context. Your sample is stratified: ~25% early content, ~25% middle, ~50% recent.` : 'You are seeing all content in this territory.'}
`;

  // Existing chronicle (for evolution)
  if (existing?.chronicle) {
    prompt += `
## Previous Chronicle (evolve, don't rewrite)
${existing.chronicle}
`;
  } else if (existing?.name || existing?.essence) {
    prompt += `
## Previous Description (basic — expand into full chronicle)
Name: ${existing.name || 'unnamed'}
Essence: ${existing.essence || 'none'}
${existing.story_arc ? `Story: ${existing.story_arc}` : ''}
${existing.story_current_chapter ? `Current chapter: ${existing.story_current_chapter}` : ''}
`;
  }

  // Dynamics
  if (existing) {
    prompt += `
## Territory Dynamics
- Energy (attention share): ${((existing.energy || 0) * 100).toFixed(1)}%
- Growth state: ${existing.growth_state || 'unknown'}
- Vitality (internal coherence): ${(existing.vitality || 0).toFixed(2)}
- Messages: ${existing.message_count || territory.point_count}
- Steward agent: ${AGENT_NAMES[existing.steward_agent_id] || existing.steward_agent_id || 'unknown'}
`;
  }

  // Tags
  if (context.topTags.length > 0) {
    prompt += `
## Top Tags
${context.topTags.join(', ')}
`;
  }

  // Agent distribution
  if (context.agentDistribution.length > 0) {
    prompt += `
## Agent Activity
${context.agentDistribution.map(a => `${a.agent}: ${a.count} messages`).join(', ')}
`;
  }

  // Neighbors
  if (context.siblings.length > 0) {
    prompt += `
## Neighboring Territories (same realm)
${context.siblings.map(s => `- ${s.name}${s.essence ? ': ' + s.essence : ''} (${s.points} points)`).join('\n')}
`;
  }

  // Content samples
  prompt += `
## Content Samples
${samples.map(s => {
    const prefix = `[${s.period.toUpperCase()} ${s.date}${s.agent ? ' ' + s.agent : ''}${s.type !== 'message' ? ' ' + s.type : ''}]`;
    return `${prefix} ${s.content}`;
  }).join('\n\n')}
`;

  // Output instructions
  prompt += `
## Output Format
Respond with ONLY a JSON object (no markdown fences, no explanation). The JSON must have these fields:

{
  "name": "Short activity-based name (what happens here, not what it looks like) — max 6 words",
  "essence": "One sentence capturing the territory's core meaning",
  "chronicle": "2-4 paragraphs. A living narrative that evolves: what this territory is about, how it developed over time, what's active now, and where momentum is pointing. Reference specific content you saw. If updating a previous chronicle, preserve valuable context and note what changed.",
  "story_birth": "How this territory first formed (from earliest content)",
  "story_arc": "The major trajectory — how the territory evolved",
  "story_current_chapter": "What's happening now (from recent content)",
  "signature_patterns": ["3-5 recurring patterns or themes you observe"],
  "open_threads": ["2-3 unresolved questions or active threads"],
  "top_entities": ["Up to 10 key entities (people, tools, concepts) mentioned"],
  "archetype_type": "One of: Workshop, Laboratory, Garden, Library, Arena, Sanctuary, Observatory, Crossroads",
  "neighbor_connections": "How this territory relates to its neighbors (if any shown)"
}

Rules:
- Ground every claim in actual content you saw. If you can't point to evidence, don't say it.
- Name by activity: "Late-Night Debug Sessions" not "Software Engineering"
- The chronicle should read like a naturalist's field notes, not a marketing blurb
- Avoid abstract nouns: consciousness, transformation, paradigm, journey, tapestry, synergy
- Be specific. "The user debugged the Discord bot reconnection logic" not "the user worked on technical challenges"
`;

  return prompt;
}

// ── Step 5: Call Claude CLI ─────────────────────────────────────────────

function callClaude(prompt, model = 'sonnet') {
  return new Promise((resolve, reject) => {
    const claudeBin = process.env.CLAUDE_BIN || 'claude';
    const args = ['--print', '--model', model, '--output-format', 'text', '--max-turns', '1'];

    const child = execFile(claudeBin, args, {
      cwd: root,
      env: {
        ...process.env,
        HOME: process.env.HOME || '/home/claude',
      },
      maxBuffer: 1024 * 1024, // 1MB
      timeout: 120_000, // 2 min per territory
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Claude failed: ${err.message}\nstderr: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });

    // Write prompt via stdin to avoid E2BIG
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ── Step 6: Parse Claude output and store ───────────────────────────────

function parseChronicleOutput(raw) {
  // Try to extract JSON from the response
  let jsonStr = raw;

  // Strip markdown fences if present
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1];

  // Try to find JSON object
  const objMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!objMatch) throw new Error('No JSON object found in response');

  return JSON.parse(objMatch[0]);
}

async function storeChronicle(territoryId, chronicle, contentStats, model) {
  const exploredPct = contentStats.total > 0
    ? Math.round((contentStats.sampled / contentStats.total) * 100)
    : 0;

  const cursor = JSON.stringify({
    analyzed_count: contentStats.sampled,
    total_at_analysis: contentStats.total,
    explored_percent: exploredPct,
    analyzed_at: new Date().toISOString(),
  });

  const jsonFields = {
    signature_patterns: JSON.stringify(chronicle.signature_patterns || []),
    open_threads: JSON.stringify(chronicle.open_threads || []),
    top_entities: JSON.stringify(chronicle.top_entities || []),
  };

  await d1Run(`
    UPDATE territory_profiles SET
      name = ?,
      essence = ?,
      chronicle = ?,
      story_birth = ?,
      story_arc = ?,
      story_current_chapter = ?,
      signature_patterns = ?,
      top_entities = ?,
      uncertainty_open_questions = ?,
      archetype_type = ?,
      chronicle_cursor = ?,
      chronicle_model = ?,
      explored_count = ?,
      explored_percent = ?,
      last_described_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      generation_model = ?,
      raw_response = ?
    WHERE territory_id = ?
  `, [
    chronicle.name,
    chronicle.essence,
    chronicle.chronicle,
    chronicle.story_birth,
    chronicle.story_arc,
    chronicle.story_current_chapter,
    jsonFields.signature_patterns,
    jsonFields.top_entities,
    JSON.stringify(chronicle.open_threads || []),
    chronicle.archetype_type,
    cursor,
    model,
    contentStats.sampled,
    exploredPct,
    `claude-${model}`,
    JSON.stringify(chronicle),
    territoryId,
  ]);
}

// ── Step 7: Assign themes to territories + generate theme descriptions ────

async function assignTerritoryThemes() {
  console.log('\n  ── Assigning Themes to Territories ──');

  // For each territory, find its dominant theme_id from clustering_points
  const assignments = await d1Query(`
    SELECT territory_id, theme_id, realm_id, cnt FROM (
      SELECT territory_id, theme_id, realm_id, COUNT(*) as cnt,
             ROW_NUMBER() OVER (PARTITION BY territory_id ORDER BY COUNT(*) DESC) as rn
      FROM clustering_points
      WHERE territory_id IS NOT NULL AND theme_id IS NOT NULL AND theme_id >= 0
      GROUP BY territory_id, theme_id, realm_id
    ) WHERE rn = 1
  `);

  let updated = 0;
  for (const a of assignments) {
    await d1Run(`
      UPDATE territory_profiles SET semantic_theme_id = ?
      WHERE territory_id = ? AND (semantic_theme_id IS NULL OR semantic_theme_id != ?)
    `, [a.theme_id, a.territory_id, a.theme_id]);
    updated++;
  }

  console.log(`  Assigned themes to ${updated} territories`);
  return assignments;
}

async function describeThemes() {
  console.log('\n  ── Theme Descriptions (built from territory chronicles) ──');

  // Get all (realm_id, theme_id) combos with their stats
  const themes = await d1Query(`
    SELECT realm_id, theme_id, COUNT(*) as point_count,
           COUNT(DISTINCT territory_id) as territory_count
    FROM clustering_points
    WHERE realm_id IS NOT NULL AND realm_id >= 0
      AND theme_id IS NOT NULL AND theme_id >= 0
    GROUP BY realm_id, theme_id
    HAVING point_count >= 5
    ORDER BY point_count DESC
  `);

  const userId = OWNER_ID;

  let success = 0;
  let skipped = 0;

  for (const theme of themes) {
    // Get territory chronicles under this theme
    const territories = await d1Query(`
      SELECT tp.territory_id, tp.name, tp.essence, tp.chronicle,
             tp.story_arc, tp.story_current_chapter,
             tp.signature_patterns, tp.message_count, tp.energy, tp.growth_state
      FROM territory_profiles tp
      WHERE tp.realm_id = ? AND tp.semantic_theme_id = ? AND tp.name IS NOT NULL
      ORDER BY tp.message_count DESC
    `, [theme.realm_id, theme.theme_id]);

    if (territories.length === 0) {
      skipped++;
      continue;
    }

    // Build territory digests for prompt
    const territoryDigests = territories.map(t => {
      let digest = `### ${t.name} (${t.message_count || 0} msgs, ${t.growth_state || 'steady'})`;
      if (t.essence) digest += `\nEssence: ${t.essence}`;
      if (t.chronicle) {
        // Include more chronicle text for richer synthesis
        const paras = t.chronicle.split('\n\n');
        const chronicleText = paras.slice(0, 2).join('\n').slice(0, 500);
        digest += `\nChronicle: ${chronicleText}${t.chronicle.length > 500 ? '...' : ''}`;
      } else if (t.story_arc) {
        digest += `\nStory: ${t.story_arc}`;
      }
      if (t.story_current_chapter) {
        digest += `\nCurrent: ${t.story_current_chapter}`;
      }
      if (t.signature_patterns) {
        try {
          const patterns = JSON.parse(t.signature_patterns);
          if (patterns.length) digest += `\nPatterns: ${patterns.slice(0, 3).join('; ')}`;
        } catch {}
      }
      return digest;
    }).join('\n\n');

    // Sample a few actual messages from this theme for grounding
    const messageSamples = await d1Query(`
      SELECT m.content, m.agent_id, cp.created_at
      FROM clustering_points cp
      JOIN messages m ON m.id = cp.source_id AND cp.source_type = 'message'
      WHERE cp.realm_id = ? AND cp.theme_id = ?
        AND m.content IS NOT NULL AND LENGTH(m.content) > 20
      ORDER BY RANDOM() LIMIT 15
    `, [theme.realm_id, theme.theme_id]);

    const samplesText = messageSamples.map(s => {
      const agent = AGENT_NAMES[s.agent_id] || s.agent_id || '?';
      const date = s.created_at?.split('T')[0] || '?';
      const content = (s.content || '').slice(0, 200);
      return `[${date} ${agent}] ${content}${s.content.length > 200 ? '...' : ''}`;
    }).join('\n\n');

    // Get top tags across theme
    const tagRows = await d1Query(`
      SELECT m.tags FROM clustering_points cp
      JOIN messages m ON m.id = cp.source_id
      WHERE cp.realm_id = ? AND cp.theme_id = ? AND m.tags IS NOT NULL AND LENGTH(m.tags) > 2
      ORDER BY RANDOM() LIMIT 80
    `, [theme.realm_id, theme.theme_id]);

    const tagCounts = {};
    for (const r of tagRows) {
      try {
        for (const tag of JSON.parse(r.tags)) {
          tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        }
      } catch {}
    }
    const topTags = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([tag, count]) => `${tag} (${count})`);

    // Check existing theme description
    const existing = await d1Query(`
      SELECT name, essence, story_arc, story_current_chapter FROM semantic_themes
      WHERE realm_id = ? AND semantic_theme_id = ?
      LIMIT 1
    `, [theme.realm_id, theme.theme_id]);
    const prev = existing[0];

    const prompt = `You are a cartographer of personal knowledge, writing a field guide entry for a semantic theme in someone's Mindscape.
A theme is a mid-level region: larger than territories (individual topics), smaller than realms (major life domains). It represents a coherent strand of thought, work, or experience.

## Theme (realm ${theme.realm_id}, theme ${theme.theme_id}): ${theme.point_count.toLocaleString()} data points across ${theme.territory_count} territories (${territories.length} described)

${prev?.name ? `## Previous Description (evolve, don't rewrite)\nName: ${prev.name}\nEssence: ${prev.essence || ''}\n${prev.story_arc ? 'Arc: ' + prev.story_arc : ''}\n${prev.story_current_chapter ? 'Current: ' + prev.story_current_chapter : ''}\n` : ''}
## Territory Chronicles (${territories.length} territories)
${territoryDigests}

${topTags.length > 0 ? `## Tags Across This Theme\n${topTags.join(', ')}\n` : ''}
## Raw Message Samples (${messageSamples.length} of ${theme.point_count})
${samplesText}

## Output
Respond with ONLY a JSON object:
{
  "name": "Theme name (2-5 words). Name by what HAPPENS here — activities, not abstractions. 'Late-Night Health Research' not 'Wellness Domain'",
  "essence": "2-3 sentences describing this theme's character. What kind of thinking/work/experience does this represent? What makes it distinctive?",
  "story_birth": "When and how this theme emerged (reference specific content)",
  "story_arc": "2-3 sentences: the major trajectory — what changed from early to recent content. Note shifts, intensifications, or pivots.",
  "story_current_chapter": "1-2 sentences: what's active and recent. Be concrete.",
  "signature_patterns": ["3-5 recurring patterns — behavioral, topical, or structural. Each should be a specific observation, not a label."],
  "open_questions": ["2-3 unresolved threads or tensions within this theme"],
  "top_entities": ["Up to 10 key entities: people, tools, places, concepts. Only names actually mentioned in the content."]
}

Rules:
- Ground every claim in content you saw. Reference specific messages, dates, tools, or people.
- Name by ACTIVITY: "Discord Bot Build & Deploy" not "Technical Development"
- THE SWAP TEST: if your description could apply to any theme, delete and rewrite
- Entities must be actual names from the content, not categories
- Avoid: consciousness, transformation, paradigm, journey, tapestry, synergy, landscape, holistic, delve, resonate, craft`;

    if (dryRun) {
      console.log(`  [DRY RUN] r${theme.realm_id}-t${theme.theme_id}: ${territories.length} territories, ${prompt.length} chars`);
      continue;
    }

    try {
      process.stdout.write(`  r${theme.realm_id}-t${theme.theme_id} (${territories.length} terrs, ${theme.point_count} pts)...`);
      const raw = await callClaude(prompt, 'sonnet');  // themes need deeper synthesis
      const parsed = parseChronicleOutput(raw);

      // Compute territory_ids list
      const territoryIds = territories.map(t => t.territory_id);

      await d1Run(`
        INSERT INTO semantic_themes (realm_id, semantic_theme_id, user_id, name, essence,
                                     territory_count, message_count, territory_ids,
                                     included_territory_count, coverage_percent,
                                     top_entities, signature_patterns,
                                     story_birth, story_arc, story_current_chapter,
                                     uncertainty_open_questions,
                                     generated_at, generation_model, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?,
                ?, ?,
                ?, ?, ?,
                ?,
                strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(user_id, realm_id, semantic_theme_id) DO UPDATE SET
          name = excluded.name,
          essence = excluded.essence,
          territory_count = excluded.territory_count,
          message_count = excluded.message_count,
          territory_ids = excluded.territory_ids,
          included_territory_count = excluded.included_territory_count,
          coverage_percent = excluded.coverage_percent,
          top_entities = excluded.top_entities,
          signature_patterns = excluded.signature_patterns,
          story_birth = excluded.story_birth,
          story_arc = excluded.story_arc,
          story_current_chapter = excluded.story_current_chapter,
          uncertainty_open_questions = excluded.uncertainty_open_questions,
          generated_at = excluded.generated_at,
          generation_model = excluded.generation_model,
          updated_at = excluded.updated_at
      `, [
        theme.realm_id, theme.theme_id, userId, parsed.name, parsed.essence,
        theme.territory_count, theme.point_count,
        JSON.stringify(territoryIds),
        territories.length, Math.round((territories.length / theme.territory_count) * 100),
        JSON.stringify(parsed.top_entities || []),
        JSON.stringify(parsed.signature_patterns || []),
        parsed.story_birth, parsed.story_arc, parsed.story_current_chapter,
        JSON.stringify(parsed.open_questions || []),
        `claude-${claudeModel}`,
      ]);

      console.log(` → "${parsed.name}"`);
      success++;
    } catch (err) {
      console.log(` ✗ ${err.message.slice(0, 100)}`);
    }
  }

  console.log(`  Themes: ${success} described, ${skipped} skipped (no described territories)`);
}

// ── Step 8: Generate realm descriptions from theme + territory chronicles ──

async function describeRealms() {
  console.log('\n  ── Realm Descriptions (built from territory chronicles) ──');

  const realms = await d1Query(`
    SELECT realm_id, COUNT(*) as point_count, COUNT(DISTINCT territory_id) as territory_count
    FROM clustering_points
    WHERE realm_id IS NOT NULL AND realm_id >= 0
    GROUP BY realm_id
    ORDER BY point_count DESC
  `);

  const userId = OWNER_ID;

  for (const realm of realms) {
    // Get territory chronicles (the rich source material)
    const territories = await d1Query(`
      SELECT territory_id, name, essence, chronicle, story_arc, story_current_chapter,
             signature_patterns, uncertainty_open_questions, archetype_type,
             message_count, energy, growth_state
      FROM territory_profiles
      WHERE realm_id = ? AND name IS NOT NULL
      ORDER BY message_count DESC
    `, [realm.realm_id]);

    if (territories.length === 0) {
      console.log(`  Realm ${realm.realm_id}: no described territories yet, skipping`);
      continue;
    }

    // Build prompt from territory chronicles (not just names)
    const territoryDigests = territories.map(t => {
      let digest = `### ${t.name} (${t.message_count || 0} msgs, ${((t.energy || 0) * 100).toFixed(1)}% energy, ${t.growth_state || 'steady'})`;
      if (t.essence) digest += `\nEssence: ${t.essence}`;
      if (t.chronicle) {
        // Include first paragraph of chronicle
        const firstPara = t.chronicle.split('\n\n')[0];
        digest += `\nChronicle: ${firstPara.slice(0, 300)}${firstPara.length > 300 ? '...' : ''}`;
      } else if (t.story_arc) {
        digest += `\nStory: ${t.story_arc.slice(0, 200)}`;
      }
      if (t.signature_patterns) {
        try {
          const patterns = JSON.parse(t.signature_patterns);
          if (patterns.length) digest += `\nPatterns: ${patterns.slice(0, 3).join('; ')}`;
        } catch {}
      }
      return digest;
    }).join('\n\n');

    // Get existing realm description for evolution
    const existing = await d1Query(`
      SELECT name, essence, story_arc, story_current_chapter FROM realms
      WHERE realm_id = ? LIMIT 1
    `, [realm.realm_id]);
    const prev = existing[0];

    const prompt = `You are writing a description for a realm in a personal knowledge landscape (Mindscape).
A realm is a large region containing related territories. Your description should synthesize the territory chronicles below into a coherent realm-level narrative.

## Realm ${realm.realm_id}: ${realm.point_count.toLocaleString()} total points across ${realm.territory_count} territories (${territories.length} described)

${prev?.name ? `## Previous Description (evolve, don't rewrite)\nName: ${prev.name}\nEssence: ${prev.essence || ''}\n${prev.story_arc ? 'Story: ' + prev.story_arc : ''}\n${prev.story_current_chapter ? 'Current: ' + prev.story_current_chapter : ''}\n` : ''}
## Territory Chronicles (${territories.length} territories)
${territoryDigests}

## Output
Respond with ONLY a JSON object:
{
  "name": "Short realm name (2-4 words, captures the shared theme across all territories)",
  "essence": "One sentence describing what unites these territories",
  "story_arc": "2-3 sentences: the realm's evolution over time, synthesized from territory chronicles",
  "story_current_chapter": "1-2 sentences: what's active in this realm right now",
  "signature_patterns": ["3-5 patterns that recur across multiple territories"],
  "open_questions": ["2-3 questions or tensions that span the realm"],
  "archetype_type": "One of: Kingdom, Wilderness, Archipelago, Continent, Network"
}

Rules:
- Build UP from the territory chronicles — don't invent, synthesize
- The name should capture the overarching theme, not just the biggest territory
- Note connections and tensions between territories
- Be specific to actual content, not generic`;

    if (dryRun) {
      console.log(`  [DRY RUN] Realm ${realm.realm_id}: ${territories.length} territories, prompt ${prompt.length} chars`);
      continue;
    }

    try {
      console.log(`  Realm ${realm.realm_id} (${territories.length} territories)...`);
      const raw = await callClaude(prompt, 'sonnet');  // realms need deeper synthesis
      const parsed = parseChronicleOutput(raw);

      await d1Run(`
        INSERT INTO realms (realm_id, user_id, name, essence, archetype_type,
                            territory_count, message_count, story_arc, story_current_chapter,
                            signature_patterns, uncertainty_open_questions)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(realm_id, user_id) DO UPDATE SET
          name = excluded.name,
          essence = excluded.essence,
          archetype_type = excluded.archetype_type,
          territory_count = excluded.territory_count,
          message_count = excluded.message_count,
          story_arc = excluded.story_arc,
          story_current_chapter = excluded.story_current_chapter,
          signature_patterns = excluded.signature_patterns,
          uncertainty_open_questions = excluded.uncertainty_open_questions,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      `, [
        realm.realm_id, userId, parsed.name, parsed.essence, parsed.archetype_type,
        realm.territory_count, realm.point_count,
        parsed.story_arc, parsed.story_current_chapter,
        JSON.stringify(parsed.signature_patterns || []),
        JSON.stringify(parsed.open_questions || []),
      ]);

      console.log(`    → "${parsed.name}" — ${parsed.essence}`);
    } catch (err) {
      console.error(`    ✗ Realm ${realm.realm_id} failed: ${err.message}`);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  Territory Chronicle Generator               ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  Model: ${claudeModel}`);
  console.log(`  Dry run: ${dryRun}`);
  console.log(`  Force: ${force}`);
  console.log(`  Max territories: ${maxTerritories}`);
  if (singleTerritory) console.log(`  Single territory: ${singleTerritory}`);

  // Get territories
  let territories = await getTerritoriesForChronicle();
  console.log(`\n  Found ${territories.length} territories needing chronicles`);

  if (territories.length === 0) {
    console.log('  Nothing to do.');
    return;
  }

  // Sort by point_count descending (biggest first)
  territories.sort((a, b) => (b.point_count || 0) - (a.point_count || 0));

  // Apply limit
  if (territories.length > maxTerritories) {
    console.log(`  Capping to ${maxTerritories} territories (${territories.length - maxTerritories} deferred)`);
    territories = territories.slice(0, maxTerritories);
  }

  console.log('');

  let success = 0;
  let failed = 0;

  for (const territory of territories) {
    const reason = territory.reason || 'force';
    const label = `Territory ${territory.territory_id} (${territory.point_count} pts, realm ${territory.realm_id}, ${reason})`;
    process.stdout.write(`  ${label}...`);

    try {
      // Sample content
      const content = await sampleContent(territory.territory_id);

      if (content.samples.length < 3) {
        console.log(` skipped (only ${content.samples.length} samples)`);
        continue;
      }

      // Get context
      const context = await getTerritoryContext(territory.territory_id, territory.realm_id);

      // Build prompt
      const prompt = buildPrompt(territory, content, context);

      if (dryRun) {
        console.log(` [DRY RUN] prompt=${prompt.length} chars, ${content.sampled}/${content.total} samples`);
        continue;
      }

      // Call Claude
      const raw = await callClaude(prompt, claudeModel);

      // Parse and store
      const chronicle = parseChronicleOutput(raw);
      await storeChronicle(territory.territory_id, chronicle, content, claudeModel);

      console.log(` → "${chronicle.name}"`);
      success++;
    } catch (err) {
      console.log(` ✗ ${err.message.slice(0, 100)}`);
      failed++;
    }
  }

  console.log(`\n  Done: ${success} succeeded, ${failed} failed`);

  // Assign themes to territories, then describe themes, then realms
  if (!dryRun) {
    await assignTerritoryThemes();
    await describeThemes();
    await describeRealms();
  }

  console.log('\n  Chronicle generation complete.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
